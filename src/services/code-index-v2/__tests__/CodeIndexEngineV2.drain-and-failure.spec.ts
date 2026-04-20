import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createDeferred,
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

describe("CodeIndexEngineV2 drain and failure handling", () => {
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

	it("fails fast when a metadata-sidecar timeout interrupts backlog refresh", async () => {
		const metadataTimeout = new Error(
			"Metadata sidecar timed out during getRunBacklogMetrics after 5000ms (timeout 5000ms).",
		)
		metadataTimeout.name = "MetadataSidecarRequestTimeoutError"
		testState.mocks.metadataStore.getRunBacklogMetrics.mockReset()
		testState.mocks.metadataStore.getRunBacklogMetrics.mockRejectedValueOnce(metadataTimeout)

		const engine = createEngine()

		await expect(engine.start()).rejects.toBe(metadataTimeout)
		expect(testState.mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			expect.stringContaining("getRunBacklogMetrics"),
		)
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalled()
	})

	it("does not mark a run complete until pending vector work fully drains", async () => {
		const backlog = zeroBacklog()
		const embedDrain = createDeferred<{
			runId: string
			upsertedChunks: number
			deletedChunks: number
			committedRevisions: number
		}>()
		const embedStarted = createDeferred<void>()
		let parseBatch = 0

		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.diffPlanner.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		testState.mocks.parseChunkService.run.mockImplementation(async () => {
			parseBatch += 1
			if (parseBatch === 1) {
				backlog.parsedRevisions = 1
				backlog.stagedChunks = 3
				return createParseSummary()
			}

			return createParseSummary({
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
			})
		})
		testState.mocks.diffPlanner.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 1
			backlog.stagedChunks = 0
			backlog.queuedUpsertJobs = 3

			return createPlannerSummary()
		})
		testState.mocks.embedUpsertWorker.run.mockImplementation(async () => {
			embedStarted.resolve()
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			backlog.runningUpsertJobs = 3
			const summary = await embedDrain.promise
			backlog.runningUpsertJobs = 0
			return summary
		})

		const engine = createEngine()
		const startPromise = engine.start()

		await embedStarted.promise
		expect(testState.mocks.metadataStore.markRunComplete).not.toHaveBeenCalled()

		embedDrain.resolve(createEmbedSummary())
		await startPromise

		expect(testState.mocks.metadataStore.markRunComplete).toHaveBeenCalledTimes(1)
		expect(testState.mocks.metadataStore.markRunComplete).toHaveBeenCalledWith("run-1")
	})

	it("continues parsing after an all-failure batch instead of treating it as completion", async () => {
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 40,
				skippedFiles: 0,
				changedFiles: 40,
				unchangedFiles: 0,
			}),
		)
		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.parseChunkService.run
			.mockResolvedValueOnce(
				createParseSummary({
					attemptedRevisions: 20,
					parsedRevisions: 0,
					parsedChunks: 0,
					parsedRevisionIds: [],
					terminalFailedRevisions: 20,
				}),
			)
			.mockResolvedValueOnce(
				createParseSummary({
					attemptedRevisions: 1,
					parsedRevisions: 1,
					parsedChunks: 2,
					parsedRevisionIds: ["revision-recovered"],
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
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockResolvedValue(
			createEmbedSummary({
				upsertedChunks: 2,
			}),
		)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.parseChunkService.run).toHaveBeenCalledTimes(3)
		expect(testState.mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.any(Object),
		)
		expect(testState.mocks.embedUpsertWorker.run).toHaveBeenCalled()
	})
})
