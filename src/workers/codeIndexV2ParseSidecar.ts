import * as fs from "fs/promises"
import { TelemetryService } from "@roo-code/telemetry"
import type { CodeIndexParserAdapter } from "../services/code-index-v2/adapters/CodeIndexParserAdapter"
import type { ParsedChunkUpsertInput } from "../services/code-index-v2/pipeline/ParseExecution"
import type {
	ParseSidecarChildToHostMessage,
	ParseSidecarHostToChildMessage,
} from "../services/code-index-v2/sidecar/parseProtocol"

let parserAdapterPromise: Promise<CodeIndexParserAdapter> | undefined
let normalizeChunksPromise:
	| Promise<(chunks: Awaited<ReturnType<CodeIndexParserAdapter["parseFile"]>>) => ParsedChunkUpsertInput[]>
	| undefined
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

function send(message: ParseSidecarChildToHostMessage) {
	if (typeof process.send === "function") {
		process.send(message)
	}
}

function sendLifecycle(stage: Extract<ParseSidecarChildToHostMessage, { type: "lifecycle" }>["stage"]) {
	send({
		type: "lifecycle",
		stage,
		memory: getMemorySnapshot(),
		cpu: getCpuSnapshot(),
	})
}

async function getParserAdapter(): Promise<CodeIndexParserAdapter> {
	if (!parserAdapterPromise) {
		sendLifecycle("worker-parser-init-start")
		parserAdapterPromise = import("../services/code-index-v2/adapters/CodeIndexParserAdapter")
			.then(({ CodeIndexParserAdapter }) => new CodeIndexParserAdapter())
			.finally(() => {
				sendLifecycle("worker-parser-init-complete")
			})
	}
	return parserAdapterPromise
}

async function getChunkNormalizer() {
	if (!normalizeChunksPromise) {
		normalizeChunksPromise = import("../services/code-index-v2/pipeline/ParseExecution").then(
			({ toParsedChunkUpsertInputs }) => toParsedChunkUpsertInputs,
		)
	}
	return normalizeChunksPromise
}

async function handleMessage(message: ParseSidecarHostToChildMessage) {
	try {
		switch (message.type) {
			case "init":
				send({
					type: "ready",
					pid: process.pid,
					memory: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
				sendLifecycle("worker-bootstrap-ready")
				return
			case "parse-revision": {
				const startedAt = Date.now()
				const [parserAdapter, normalizeChunks] = await Promise.all([getParserAdapter(), getChunkNormalizer()])
				const content = await fs.readFile(message.normalizedPath, "utf8")
				const chunks = await parserAdapter.parseFile({
					filePath: message.normalizedPath,
					relativePath: message.relativePath,
					content,
					maxFileSizeBytes: message.maxFileSizeBytes,
				})
				send({
					type: "parse-result",
					requestId: message.requestId,
					chunks: normalizeChunks(chunks),
					parseLatencyMs: Date.now() - startedAt,
					memory: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
				return
			}
			case "shutdown":
				send({
					type: "shutdown-complete",
					requestId: message.requestId,
				})
				setTimeout(() => process.exit(0), 10).unref()
				return
		}
	} catch (error) {
		send({
			type: "error",
			requestId: "requestId" in message ? message.requestId : undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			memory: getMemorySnapshot(),
			cpu: getCpuSnapshot(),
		})
	}
}

process.on("message", (message: ParseSidecarHostToChildMessage) => {
	void handleMessage(message)
})

sendLifecycle("worker-bootstrap-start")

process.on("uncaughtException", (error) => {
	send({
		type: "error",
		errorMessage: error.message,
		stack: error.stack,
		memory: getMemorySnapshot(),
		cpu: getCpuSnapshot(),
	})
	process.exit(1)
})

process.on("unhandledRejection", (error) => {
	send({
		type: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		memory: getMemorySnapshot(),
		cpu: getCpuSnapshot(),
	})
	process.exit(1)
})
