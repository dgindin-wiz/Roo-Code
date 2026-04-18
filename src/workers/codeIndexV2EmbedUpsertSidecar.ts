import { TelemetryService } from "@roo-code/telemetry"
import { createSidecarDependencies } from "../services/code-index-v2/sidecar/dependencyFactory"
import { SidecarChildToHostMessage, SidecarHostToChildMessage } from "../services/code-index-v2/sidecar/protocol"
import {
	createEmbeddedUpsertBatch,
	type EmbeddedUpsertBatch,
	writeEmbeddedUpsertBatch,
} from "../services/code-index-v2/pipeline/EmbedUpsertExecution"

let initialized = false
let dependencies: ReturnType<typeof createSidecarDependencies> | undefined
let activeControllers = new Map<string, AbortController>()
let lastCpuSample:
	| {
			usage: NodeJS.CpuUsage
			recordedAtMs: number
	  }
	| undefined

const MAX_VECTOR_WRITE_BATCHES = 2
const MAX_VECTOR_WRITE_BYTES = 128 * 1024 * 1024

interface VectorWriteTask {
	requestId: string
	embedded: EmbeddedUpsertBatch
	estimatedBytes: number
	resolve: (upsertLatencyMs: number) => void
	reject: (error: unknown) => void
}

const vectorWriteQueue: VectorWriteTask[] = []
const vectorWriteCapacityWaiters = new Set<() => void>()
let activeVectorWriteTask: VectorWriteTask | undefined
let vectorWriteQueueBytes = 0
let vectorWriteQueueEmbeddings = 0
let vectorWriteDrainPromise: Promise<void> | undefined

if (!TelemetryService.hasInstance()) {
	TelemetryService.createInstance([])
}

function getMemorySnapshot() {
	const usage = process.memoryUsage()
	return {
		rssMB: Math.round(usage.rss / 1024 / 1024),
		heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
		heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
		externalMB: Math.round(usage.external / 1024 / 1024),
		arrayBuffersMB: Math.round(usage.arrayBuffers / 1024 / 1024),
	}
}

function getCpuSnapshot() {
	const nowMs = Date.now()
	const usage = process.cpuUsage()
	const previous = lastCpuSample
	lastCpuSample = {
		usage,
		recordedAtMs: nowMs,
	}
	if (!previous) {
		return {}
	}
	const elapsedMs = nowMs - previous.recordedAtMs
	if (elapsedMs <= 0) {
		return {}
	}
	const delta = process.cpuUsage(previous.usage)
	const cpuMicros = delta.user + delta.system
	const processPercent = Number(((cpuMicros / (elapsedMs * 1000)) * 100).toFixed(1))
	return {
		processPercent: Number.isFinite(processPercent) ? processPercent : undefined,
	}
}

function send(message: SidecarChildToHostMessage) {
	if (typeof process.send === "function") {
		process.send(message)
	}
}

function sendError(requestId: string | undefined, error: unknown, retryable?: boolean) {
	send({
		type: "error",
		requestId,
		errorMessage: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		retryable,
		memory: getMemorySnapshot(),
		cpu: getCpuSnapshot(),
	})
}

function estimateVectorWriteBytes(embedded: EmbeddedUpsertBatch): number {
	let vectorBytes = 0
	let payloadBytes = 0
	for (const point of embedded.points) {
		vectorBytes += point.vector.length * 4
		try {
			payloadBytes += Buffer.byteLength(JSON.stringify(point.payload), "utf8")
		} catch {
			payloadBytes += 8 * 1024
		}
	}
	// Account for object overhead and transient serialization copies without pretending this is exact.
	return Math.ceil((vectorBytes + payloadBytes) * 2.5)
}

function getVectorWriteQueueMetrics() {
	return {
		vectorWriteQueueDepth: vectorWriteQueue.length + (activeVectorWriteTask ? 1 : 0),
		queuedVectorWriteBatches: vectorWriteQueue.length + (activeVectorWriteTask ? 1 : 0),
		queuedVectorWriteEmbeddings: vectorWriteQueueEmbeddings,
		queuedVectorWriteBytes: vectorWriteQueueBytes,
	}
}

function notifyVectorWriteCapacity() {
	for (const waiter of Array.from(vectorWriteCapacityWaiters)) {
		waiter()
	}
}

async function waitForVectorWriteCapacity(signal?: AbortSignal): Promise<number> {
	const startedAt = Date.now()
	while (
		vectorWriteQueue.length + (activeVectorWriteTask ? 1 : 0) > MAX_VECTOR_WRITE_BATCHES - 1 ||
		vectorWriteQueueBytes > MAX_VECTOR_WRITE_BYTES
	) {
		if (signal?.aborted) {
			throw new Error("Embed/upsert worker aborted")
		}
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				vectorWriteCapacityWaiters.delete(finish)
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}
			const onAbort = () => {
				vectorWriteCapacityWaiters.delete(finish)
				signal?.removeEventListener("abort", onAbort)
				reject(new Error("Embed/upsert worker aborted"))
			}
			vectorWriteCapacityWaiters.add(finish)
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}
	return Date.now() - startedAt
}

function enqueueVectorWrite(requestId: string, embedded: EmbeddedUpsertBatch): Promise<number> {
	const estimatedBytes = estimateVectorWriteBytes(embedded)
	vectorWriteQueueBytes += estimatedBytes
	vectorWriteQueueEmbeddings += embedded.embeddingCount
	const writePromise = new Promise<number>((resolve, reject) => {
		vectorWriteQueue.push({
			requestId,
			embedded,
			estimatedBytes,
			resolve,
			reject,
		})
	})
	void drainVectorWriteQueue()
	return writePromise
}

async function drainVectorWriteQueue(): Promise<void> {
	if (vectorWriteDrainPromise) {
		return vectorWriteDrainPromise
	}

	vectorWriteDrainPromise = (async () => {
		while (vectorWriteQueue.length > 0) {
			const task = vectorWriteQueue.shift()!
			activeVectorWriteTask = task
			try {
				if (!dependencies) {
					throw new Error("Code index sidecar vector writer is unavailable")
				}
				const upsertLatencyMs = await writeEmbeddedUpsertBatch(task.embedded, dependencies.vectorStore)
				task.resolve(upsertLatencyMs)
			} catch (error) {
				task.reject(error)
			} finally {
				vectorWriteQueueBytes = Math.max(0, vectorWriteQueueBytes - task.estimatedBytes)
				vectorWriteQueueEmbeddings = Math.max(0, vectorWriteQueueEmbeddings - task.embedded.embeddingCount)
				activeVectorWriteTask = undefined
				notifyVectorWriteCapacity()
			}
		}
	})().finally(() => {
		vectorWriteDrainPromise = undefined
		notifyVectorWriteCapacity()
	})

	return vectorWriteDrainPromise
}

async function handleMessage(message: SidecarHostToChildMessage) {
	try {
		switch (message.type) {
			case "init": {
				dependencies = createSidecarDependencies(message.payload)
				await dependencies.vectorStore.initialize()
				initialized = true
				send({
					type: "ready",
					pid: process.pid,
					memory: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
				return
			}
			case "execute-upsert": {
				if (!initialized || !dependencies) {
					throw new Error("Code index sidecar received work before initialization")
				}
				const controller = new AbortController()
				activeControllers.set(message.requestId, controller)
				try {
					const requestStartedAt = Date.now()
					const vectorWriteBackpressureMs = await waitForVectorWriteCapacity(controller.signal)
					const embedded = await createEmbeddedUpsertBatch(message.items, dependencies.embeddingAdapter, {
						signal: controller.signal,
						debugContext: {
							runId: message.runId,
							batchId: `${message.runId}:${message.laneId}:${message.requestId}`,
							outerBatchSize: message.items.length,
						},
					})
					const vectorWritePromise =
						embedded.points.length > 0
							? enqueueVectorWrite(message.requestId, embedded)
							: Promise.resolve(0)
					const queueMetrics = getVectorWriteQueueMetrics()
					const laneReleasedAfterEmbedMs = Date.now() - requestStartedAt
					send({
						type: "upsert-embedded",
						requestId: message.requestId,
						embeddingCount: embedded.embeddingCount,
						embedLatencyMs: embedded.embedLatencyMs,
						pointIds: embedded.pointIds,
						vectorWriteQueueDepth: queueMetrics.vectorWriteQueueDepth,
						queuedVectorWriteBatches: queueMetrics.queuedVectorWriteBatches,
						queuedVectorWriteEmbeddings: queueMetrics.queuedVectorWriteEmbeddings,
						vectorWriteBackpressureMs,
						laneReleasedAfterEmbedMs,
						memory: getMemorySnapshot(),
						cpu: getCpuSnapshot(),
					})
					const upsertLatencyMs = await vectorWritePromise
					const completionQueueMetrics = getVectorWriteQueueMetrics()
					send({
						type: "upsert-result",
						requestId: message.requestId,
						embeddingCount: embedded.embeddingCount,
						embedLatencyMs: embedded.embedLatencyMs,
						upsertLatencyMs,
						pointIds: embedded.pointIds,
						vectorWriteQueueDepth: completionQueueMetrics.vectorWriteQueueDepth,
						queuedVectorWriteBatches: completionQueueMetrics.queuedVectorWriteBatches,
						queuedVectorWriteEmbeddings: completionQueueMetrics.queuedVectorWriteEmbeddings,
						vectorWriteBackpressureMs,
						laneReleasedAfterEmbedMs,
						runtimeProfile: embedded.adaptiveControllerState,
						runtimeObservations: embedded.adaptiveControllerObservations,
						variantTelemetry: embedded.variantTelemetry,
						memory: getMemorySnapshot(),
						cpu: getCpuSnapshot(),
					})
				} finally {
					activeControllers.delete(message.requestId)
				}
				return
			}
			case "cancel": {
				activeControllers.get(message.requestId)?.abort()
				send({
					type: "cancelled",
					requestId: message.requestId,
				})
				return
			}
			case "recycle": {
				if (!dependencies) {
					throw new Error("Code index sidecar received recycle before initialization")
				}
				const memoryBefore = getMemorySnapshot()
				await dependencies.embeddingAdapter.recycleClient?.()
				await dependencies.vectorStore.recycleClient?.()
				send({
					type: "recycle-complete",
					requestId: message.requestId,
					memoryBefore,
					memoryAfter: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
				return
			}
			case "controller-update": {
				dependencies?.embeddingAdapter.seedAdaptiveControllerState?.(message.runtimeProfile)
				return
			}
			case "shutdown": {
				try {
					await dependencies?.embeddingAdapter.recycleClient?.()
					await dependencies?.vectorStore.recycleClient?.()
				} finally {
					send({
						type: "shutdown-complete",
						requestId: message.requestId,
					})
					setTimeout(() => process.exit(0), 10).unref()
				}
				return
			}
		}
	} catch (error) {
		const retryable = (() => {
			const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
			return (
				message.includes("rate limit") ||
				message.includes("429") ||
				message.includes("timeout") ||
				message.includes("timed out") ||
				message.includes("deadline exceeded") ||
				message.includes("too many requests")
			)
		})()
		sendError("requestId" in message ? message.requestId : undefined, error, retryable)
	}
}

process.on("message", (message: SidecarHostToChildMessage) => {
	void handleMessage(message)
})

process.on("uncaughtException", (error) => {
	sendError(undefined, error)
	process.exit(1)
})

process.on("unhandledRejection", (error) => {
	sendError(undefined, error)
	process.exit(1)
})
