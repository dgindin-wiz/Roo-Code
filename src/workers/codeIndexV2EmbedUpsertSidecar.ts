import { TelemetryService } from "@roo-code/telemetry"
import { createSidecarDependencies } from "../services/code-index-v2/sidecar/dependencyFactory"
import { SidecarChildToHostMessage, SidecarHostToChildMessage } from "../services/code-index-v2/sidecar/protocol"
import { executeUpsertBatch } from "../services/code-index-v2/pipeline/EmbedUpsertExecution"

let initialized = false
let dependencies: ReturnType<typeof createSidecarDependencies> | undefined
let activeControllers = new Map<string, AbortController>()
let lastCpuSample:
	| {
			usage: NodeJS.CpuUsage
			recordedAtMs: number
	  }
	| undefined

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
					const result = await executeUpsertBatch(
						message.items,
						dependencies.embeddingAdapter,
						dependencies.vectorStore,
						{
							signal: controller.signal,
							debugContext: {
								runId: message.runId,
								batchId: `${message.runId}:${message.laneId}:${message.requestId}`,
								outerBatchSize: message.items.length,
							},
						},
					)
					send({
						type: "upsert-result",
						requestId: message.requestId,
						embeddingCount: result.embeddingCount,
						embedLatencyMs: result.embedLatencyMs,
						upsertLatencyMs: result.upsertLatencyMs,
						pointIds: result.pointIds,
						runtimeProfile: result.adaptiveControllerState,
						runtimeObservations: result.adaptiveControllerObservations,
						variantTelemetry: result.variantTelemetry,
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
