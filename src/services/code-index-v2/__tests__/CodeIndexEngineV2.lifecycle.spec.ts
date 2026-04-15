import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createDiscoverySummary,
	createEmbedSummary,
	createParseSummary,
	createPlannerSummary,
	createResolvedMetadataPaths,
	createStatHashSummary,
	type EngineHarness,
} from "./CodeIndexEngineV2.testUtils"

const testState = vi.hoisted(() => ({
	mocks: {} as EngineHarness,
}))

vi.mock("fs/promises", () => ({
	access: (...args: unknown[]) => testState.mocks.fsAccess(...args),
	stat: (...args: unknown[]) => testState.mocks.fsStat(...args),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "codeIndex.debugLogging") {
					return false
				}
				if (key === "codeIndex.embeddingBatchSize") {
					return 60
				}
				return defaultValue
			}),
		}),
	},
	Uri: {
		joinPath: vi.fn((...parts: Array<{ fsPath?: string } | string>) => ({
			fsPath: parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? ""))).join("/"),
		})),
	},
}))

vi.mock("../store/MetadataStore", () => ({
	MetadataStore: vi.fn(() => testState.mocks.metadataStore),
}))

vi.mock("../sidecar/MetadataSidecarClient", () => ({
	MetadataSidecarClient: vi.fn(() => testState.mocks.metadataStore),
}))

vi.mock("../store/MetadataPathResolver", () => ({
	resolveMetadataStorePaths: vi.fn((_context: unknown, workspacePath: string) =>
		createResolvedMetadataPaths(workspacePath),
	),
}))

vi.mock("../adapters/VsCodeWorkspaceAdapter", () => ({
	VsCodeWorkspaceAdapter: vi.fn(() => testState.mocks.workspaceAdapter),
}))

vi.mock("../adapters/CodeIndexParserAdapter", () => ({
	CodeIndexParserAdapter: vi.fn(),
}))

vi.mock("../discovery", () => ({
	DiscoveryService: vi.fn(() => testState.mocks.discoveryService),
}))

vi.mock("../pipeline", () => ({
	StatHashService: vi.fn(() => testState.mocks.statHashService),
	ParseChunkService: vi.fn(() => testState.mocks.parseChunkService),
	DiffPlanner: vi.fn(() => testState.mocks.diffPlanner),
	EmbedUpsertWorker: vi.fn(() => testState.mocks.embedUpsertWorker),
	SidecarParseExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
	SidecarEmbedUpsertExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("../reconciliation/ReconciliationService", () => ({
	ReconciliationService: vi.fn(() => testState.mocks.reconciliationService),
}))

vi.mock("../watcher", () => ({
	WatcherCoordinator: vi.fn(() => testState.mocks.watcherCoordinator),
}))

vi.mock("../../code-index/cache-manager", () => ({
	CacheManager: vi.fn(),
}))

vi.mock("../../code-index/service-factory", () => ({
	CodeIndexServiceFactory: vi.fn(() => testState.mocks.serviceFactory),
}))

vi.mock("../adapters/ExistingEmbedderAdapter", () => ({
	ExistingEmbedderAdapter: vi.fn(() => testState.mocks.embeddingAdapter),
}))

vi.mock("../adapters/QdrantRestVectorStoreAdapter", () => ({
	QdrantRestVectorStoreAdapter: vi.fn(() => testState.mocks.vectorStore),
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		configureDiagnosticsDirectory: (...args: unknown[]) =>
			(testState.mocks.logger.configureDiagnosticsDirectory as (...callArgs: unknown[]) => unknown)(...args),
		setContext: (...args: unknown[]) =>
			(testState.mocks.logger.setContext as (...callArgs: unknown[]) => unknown)(...args),
		log: (...args: unknown[]) => (testState.mocks.logger.log as (...callArgs: unknown[]) => unknown)(...args),
		getMemorySnapshot: (...args: unknown[]) =>
			(testState.mocks.logger.getMemorySnapshot as (...callArgs: unknown[]) => unknown)(...args),
		getCpuSnapshot: (...args: unknown[]) =>
			(testState.mocks.logger.getCpuSnapshot as (...callArgs: unknown[]) => unknown)(...args),
		getTrackedProcessSummary: (...args: unknown[]) =>
			(testState.mocks.logger.getTrackedProcessSummary as (...callArgs: unknown[]) => unknown)(...args),
		getBuildInfo: (...args: unknown[]) =>
			(testState.mocks.logger.getBuildInfo as (...callArgs: unknown[]) => unknown)(...args),
	},
}))

describe("CodeIndexEngineV2 lifecycle", () => {
	const createHarness = () => createBaseEngineHarness()

	const createEngine = () =>
		new CodeIndexEngineV2(
			testState.mocks.context,
			"/workspace",
			testState.mocks.configManager,
			testState.mocks.stateManager as any,
		)

	beforeEach(() => {
		vi.restoreAllMocks()
		vi.useFakeTimers()
		testState.mocks = createHarness()
		vi.spyOn(CodeIndexEngineV2.prototype as any, "waitForPipelineTick").mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("starts the full pipeline, enables watcher/reconciliation, supports search, and stops cleanly", async () => {
		const engine = createEngine()

		await engine.start()

		expect(testState.mocks.logger.configureDiagnosticsDirectory).toHaveBeenCalledWith(
			"/global-storage/code-index-v2/persistent/workspace-1/diagnostics",
			"/workspace",
		)
		expect(testState.mocks.metadataStore.initialize).toHaveBeenCalledTimes(1)
		expect(testState.mocks.metadataStore.cleanupStaleRuns).toHaveBeenCalledTimes(1)
		expect(testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [])
		expect(testState.mocks.workspaceAdapter.initialize).toHaveBeenCalledTimes(1)
		expect(testState.mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(testState.mocks.embeddingAdapter.createEmbeddings).toHaveBeenCalledWith(["preflight"], {
			isQuery: true,
			signal: expect.any(Object),
		})
		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(1)
		expect(testState.mocks.statHashService.run).toHaveBeenCalledWith(
			"run-1",
			expect.any(Object),
			undefined,
			expect.any(Object),
		)
		expect(testState.mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			1,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			expect.objectContaining({
				limit: 20,
				concurrency: 4,
			}),
		)
		expect(testState.mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.any(Object),
		)
		expect(testState.mocks.embedUpsertWorker.run).toHaveBeenCalledWith(
			"run-1",
			expect.any(Object),
			expect.any(Function),
		)
		expect(testState.mocks.watcherCoordinator.initialize).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.startIndexingTimer).toHaveBeenCalledTimes(1)

		const status = await engine.getStatus()
		expect(status.message).toContain("V2 mapped 2 files")
		expect(status.message).toContain("synced 3 chunks")

		const searchResults = await engine.search("find value", 5)
		expect(testState.mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20, 0.4)
		expect(searchResults).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(testState.mocks.discoveryService.runReconciliationDiscovery).toHaveBeenCalledTimes(1)
		expect(testState.mocks.reconciliationService.findMissingFiles).toHaveBeenCalledTimes(1)

		await engine.stop()
		expect(testState.mocks.watcherCoordinator.dispose).toHaveBeenCalledTimes(1)
		expect(testState.mocks.embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.vectorStore.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
	})

	it("fails fast on Qdrant preflight before workspace discovery begins", async () => {
		testState.mocks.vectorStore.initialize.mockRejectedValueOnce(new Error("Qdrant unavailable"))

		const engine = createEngine()

		await expect(engine.start()).rejects.toThrow("Qdrant unavailable")
		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(testState.mocks.embeddingAdapter.createEmbeddings).not.toHaveBeenCalled()
	})

	it("fails fast on embedder preflight before workspace discovery begins", async () => {
		testState.mocks.embeddingAdapter.createEmbeddings.mockRejectedValueOnce(new Error("Embedder unavailable"))

		const engine = createEngine()

		await expect(engine.start()).rejects.toThrow("Embedder unavailable")
		expect(testState.mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
	})

	it("times out Qdrant preflight with a specific error and does not wedge future starts", async () => {
		testState.mocks.vectorStore.initialize.mockImplementationOnce(() => new Promise<void>(() => undefined))

		const engine = createEngine()
		const startPromise = expect(engine.start()).rejects.toThrow("Qdrant verification timed out after 10s")

		await vi.advanceTimersByTimeAsync(10_000)
		await startPromise

		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Verifying indexing services: Qdrant",
			0,
			2,
			expect.any(Object),
		)
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			"Qdrant verification timed out after 10s",
		)

		await engine.start()
		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(1)
	})

	it("times out embedder preflight with a specific error", async () => {
		testState.mocks.embeddingAdapter.createEmbeddings.mockImplementationOnce(() => new Promise(() => undefined))

		const engine = createEngine()
		const startPromise = expect(engine.start()).rejects.toThrow(
			"Embedding provider verification timed out after 15s",
		)

		await vi.advanceTimersByTimeAsync(15_000)
		await startPromise

		expect(testState.mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Verifying indexing services: embedding provider",
			1,
			2,
			expect.any(Object),
		)
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			"Embedding provider verification timed out after 15s",
		)
	})

	it("returns watcher-driven targeted updates to standby after the pipeline completes", async () => {
		const engine = createEngine()

		await engine.start()
		testState.mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(2_335)

		await (engine as any).runTargetedUpdate(["/workspace/src/example.ts"], "watcher")

		expect(testState.mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/example.ts"],
			"watcher",
			undefined,
		)
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Standby",
			"V2 is current across 2,335 files",
		)
	})

	it("refreshAll reruns the full pipeline without clearing the index", async () => {
		const engine = createEngine()

		await engine.start()
		testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockImplementationOnce(
			async (_triggerType, _signal, onProgress) => {
				onProgress?.({ discoveredFiles: 3 })
				return createDiscoverySummary({ runId: "run-refresh", discoveredFiles: 3 })
			},
		)
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				runId: "run-refresh",
				checkedFiles: 3,
				skippedFiles: 0,
				changedFiles: 1,
				unchangedFiles: 2,
				oversizedFiles: 1,
				oversizedDetails: [
					{
						relativePath: "src/huge.ts",
						sizeBytes: 2_000_000,
						recommendation: "review_manually",
						reason: "Large source file",
					},
				],
			}),
		)
		testState.mocks.parseChunkService.run.mockResolvedValueOnce(
			createParseSummary({
				runId: "run-refresh",
				parsedChunks: 2,
				parsedRevisionIds: ["revision-refresh"],
			}),
		)
		testState.mocks.diffPlanner.run.mockResolvedValueOnce(
			createPlannerSummary({
				runId: "run-refresh",
				upsertJobs: 2,
			}),
		)
		testState.mocks.embedUpsertWorker.run.mockResolvedValueOnce(
			createEmbedSummary({
				runId: "run-refresh",
				upsertedChunks: 2,
			}),
		)

		await engine.refreshAll()

		expect(testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(2)
		expect(testState.mocks.vectorStore.deleteCollection).not.toHaveBeenCalled()
		expect(testState.mocks.metadataStore.clearStorage).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.setOversizedDetails).toHaveBeenCalledWith([
			expect.objectContaining({
				relativePath: "src/huge.ts",
			}),
		])
	})

	it("aborts an active run on stop and settles in standby instead of error", async () => {
		testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockResolvedValueOnce(
			createDiscoverySummary(),
		)
		testState.mocks.statHashService.run.mockImplementation(
			async (_runId, signal) =>
				new Promise((resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Stat/hash stage aborted"))
						return
					}
					signal?.addEventListener("abort", () => reject(new Error("Stat/hash stage aborted")), {
						once: true,
					})
				}),
		)

		const engine = createEngine()
		const startPromise = engine.start()
		await vi.waitFor(() => {
			expect(testState.mocks.statHashService.run).toHaveBeenCalledTimes(1)
		})

		await expect(engine.stop()).resolves.toBeUndefined()
		await expect(startPromise).resolves.toBeUndefined()

		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith("Stopping", "Stopping indexing...")
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith("Standby", "Indexing stopped.")
		expect(testState.mocks.metadataStore.markRunStopped).toHaveBeenCalledWith("run-1", "Stopped by user.")
	})

	it("logs a compact indexing performance summary for successful runs", async () => {
		const engine = createEngine()

		await engine.start()

		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"index-performance-summary",
			expect.objectContaining({
				runType: "start",
				discoveredFiles: 2,
				filesScanned: 2,
				filesChanged: 1,
			}),
		)
	})
})
