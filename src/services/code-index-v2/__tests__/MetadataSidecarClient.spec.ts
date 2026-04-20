import { EventEmitter } from "events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createResolvedMetadataPaths } from "./CodeIndexEngineV2.testUtils"

class MockChildProcess extends EventEmitter {
	pid = 4242
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	readonly send = vi.fn((message: Record<string, unknown>) => {
		if (message.type === "init") {
			queueMicrotask(() => {
				this.emit("message", {
					type: "ready",
					pid: this.pid,
					memory: {
						rssMB: 100,
						heapUsedMB: 20,
						heapTotalMB: 40,
						externalMB: 5,
						arrayBuffersMB: 1,
					},
					cpu: {
						processPercent: 12,
					},
				})
			})
		}
	})
	readonly kill = vi.fn((signal?: NodeJS.Signals) => {
		this.signalCode = signal ?? null
		queueMicrotask(() => {
			this.emit("exit", null, signal ?? null)
		})
		return true
	})
}

const testState = vi.hoisted(() => ({
	fork: vi.fn(),
	existsSync: vi.fn((_filePath?: string) => true),
	logger: {
		log: vi.fn(),
		getMemorySnapshot: vi.fn(() => ({
			rssMB: 256,
			heapUsedMB: 64,
			heapTotalMB: 128,
			externalMB: 16,
			arrayBuffersMB: 4,
		})),
		getCpuSnapshot: vi.fn(() => ({
			processPercent: 15,
		})),
		updateTrackedProcessSnapshot: vi.fn(),
		clearTrackedProcessSnapshot: vi.fn(),
	},
}))

vi.mock("child_process", () => ({
	fork: (...args: unknown[]) => testState.fork(...args),
}))

vi.mock("fs", () => ({
	existsSync: (filePath: string) => testState.existsSync(filePath),
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: testState.logger,
}))

import {
	MetadataSidecarClient,
	MetadataSidecarRequestTimeoutError,
	MetadataSidecarUnavailableError,
} from "../sidecar/MetadataSidecarClient"

describe("MetadataSidecarClient", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		testState.fork.mockReset()
		testState.existsSync.mockReset()
		testState.existsSync.mockReturnValue(true)
		Object.values(testState.logger).forEach((mock) => mock.mockReset?.())
		testState.logger.getMemorySnapshot.mockReturnValue({
			rssMB: 256,
			heapUsedMB: 64,
			heapTotalMB: 128,
			externalMB: 16,
			arrayBuffersMB: 4,
		})
		testState.logger.getCpuSnapshot.mockReturnValue({
			processPercent: 15,
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("times out a hanging hot-path request, kills the sidecar, and refuses to respawn within the run", async () => {
		const child = new MockChildProcess()
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()

		const requestPromise = (
			client as unknown as { getRunBacklogMetrics: (runId: string) => Promise<unknown> }
		).getRunBacklogMetrics("run-1")
		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)

		await vi.advanceTimersByTimeAsync(10_000)

		await requestAssertion
		await expect(
			(client as unknown as { getRunBacklogMetrics: (runId: string) => Promise<unknown> }).getRunBacklogMetrics(
				"run-1",
			),
		).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)
		expect(testState.fork).toHaveBeenCalledTimes(1)
		expect(child.kill).toHaveBeenCalledWith("SIGTERM")
		expect(testState.logger.log).toHaveBeenCalledWith(
			"basic",
			"MetadataSidecar",
			"metadata-sidecar-request-timeout",
			expect.objectContaining({
				operation: "getRunBacklogMetrics",
				timeoutMs: 10_000,
			}),
		)
	})

	it("uses an extended timeout for full vacuum maintenance", async () => {
		const child = new MockChildProcess()
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()

		const requestPromise = (
			client as unknown as { performMaintenance: (input: { vacuumMode: "full" }) => Promise<unknown> }
		).performMaintenance({ vacuumMode: "full" })
		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)

		await vi.advanceTimersByTimeAsync(90_000)
		expect(child.kill).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(510_000)
		await requestAssertion
		expect(testState.logger.log).toHaveBeenCalledWith(
			"basic",
			"MetadataSidecar",
			"metadata-sidecar-request-timeout",
			expect.objectContaining({
				operation: "performMaintenance",
				timeoutMs: 600_000,
			}),
		)
	})

	it("reports diagnostics for standby, online, busy, and failed states", async () => {
		const child = new MockChildProcess()
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				role: "writer",
				label: "metadata-writer-sidecar",
				state: "standby",
				pid: null,
				pendingRequestCount: 0,
			}),
		)

		await client.initialize()

		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				state: "online",
				pid: 4242,
				pendingRequestCount: 0,
				lastOperation: "init",
			}),
		)

		const requestPromise = (
			client as unknown as { getRunProgressRecord: (runId: string) => Promise<unknown> }
		).getRunProgressRecord("run-1")
		await Promise.resolve()
		await vi.runAllTicks()
		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				state: "busy",
				pendingRequestCount: 1,
				lastOperation: "getRunProgressRecord",
			}),
		)

		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)
		await vi.advanceTimersByTimeAsync(5_000)
		await requestAssertion

		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				state: "failed",
				pendingRequestCount: 0,
				lastOperation: "getRunProgressRecord",
				lastTimeoutMs: 5_000,
				lastError: expect.stringContaining("getRunProgressRecord"),
			}),
		)
	})

	it("rejects every pending request when one timeout marks the sidecar unhealthy", async () => {
		const child = new MockChildProcess()
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()

		const backlogPromise = (
			client as unknown as { getRunBacklogMetrics: (runId: string) => Promise<unknown> }
		).getRunBacklogMetrics("run-1")
		const progressPromise = (
			client as unknown as { getRunProgressRecord: (runId: string) => Promise<unknown> }
		).getRunProgressRecord("run-1")
		const settledResults = Promise.allSettled([backlogPromise, progressPromise])

		await vi.advanceTimersByTimeAsync(5_000)

		const [backlogResult, progressResult] = await settledResults
		expect(backlogResult.status).toBe("rejected")
		expect(progressResult.status).toBe("rejected")
		expect((backlogResult as PromiseRejectedResult).reason).toBeInstanceOf(MetadataSidecarRequestTimeoutError)
		expect((progressResult as PromiseRejectedResult).reason).toBeInstanceOf(MetadataSidecarRequestTimeoutError)
		expect(testState.fork).toHaveBeenCalledTimes(1)
		expect((progressResult as PromiseRejectedResult).reason).not.toBeInstanceOf(MetadataSidecarUnavailableError)
	})

	it("uses the dedicated 10s claim timeout for job claims", async () => {
		const child = new MockChildProcess()
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()

		const requestPromise = (
			client as unknown as {
				claimJobsWithLease: (jobType: string, limit: number, runId: string) => Promise<unknown>
			}
		).claimJobsWithLease("upsert", 10, "run-1")
		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)

		await vi.advanceTimersByTimeAsync(9_999)
		expect(child.kill).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		await requestAssertion
		expect(child.kill).toHaveBeenCalledWith("SIGTERM")
		expect(testState.logger.log).toHaveBeenCalledWith(
			"basic",
			"MetadataSidecar",
			"metadata-sidecar-request-timeout",
			expect.objectContaining({
				operation: "claimJobsWithLease",
				timeoutMs: 10_000,
			}),
		)
	})

	it("hard-kills a timed-out sidecar when SIGTERM does not exit", async () => {
		const child = new MockChildProcess()
		child.kill.mockImplementation(() => true)
		testState.fork.mockReturnValue(child as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()

		const requestPromise = (
			client as unknown as { getRunBacklogMetrics: (runId: string) => Promise<unknown> }
		).getRunBacklogMetrics("run-1")
		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)

		await vi.advanceTimersByTimeAsync(10_000)
		await requestAssertion
		expect(child.kill).toHaveBeenCalledWith("SIGTERM")

		await vi.advanceTimersByTimeAsync(2_000)
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
	})

	it("lets a reader sidecar restart lazily after a read timeout without staying poisoned", async () => {
		const firstChild = new MockChildProcess()
		const secondChild = new MockChildProcess()
		secondChild.pid = 4343
		testState.fork.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"), { role: "reader" })

		await client.initialize()

		const requestPromise = (
			client as unknown as { getRunBacklogMetrics: (runId: string) => Promise<unknown> }
		).getRunBacklogMetrics("run-1")
		const requestAssertion = expect(requestPromise).rejects.toBeInstanceOf(MetadataSidecarRequestTimeoutError)

		await vi.advanceTimersByTimeAsync(10_000)
		await requestAssertion
		await vi.runAllTicks()
		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				role: "reader",
				state: "failed",
				lastError: expect.stringContaining("getRunBacklogMetrics"),
			}),
		)

		await client.initialize()

		expect(testState.fork).toHaveBeenCalledTimes(2)
		expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM")
		expect(client.getDiagnosticsSnapshot()).toEqual(
			expect.objectContaining({
				role: "reader",
				state: "online",
				pid: 4343,
				lastError: null,
			}),
		)
		expect(testState.logger.log).toHaveBeenCalledWith(
			"basic",
			"MetadataSidecar",
			"metadata-sidecar-request-start",
			expect.objectContaining({
				operation: "init",
				sidecarRole: "reader",
				sidecarLabel: "metadata-reader-sidecar",
			}),
		)
	})

	it("allows reinitialization after a graceful dispose followed by a clean sidecar exit", async () => {
		const firstChild = new MockChildProcess()
		firstChild.send.mockImplementation((message: Record<string, unknown>) => {
			if (message.type === "init") {
				queueMicrotask(() => {
					firstChild.emit("message", {
						type: "ready",
						pid: firstChild.pid,
						memory: {
							rssMB: 100,
							heapUsedMB: 20,
							heapTotalMB: 40,
							externalMB: 5,
							arrayBuffersMB: 1,
						},
						cpu: {
							processPercent: 12,
						},
					})
				})
				return
			}
			if (message.type === "shutdown") {
				queueMicrotask(() => {
					firstChild.emit("message", {
						type: "shutdown-complete",
						requestId: message.requestId,
					})
				})
			}
		})

		const secondChild = new MockChildProcess()
		secondChild.pid = 4343
		testState.fork.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)
		const client = new MetadataSidecarClient(createResolvedMetadataPaths("/workspace"))

		await client.initialize()
		await client.dispose()
		firstChild.emit("exit", 0, null)
		await client.initialize()

		expect(testState.fork).toHaveBeenCalledTimes(2)
		expect(testState.logger.log).not.toHaveBeenCalledWith(
			"basic",
			"MetadataSidecar",
			"metadata-sidecar-request-timeout",
			expect.objectContaining({
				operation: "shutdown",
			}),
		)
	})
})
