import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	const { EventEmitter } = require("events")
	class FakeChildProcess extends EventEmitter {
		pid = 4321
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

describe("SidecarParseExecutor", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})

	it("initializes a lane on ready and resolves parse requests", async () => {
		const { SidecarParseExecutor } = await import("../pipeline/SidecarParseExecutor")
		const child = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValue(child as any)
		const executor = new SidecarParseExecutor("/workspace", 1)

		const parsePromise = executor.parseRevision({
			runId: "run-1",
			revisionId: "revision-1",
			normalizedPath: "/workspace/src/example.ts",
			relativePath: "src/example.ts",
		})

		expect(child.sentMessages[0]).toEqual({
			type: "init",
			payload: { workspacePath: "/workspace" },
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

		const parseRequest = child.sentMessages[1]
		expect(parseRequest.type).toBe("parse-revision")
		child.emit("message", {
			type: "parse-result",
			requestId: parseRequest.requestId,
			chunks: [{ chunkFingerprint: "fp-1", startLine: 1, endLine: 1, content: "value" }],
			parseLatencyMs: 12,
			memory: { rssMB: 55 },
			cpu: { processPercent: 8 },
		})

		await expect(parsePromise).resolves.toEqual({
			chunks: [{ chunkFingerprint: "fp-1", startLine: 1, endLine: 1, content: "value" }],
			parseLatencyMs: 12,
		})
	})

	it("times out lane startup, kills the child, and clears lane state", async () => {
		const { SidecarParseExecutor } = await import("../pipeline/SidecarParseExecutor")
		const child = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValue(child as any)
		const executor = new SidecarParseExecutor("/workspace", 1)

		const parsePromise = executor.parseRevision({
			runId: "run-1",
			revisionId: "revision-1",
			normalizedPath: "/workspace/src/example.ts",
			relativePath: "src/example.ts",
		})

		const rejection = expect(parsePromise).rejects.toThrow(
			"Code index parse sidecar failed to initialize within 10000ms.",
		)
		await vi.advanceTimersByTimeAsync(10_000)
		await rejection
		expect(child.killed).toBe(true)

		const replacementChild = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValueOnce(replacementChild as any)
		const secondParsePromise = executor.parseRevision({
			runId: "run-1",
			revisionId: "revision-2",
			normalizedPath: "/workspace/src/other.ts",
			relativePath: "src/other.ts",
		})
		replacementChild.emit("message", {
			type: "ready",
			pid: replacementChild.pid,
		})
		await vi.waitFor(() => {
			expect(replacementChild.sentMessages).toHaveLength(2)
		})
		const parseRequest = replacementChild.sentMessages[1]
		replacementChild.emit("message", {
			type: "parse-result",
			requestId: parseRequest.requestId,
			chunks: [],
			parseLatencyMs: 1,
		})
		await expect(secondParsePromise).resolves.toEqual({
			chunks: [],
			parseLatencyMs: 1,
		})
	})

	it("aborts lane startup promptly and kills the child", async () => {
		const { SidecarParseExecutor } = await import("../pipeline/SidecarParseExecutor")
		const child = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValue(child as any)
		const executor = new SidecarParseExecutor("/workspace", 1)
		const abortController = new AbortController()

		const parsePromise = executor.parseRevision({
			runId: "run-1",
			revisionId: "revision-1",
			normalizedPath: "/workspace/src/example.ts",
			relativePath: "src/example.ts",
			signal: abortController.signal,
		})

		abortController.abort()

		await expect(parsePromise).rejects.toThrow("Parse/chunk stage aborted")
		expect(child.killed).toBe(true)
	})

	it("propagates child process errors before ready", async () => {
		const { SidecarParseExecutor } = await import("../pipeline/SidecarParseExecutor")
		const child = new mocks.FakeChildProcess()
		mocks.fork.mockReturnValue(child as any)
		const executor = new SidecarParseExecutor("/workspace", 1)

		const parsePromise = executor.parseRevision({
			runId: "run-1",
			revisionId: "revision-1",
			normalizedPath: "/workspace/src/example.ts",
			relativePath: "src/example.ts",
		})

		child.emit("error", new Error("spawn EACCES"))

		await expect(parsePromise).rejects.toThrow("spawn EACCES")
	})
})
