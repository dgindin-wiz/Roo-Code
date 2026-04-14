import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	const { EventEmitter } = require("events")

	class FakeChildProcess extends EventEmitter {
		pid = 5678
		sentMessages: any[] = []
		killed = false

		send(message: any) {
			this.sentMessages.push(message)
		}

		kill() {
			this.killed = true
			this.emit("exit", null, "SIGTERM")
			return true
		}
	}

	const fork = vi.fn()

	return {
		FakeChildProcess,
		fork,
	}
})

vi.mock("child_process", () => ({
	fork: mocks.fork,
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		log: vi.fn(),
		updateTrackedProcessSnapshot: vi.fn(),
		clearTrackedProcessSnapshot: vi.fn(),
		getDiagnosticsDirectory: vi.fn(() => "/tmp/roo-code-index-v2-diagnostics"),
	},
}))

describe("SidecarEmbedUpsertExecutor", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})

	it("computes sidecar round-trip and delivery delay from host-observed timings", async () => {
		const { SidecarEmbedUpsertExecutor } = await import("../pipeline/SidecarEmbedUpsertExecutor")
		const child = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValue(child as any)

		const executor = new SidecarEmbedUpsertExecutor(
			"/workspace",
			{} as any,
			3,
			{
				provider: "openai-compatible",
				modelId: "text-embedding-3-small",
				runtimeKind: "remote",
				runtimeLabel: "Remote embedder",
			},
			1,
		)

		const upsertPromise = executor.executeUpsertBatch("run-1", 1, [
			{
				chunk: {
					chunkId: "chunk-1",
					revisionId: "revision-1",
					chunkFingerprint: "fp-1",
					startLine: 1,
					endLine: 1,
					content: "const value = 1",
					fileId: "file-1",
					workspaceId: "workspace-1",
					relativePath: "src/example.ts",
					parserVersion: "parser-v1",
					chunkerVersion: "chunker-v1",
				},
				variants: [
					{
						variantId: "variant-1",
						chunkId: "chunk-1",
						variantType: "raw_code",
						content: "const value = 1",
					},
				],
			},
		])

		expect(child.sentMessages[0]).toEqual({
			type: "init",
			payload: expect.objectContaining({
				workspacePath: "/workspace",
			}),
		})

		child.emit("message", {
			type: "ready",
			pid: child.pid,
			memory: { rssMB: 50 },
			cpu: { processPercent: 5 },
		})

		await vi.waitFor(() => {
			expect(child.sentMessages).toHaveLength(2)
		})

		const upsertRequest = child.sentMessages[1]
		expect(upsertRequest.type).toBe("execute-upsert")

		await vi.advanceTimersByTimeAsync(3_500)
		child.emit("message", {
			type: "upsert-result",
			requestId: upsertRequest.requestId,
			embeddingCount: 1,
			embedLatencyMs: 1_200,
			upsertLatencyMs: 300,
			pointIds: ["point-1"],
			runtimeObservations: [],
			variantTelemetry: {
				storedVariantCount: 1,
				embeddedVariantCount: 1,
				storedVariantCountsByType: { raw_code: 1 },
				embeddedVariantCountsByType: { raw_code: 1 },
				skippedVectorizationReasons: {},
			},
			memory: { rssMB: 55 },
			cpu: { processPercent: 8 },
		})

		await expect(upsertPromise).resolves.toSatisfy((result) => {
			expect(result.embeddingCount).toBe(1)
			expect(result.sidecarRoundTripLatencyMs).toBeGreaterThanOrEqual(3_500)
			expect(result.sidecarDeliveryDelayMs).toBe(
				result.sidecarRoundTripLatencyMs! - result.embedLatencyMs - result.upsertLatencyMs,
			)
			return true
		})
	})
})
