import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createDiscoverySummary,
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

describe("CodeIndexEngineV2 resume/status summary", () => {
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

	it("surfaces cumulative codebase progress and invested time when resuming prior work", async () => {
		testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockResolvedValueOnce(
			createDiscoverySummary({
				discoveredFiles: 100,
			}),
		)
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 100,
				skippedFiles: 0,
				changedFiles: 1,
				unchangedFiles: 99,
				oversizedFiles: 0,
				missingFiles: 0,
			}),
		)
		testState.mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(40)
		testState.mocks.metadataStore.countActiveChunksForWorkspace.mockResolvedValue(400)
		testState.mocks.metadataStore.listRunSummaries.mockResolvedValue([
			{
				runId: "stopped-run-1",
				state: "stopped",
				totalRunMs: 120_000,
			},
		])

		const engine = createEngine()
		await engine.start()

		const completedSnapshot = [...testState.mocks.stateManager.setPipelineSnapshot.mock.calls]
			.map(([snapshot]) => snapshot)
			.reverse()
			.find((snapshot: any) => snapshot?.overallState === "completed")

		expect(completedSnapshot).toBeDefined()
		expect(completedSnapshot.runMode).toBe("resume")
		expect(completedSnapshot.recoveredElapsedMs).toBe(120_000)
		expect(completedSnapshot.investedElapsedMs).toBeGreaterThanOrEqual(120_000)
		expect(completedSnapshot.codebaseProgress).toEqual(
			expect.objectContaining({
				indexedFiles: 41,
				totalFiles: 100,
				syncedChunks: 403,
				knownTotalChunks: 403,
			}),
		)
		expect(completedSnapshot.phaseTimingMs).toEqual(
			expect.objectContaining({
				discoveryMs: expect.any(Number),
				fileChecksMs: expect.any(Number),
				parseMs: expect.any(Number),
				planMs: expect.any(Number),
				embedSyncMs: expect.any(Number),
			}),
		)

		const fileChecksMetrics = completedSnapshot.services.find(
			(service: any) => service.id === "file_checks",
		)?.metrics
		const parseMetrics = completedSnapshot.services.find((service: any) => service.id === "parse")?.metrics
		const planMetrics = completedSnapshot.services.find((service: any) => service.id === "plan")?.metrics

		expect(fileChecksMetrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "changed", visibility: "primary" }),
				expect.objectContaining({ key: "oversized", visibility: "detail" }),
			]),
		)
		expect(parseMetrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "parsedChunks", visibility: "primary" }),
				expect.objectContaining({ key: "parserFailures", visibility: "detail" }),
			]),
		)
		expect(planMetrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "planned", visibility: "primary" }),
				expect.objectContaining({ key: "queuedUpserts", visibility: "detail" }),
			]),
		)
	})

	it("uses interrupted stale-run summaries for recovered timing during resume", async () => {
		testState.mocks.metadataStore.cleanupStaleRuns.mockResolvedValueOnce({
			staleRunIds: ["stale-run-1"],
			staleRunsMarkedFailed: 1,
			staleJobsAbandoned: 0,
			staleJobsPreservedForResume: 3,
			staleRevisionsFailed: 0,
			staleChunksAbandoned: 0,
			expiredRunsDeleted: 0,
			expiredJobsGarbageCollected: 0,
			expiredRevisionsGarbageCollected: 0,
			expiredChunksGarbageCollected: 0,
		})
		testState.mocks.metadataStore.getRunSummary.mockResolvedValue({
			runId: "stale-run-1",
			state: "stopped",
			totalRunMs: 480_000,
		})
		testState.mocks.metadataStore.adoptRetryableJobsFromStaleRuns.mockResolvedValueOnce(3)
		testState.mocks.metadataStore.countOutstandingResumedJobs.mockResolvedValueOnce(3).mockResolvedValue(0)
		testState.mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(40)
		testState.mocks.metadataStore.countActiveChunksForWorkspace.mockResolvedValue(400)
		testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockResolvedValueOnce(
			createDiscoverySummary({ discoveredFiles: 100 }),
		)
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 100,
				skippedFiles: 0,
				changedFiles: 1,
				unchangedFiles: 99,
			}),
		)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.metadataStore.getRunSummary).toHaveBeenCalledWith("stale-run-1")
		expect(testState.mocks.stateManager.startIndexingTimer).toHaveBeenCalled()
		expect(testState.mocks.stateManager.setRecoveryContext).toHaveBeenCalledWith(
			"stale_recovery",
			"reusable_revisions",
		)
		expect(testState.mocks.stateManager.startIndexingTimer.mock.invocationCallOrder[0]).toBeLessThan(
			testState.mocks.stateManager.setRecoveryContext.mock.invocationCallOrder[0],
		)

		const completedSnapshot = [...testState.mocks.stateManager.setPipelineSnapshot.mock.calls]
			.map(([snapshot]) => snapshot)
			.reverse()
			.find((snapshot: any) => snapshot?.overallState === "completed")

		expect(completedSnapshot).toBeDefined()
		expect(completedSnapshot.runMode).toBe("resume")
		expect(completedSnapshot.recoveredElapsedMs).toBe(480_000)
		expect(completedSnapshot.codebaseProgress).toEqual(
			expect.objectContaining({
				indexedFiles: 41,
				syncedChunks: 403,
			}),
		)
	})
})
