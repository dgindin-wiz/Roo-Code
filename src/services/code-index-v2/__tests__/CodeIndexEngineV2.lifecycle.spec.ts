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

	it("hydrates first-load standby status from reader metadata without starting indexing", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_204)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveryMs: 1_000,
				statHashMs: 2_000,
				parseChunkMs: 3_000,
				diffPlanningMs: 4_000,
				embedUpsertMs: 32_000,
				discoveredFiles: 199,
				filesScanned: 199,
				parsedChunks: 1_204,
				syncedChunks: 1_204,
				upsertedChunks: 1_204,
				deletedChunks: 0,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)

		expect(testState.mocks.metadataReadStore.initialize).toHaveBeenCalledTimes(1)
		expect(testState.mocks.metadataStore.initialize).not.toHaveBeenCalled()
		expect(testState.mocks.metadataStore.cleanupStaleRuns).not.toHaveBeenCalled()
		expect(testState.mocks.workspaceAdapter.initialize).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.setStandbyPipelineSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				overallState: "completed",
				runMode: "initial-discovery",
				elapsedMs: 42_000,
				codebaseProgress: expect.objectContaining({
					indexedFiles: 199,
					totalFiles: 199,
					fileTotalKind: "exact",
					syncedChunks: 1_204,
					knownTotalChunks: 1_204,
					chunkTotalKind: "exact",
				}),
			}),
			"V2 index ready across 199 files",
		)
		const standbySnapshot = testState.mocks.stateManager.setStandbyPipelineSnapshot.mock.calls[0][0]
		expect(standbySnapshot.runtime?.sidecars).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "metadata_reader",
					title: "Metadata reader",
					state: "standby",
					health: "healthy",
				}),
				expect.objectContaining({
					id: "metadata_writer",
					title: "Metadata writer",
					state: "standby",
				}),
			]),
		)
		expect(standbySnapshot.services.find((service: any) => service.id === "vector_sync")).toEqual(
			expect.objectContaining({
				state: "completed",
				health: "healthy",
				progressCurrent: 1_204,
				progressTotal: 1_204,
			}),
		)
		expect(testState.mocks.stateManager.setResilienceStats).toHaveBeenCalledWith(
			expect.objectContaining({
				warningDetails: [],
			}),
		)
	})

	it("hydrates completed standby with current active file totals instead of historical tombstoned totals", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(73_625)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_766_503)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(73_625)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "reconcile",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveredFiles: 73_913,
				filesScanned: 73_913,
				parsedChunks: 1_766_503,
				syncedChunks: 1_766_503,
				upsertedChunks: 1_766_503,
				deletedChunks: 288,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)

		expect(testState.mocks.stateManager.setStandbyPipelineSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				overallState: "completed",
				codebaseProgress: expect.objectContaining({
					indexedFiles: 73_625,
					totalFiles: 73_625,
					fileTotalKind: "exact",
					syncedChunks: 1_766_503,
					knownTotalChunks: 1_766_503,
					chunkTotalKind: "exact",
				}),
				summary: undefined,
			}),
			"V2 index ready across 73,625 files",
		)
	})

	it("hydrates newer incomplete operational runs as resumable standby state", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(73_686)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_752_602)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(73_912)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "old-complete-summary",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 2_000,
				totalRunMs: 1_000,
				discoveredFiles: 73_912,
				filesScanned: 73_912,
				syncedChunks: 1_700_000,
			},
		])
		testState.mocks.metadataReadStore.listRecentRunProgress.mockResolvedValue([
			{
				runId: "newer-stopped-run",
				state: "stopped",
				triggerType: "initial-discovery",
				startedAt: 10_000,
				completedAt: null,
				lastHeartbeatAt: 20_000,
				heartbeatOwner: null,
				blockingReason: null,
				errorMessage: "Marked stale after restart before the V2 run completed.",
				progress: {
					filesDiscovered: 73_912,
					filesHashed: 73_912,
					filesPlanned: 73_686,
					filesCommitted: 73_686,
					stagedChunks: 0,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
					queuedDeleteJobs: 0,
					runningDeleteJobs: 0,
				},
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)

		expect(testState.mocks.stateManager.setStandbyPipelineSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				overallState: "stopped",
				runMode: "resume",
				lastCompletedAt: undefined,
				summary: expect.objectContaining({
					headline: "Resume available",
					progressLabel: "73,686 / 73,912 files indexed • 1,752,602 chunks available",
				}),
				codebaseProgress: expect.objectContaining({
					indexedFiles: 73_686,
					totalFiles: 73_912,
					fileTotalKind: "exact",
					syncedChunks: 1_752_602,
					chunkTotalKind: "available",
					knownTotalChunks: undefined,
				}),
			}),
			"V2 index has resumable progress across 73,686 files",
		)
		const standbySnapshot = testState.mocks.stateManager.setStandbyPipelineSnapshot.mock.calls[0][0]
		expect(standbySnapshot.services.find((service: any) => service.id === "vector_sync")).toEqual(
			expect.objectContaining({
				state: "warning",
				progressCurrent: 1_752_602,
				progressTotal: undefined,
				indeterminate: true,
			}),
		)
		await vi.advanceTimersByTimeAsync(16_000)
		expect(testState.mocks.metadataStore.performMaintenance).not.toHaveBeenCalled()
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "skipped",
						detail: expect.stringContaining("Resumable indexing work"),
					}),
				],
			}),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"metadata-footprint-cleanup-deferred",
			expect.objectContaining({
				reason: "resumable-work",
				latestRunId: "newer-stopped-run",
			}),
		)
	})

	it("runs idle footprint cleanup as a bounded pass for completed standby state", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_204)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveredFiles: 199,
				filesScanned: 199,
				syncedChunks: 1_204,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		testState.mocks.metadataStore.performMaintenance.mockResolvedValueOnce({
			checkpointMode: "TRUNCATE",
			shrinkMemory: true,
			pruneFootprint: true,
			markFootprintCleanup: true,
			maxPruneBatches: 1,
			vacuumMode: "none",
			operationalDbBytes: 9_000_000,
			operationalWalBytes: 0,
			telemetryDbBytes: 4_000,
			telemetryWalBytes: 0,
			footprintPrune: {
				markerKey: "metadataFootprintCleanupV1",
				markerState: "completed",
				prunedJobs: 10_000,
				prunedChunks: 10,
				prunedChunkVariants: 30,
				prunedFtsRows: 10,
				prunedRevisions: 2,
				hasMore: false,
				prunedJobBatchLimit: 10_000,
				prunedChunkBatchLimit: 10_000,
				prunedRevisionBatchLimit: 10_000,
				freelistPagesBefore: 1,
				freelistPagesAfter: 2,
				pageSizeBytes: 4096,
				estimatedReclaimableBytesBefore: 4096,
				estimatedReclaimableBytesAfter: 8192,
			},
			memoryBefore: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
			memoryAfter: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
		})
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "scheduled",
					}),
				],
			}),
		)
		await vi.advanceTimersByTimeAsync(16_000)

		expect(testState.mocks.metadataStore.performMaintenance).toHaveBeenCalledWith(
			expect.objectContaining({
				pruneFootprint: true,
				markFootprintCleanup: true,
				maxPruneBatches: 1,
				vacuumMode: "none",
			}),
		)
		const taskStates = testState.mocks.stateManager.setPipelineRuntimeSnapshot.mock.calls
			.map((call) => call[0].tasks?.[0]?.state)
			.filter(Boolean)
		expect(taskStates).toEqual(expect.arrayContaining(["scheduled", "running", "complete"]))
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "complete",
						actions: [
							expect.objectContaining({
								id: "compact_metadata_db",
								enabled: true,
							}),
						],
						metrics: expect.arrayContaining([
							expect.objectContaining({ key: "jobs_pruned", value: "10000" }),
							expect.objectContaining({ key: "chunks_pruned", value: "10" }),
							expect.objectContaining({ key: "revisions_pruned", value: "2" }),
							expect.objectContaining({ key: "reclaimable", value: "8.0 KB" }),
						]),
					}),
				],
			}),
		)
	})

	it("compacts metadata DB only after footprint cleanup completes", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_204)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveredFiles: 199,
				filesScanned: 199,
				syncedChunks: 1_204,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		testState.mocks.metadataStore.performMaintenance
			.mockResolvedValueOnce({
				checkpointMode: "TRUNCATE",
				shrinkMemory: true,
				pruneFootprint: true,
				markFootprintCleanup: true,
				maxPruneBatches: 1,
				vacuumMode: "none",
				operationalDbBytes: 9_000_000,
				operationalWalBytes: 0,
				telemetryDbBytes: 4_000,
				telemetryWalBytes: 0,
				footprintPrune: {
					markerKey: "metadataFootprintCleanupV1",
					markerState: "completed",
					prunedJobs: 10_000,
					prunedChunks: 10,
					prunedChunkVariants: 30,
					prunedFtsRows: 10,
					prunedRevisions: 2,
					hasMore: false,
					prunedJobBatchLimit: 10_000,
					prunedChunkBatchLimit: 10_000,
					prunedRevisionBatchLimit: 10_000,
					freelistPagesBefore: 1,
					freelistPagesAfter: 2,
					pageSizeBytes: 4096,
					estimatedReclaimableBytesBefore: 4096,
					estimatedReclaimableBytesAfter: 8192,
				},
				memoryBefore: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
				memoryAfter: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
			})
			.mockResolvedValueOnce({
				checkpointMode: "TRUNCATE",
				shrinkMemory: true,
				pruneFootprint: false,
				vacuumMode: "full",
				operationalDbBytes: 4_000_000,
				operationalWalBytes: 0,
				telemetryDbBytes: 4_000,
				telemetryWalBytes: 0,
				compaction: {
					operationalDbBytesBefore: 9_000_000,
					operationalDbBytesAfter: 4_000_000,
					operationalWalBytesBefore: 0,
					operationalWalBytesAfter: 0,
					reclaimedBytes: 5_000_000,
					requiredFreeBytes: 9_900_000,
					availableFreeBytesBefore: 20_000_000,
					availableFreeBytesAfter: 25_000_000,
					elapsedMs: 12_000,
				},
				memoryBefore: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
				memoryAfter: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
			})
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)
		await vi.advanceTimersByTimeAsync(16_000)
		await expect(engine.compactMetadataDatabase()).resolves.toMatchObject({
			operationalDbBytesBefore: 9_000_000,
			operationalDbBytesAfter: 4_000_000,
			reclaimedBytes: 5_000_000,
		})

		expect(testState.mocks.metadataReadStore.dispose).toHaveBeenCalled()
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalled()
		expect(testState.mocks.metadataStore.performMaintenance).toHaveBeenLastCalledWith(
			expect.objectContaining({
				checkpointMode: "TRUNCATE",
				shrinkMemory: true,
				pruneFootprint: false,
				vacuumMode: "full",
			}),
		)
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "running",
						summary: "Compacting metadata DB file",
						phaseLabel: "Compacting DB file",
						progressUnit: "DB rewrite",
						indeterminate: true,
						etaLabel: "finish DB rewrite, then resume metadata reads",
					}),
				],
			}),
		)
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "complete",
						summary: "Metadata DB file compacted",
						phaseLabel: "Compaction complete",
						metrics: expect.arrayContaining([
							expect.objectContaining({ key: "db_before", value: "8.6 MB" }),
							expect.objectContaining({ key: "db_after", value: "3.8 MB" }),
							expect.objectContaining({ key: "db_reclaimed", value: "4.8 MB" }),
						]),
					}),
				],
			}),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"metadata-compaction-complete",
			expect.objectContaining({
				reclaimedBytes: 5_000_000,
				sidecarRole: "writer",
			}),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"metadata-compaction-writer-recycled",
			expect.objectContaining({
				sidecarRole: "writer",
			}),
		)
	})

	it("publishes partial metadata cleanup state when more bounded cleanup remains", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_204)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveredFiles: 199,
				filesScanned: 199,
				syncedChunks: 1_204,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		testState.mocks.metadataStore.performMaintenance.mockResolvedValueOnce({
			checkpointMode: "TRUNCATE",
			shrinkMemory: true,
			pruneFootprint: true,
			markFootprintCleanup: true,
			maxPruneBatches: 1,
			vacuumMode: "none",
			operationalDbBytes: 9_000_000,
			operationalWalBytes: 0,
			telemetryDbBytes: 4_000,
			telemetryWalBytes: 0,
			footprintPrune: {
				markerKey: "metadataFootprintCleanupV1",
				markerState: "partial",
				prunedJobs: 10_000,
				prunedChunks: 0,
				prunedChunkVariants: 0,
				prunedFtsRows: 0,
				prunedRevisions: 0,
				hasMore: true,
				freelistPagesBefore: 0,
				freelistPagesAfter: 10,
				pageSizeBytes: 4096,
				estimatedReclaimableBytesBefore: 0,
				estimatedReclaimableBytesAfter: 40_960,
			},
			memoryBefore: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
			memoryAfter: { rssMB: 1, heapUsedMB: 1, externalMB: 0, arrayBuffersMB: 0 },
		})
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)
		await vi.advanceTimersByTimeAsync(16_000)

		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "partial",
						summary: expect.stringContaining("will continue"),
					}),
				],
			}),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"metadata-footprint-cleanup-rescheduled",
			expect.objectContaining({
				reason: "more-prunable-data",
			}),
		)
	})

	it("resets a poisoned writer sidecar after idle footprint cleanup times out", async () => {
		const timeoutError = new Error("Metadata sidecar timed out during performMaintenance after 90006ms")
		timeoutError.name = "MetadataSidecarRequestTimeoutError"
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(1_204)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(199)
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "run-last",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 43_000,
				totalRunMs: 42_000,
				discoveredFiles: 199,
				filesScanned: 199,
				syncedChunks: 1_204,
			},
		])
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		testState.mocks.metadataStore.performMaintenance.mockRejectedValueOnce(timeoutError)
		testState.mocks.metadataStore.initialize.mockImplementation(async () => {
			if (testState.mocks.metadataStore.dispose.mock.calls.length === 0) {
				throw timeoutError
			}
		})
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(true)
		await vi.advanceTimersByTimeAsync(16_000)

		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				tasks: [
					expect.objectContaining({
						id: "metadata_cleanup",
						state: "failed",
						detail: expect.stringContaining("failed"),
						metrics: expect.arrayContaining([
							expect.objectContaining({
								key: "last_error",
								value: expect.stringContaining("performMaintenance"),
							}),
						]),
					}),
				],
			}),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"metadata-footprint-cleanup-resetting-writer",
			expect.objectContaining({
				reason: "sidecar-runtime-error",
			}),
		)
		await expect(engine.start()).resolves.toBeUndefined()
		expect(testState.mocks.stateManager.setSystemState).not.toHaveBeenCalledWith(
			"Error",
			expect.stringContaining("performMaintenance"),
		)
	})

	it("does not treat preserved telemetry-only history as current standby index state", async () => {
		testState.mocks.metadataReadStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(0)
		testState.mocks.metadataReadStore.countActiveChunksForWorkspace.mockResolvedValue(0)
		testState.mocks.metadataReadStore.countTrackedFilesForWorkspace.mockResolvedValue(0)
		testState.mocks.metadataReadStore.listRevisionWarnings.mockResolvedValue({ total: 0, items: [] })
		testState.mocks.metadataReadStore.listRunSummaries.mockResolvedValue([
			{
				runId: "old-run",
				workspaceId: "workspace-1",
				triggerType: "initial-discovery",
				state: "complete",
				startedAt: 1_000,
				completedAt: 2_000,
				totalRunMs: 1_000,
				discoveredFiles: 199,
				filesScanned: 199,
				syncedChunks: 1_204,
			},
		])
		const engine = createEngine()

		await expect(engine.hydrateStandbyStatus()).resolves.toBe(false)

		expect(testState.mocks.metadataReadStore.initialize).toHaveBeenCalledTimes(1)
		expect(testState.mocks.stateManager.setStandbyPipelineSnapshot).not.toHaveBeenCalled()
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
		expect(
			testState.mocks.stateManager.setPipelineSnapshot.mock.calls.some((call) =>
				call[0].runtime?.sidecars?.some(
					(sidecar: { id?: string; title?: string }) =>
						sidecar.id === "metadata_writer" && sidecar.title === "Metadata writer",
				),
			),
		).toBe(true)

		const status = await engine.getStatus()
		expect(status.message).toContain("V2 mapped 2 files")
		expect(status.message).toContain("synced 3 chunks")

		const searchResults = await engine.search("find value", 5)
		expect(testState.mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20, 0.4)
		expect(searchResults).toHaveLength(1)
		expect(testState.mocks.stateManager.setPipelineRuntimeSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				sidecars: expect.arrayContaining([
					expect.objectContaining({
						id: "metadata_reader",
						title: "Metadata reader",
					}),
				]),
			}),
		)

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(testState.mocks.discoveryService.runReconciliationDiscovery).toHaveBeenCalledTimes(1)
		expect(testState.mocks.reconciliationService.findMissingFiles).toHaveBeenCalledTimes(1)

		await engine.stop()
		expect(testState.mocks.watcherCoordinator.dispose).toHaveBeenCalledTimes(1)
		expect(testState.mocks.embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.vectorStore.recycleClient).toHaveBeenCalled()
		expect(testState.mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
	})

	it("does not turn a completed run into failed when terminal maintenance fails", async () => {
		testState.mocks.metadataStore.performMaintenance.mockRejectedValueOnce(new Error("maintenance timeout"))
		const engine = createEngine()

		await expect(engine.start()).resolves.toBeUndefined()

		expect(testState.mocks.metadataStore.performMaintenance).toHaveBeenCalledWith(
			expect.objectContaining({
				checkpointMode: "TRUNCATE",
				shrinkMemory: true,
				pruneFootprint: false,
				vacuumMode: "none",
			}),
		)
		expect(testState.mocks.metadataStore.writeRunSummary).toHaveBeenCalled()
		expect(testState.mocks.stateManager.reportComplete).toHaveBeenCalled()
		expect(testState.mocks.stateManager.setPipelineTerminalState).not.toHaveBeenCalledWith("failed")
		expect(testState.mocks.stateManager.setSystemState).not.toHaveBeenCalledWith(
			"Error",
			expect.stringContaining("maintenance timeout"),
		)
		expect(testState.mocks.logger.log).toHaveBeenCalledWith(
			"basic",
			"CodeIndexEngineV2",
			"terminal-metadata-maintenance-failed",
			expect.objectContaining({
				runId: "run-1",
				errorMessage: "maintenance timeout",
			}),
		)
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
				runType: "initial-discovery",
				discoveredFiles: 2,
				filesScanned: 2,
				filesChanged: 1,
			}),
		)
	})
})
