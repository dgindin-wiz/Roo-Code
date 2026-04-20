import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import {
	createBaseEngineHarness,
	createEmbedSummary,
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
	MetadataSidecarClient: vi.fn((_paths: unknown, options?: { role?: string }) =>
		options?.role === "reader" ? testState.mocks.metadataReadStore : testState.mocks.metadataStore,
	),
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

describe("CodeIndexEngineV2 scheduler", () => {
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

	it("uses conservative scheduler defaults for very large workspaces", async () => {
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 65_000,
				skippedFiles: 10,
				changedFiles: 1,
				unchangedFiles: 64_989,
			}),
		)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			1,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			expect.objectContaining({
				limit: 10,
				concurrency: 2,
			}),
		)
		expect(testState.mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 25,
				maxJobs: 800,
			}),
			expect.any(Object),
		)
	})

	it("uses hashing_initial and explicit oversized counts on a fresh run without a baseline", async () => {
		testState.mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(0)
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockImplementation(async (_runId, _signal, _relativePaths, options) => {
			options?.onProgress?.({
				checkedFiles: 12,
				changedFiles: 12,
				skippedFiles: 2,
				unchangedFiles: 0,
				oversizedFiles: 2,
				missingFiles: 0,
			})
			return createStatHashSummary({
				checkedFiles: 12,
				changedFiles: 12,
				skippedFiles: 2,
				unchangedFiles: 0,
				oversizedFiles: 2,
			})
		})

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Preparing files for indexing",
			0,
			2,
			expect.objectContaining({
				detailedStage: "hashing_initial",
			}),
		)
		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			expect.stringContaining("Preparing files for indexing... 12 checked, 12 changed, 2 oversized"),
			12,
			12,
			expect.objectContaining({
				detailedStage: "hashing_initial",
				changedFiles: 12,
				unchangedFiles: 0,
				oversizedFiles: 2,
				missingFiles: 0,
			}),
		)
	})

	it("uses comparing_signatures only when a comparable baseline exists", async () => {
		testState.mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(3)
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockImplementation(async (_runId, _signal, _relativePaths, options) => {
			options?.onProgress?.({
				checkedFiles: 15,
				changedFiles: 12,
				skippedFiles: 3,
				unchangedFiles: 3,
				oversizedFiles: 0,
				missingFiles: 0,
			})
			return createStatHashSummary({
				checkedFiles: 15,
				changedFiles: 12,
				skippedFiles: 3,
				unchangedFiles: 3,
			})
		})

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Comparing file signatures",
			0,
			2,
			expect.objectContaining({
				detailedStage: "comparing_signatures",
			}),
		)
		expect(testState.mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			expect.stringContaining("Comparing file signatures... 15 checked, 12 changed, 3 unchanged"),
			15,
			15,
			expect.objectContaining({
				detailedStage: "comparing_signatures",
				changedFiles: 12,
				unchangedFiles: 3,
				oversizedFiles: 0,
				missingFiles: 0,
			}),
		)
	})

	it("keeps refilling the planner until runnable upsert work exists when embed lanes are underfed", async () => {
		const backlog = zeroBacklog({
			parsedRevisions: 3,
			stagedChunks: 900,
		})

		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 65_000,
				skippedFiles: 0,
				changedFiles: 1,
				unchangedFiles: 0,
			}),
		)
		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.parseChunkService.run
			.mockResolvedValueOnce(
				createParseSummary({
					attemptedRevisions: 0,
					parsedRevisions: 0,
					parsedChunks: 0,
					parsedRevisionIds: [],
				}),
			)
			.mockResolvedValueOnce(
				createParseSummary({
					attemptedRevisions: 0,
					parsedRevisions: 0,
					parsedChunks: 0,
					parsedRevisionIds: [],
				}),
			)
		testState.mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		testState.mocks.diffPlanner.run.mockReset()
		testState.mocks.diffPlanner.run
			.mockImplementationOnce(async () => {
				backlog.parsedRevisions = 2
				backlog.stagedChunks = 850
				backlog.queuedUpsertJobs = 0
				backlog.runningUpsertJobs = 0
				return createPlannerSummary({
					plannedRevisions: 1,
					upsertJobs: 0,
				})
			})
			.mockImplementationOnce(async () => {
				backlog.parsedRevisions = 1
				backlog.stagedChunks = 600
				backlog.queuedUpsertJobs = 350
				return createPlannerSummary({
					plannedRevisions: 1,
					upsertJobs: 350,
				})
			})
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			backlog.runningUpsertJobs = 0
			backlog.stagedChunks = 0
			return createEmbedSummary({
				upsertedChunks: 350,
			})
		})

		const logSpy = vi.spyOn(IndexDebugLoggerV2, "log").mockImplementation(() => {})
		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.diffPlanner.run).toHaveBeenCalledTimes(2)
		const refillLog = logSpy.mock.calls.find(([, , message]) => message === "planner-refill-burst-complete")
		expect(refillLog?.[3]).toEqual(
			expect.objectContaining({
				runId: "run-1",
				plannerRefillPasses: 2,
				runnableEmbedQueueDepth: 350,
				parsedChunkBacklog: 600,
				totalVectorBacklog: 950,
			}),
		)
	})

	it("does not throttle parse solely because queued upsert jobs are high", () => {
		const engine = createEngine()
		const profile = (engine as any).getSchedulerProfile(65_000)

		expect(
			(engine as any).shouldThrottleParse(
				{
					...zeroBacklog(),
					stagedChunkBytes: 0,
					queuedUpsertJobs: 1_200,
					runningUpsertJobs: 0,
				},
				profile,
				{ embedPhaseStarted: true },
			),
		).toBe(false)
		expect(
			(engine as any).shouldResumeParse(
				{
					...zeroBacklog(),
					stagedChunkBytes: 0,
					queuedUpsertJobs: 1_200,
					runningUpsertJobs: 0,
				},
				profile,
				null,
			),
		).toBe(true)
	})
})
