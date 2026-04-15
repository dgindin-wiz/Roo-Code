import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createChunkRecord,
	createDiscoverySummary,
	createEmbedSummary,
	createFileRecord,
	createParseSummary,
	createPlannerSummary,
	createResolvedMetadataPaths,
	createStatHashSummary,
	zeroBacklog,
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

describe("CodeIndexEngineV2 maintenance and recovery", () => {
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

	it("retires stale tracked files that no longer match current candidate rules before stat-hash", async () => {
		testState.mocks.metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValueOnce([
			createFileRecord({
				fileId: "generated-1",
				relativePath: "src/webview-ui/build/assets/index.js",
				normalizedPath: "/workspace/src/webview-ui/build/assets/index.js",
				lastSeenSize: 1024,
				activeRevisionId: "revision-generated",
				latestRevisionId: "revision-generated",
				latestRevisionContentHash: "hash-generated",
				latestRevisionFastFingerprint: "fp-generated",
			}),
			createFileRecord({
				fileId: "source-1",
				relativePath: "src/app.ts",
				normalizedPath: "/workspace/src/app.ts",
				activeRevisionId: "revision-source",
				latestRevisionId: "revision-source",
				latestRevisionContentHash: "hash-source",
				latestRevisionFastFingerprint: "fp-source",
			}),
		])
		testState.mocks.workspaceAdapter.isCandidateFile.mockImplementation(
			(filePath: string) => !filePath.includes("/build/"),
		)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.metadataStore.excludeFilesFromIndexing).toHaveBeenCalledWith(["generated-1"])
		expect(testState.mocks.statHashService.run).toHaveBeenCalledTimes(1)
	})

	it("retires newly oversized files immediately during targeted updates", async () => {
		const engine = createEngine()

		await engine.start()
		testState.mocks.discoveryService.runTargetedDiscovery.mockClear()
		testState.mocks.metadataStore.beginRun.mockResolvedValueOnce("oversized-run")
		testState.mocks.metadataStore.getFileRecordByWorkspacePathOptional.mockResolvedValueOnce({
			fileId: "file-oversized",
			relativePath: "src/huge.pb.go",
		})
		testState.mocks.metadataStore.getActiveRevisionForFile.mockResolvedValueOnce({
			revisionId: "active-revision",
		})
		testState.mocks.metadataStore.getChunksForRevision.mockResolvedValueOnce([
			{ chunkId: "chunk-1" },
			{ chunkId: "chunk-2" },
		])
		testState.mocks.workspaceAdapter.statFile.mockResolvedValueOnce({
			path: "/workspace/src/huge.pb.go",
			mtimeMs: 2,
			size: 1_048_577,
		})

		await (engine as any).runTargetedUpdate(["/workspace/src/huge.pb.go"], "watcher")

		expect(testState.mocks.discoveryService.runTargetedDiscovery).not.toHaveBeenCalled()
		expect(testState.mocks.metadataStore.beginRun).toHaveBeenCalledWith("oversized-watcher")
		expect(testState.mocks.metadataStore.enqueueJobs).toHaveBeenCalledWith([
			{
				workspaceId: "workspace-1",
				runId: "oversized-run",
				jobType: "delete",
				entityId: "chunk-1",
			},
			{
				workspaceId: "workspace-1",
				runId: "oversized-run",
				jobType: "delete",
				entityId: "chunk-2",
			},
		])
		expect(testState.mocks.metadataStore.markFileTombstoned).toHaveBeenCalledWith("file-oversized", true)
	})

	it("clears live V2 state instead of leaving watcher status behind", async () => {
		const engine = createEngine()

		;(engine as any)._watcherCoordinator = testState.mocks.watcherCoordinator
		;(engine as any)._reconciliationTimer = setInterval(() => undefined, 60_000)
		;(engine as any)._embeddingAdapter = testState.mocks.embeddingAdapter
		;(engine as any)._vectorStore = testState.mocks.vectorStore
		;(engine as any)._started = true

		await engine.clear()

		expect(testState.mocks.watcherCoordinator.dispose).toHaveBeenCalled()
		expect(testState.mocks.vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
		expect(testState.mocks.vectorStore.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.metadataStore.clearStorage).toHaveBeenCalledWith({ includeTelemetry: false })
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.resetIndexingState).toHaveBeenCalledWith("Index data cleared successfully.")
		expect((engine as any)._started).toBe(false)
		expect((engine as any)._watcherCoordinator).toBeUndefined()
		expect((engine as any)._indexEmbeddingAdapter).toBeUndefined()
		expect((engine as any)._indexVectorStore).toBeUndefined()
		expect((engine as any)._searchEmbeddingAdapter).toBeUndefined()
		expect((engine as any)._searchVectorStore).toBeUndefined()
		expect((engine as any)._staleRunIdsToResume).toEqual([])
		expect((engine as any)._resumedRetryJobsCount).toBe(0)
		expect((engine as any)._resumedPendingJobsCount).toBe(0)
		expect((engine as any)._lastCpuSample).toBeUndefined()
	})

	it("clears persistent and telemetry-backed V2 state on full database clears", async () => {
		const engine = createEngine()

		;(engine as any)._watcherCoordinator = testState.mocks.watcherCoordinator
		;(engine as any)._reconciliationTimer = setInterval(() => undefined, 60_000)
		;(engine as any)._embeddingAdapter = testState.mocks.embeddingAdapter
		;(engine as any)._vectorStore = testState.mocks.vectorStore
		;(engine as any)._started = true

		await engine.clearDatabase()

		expect(testState.mocks.watcherCoordinator.dispose).toHaveBeenCalled()
		expect(testState.mocks.vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
		expect(testState.mocks.metadataStore.clearStorage).toHaveBeenCalledWith({ includeTelemetry: true })
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.resetIndexingState).toHaveBeenCalledWith(
			"Index database cleared successfully.",
		)
		expect((engine as any)._started).toBe(false)
	})

	it("plans and syncs preserved parsed revisions reused from a previous run", async () => {
		const backlog = zeroBacklog({
			parsedRevisions: 1,
			stagedChunks: 2,
		})

		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 5,
				skippedFiles: 0,
				changedFiles: 1,
				unchangedFiles: 0,
				reusedParsedRevisionIds: ["revision-reused"],
			}),
		)
		testState.mocks.metadataStore.getChunksForRevision.mockResolvedValueOnce([
			{ chunkId: "chunk-reused", revisionId: "revision-reused" },
			{ chunkId: "chunk-reused-2", revisionId: "revision-reused" },
		])
		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.parseChunkService.run.mockResolvedValueOnce(
			createParseSummary({
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
			}),
		)
		testState.mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		testState.mocks.diffPlanner.run.mockReset()
		testState.mocks.diffPlanner.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 1
			backlog.stagedChunks = 0
			backlog.queuedUpsertJobs = 2

			return createPlannerSummary({
				upsertJobs: 2,
			})
		})
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockImplementation(async () => {
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			return createEmbedSummary({
				upsertedChunks: 2,
			})
		})

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.anything(),
		)
		expect(testState.mocks.embedUpsertWorker.run).toHaveBeenCalled()
	})

	it("adopts retryable queued jobs from stale runs into the new run on startup", async () => {
		testState.mocks.metadataStore.cleanupStaleRuns.mockResolvedValueOnce({
			staleRunIds: ["stale-run-1", "stale-run-2"],
			staleRunsMarkedFailed: 2,
			staleJobsAbandoned: 0,
			staleJobsPreservedForResume: 4,
			staleRevisionsFailed: 3,
			staleChunksAbandoned: 5,
			expiredRunsDeleted: 0,
			expiredJobsGarbageCollected: 0,
			expiredRevisionsGarbageCollected: 0,
			expiredChunksGarbageCollected: 0,
		})
		testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns.mockResolvedValueOnce(4)
		testState.mocks.metadataStore.countOutstandingResumedJobs.mockResolvedValueOnce(4).mockResolvedValue(0)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [
			"stale-run-1",
			"stale-run-2",
		])
		const status = await engine.getStatus()
		expect(status.message).toContain("V2 mapped 2 files")
		expect(status.message).not.toContain("queued retry jobs")
	})

	it("does not enter embedding for a no-op background reconcile on an already indexed workspace", async () => {
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run
			.mockResolvedValueOnce(
				createStatHashSummary({
					checkedFiles: 2,
					skippedFiles: 1,
					changedFiles: 1,
				}),
			)
			.mockResolvedValueOnce(
				createStatHashSummary({
					runId: "run-reconcile",
					checkedFiles: 2,
					skippedFiles: 2,
					changedFiles: 0,
					unchangedFiles: 0,
				}),
			)
		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.parseChunkService.run.mockResolvedValueOnce(createParseSummary()).mockResolvedValueOnce(
			createParseSummary({
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
			}),
		)
		testState.mocks.embedUpsertWorker.run.mockClear()

		const engine = createEngine()
		await engine.start()
		testState.mocks.stateManager.startEmbedPhase.mockClear()
		testState.mocks.stateManager.reportEmbedProgress.mockClear()
		testState.mocks.stateManager.reportCustomProgress.mockClear()

		await (engine as any).runReconciliation()

		expect(testState.mocks.discoveryService.runReconciliationDiscovery).toHaveBeenCalledTimes(1)
		expect(testState.mocks.embedUpsertWorker.run).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.startEmbedPhase).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.reportEmbedProgress).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Reconciling local state with the workspace",
			0,
			1,
			expect.objectContaining({
				detailedStage: "reconciling",
				isBackgroundReconcile: true,
			}),
		)
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Standby",
			"V2 is current across 3 files",
		)
		expect(testState.mocks.metadataStore.writeRunSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-reconcile",
				triggerType: "reconcile",
				state: "complete",
				filesChanged: 0,
			}),
		)
	})

	it("resumes queued retry jobs from prior failed runs even without freshly detected stale runs", async () => {
		testState.mocks.metadataStore.cleanupStaleRuns.mockResolvedValueOnce({
			staleRunIds: [],
			staleRunsMarkedFailed: 0,
			staleJobsAbandoned: 0,
			staleJobsPreservedForResume: 0,
			staleRevisionsFailed: 0,
			staleChunksAbandoned: 0,
			expiredRunsDeleted: 0,
			expiredJobsGarbageCollected: 0,
			expiredRevisionsGarbageCollected: 0,
			expiredChunksGarbageCollected: 0,
		})
		testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns.mockResolvedValueOnce(3)
		testState.mocks.metadataStore.countOutstandingResumedJobs.mockResolvedValueOnce(3).mockResolvedValue(0)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [])
		expect(testState.mocks.stateManager.setResilienceStats).toHaveBeenCalledWith(
			expect.objectContaining({
				resumedRetryJobs: 3,
				resumedPendingJobs: 3,
			}),
		)
		const status = await engine.getStatus()
		expect(status.message).not.toContain("queued retry jobs")
	})

	it("passes warning sort through when fetching warning details", async () => {
		const engine = createEngine()
		await engine.getWarningDetails(10, 5, "failed", "path")

		expect(testState.mocks.metadataStore.listRevisionWarnings).toHaveBeenCalledWith(
			"workspace-1",
			5,
			10,
			"failed",
			"path",
		)
	})

	it("retries only warning-state files through a targeted update", async () => {
		const engine = createEngine()
		await engine.start()
		testState.mocks.discoveryService.runTargetedDiscovery.mockClear()
		testState.mocks.metadataStore.listWarningRelativePaths.mockResolvedValueOnce([
			"src/problematic/parser.ts",
			"src/problematic/embed.ts",
		])
		testState.mocks.discoveryService.runTargetedDiscovery.mockResolvedValueOnce(
			createDiscoverySummary({
				runId: "run-targeted",
				discoveredFiles: 2,
			}),
		)

		const result = await engine.retryWarningFiles("all")

		expect(result).toEqual({ retriedFiles: 2 })
		expect(testState.mocks.metadataStore.listWarningRelativePaths).toHaveBeenCalledWith("workspace-1", "all")
		expect(testState.mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/problematic/parser.ts", "/workspace/src/problematic/embed.ts"],
			"manual",
			undefined,
		)
	})

	it("retries only the explicitly requested warning file when relative paths are provided", async () => {
		const engine = createEngine()
		await engine.start()
		testState.mocks.discoveryService.runTargetedDiscovery.mockClear()
		testState.mocks.metadataStore.listWarningRelativePaths.mockClear()
		testState.mocks.discoveryService.runTargetedDiscovery.mockResolvedValueOnce(
			createDiscoverySummary({
				runId: "run-targeted",
				discoveredFiles: 1,
			}),
		)

		const result = await engine.retryWarningFiles("failed", ["src/problematic/embed.ts"])

		expect(result).toEqual({ retriedFiles: 1 })
		expect(testState.mocks.metadataStore.listWarningRelativePaths).not.toHaveBeenCalled()
		expect(testState.mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/problematic/embed.ts"],
			"manual",
			undefined,
		)
	})
})
