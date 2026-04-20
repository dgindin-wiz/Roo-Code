import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createDiscoverySummary,
	createEmbedSummary,
	createParseSummary,
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

describe("CodeIndexEngineV2 progress cards", () => {
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

	it("emits split embedding and vector sync service snapshots during the fused embed drain", async () => {
		const engine = createEngine()

		await engine.start()

		const pipelineSnapshots = testState.mocks.stateManager.setPipelineSnapshot.mock.calls.map(
			([snapshot]) => snapshot,
		)
		const splitSnapshot = pipelineSnapshots.find((snapshot: any) => {
			if (!Array.isArray(snapshot?.services)) {
				return false
			}

			const embeddingService = snapshot.services.find((service: any) => service.id === "embedding")
			const vectorSyncService = snapshot.services.find((service: any) => service.id === "vector_sync")

			return (
				embeddingService &&
				vectorSyncService &&
				Array.isArray(vectorSyncService.metrics) &&
				vectorSyncService.metrics.length > 0
			)
		})

		expect(splitSnapshot).toBeDefined()
		expect(splitSnapshot.services.find((service: any) => service.id === "embedding")?.summary).toBeDefined()
		expect(splitSnapshot.services.find((service: any) => service.id === "vector_sync")?.metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "avgUpsert" }),
				expect.objectContaining({ key: "queuedUpserts" }),
			]),
		)
	})

	it("uses live embed progress for vector-sync cards and avoids stale planner wording while runnable work exists", async () => {
		let progressCallbackSeen = false
		testState.mocks.embedUpsertWorker.run.mockReset()
		let embedRunCount = 0
		testState.mocks.embedUpsertWorker.run.mockImplementation(async (_runId, _signal, onProgress) => {
			embedRunCount += 1
			if (embedRunCount === 1) {
				onProgress?.({
					upsertedChunks: 4,
					deletedChunks: 0,
					committedRevisions: 0,
					batchesCompleted: 1,
					workerPhase: "embedding",
					chunksPerSecond: 24,
					activeLaneCount: 0,
					inFlightChunkCount: 0,
				})
				progressCallbackSeen = true
				return createEmbedSummary({
					upsertedChunks: 4,
				})
			}
			return createEmbedSummary()
		})

		const engine = createEngine()
		await engine.start()

		expect(progressCallbackSeen).toBe(true)
		const liveSnapshot = [...testState.mocks.stateManager.setPipelineSnapshot.mock.calls]
			.map(([snapshot]) => snapshot)
			.reverse()
			.find((snapshot: any) => {
				const vectorSync = snapshot?.services?.find((service: any) => service.id === "vector_sync")
				return vectorSync?.progressCurrent === 4
			})

		expect(liveSnapshot).toBeDefined()
		const vectorSyncService = liveSnapshot.services.find((service: any) => service.id === "vector_sync")
		expect(vectorSyncService.progressCurrent).toBe(4)
		expect(vectorSyncService.detail).not.toContain("Planner is catching up")
		expect(vectorSyncService.detail).toContain("chunks synced")
	})

	it("uses final stat-hash totals for completed file-check cards on a fresh run", async () => {
		testState.mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockImplementation(
			async (_triggerType, _signal, onProgress) => {
				onProgress?.({ discoveredFiles: 199 })
				return createDiscoverySummary({ discoveredFiles: 199 })
			},
		)
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 199,
				skippedFiles: 0,
				changedFiles: 199,
				unchangedFiles: 0,
				oversizedFiles: 0,
				missingFiles: 0,
			}),
		)

		const engine = createEngine()
		await engine.start()

		const completedSnapshot = [...testState.mocks.stateManager.setPipelineSnapshot.mock.calls]
			.map(([snapshot]) => snapshot)
			.reverse()
			.find((snapshot: any) => snapshot?.overallState === "completed")

		expect(completedSnapshot).toBeDefined()
		expect(completedSnapshot.runMode).toBe("initial-discovery")
		const fileChecks = completedSnapshot.services.find((service: any) => service.id === "file_checks")
		expect(fileChecks).toEqual(
			expect.objectContaining({
				state: "completed",
				progressCurrent: 199,
				progressTotal: 199,
				progressPercent: 100,
				detail: "199 changed • 0 unchanged",
			}),
		)
		expect(fileChecks.metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "changed", value: "199" }),
				expect.objectContaining({ key: "unchanged", value: "0" }),
			]),
		)
	})

	it("persists workspace-scoped metadata-sidecar metrics into terminal run summaries", async () => {
		testState.mocks.logger.getTrackedProcessSummary.mockReturnValue({
			totalTrackedRssMB: 121,
			byGroup: {
				parseSidecars: { totalRssMB: 48 },
				embedSidecars: { totalRssMB: 36 },
				metadataSidecar: {
					totalRssMB: 123,
					totalCpuPercent: 7,
					totalHeapUsedMB: 55,
					totalExternalMB: 9,
					totalArrayBuffersMB: 3,
				},
			},
		} as any)

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.logger.getTrackedProcessSummary).toHaveBeenCalledWith("/workspace")
		expect(testState.mocks.metadataStore.writeRunSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				triggerType: "initial-discovery",
				metadataSidecarRssMB: 123,
				metadataSidecarCpuPercent: 7,
				metadataSidecarHeapUsedMB: 55,
				metadataSidecarExternalMB: 9,
				metadataSidecarArrayBuffersMB: 3,
			}),
		)
	})

	it("does not preserve transient pressure-only warnings in the final completed snapshot", async () => {
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockImplementationOnce(async (_runId, _signal, onProgress) => {
			onProgress?.({
				upsertedChunks: 3,
				deletedChunks: 0,
				committedRevisions: 1,
				pressureState: "hard",
				pressureReasons: ["rss", "external"],
				workerPhase: "embedding",
				activeLaneCount: 1,
				inFlightChunkCount: 1,
			})
			return createEmbedSummary({
				upsertedChunks: 3,
			})
		})

		const engine = createEngine()
		await engine.start()

		const completedSnapshot = [...testState.mocks.stateManager.setPipelineSnapshot.mock.calls]
			.map(([snapshot]) => snapshot)
			.reverse()
			.find((snapshot: any) => snapshot?.overallState === "completed")

		expect(completedSnapshot).toBeDefined()
		const embedding = completedSnapshot.services.find((service: any) => service.id === "embedding")
		const vectorSync = completedSnapshot.services.find((service: any) => service.id === "vector_sync")
		expect(embedding).toEqual(
			expect.objectContaining({
				state: "completed",
				health: "healthy",
				summary: "Embedding complete",
			}),
		)
		expect(vectorSync).toEqual(
			expect.objectContaining({
				state: "completed",
				health: "healthy",
				summary: "Vector sync complete",
			}),
		)
	})

	it("reports raw parsed chunk totals to the state manager so embedding estimates are not double-extrapolated", async () => {
		testState.mocks.statHashService.run.mockReset()
		testState.mocks.statHashService.run.mockResolvedValueOnce(
			createStatHashSummary({
				checkedFiles: 10,
				skippedFiles: 0,
				changedFiles: 10,
				unchangedFiles: 0,
			}),
		)
		testState.mocks.parseChunkService.run.mockReset()
		testState.mocks.parseChunkService.run
			.mockImplementationOnce(async (_runId, _signal, onProgress) => {
				onProgress?.({ parsedRevisions: 2, parsedChunks: 10 })
				return createParseSummary({
					attemptedRevisions: 2,
					parsedRevisions: 2,
					parsedChunks: 10,
					parsedRevisionIds: ["revision-1", "revision-2"],
				})
			})
			.mockResolvedValueOnce(
				createParseSummary({
					attemptedRevisions: 0,
					parsedRevisions: 0,
					parsedChunks: 0,
					parsedRevisionIds: [],
				}),
			)
		testState.mocks.embedUpsertWorker.run.mockReset()
		testState.mocks.embedUpsertWorker.run.mockImplementationOnce(async (_runId, _signal, onProgress) => {
			onProgress?.({
				upsertedChunks: 4,
				deletedChunks: 0,
				committedRevisions: 0,
				batchesCompleted: 1,
				chunksPerSecond: 2,
				averageBatchLatencyMs: 2000,
				lastBatchLatencyMs: 2000,
			})
			return createEmbedSummary({
				upsertedChunks: 4,
			})
		})

		const engine = createEngine()
		await engine.start()

		expect(testState.mocks.stateManager.startEmbedPhase).toHaveBeenCalledWith(
			10,
			true,
			10,
			0,
			expect.objectContaining({
				detailedStage: "planning_vectors",
				hasKnownVectorWork: true,
				hasStartedVectorSync: false,
			}),
		)
		expect(testState.mocks.stateManager.reportEmbedProgress).toHaveBeenCalledWith(
			4,
			10,
			2,
			true,
			expect.objectContaining({
				detailedStage: "embedding",
				hasKnownVectorWork: true,
				hasStartedVectorSync: true,
				isBackgroundReconcile: false,
			}),
		)
	})
})
