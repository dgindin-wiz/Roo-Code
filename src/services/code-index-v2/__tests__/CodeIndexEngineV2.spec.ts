import { beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import { ExistingEmbedderAdapter } from "../adapters/ExistingEmbedderAdapter"
import { QdrantRestVectorStoreAdapter } from "../adapters/QdrantRestVectorStoreAdapter"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"

const createDeferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})

	return { promise, resolve, reject }
}

const mocks = vi.hoisted(() => {
	const fsAccess = vi.fn().mockResolvedValue(undefined)

	const metadataStore = {
		initialize: vi.fn().mockResolvedValue(undefined),
		cleanupStaleRuns: vi.fn().mockResolvedValue({
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
		}),
		adoptRetryableJobsFromStaleRuns: vi.fn().mockResolvedValue(0),
		countOutstandingResumedJobs: vi.fn().mockResolvedValue(0),
		dispose: vi.fn().mockResolvedValue(undefined),
		countTrackedFilesForWorkspace: vi.fn().mockResolvedValue(10),
		countActiveIndexedFilesForWorkspace: vi.fn().mockResolvedValue(3),
		countActiveChunksForWorkspace: vi.fn().mockResolvedValue(24_439),
		getDiscoveredFilesForWorkspace: vi.fn().mockResolvedValue([]),
		getDiscoveredFilesByRelativePaths: vi.fn().mockResolvedValue([]),
		listRevisionWarnings: vi.fn().mockResolvedValue({ total: 0, items: [] }),
		listWarningRelativePaths: vi.fn().mockResolvedValue([]),
		beginRun: vi.fn().mockResolvedValue("delete-run"),
		getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		getFileRecordByWorkspacePathOptional: vi.fn().mockResolvedValue(undefined),
		getActiveRevisionForFile: vi.fn().mockResolvedValue(undefined),
		getChunksForRevision: vi.fn().mockResolvedValue([]),
		getActiveChunksByFingerprints: vi.fn().mockResolvedValue([]),
		getActiveChunksByRelativePaths: vi.fn().mockResolvedValue([]),
		runPlannerSlice: vi.fn(),
		getRunBacklogMetrics: vi.fn(),
		searchActiveChunksLexically: vi.fn().mockResolvedValue([]),
		searchActiveChunksLexicallyWithStatus: vi.fn().mockResolvedValue({
			results: [],
			status: "completed",
			mode: "fts_only",
			timingsMs: {
				ftsMs: 0,
				fallbackMs: 0,
				totalMs: 0,
			},
		}),
		enqueueJobs: vi.fn().mockResolvedValue(undefined),
		markFileTombstoned: vi.fn().mockResolvedValue(undefined),
		excludeFilesFromIndexing: vi.fn().mockResolvedValue(undefined),
		markRunComplete: vi.fn().mockResolvedValue(undefined),
		markRunFailed: vi.fn().mockResolvedValue(undefined),
		markRunStopped: vi.fn().mockResolvedValue(undefined),
		heartbeatRun: vi.fn().mockResolvedValue(undefined),
		appendRunSample: vi.fn().mockResolvedValue(undefined),
		checkpointWal: vi.fn().mockResolvedValue(undefined),
		countChunksForRevisions: vi.fn().mockResolvedValue(0),
		getRunProgressRecord: vi.fn().mockResolvedValue(undefined),
		writeRunSummary: vi.fn().mockResolvedValue(undefined),
		clearStorage: vi.fn().mockResolvedValue(undefined),
		getDiagnosticsDirectoryPath: vi
			.fn()
			.mockReturnValue("/global-storage/code-index-v2/persistent/workspace-1/diagnostics"),
	}

	const workspaceAdapter = {
		initialize: vi.fn().mockResolvedValue(undefined),
		getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
		isCandidateFile: vi.fn().mockReturnValue(true),
		statFile: vi.fn().mockResolvedValue({
			path: "/workspace/src/example.ts",
			mtimeMs: 1,
			size: 128,
		}),
	}

	const discoveryService = {
		runInitialDiscovery: vi.fn().mockResolvedValue({
			runId: "run-1",
			discoveredFiles: 2,
			isPartial: false,
		}),
		runWorkspaceDiscoveryWithProgress: vi.fn().mockImplementation(async (_triggerType, _signal, onProgress) => {
			onProgress?.({ discoveredFiles: 2 })
			return {
				runId: "run-1",
				discoveredFiles: 2,
				isPartial: false,
			}
		}),
		runReconciliationDiscovery: vi.fn().mockResolvedValue({
			runId: "run-reconcile",
			discoveredFiles: 2,
			isPartial: false,
		}),
		runTargetedDiscovery: vi.fn().mockResolvedValue({
			runId: "run-targeted",
			discoveredFiles: 1,
			isPartial: false,
		}),
	}

	const statHashService = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			checkedFiles: 2,
			skippedFiles: 1,
			changedFiles: 1,
			unchangedFiles: 1,
			oversizedFiles: 0,
			missingFiles: 0,
			reusedParsedRevisionIds: [],
		}),
	}

	const parseChunkService = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			attemptedRevisions: 1,
			parsedRevisions: 1,
			parsedChunks: 3,
			parsedRevisionIds: ["revision-1"],
		}),
		dispose: vi.fn().mockResolvedValue(undefined),
	}

	const diffPlanner = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			plannedRevisions: 1,
			upsertJobs: 3,
			deleteJobs: 0,
			reusedFingerprintUpserts: 0,
			deletedMissingFingerprintChunks: 0,
			safetyFallbackRevisions: 0,
			plannerSliceLatencyMs: 0,
		}),
	}
	metadataStore.runPlannerSlice = diffPlanner.run

	const embedUpsertWorker = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			upsertedChunks: 3,
			deletedChunks: 0,
			committedRevisions: 1,
		}),
		dispose: vi.fn().mockResolvedValue(undefined),
	}

	const reconciliationService = {
		findMissingFiles: vi.fn().mockResolvedValue({
			runId: "run-reconcile",
			discoveredFiles: 2,
			isPartial: false,
			missingFiles: [],
		}),
	}

	const watcherCoordinator = {
		initialize: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
	}

	const embeddingAdapter = {
		provider: "ollama",
		modelId: "nomic-embed-text",
		runtimeKind: "local" as const,
		runtimeLabel: "Local embedder",
		deviceHint: "Ollama auto-selects CPU/GPU",
		createEmbeddings: vi.fn().mockResolvedValue({
			embeddings: [[0.1, 0.2, 0.3]],
		}),
		recycleClient: vi.fn().mockResolvedValue(undefined),
	}

	const vectorStore = {
		initialize: vi.fn().mockResolvedValue(undefined),
		hasIndexedPoints: vi.fn().mockResolvedValue(true),
		deleteCollection: vi.fn().mockResolvedValue(undefined),
		search: vi.fn().mockResolvedValue([
			{
				id: "point-1",
				score: 0.9,
				payload: {
					filePath: "src/example.ts",
					codeChunk: "const value = 1",
					startLine: 1,
					endLine: 1,
				},
			},
		]),
		recycleClient: vi.fn().mockResolvedValue(undefined),
	}

	const serviceFactory = {
		createEmbedder: vi.fn().mockReturnValue({
			createEmbeddings: vi.fn(),
			embedderInfo: { name: "openai" },
		}),
	}

	const stateManager = {
		startIndexingTimer: vi.fn(),
		beginPipelineRun: vi.fn(),
		setPipelineSnapshot: vi.fn(),
		setPipelineTerminalState: vi.fn(),
		preserveCompletedPipelineSnapshot: vi.fn(),
		reportCustomProgress: vi.fn(),
		reportHeartbeat: vi.fn(),
		setActivityDetail: vi.fn(),
		getCurrentStatus: vi.fn().mockReturnValue({
			estimatedTimeRemaining: null,
		}),
		setResilienceStats: vi.fn(),
		setOversizedDetails: vi.fn(),
		setRecoveryContext: vi.fn(),
		setSystemState: vi.fn(),
		resetIndexingState: vi.fn(),
		reportScanProgress: vi.fn(),
		startEmbedPhase: vi.fn(),
		reportEmbedProgress: vi.fn(),
		reportComplete: vi.fn(),
	}

	return {
		fsAccess,
		metadataStore,
		workspaceAdapter,
		discoveryService,
		statHashService,
		parseChunkService,
		diffPlanner,
		embedUpsertWorker,
		reconciliationService,
		watcherCoordinator,
		embeddingAdapter,
		vectorStore,
		serviceFactory,
		stateManager,
	}
})

vi.mock("fs/promises", () => ({
	access: mocks.fsAccess,
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
	MetadataStore: vi.fn(() => mocks.metadataStore),
}))

vi.mock("../sidecar/MetadataSidecarClient", () => ({
	MetadataSidecarClient: vi.fn(() => mocks.metadataStore),
}))

vi.mock("../store/MetadataPathResolver", () => ({
	resolveMetadataStorePaths: vi.fn((_context: unknown, workspacePath: string) => ({
		workspaceHash: "workspace-1",
		workspacePath,
		rootDir: "/global-storage/code-index-v2/workspace-1",
		persistentRootDir: "/global-storage/code-index-v2/persistent/workspace-1",
		diagnosticsRootDir: "/global-storage/code-index-v2/persistent/workspace-1/diagnostics",
		legacyDiagnosticsRootDir: "/global-storage/code-index-v2/workspace-1",
		dbPath: "/global-storage/code-index-v2/persistent/workspace-1/roo-code-index-v2.sqlite",
		telemetryDbPath: "/global-storage/code-index-v2/persistent/workspace-1/roo-code-index-v2-telemetry.sqlite",
		bootstrapPath: "/global-storage/code-index-v2/workspace-1/bootstrap.json",
	})),
}))

vi.mock("../adapters/VsCodeWorkspaceAdapter", () => ({
	VsCodeWorkspaceAdapter: vi.fn(() => mocks.workspaceAdapter),
}))

vi.mock("../adapters/CodeIndexParserAdapter", () => ({
	CodeIndexParserAdapter: vi.fn(),
}))

vi.mock("../discovery", () => ({
	DiscoveryService: vi.fn(() => mocks.discoveryService),
}))

vi.mock("../pipeline", () => ({
	StatHashService: vi.fn(() => mocks.statHashService),
	ParseChunkService: vi.fn(() => mocks.parseChunkService),
	DiffPlanner: vi.fn(() => mocks.diffPlanner),
	EmbedUpsertWorker: vi.fn(() => mocks.embedUpsertWorker),
	SidecarParseExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
	SidecarEmbedUpsertExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("../reconciliation/ReconciliationService", () => ({
	ReconciliationService: vi.fn(() => mocks.reconciliationService),
}))

vi.mock("../watcher", () => ({
	WatcherCoordinator: vi.fn(() => mocks.watcherCoordinator),
}))

vi.mock("../../code-index/cache-manager", () => ({
	CacheManager: vi.fn(),
}))

vi.mock("../../code-index/service-factory", () => ({
	CodeIndexServiceFactory: vi.fn(() => mocks.serviceFactory),
}))

vi.mock("../adapters/ExistingEmbedderAdapter", () => ({
	ExistingEmbedderAdapter: vi.fn(() => mocks.embeddingAdapter),
}))

vi.mock("../adapters/QdrantRestVectorStoreAdapter", () => ({
	QdrantRestVectorStoreAdapter: vi.fn(() => mocks.vectorStore),
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		configureDiagnosticsDirectory: vi.fn(),
		setContext: vi.fn(),
		log: vi.fn(),
		getMemorySnapshot: vi.fn(() => ({
			rssMB: 512,
			externalMB: 32,
			heapUsedMB: 128,
			heapTotalMB: 256,
		})),
		getCpuSnapshot: vi.fn(() => ({
			processPercent: 12,
		})),
		getTrackedProcessSummary: vi.fn(() => ({
			totalTrackedRssMB: 96,
			byGroup: {
				parseSidecars: { totalRssMB: 48 },
				embedSidecars: { totalRssMB: 48 },
			},
		})),
		getBuildInfo: vi.fn(() => ({
			version: "test-version",
			buildTimestamp: "2026-04-10T00:00:00.000Z",
			sha: "test-sha",
		})),
	},
}))

describe("CodeIndexEngineV2 smoke", () => {
	const zeroBacklog = () => ({
		parsedRevisions: 0,
		plannedRevisions: 0,
		stagedChunks: 0,
		queuedUpsertJobs: 0,
		runningUpsertJobs: 0,
		queuedDeleteJobs: 0,
		runningDeleteJobs: 0,
	})

	const mockContext = {
		globalStorageUri: { fsPath: "/global-storage" },
	} as any

	const mockConfigManager = {
		currentEmbedderProvider: "ollama",
		currentModelId: "text-embedding-3-small",
		currentModelDimension: 1536,
		currentRespectGitIgnore: true,
		currentIncludeDefaultIgnoredGeneratedPaths: false,
		currentEmbeddingLaneConcurrency: 2,
		currentSearchMinScore: 0.4,
		currentMaxFileSizeBytes: 1024 * 1024,
		getEffectiveMaxFileSizeBytes: vi.fn(() => 1024 * 1024),
		getOversizedFileApproval: vi.fn(() => undefined),
		getConfig: vi.fn(() => ({
			openAiCompatibleOptions: undefined,
		})),
		qdrantConfig: {
			url: "http://localhost:6333",
			apiKey: "test-key",
		},
	} as any

	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		vi.spyOn(CodeIndexEngineV2.prototype as any, "waitForPipelineTick").mockResolvedValue(undefined)
		mocks.fsAccess.mockResolvedValue(undefined)

		mocks.discoveryService.runInitialDiscovery.mockResolvedValue({
			runId: "run-1",
			discoveredFiles: 2,
			isPartial: false,
		})
		mocks.discoveryService.runReconciliationDiscovery.mockResolvedValue({
			runId: "run-reconcile",
			discoveredFiles: 2,
			isPartial: false,
		})
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValue({
			runId: "run-1",
			checkedFiles: 2,
			skippedFiles: 1,
			changedFiles: 1,
			unchangedFiles: 1,
			oversizedFiles: 0,
			missingFiles: 0,
			reusedParsedRevisionIds: [],
		})
		mocks.reconciliationService.findMissingFiles.mockResolvedValue({
			runId: "run-reconcile",
			discoveredFiles: 2,
			isPartial: false,
			missingFiles: [],
		})
		mocks.workspaceAdapter.statFile.mockResolvedValue({
			path: "/workspace/src/example.ts",
			mtimeMs: 1,
			size: 128,
		})
		mocks.parseChunkService.run
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 1,
				parsedRevisions: 1,
				parsedChunks: 3,
				parsedRevisionIds: ["revision-1"],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
			.mockResolvedValueOnce({
				runId: "run-reconcile",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
		mocks.embedUpsertWorker.run.mockResolvedValue({
			runId: "run-1",
			upsertedChunks: 3,
			deletedChunks: 0,
			committedRevisions: 1,
		})
		mocks.metadataStore.getRunBacklogMetrics.mockReset()
		mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => {
			if (mocks.embedUpsertWorker.run.mock.calls.length > 0) {
				return zeroBacklog()
			}
			if (mocks.diffPlanner.run.mock.calls.length > 0) {
				return {
					...zeroBacklog(),
					plannedRevisions: 1,
					queuedUpsertJobs: 3,
				}
			}
			if (mocks.parseChunkService.run.mock.calls.length > 0) {
				return {
					...zeroBacklog(),
					parsedRevisions: 1,
					stagedChunks: 3,
				}
			}
			return zeroBacklog()
		})
		mocks.vectorStore.hasIndexedPoints.mockResolvedValue(true)
		mocks.vectorStore.search.mockResolvedValue([
			{
				id: "point-1",
				score: 0.9,
				payload: {
					filePath: "src/example.ts",
					codeChunk: "const value = 1",
					startLine: 1,
					endLine: 1,
				},
			},
		])
	})

	it("starts the full pipeline, enables watcher/reconciliation, supports search, and stops cleanly", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()

		const configureDiagnosticsDirectory = vi.mocked(IndexDebugLoggerV2.configureDiagnosticsDirectory)
		const setContext = vi.mocked(IndexDebugLoggerV2.setContext)

		expect(configureDiagnosticsDirectory).toHaveBeenCalledWith(
			"/global-storage/code-index-v2/persistent/workspace-1/diagnostics",
			"/workspace",
		)
		expect(configureDiagnosticsDirectory.mock.invocationCallOrder[0]).toBeLessThan(
			setContext.mock.invocationCallOrder[0],
		)
		expect(mocks.metadataStore.initialize).toHaveBeenCalledTimes(1)
		expect(mocks.metadataStore.cleanupStaleRuns).toHaveBeenCalledTimes(1)
		expect(mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [])
		const { VsCodeWorkspaceAdapter } = await import("../adapters/VsCodeWorkspaceAdapter")
		expect(VsCodeWorkspaceAdapter).toHaveBeenCalledWith("/workspace", {
			respectGitIgnore: true,
			includeDefaultIgnoredGeneratedPaths: false,
		})
		expect(mocks.workspaceAdapter.initialize).toHaveBeenCalledTimes(1)
		expect(mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(mocks.embeddingAdapter.createEmbeddings).toHaveBeenCalledWith(["preflight"], {
			isQuery: true,
			signal: expect.any(Object),
		})
		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(1)
		expect(mocks.statHashService.run).toHaveBeenCalledWith(
			"run-1",
			expect.any(Object),
			undefined,
			expect.any(Object),
		)
		expect(mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			1,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			expect.objectContaining({
				limit: 20,
				concurrency: 4,
			}),
		)
		expect(mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			2,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			expect.objectContaining({
				limit: 20,
				concurrency: 4,
			}),
		)
		expect(mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.any(Object),
		)
		expect(mocks.embedUpsertWorker.run).toHaveBeenCalledWith("run-1", expect.any(Object), expect.any(Function))
		expect(mocks.watcherCoordinator.initialize).toHaveBeenCalledTimes(1)
		expect(mocks.stateManager.startIndexingTimer).toHaveBeenCalledTimes(1)
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalled()

		const status = await engine.getStatus()
		expect(status.message).toContain("V2 mapped 2 files")
		expect(status.message).toContain("synced 3 chunks")

		const searchResults = await engine.search("find value", 5)
		expect(mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(mocks.vectorStore.hasIndexedPoints).toHaveBeenCalled()
		expect(mocks.embeddingAdapter.createEmbeddings).toHaveBeenCalledWith(["find value"], { isQuery: true })
		expect(mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20, 0.4)
		expect(searchResults).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(mocks.discoveryService.runReconciliationDiscovery).toHaveBeenCalledTimes(1)
		expect(mocks.reconciliationService.findMissingFiles).toHaveBeenCalledTimes(1)
		expect(mocks.statHashService.run).toHaveBeenCalledWith(
			"run-reconcile",
			expect.any(Object),
			undefined,
			expect.any(Object),
		)

		await engine.stop()
		expect(mocks.watcherCoordinator.dispose).toHaveBeenCalledTimes(1)
		expect(mocks.embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(mocks.vectorStore.recycleClient).toHaveBeenCalled()
		expect(mocks.metadataStore.dispose).toHaveBeenCalledTimes(1)
	})

	it("emits split embedding and vector sync service snapshots during the fused embed drain", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()

		const pipelineSnapshots = mocks.stateManager.setPipelineSnapshot.mock.calls.map(([snapshot]) => snapshot)
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

	it("retires stale tracked files that no longer match current candidate rules before stat-hash", async () => {
		mocks.metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValueOnce([
			{
				fileId: "generated-1",
				workspaceId: "workspace-1",
				relativePath: "src/webview-ui/build/assets/index.js",
				normalizedPath: "/workspace/src/webview-ui/build/assets/index.js",
				lastSeenMtimeMs: 1,
				lastSeenSize: 1024,
				ignoreState: "included",
				activeRevisionId: "revision-generated",
				tombstoned: false,
				latestRevisionId: "revision-generated",
				latestRevisionContentHash: "hash-generated",
				latestRevisionFastFingerprint: "fp-generated",
				latestRevisionState: "committed",
			},
			{
				fileId: "source-1",
				workspaceId: "workspace-1",
				relativePath: "src/app.ts",
				normalizedPath: "/workspace/src/app.ts",
				lastSeenMtimeMs: 1,
				lastSeenSize: 128,
				ignoreState: "included",
				activeRevisionId: "revision-source",
				tombstoned: false,
				latestRevisionId: "revision-source",
				latestRevisionContentHash: "hash-source",
				latestRevisionFastFingerprint: "fp-source",
				latestRevisionState: "committed",
			},
		])
		mocks.workspaceAdapter.isCandidateFile.mockImplementation((filePath: string) => !filePath.includes("/build/"))

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()

		expect(mocks.metadataStore.excludeFilesFromIndexing).toHaveBeenCalledWith(["generated-1"])
		expect(mocks.statHashService.run).toHaveBeenCalledTimes(1)
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

		mocks.parseChunkService.run.mockReset()
		mocks.diffPlanner.run.mockReset()
		mocks.embedUpsertWorker.run.mockReset()
		mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		mocks.parseChunkService.run.mockImplementation(async () => {
			parseBatch += 1
			if (parseBatch === 1) {
				backlog.parsedRevisions = 1
				backlog.stagedChunks = 3
				return {
					runId: "run-1",
					attemptedRevisions: 1,
					parsedRevisions: 1,
					parsedChunks: 3,
					parsedRevisionIds: ["revision-1"],
					retryingRevisions: 0,
					terminalFailedRevisions: 0,
				}
			}

			return {
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			}
		})
		mocks.diffPlanner.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 1
			backlog.stagedChunks = 0
			backlog.queuedUpsertJobs = 3

			return {
				runId: "run-1",
				plannedRevisions: 1,
				upsertJobs: 3,
				deleteJobs: 0,
			}
		})
		mocks.embedUpsertWorker.run.mockImplementation(async () => {
			embedStarted.resolve()
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			backlog.runningUpsertJobs = 3
			const summary = await embedDrain.promise
			backlog.runningUpsertJobs = 0
			return summary
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		const startPromise = engine.start()

		await embedStarted.promise
		expect(mocks.metadataStore.markRunComplete).not.toHaveBeenCalled()

		embedDrain.resolve({
			runId: "run-1",
			upsertedChunks: 3,
			deletedChunks: 0,
			committedRevisions: 1,
		})
		await startPromise

		expect(mocks.metadataStore.markRunComplete).toHaveBeenCalledTimes(1)
		expect(mocks.metadataStore.markRunComplete).toHaveBeenCalledWith("run-1")
	})

	it("fails fast on Qdrant preflight before workspace discovery begins", async () => {
		mocks.vectorStore.initialize.mockRejectedValueOnce(new Error("Qdrant unavailable"))

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await expect(engine.start()).rejects.toThrow("Qdrant unavailable")

		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(mocks.embeddingAdapter.createEmbeddings).not.toHaveBeenCalled()
	})

	it("fails fast on embedder preflight before workspace discovery begins", async () => {
		mocks.embeddingAdapter.createEmbeddings.mockRejectedValueOnce(new Error("Embedder unavailable"))

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await expect(engine.start()).rejects.toThrow("Embedder unavailable")

		expect(mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
	})

	it("times out Qdrant preflight with a specific error and does not wedge future starts", async () => {
		mocks.vectorStore.initialize.mockImplementationOnce(() => new Promise<void>(() => undefined))

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		const startPromise = expect(engine.start()).rejects.toThrow("Qdrant verification timed out after 10s")

		await vi.advanceTimersByTimeAsync(10_000)

		await startPromise
		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Verifying indexing services: Qdrant",
			0,
			2,
			expect.any(Object),
		)
		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			"Qdrant verification timed out after 10s",
		)

		await engine.start()

		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(1)
	})

	it("times out embedder preflight with a specific error", async () => {
		mocks.embeddingAdapter.createEmbeddings.mockImplementationOnce(() => new Promise(() => undefined))

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		const startPromise = expect(engine.start()).rejects.toThrow(
			"Embedding provider verification timed out after 15s",
		)

		await vi.advanceTimersByTimeAsync(15_000)

		await startPromise
		expect(mocks.vectorStore.initialize).toHaveBeenCalled()
		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).not.toHaveBeenCalled()
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Verifying indexing services: embedding provider",
			1,
			2,
			expect.any(Object),
		)
		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			"Embedding provider verification timed out after 15s",
		)
	})

	it("returns watcher-driven targeted updates to standby after the pipeline completes", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()

		mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(2_335)

		await (engine as any).runTargetedUpdate(["/workspace/src/example.ts"], "watcher")

		expect(mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/example.ts"],
			"watcher",
			undefined,
		)
		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith("Standby", "V2 is current across 2,335 files")

		const status = await engine.getStatus()
		expect(status.state).toBe("idle")
		expect(status.message).toBe("V2 is current across 2,335 files")
	})

	it("refreshAll reruns the full pipeline without clearing the index", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()
		vi.clearAllMocks()

		mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockImplementationOnce(
			async (_triggerType, _signal, onProgress) => {
				onProgress?.({ discoveredFiles: 3 })
				return {
					runId: "run-refresh",
					discoveredFiles: 3,
					isPartial: false,
				}
			},
		)
		mocks.statHashService.run.mockResolvedValueOnce({
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
			missingFiles: 0,
			reusedParsedRevisionIds: [],
		})
		mocks.parseChunkService.run.mockResolvedValueOnce({
			runId: "run-refresh",
			attemptedRevisions: 1,
			parsedRevisions: 1,
			parsedChunks: 2,
			parsedRevisionIds: ["revision-refresh"],
			retryingRevisions: 0,
			terminalFailedRevisions: 0,
		})
		mocks.diffPlanner.run.mockResolvedValueOnce({
			runId: "run-refresh",
			plannedRevisions: 1,
			upsertJobs: 2,
			deleteJobs: 0,
		})
		mocks.embedUpsertWorker.run.mockResolvedValueOnce({
			runId: "run-refresh",
			upsertedChunks: 2,
			deletedChunks: 0,
			committedRevisions: 1,
		})

		await engine.refreshAll()

		expect(mocks.discoveryService.runWorkspaceDiscoveryWithProgress).toHaveBeenCalledTimes(1)
		expect(mocks.vectorStore.deleteCollection).not.toHaveBeenCalled()
		expect(mocks.metadataStore.clearStorage).not.toHaveBeenCalled()
		expect(mocks.stateManager.setOversizedDetails).toHaveBeenCalledWith([
			expect.objectContaining({
				relativePath: "src/huge.ts",
			}),
		])

		const status = await engine.getStatus()
		expect(status.state).toBe("idle")
		expect(status.message).toContain("V2 refresh re-evaluated 3 files")
	})

	it("uses conservative scheduler defaults for very large workspaces", async () => {
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 65_000,
			skippedFiles: 10,
			changedFiles: 1,
			unchangedFiles: 64_989,
			oversizedFiles: 0,
			missingFiles: 0,
			reusedParsedRevisionIds: [],
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			1,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			expect.objectContaining({
				limit: 10,
				concurrency: 2,
			}),
		)
		expect(mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 25,
				maxJobs: 800,
			}),
			expect.any(Object),
		)
	})

	it("reranks search results using symbol, path, and summary metadata", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-generic",
				score: 0.91,
				payload: {
					filePath: "src/auth/helpers.ts",
					chunkFingerprint: "child-generic",
					codeChunk: "export const helper = true",
					startLine: 1,
					endLine: 1,
					summary: "ts function helper in src/auth/helpers.ts:1-1",
				},
			},
			{
				id: "point-symbol",
				score: 0.82,
				payload: {
					filePath: "src/auth/AssumeRoleWithWebIdentity.ts",
					chunkFingerprint: "child-symbol",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 10,
					endLine: 12,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
					parentSymbolName: "Auth",
					summary:
						"ts function AssumeRoleWithWebIdentity in Auth at src/auth/AssumeRoleWithWebIdentity.ts:10-12",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("AssumeRoleWithWebIdentity function", 5)

		expect(results).toHaveLength(2)
		expect(results[0].id).toBe("point-symbol")
		expect(results[0].rerankScore).toBeGreaterThan(results[0].score)
		expect(results[0].matchReasons).toContain("symbol token overlap")
		expect(results[0].matchReasons).toContain("path token overlap")
		expect(results[0].matchReasons).toContain("chunk kind match")
	})

	it("uses a real candidate floor for small limits", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		await engine.search("find value", 1)

		expect(mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20, 0.4)
		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			"find value",
			20,
			expect.any(Object),
		)
	})

	it("expands identifier-style queries for lexical retrieval without changing the grounding result", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		await engine.search("refreshAllIndexData", 5)

		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			expect.stringContaining("refresh_all_index_data"),
			20,
			expect.objectContaining({
				allowExactFallback: true,
			}),
		)
		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			expect.stringContaining("refresh all index data"),
			20,
			expect.any(Object),
		)
	})

	it("filters vector and lexical candidates by directory prefix before reranking", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-auth",
				score: 0.81,
				payload: {
					filePath: "src/auth/validate.ts",
					chunkFingerprint: "auth-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 1,
					endLine: 3,
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
				},
			},
			{
				id: "point-other",
				score: 0.95,
				payload: {
					filePath: "src/other.ts",
					chunkFingerprint: "other-fp",
					codeChunk: "export const validateToken = true",
					startLine: 1,
					endLine: 1,
				},
			},
		])
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 1,
				fallbackMs: 0,
				totalMs: 1,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("validateToken", 2, { directoryPrefix: "src/auth" })

		expect(mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 60, 0.4)
		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			expect.any(String),
			60,
			expect.any(Object),
		)
		expect(results).toHaveLength(1)
		expect(results[0].payload?.filePath).toBe("src/auth/validate.ts")
	})

	it("parses query intent once and threads it through search", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		const parseQueryIntentSpy = vi.spyOn(engine as any, "parseQueryIntent")
		await engine.start()

		await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(parseQueryIntentSpy).toHaveBeenCalledTimes(1)
	})

	it("matches token overlap on whole tokens instead of substrings", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-submerged",
				score: 0.9,
				payload: {
					filePath: "src/search/submerged.ts",
					chunkFingerprint: "submerged-fp",
					codeChunk: "const submerged = true",
					searchText: "submerged helper",
					startLine: 1,
					endLine: 2,
				},
			},
			{
				id: "point-merge",
				score: 0.9,
				payload: {
					filePath: "src/search/merge.ts",
					chunkFingerprint: "merge-fp",
					codeChunk: "export function merge() {}",
					searchText: "merge helper",
					startLine: 1,
					endLine: 2,
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("merge", 5)

		expect(results[0].id).toBe("point-merge")
		expect(results[0].matchReasons).toContain("content token overlap")
		expect(results[1].matchReasons ?? []).not.toContain("content token overlap")
	})

	it("boosts path-like query hints ahead of generic token overlap", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-generic",
				score: 0.9,
				payload: {
					filePath: "src/services/helpers.ts",
					chunkFingerprint: "generic-fp",
					codeChunk: "export const helper = true",
					startLine: 1,
					endLine: 1,
				},
			},
			{
				id: "point-path",
				score: 0.76,
				payload: {
					filePath: "src/services/auth/validate.ts",
					chunkFingerprint: "path-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("src/services/auth/validate.ts", 5)

		expect(results[0].id).toBe("point-path")
		expect(results[0].matchReasons).toContain("exact hinted path match")
	})

	it("boosts symbol-like query hints ahead of generic token overlap", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-generic",
				score: 0.89,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "generic-symbol-fp",
					codeChunk: "validate token helper",
					startLine: 1,
					endLine: 3,
				},
			},
			{
				id: "point-symbol",
				score: 0.77,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "exact-symbol-fp",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 10,
					endLine: 14,
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("Auth.AssumeRoleWithWebIdentity", 5)

		expect(results[0].id).toBe("point-symbol")
		expect(results[0].matchReasons).toContain("exact hinted symbol match")
	})

	it("returns lexical candidates even when no query embedding is available", async () => {
		mocks.embeddingAdapter.createEmbeddings
			.mockResolvedValueOnce({
				embeddings: [[0.1, 0.2, 0.3]],
			})
			.mockResolvedValueOnce({
				embeddings: [],
			})
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				{
					chunkId: "chunk-lexical",
					revisionId: "revision-1",
					chunkFingerprint: "lexical-fp",
					startLine: 15,
					endLine: 19,
					language: "ts",
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
					parentSymbolName: "Auth",
					parentChunkFingerprint: null,
					summary: "ts function AssumeRoleWithWebIdentity in Auth at src/auth.ts:15-19",
					searchText: "AssumeRoleWithWebIdentity function",
					content: "export function AssumeRoleWithWebIdentity() {}",
					contentHash: "hash-lexical",
					tokenEstimate: 12,
					embeddingModel: null,
					vectorPointId: "vector-lexical",
					state: "upserted",
					createdAt: 1,
					updatedAt: 1,
					fileId: "file-1",
					workspaceId: "workspace-1",
					relativePath: "src/auth.ts",
					normalizedPath: "/workspace/src/auth.ts",
					parserVersion: "parser-v1",
					chunkerVersion: "chunker-v1",
					lexicalScore: 18,
				},
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 6,
				fallbackMs: 4,
				totalMs: 10,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("AssumeRoleWithWebIdentity", 5)

		expect(results).toHaveLength(1)
		expect(mocks.vectorStore.search).not.toHaveBeenCalled()
		expect(results[0].payload?.symbolQualifiedName).toBe("Auth.AssumeRoleWithWebIdentity")
		expect(results[0].matchReasons).toContain("lexical match")
	})

	it("boosts exact filename-style path hints during reranking", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "schema-point",
				score: 0.72,
				payload: {
					filePath: "src/services/code-index-v2/store/schema.ts",
					chunkFingerprint: "schema-fp",
					codeChunk: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					startLine: 1,
					endLine: 10,
					chunkKind: "module",
				},
			},
			{
				id: "other-point",
				score: 0.74,
				payload: {
					filePath: "src/services/code-index-v2/store/types.ts",
					chunkFingerprint: "types-fp",
					codeChunk: "export type ChunkVariantType = ...",
					startLine: 1,
					endLine: 10,
					chunkKind: "type",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("schema.ts CREATE TABLE chunk_variants", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/store/schema.ts")
		expect(results[0].matchReasons).toContain("exact hinted filename match")
		expect(results[0].matchReasons).toContain("schema file match")
		expect(results[0].matchReasons).toContain("schema storage path match")
		expect(results[0].matchReasons).toContain("ddl token overlap")
	})

	it("penalizes blog content for natural-language code questions", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "blog-point",
				score: 0.95,
				payload: {
					filePath: "apps/web-roo-code/src/content/blog/example.md",
					chunkFingerprint: "blog-fp",
					codeChunk: "How does Roo add parent and sibling context to code search results?",
					startLine: 1,
					endLine: 4,
					summary: "Blog content about Roo adoption",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText: "expandSearchResultsWithParents parent sibling context code search results",
					startLine: 100,
					endLine: 130,
					summary: "Engine logic for parent and sibling context expansion",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("retrieval engine surface match")
		expect(results[1].matchReasons).toContain("non-code content penalty")
	})

	it("boosts startup oversized tracking queries toward the engine implementation", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "config-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index/config-manager.ts",
					chunkFingerprint: "config-fp",
					codeChunk: "getOversizedFileApproval() {}",
					searchText: "oversized approvals config manager",
					startLine: 1,
					endLine: 20,
					summary: "Oversized approval lookup in config manager",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async refreshTrackedOversizedFiles() {}",
					searchText: "refreshTrackedOversizedFiles startup reconcile oversized approvals",
					startLine: 200,
					endLine: 240,
					summary: "Refresh tracked oversized files on startup and reconcile approvals",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("refreshTrackedOversizedFiles startup reconcile oversized approvals", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("startup tracking engine surface match")
		expect(results[0].matchReasons).toContain("exact startup tracking match")
		expect(results[0].matchReasons).toContain("content token overlap")
		expect(results[0].matchReasons).toContain("implementation token overlap")
	})

	it("boosts full refresh manager queries toward the manager implementation entrypoint", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "custom-modes-point",
				score: 0.95,
				payload: {
					filePath: "src/core/config/CustomModesManager.ts",
					chunkFingerprint: "custom-modes-fp",
					codeChunk: "private refreshMergedState() {}",
					searchText: "refresh merged state custom modes manager",
					symbolName: "refreshMergedState",
					symbolQualifiedName: "CustomModesManager.refreshMergedState",
					startLine: 1,
					endLine: 20,
					summary: "Refresh custom modes manager merged state",
				},
			},
			{
				id: "manager-point",
				score: 0.83,
				payload: {
					filePath: "src/services/code-index/manager.ts",
					chunkFingerprint: "manager-fp",
					codeChunk: "public async refreshAllIndexData() {}",
					searchText: "refreshAllIndexData full refresh manager workspace index",
					symbolName: "refreshAllIndexData",
					symbolQualifiedName: "CodeIndexManager.refreshAllIndexData",
					startLine: 200,
					endLine: 260,
					summary: "Run a non destructive full refresh of the workspace index",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("refreshAllIndexData full refresh manager", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index/manager.ts")
		expect(results[0].matchReasons).toContain("full refresh manager path match")
		expect(results[0].matchReasons).toContain("exact full refresh manager match")
	})

	it("penalizes wrapper surfaces for implementation-oriented hybrid retrieval queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "ui-point",
				score: 0.95,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "ui-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					startLine: 1,
					endLine: 20,
					summary: "Search result display component",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private mergeSearchCandidates() {}",
					searchText: "mergeSearchCandidates lexical vector hybrid retrieval",
					startLine: 50,
					endLine: 90,
					summary: "Engine logic for combining lexical and vector retrieval before reranking",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search(
			"How does V2 combine lexical search and vector search before returning results",
			5,
		)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("hybrid retrieval engine surface match")
		expect(results[0].matchReasons).toContain("implementation token overlap")
		expect(results[1].matchReasons).toContain("wrapper surface penalty")
	})

	it("prefers engine parent and sibling context behavior over wrapper and fixture surfaces", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "display-point",
				score: 0.95,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "display-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					startLine: 1,
					endLine: 20,
					summary: "Search result display component",
				},
			},
			{
				id: "fixture-point",
				score: 0.9,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "How does Roo add parent and sibling context to code search results",
					searchText: "eval benchmark fixture parent sibling context",
					startLine: 1,
					endLine: 20,
					summary: "Benchmark fixture for retrieval queries",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("retrieval engine surface match")
		expect(results.some((result) => result.matchReasons?.includes("fixture surface penalty"))).toBe(true)
	})

	it("penalizes context-management distractors for parent and sibling context retrieval queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "context-point",
				score: 0.95,
				payload: {
					filePath: "src/core/context/context-management/context-error-handling.ts",
					chunkFingerprint: "context-fp",
					codeChunk: "function checkContextWindowExceededError() {}",
					searchText: "context window management context handling",
					symbolName: "checkContextWindowExceededError",
					symbolQualifiedName: "checkContextWindowExceededError",
					startLine: 1,
					endLine: 20,
					summary: "Context management error handling",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("context-management surface penalty")
	})

	it("prefers the search results display component over benchmark fixtures for display-oriented queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "fixture-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "codebase search results display parent context sibling context",
					searchText: "benchmark fixture search results display parent sibling context",
					startLine: 1,
					endLine: 20,
					summary: "Benchmark fixture",
				},
			},
			{
				id: "display-point",
				score: 0.83,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "display-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					symbolName: "CodebaseSearchResultsDisplay",
					symbolQualifiedName: "CodebaseSearchResultsDisplay",
					startLine: 1,
					endLine: 20,
					summary: "Display codebase search results with parent and sibling context",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("codebase search results display parent context sibling context", 5)

		expect(results[0].payload?.filePath).toBe("webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx")
		expect(results[0].matchReasons).toContain("search results display surface match")
		expect(results[1].matchReasons).toContain("fixture surface penalty")
	})

	it("penalizes parser adapter surfaces for parent and sibling context behavior queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "parser-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts",
					chunkFingerprint: "parser-fp",
					codeChunk: "buildSearchText() {}",
					searchText: "build search text parent sibling context code search results",
					symbolName: "buildSearchText",
					symbolQualifiedName: "CodeIndexParserAdapter.buildSearchText",
					startLine: 1,
					endLine: 20,
					summary: "Build search text for code index chunks",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("parser/adapter surface penalty")
	})

	it("penalizes metadata store surfaces for parent and sibling context behavior queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "store-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/store/MetadataStore.ts",
					chunkFingerprint: "store-fp",
					codeChunk: "computeLexicalScore() {}",
					searchText: "compute lexical score parent sibling context code search results",
					symbolName: "computeLexicalScore",
					symbolQualifiedName: "MetadataStore.computeLexicalScore",
					startLine: 1,
					endLine: 20,
					summary: "Compute lexical score for code index retrieval",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("storage surface penalty")
	})

	it("boosts preflight timeout queries toward the engine verification flow", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "cli-point",
				score: 0.95,
				payload: {
					filePath: "apps/cli/scripts/integration/cases/cancel-immediately-after-start-ack.ts",
					chunkFingerprint: "cli-fp",
					codeChunk: "onTimeoutMessage() {}",
					searchText: "timeout message qdrant verification timed out",
					symbolName: "onTimeoutMessage",
					symbolQualifiedName: "runStreamCase.onTimeoutMessage",
					startLine: 1,
					endLine: 20,
					summary: "CLI timeout message helper",
				},
			},
			{
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async preflightIndexingDependencies() {}",
					searchText: "preflightIndexingDependencies qdrant verification timed out after 10s preflight",
					symbolName: "preflightIndexingDependencies",
					symbolQualifiedName: "CodeIndexEngineV2.preflightIndexingDependencies",
					startLine: 200,
					endLine: 260,
					summary: "Verify Qdrant and embedding provider availability before indexing starts",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("Qdrant verification timed out after 10s preflight", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("preflight implementation match")
		expect(results[1].matchReasons).toContain("preflight cli surface penalty")
	})

	it("boosts low value file filtering queries toward the shared low value file implementation", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "fixture-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "low value file filtering code index",
					searchText: "low value file filtering benchmark fixture",
					startLine: 1,
					endLine: 20,
					summary: "Benchmark query fixture",
				},
			},
			{
				id: "engine-point",
				score: 0.7,
				payload: {
					filePath: "src/services/code-index/shared/low-value-files.ts",
					chunkFingerprint: "shared-fp",
					codeChunk: "const LOW_VALUE_FILE_NAMES = new Set([])",
					searchText: "LOW_VALUE_FILE_NAMES low value file filtering code index",
					symbolName: "LOW_VALUE_FILE_NAMES",
					symbolQualifiedName: "LOW_VALUE_FILE_NAMES",
					startLine: 1,
					endLine: 20,
					summary: "Low value file filtering list used by code index",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("low value file filtering code index", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index/shared/low-value-files.ts")
		expect(results[0].matchReasons).toContain("low value files implementation match")
		expect(results[1].matchReasons).toContain("low value files non-code surface penalty")
	})

	it("boosts oversized webview handler queries toward the webview handler implementation", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "cli-point",
				score: 0.95,
				payload: {
					filePath: "apps/cli/src/agent/json-event-emitter.ts",
					chunkFingerprint: "cli-fp",
					codeChunk: "handleReasoningMessage() {}",
					searchText: "json event emitter handler message",
					symbolName: "handleReasoningMessage",
					symbolQualifiedName: "JsonEventEmitter.handleReasoningMessage",
					startLine: 1,
					endLine: 20,
					summary: "CLI reasoning event handler",
				},
			},
			{
				id: "handler-point",
				score: 0.79,
				payload: {
					filePath: "src/core/webview/webviewMessageHandler.ts",
					chunkFingerprint: "handler-fp",
					codeChunk: 'case "fullRefreshIndexData": requestOversizedFileDetails()',
					searchText: "fullRefreshIndexData requestOversizedFileDetails webview message handler",
					symbolName: "fullRefreshIndexData",
					symbolQualifiedName: "webviewMessageHandler.fullRefreshIndexData",
					startLine: 200,
					endLine: 260,
					summary: "Webview message handler for full refresh and oversized file details",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search(
			"fullRefreshIndexData requestOversizedFileDetails webview message handler",
			5,
		)

		expect(results[0].payload?.filePath).toBe("src/core/webview/webviewMessageHandler.ts")
		expect(results[0].matchReasons).toContain("oversized webview handler implementation match")
		expect(results[1].matchReasons).toContain("oversized webview handler unrelated surface penalty")
	})

	it("returns stage snapshots through searchDebug without changing the final result shape", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "schema-point",
				score: 0.72,
				payload: {
					filePath: "src/services/code-index-v2/store/schema.ts",
					chunkFingerprint: "schema-fp",
					codeChunk: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					startLine: 1,
					endLine: 10,
					chunkKind: "module",
				},
			},
		])
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				{
					chunkId: "schema-lexical",
					revisionId: "revision-1",
					chunkFingerprint: "schema-fp",
					startLine: 1,
					endLine: 10,
					language: "ts",
					chunkKind: "module",
					symbolName: null,
					symbolQualifiedName: null,
					parentSymbolName: null,
					parentChunkFingerprint: null,
					summary: "schema definitions for code index tables",
					searchText: "CREATE TABLE chunk_variants",
					content: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					contentHash: "schema-content-hash",
					tokenEstimate: 12,
					embeddingModel: null,
					vectorPointId: "schema-point",
					state: "upserted",
					createdAt: 1,
					updatedAt: 1,
					fileId: "file-1",
					workspaceId: "workspace-1",
					relativePath: "src/services/code-index-v2/store/schema.ts",
					normalizedPath: "/workspace/src/services/code-index-v2/store/schema.ts",
					parserVersion: "parser-v1",
					chunkerVersion: "chunker-v1",
					lexicalScore: 28,
				},
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 7,
				fallbackMs: 3,
				totalMs: 10,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const trace = await engine.searchDebug!("schema.ts CREATE TABLE chunk_variants", 5)

		expect(trace.timingsMs.totalMs).toBeGreaterThanOrEqual(0)
		expect(trace.timingsMs.lexicalRetrievalMs).toBeGreaterThanOrEqual(0)
		expect(trace.lexicalStatus).toBe("completed")
		expect(trace.lexicalMode).toBe("fts_plus_exact_fallback")
		expect(trace.stages.vector).toHaveLength(1)
		expect(trace.stages.lexical).toHaveLength(1)
		expect(trace.stages.merged).toHaveLength(1)
		expect(trace.stages.final).toHaveLength(1)
		expect(trace.stages.final[0]?.payload?.filePath).toBe("src/services/code-index-v2/store/schema.ts")
	})

	it("skips lexical retrieval in searchDebug for broad long natural language queries without retrieval hints", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([])
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				{
					chunkId: "lexical-1",
					revisionId: "revision-1",
					chunkFingerprint: "lexical-fp",
					startLine: 1,
					endLine: 10,
					language: "ts",
					chunkKind: "module",
					symbolName: null,
					symbolQualifiedName: null,
					parentSymbolName: null,
					parentChunkFingerprint: null,
					summary: "ignored",
					searchText: "ignored",
					content: "ignored",
					contentHash: "ignored",
					tokenEstimate: 12,
					embeddingModel: null,
					vectorPointId: "vector-1",
					state: "upserted",
					createdAt: 1,
					updatedAt: 1,
					fileId: "file-1",
					workspaceId: "workspace-1",
					relativePath: "src/ignored.ts",
					normalizedPath: "/workspace/src/ignored.ts",
					parserVersion: "parser-v1",
					chunkerVersion: "chunker-v1",
					lexicalScore: 28,
				},
			],
			status: "completed",
			mode: "fts_only",
			timingsMs: {
				ftsMs: 9,
				fallbackMs: 0,
				totalMs: 9,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const trace = await engine.searchDebug!(
			"How does Roo decide what code to use for general workspace behavior",
			5,
		)

		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).not.toHaveBeenCalled()
		expect(trace.stages.lexical).toHaveLength(0)
		expect(trace.timingsMs.lexicalRetrievalMs).toBe(0)
		expect(trace.lexicalStatus).toBe("skipped")
		expect(trace.lexicalMode).toBe("none")
	})

	it("runs FTS-only lexical retrieval for natural-language implementation queries", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "vector-point",
				score: 0.88,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					startLine: 1,
					endLine: 10,
					chunkKind: "method",
				},
			},
		])
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockReset()
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValue({
			results: [],
			status: "completed",
			mode: "fts_only",
			timingsMs: {
				ftsMs: 12,
				fallbackMs: 0,
				totalMs: 12,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const trace = await engine.searchDebug!("How does Roo add parent and sibling context to code search results", 5)

		expect(mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			"How does Roo add parent and sibling context to code search results",
			20,
			{ allowExactFallback: false },
		)
		expect(trace.lexicalStatus).toBe("completed")
		expect(trace.lexicalMode).toBe("fts_only")
		expect(trace.stages.lexical).toHaveLength(0)
		expect(trace.stages.final[0]?.payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(trace.timingsMs.lexicalRetrievalMs).toBeGreaterThanOrEqual(0)
	})

	it("uses separate dependency instances for indexing and search", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()
		await engine.searchDebug!("schema.ts CREATE TABLE chunk_variants", 5)

		expect(vi.mocked(ExistingEmbedderAdapter)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(QdrantRestVectorStoreAdapter)).toHaveBeenCalledTimes(2)
	})

	it("logs a compact indexing performance summary for successful runs", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()

		expect(vi.mocked(IndexDebugLoggerV2.log)).toHaveBeenCalledWith(
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

	it("merges lexical and vector candidates for the same chunk", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-vector",
				score: 0.72,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in src/auth.ts:10-14",
				},
			},
		])
		mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				{
					chunkId: "chunk-shared",
					revisionId: "revision-1",
					chunkFingerprint: "shared-fp",
					startLine: 10,
					endLine: 14,
					language: "ts",
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					parentSymbolName: "Auth",
					parentChunkFingerprint: null,
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
					searchText: "validateToken function",
					content: "export function validateToken() {}",
					contentHash: "hash-shared",
					tokenEstimate: 12,
					embeddingModel: null,
					vectorPointId: "point-vector",
					state: "upserted",
					createdAt: 1,
					updatedAt: 1,
					fileId: "file-1",
					workspaceId: "workspace-1",
					relativePath: "src/auth.ts",
					normalizedPath: "/workspace/src/auth.ts",
					parserVersion: "parser-v1",
					chunkerVersion: "chunker-v1",
					lexicalScore: 18,
				},
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 5,
				fallbackMs: 3,
				totalMs: 8,
			},
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("validateToken", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.chunkFingerprint).toBe("shared-fp")
		expect(results[0].matchReasons).toContain("lexical match")
		expect(results[0].matchReasons).toContain("symbol token overlap")
	})

	it("collapses multi-variant hits back to the raw-code payload", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-summary",
				score: 0.83,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					variantType: "summary",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
				},
			},
			{
				id: "point-raw",
				score: 0.79,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					variantType: "raw_code",
					codeChunk: "export function validateToken() { return true }",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("where do we validate the token", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.variantType).toBe("raw_code")
		expect(results[0].payload?.codeChunk).toBe("export function validateToken() { return true }")
		expect(results[0].matchReasons).toContain("summary variant match")
		expect(results[0].matchReasons).toContain("raw code grounding")
	})

	it("boosts symbol signature variants for symbol-oriented queries while grounding to raw code", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-signature",
				score: 0.8,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "sig-fp",
					variantType: "symbol_signature",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 20,
					endLine: 24,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			},
			{
				id: "point-raw",
				score: 0.74,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "sig-fp",
					variantType: "raw_code",
					codeChunk: "export function AssumeRoleWithWebIdentity() { return true }",
					startLine: 20,
					endLine: 24,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("Auth.AssumeRoleWithWebIdentity", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.variantType).toBe("raw_code")
		expect(results[0].matchReasons).toContain("symbol signature variant match")
		expect(results[0].matchReasons).toContain("raw code grounding")
	})

	it("expands parent chunks after strong child hits", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-method",
				score: 0.88,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-fp",
					codeChunk: "validateToken(token: string) { return token.length > 0 }",
					startLine: 20,
					endLine: 24,
					chunkKind: "method",
					symbolName: "validateToken",
					symbolQualifiedName: "AuthService.validateToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				},
			},
			{
				id: "point-other",
				score: 0.7,
				payload: {
					filePath: "src/services/other.ts",
					chunkFingerprint: "child-other-fp",
					codeChunk: "other helper",
					startLine: 1,
					endLine: 2,
				},
			},
		])
		mocks.metadataStore.getActiveChunksByFingerprints.mockResolvedValueOnce([
			{
				chunkId: "chunk-parent",
				revisionId: "revision-1",
				chunkFingerprint: "parent-class-fp",
				startLine: 1,
				endLine: 40,
				language: "ts",
				chunkKind: "class",
				symbolName: "AuthService",
				symbolQualifiedName: "AuthService",
				parentSymbolName: null,
				parentChunkFingerprint: null,
				summary: "ts class AuthService in src/services/auth.ts:1-40",
				searchText: "AuthService class definition",
				content: "class AuthService { validateToken() {} }",
				contentHash: "hash-parent",
				tokenEstimate: 25,
				embeddingModel: null,
				vectorPointId: "vector-parent",
				state: "upserted",
				createdAt: 1,
				updatedAt: 1,
				fileId: "file-1",
				workspaceId: "workspace-1",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("validateToken method", 3)

		expect(mocks.metadataStore.getActiveChunksByFingerprints).toHaveBeenCalledWith([
			{
				relativePath: "src/services/auth.ts",
				chunkFingerprint: "parent-class-fp",
			},
		])
		expect(results).toHaveLength(3)
		expect(results[0].payload?.symbolQualifiedName).toBe("AuthService.validateToken")
		expect(results[1].payload?.symbolQualifiedName).toBe("AuthService")
		expect(results[1].matchReasons).toContain("expanded parent context")
		expect(results[1].payload?.chunkKind).toBe("class")
		expect(results[2].id).toBe("point-other")
	})

	it("collapses duplicate child hits from the same parent and adds one sibling context", async () => {
		mocks.vectorStore.search.mockResolvedValueOnce([
			{
				id: "point-method-1",
				score: 0.89,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-a",
					codeChunk: "validateToken(token: string) {}",
					startLine: 20,
					endLine: 24,
					chunkKind: "method",
					symbolName: "validateToken",
					symbolQualifiedName: "AuthService.validateToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				},
			},
			{
				id: "point-method-2",
				score: 0.87,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-b",
					codeChunk: "refreshToken(token: string) {}",
					startLine: 30,
					endLine: 34,
					chunkKind: "method",
					symbolName: "refreshToken",
					symbolQualifiedName: "AuthService.refreshToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method refreshToken in AuthService at src/services/auth.ts:30-34",
				},
			},
			{
				id: "point-other",
				score: 0.7,
				payload: {
					filePath: "src/services/other.ts",
					chunkFingerprint: "child-other-fp",
					codeChunk: "other helper",
					startLine: 1,
					endLine: 2,
				},
			},
		])
		mocks.metadataStore.getActiveChunksByFingerprints.mockResolvedValueOnce([
			{
				chunkId: "chunk-parent",
				revisionId: "revision-1",
				chunkFingerprint: "parent-class-fp",
				startLine: 1,
				endLine: 40,
				language: "ts",
				chunkKind: "class",
				symbolName: "AuthService",
				symbolQualifiedName: "AuthService",
				parentSymbolName: null,
				parentChunkFingerprint: null,
				summary: "ts class AuthService in src/services/auth.ts:1-40",
				searchText: "AuthService class definition",
				content: "class AuthService { validateToken() {} refreshToken() {} }",
				contentHash: "hash-parent",
				tokenEstimate: 25,
				embeddingModel: null,
				vectorPointId: "vector-parent",
				state: "upserted",
				createdAt: 1,
				updatedAt: 1,
				fileId: "file-1",
				workspaceId: "workspace-1",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
		])
		mocks.metadataStore.getActiveChunksByRelativePaths.mockResolvedValueOnce([
			{
				chunkId: "chunk-method-a",
				revisionId: "revision-1",
				chunkFingerprint: "child-method-a",
				startLine: 20,
				endLine: 24,
				language: "ts",
				chunkKind: "method",
				symbolName: "validateToken",
				symbolQualifiedName: "AuthService.validateToken",
				parentSymbolName: "AuthService",
				parentChunkFingerprint: "parent-class-fp",
				summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				searchText: "validateToken method",
				content: "validateToken(token: string) {}",
				contentHash: "hash-a",
				tokenEstimate: 10,
				embeddingModel: null,
				vectorPointId: "vector-method-a",
				state: "upserted",
				createdAt: 1,
				updatedAt: 1,
				fileId: "file-1",
				workspaceId: "workspace-1",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
			{
				chunkId: "chunk-method-b",
				revisionId: "revision-1",
				chunkFingerprint: "child-method-b",
				startLine: 30,
				endLine: 34,
				language: "ts",
				chunkKind: "method",
				symbolName: "refreshToken",
				symbolQualifiedName: "AuthService.refreshToken",
				parentSymbolName: "AuthService",
				parentChunkFingerprint: "parent-class-fp",
				summary: "ts method refreshToken in AuthService at src/services/auth.ts:30-34",
				searchText: "refreshToken method",
				content: "refreshToken(token: string) {}",
				contentHash: "hash-b",
				tokenEstimate: 10,
				embeddingModel: null,
				vectorPointId: "vector-method-b",
				state: "upserted",
				createdAt: 1,
				updatedAt: 1,
				fileId: "file-1",
				workspaceId: "workspace-1",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
		])

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		const results = await engine.search("token method", 4)

		expect(results).toHaveLength(4)
		expect(results[0].payload?.symbolQualifiedName).toBe("AuthService.validateToken")
		expect(results[1].payload?.symbolQualifiedName).toBe("AuthService")
		expect(results[1].matchReasons).toContain("expanded parent context")
		expect(results[2].payload?.symbolQualifiedName).toBe("AuthService.refreshToken")
		expect(results[2].matchReasons).toContain("expanded sibling context")
		expect(results[3].id).toBe("point-other")
		expect(results.filter((result) => result.id === "point-method-2")).toHaveLength(0)
	})

	it("uses hashing_initial and explicit oversized counts on a fresh run without a baseline", async () => {
		mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(0)
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockImplementation(async (_runId, _signal, _relativePaths, options) => {
			options?.onProgress?.({
				checkedFiles: 12,
				changedFiles: 12,
				skippedFiles: 2,
				unchangedFiles: 0,
				oversizedFiles: 2,
				missingFiles: 0,
			})
			return {
				runId: "run-1",
				checkedFiles: 12,
				changedFiles: 12,
				skippedFiles: 2,
				unchangedFiles: 0,
				oversizedFiles: 2,
				missingFiles: 0,
			}
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Preparing files for indexing",
			0,
			2,
			expect.objectContaining({
				detailedStage: "hashing_initial",
			}),
		)
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
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
		mocks.metadataStore.countActiveIndexedFilesForWorkspace.mockResolvedValue(3)
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockImplementation(async (_runId, _signal, _relativePaths, options) => {
			options?.onProgress?.({
				checkedFiles: 15,
				changedFiles: 12,
				skippedFiles: 3,
				unchangedFiles: 3,
				oversizedFiles: 0,
				missingFiles: 0,
			})
			return {
				runId: "run-1",
				checkedFiles: 15,
				changedFiles: 12,
				skippedFiles: 3,
				unchangedFiles: 3,
				oversizedFiles: 0,
				missingFiles: 0,
			}
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Comparing file signatures",
			0,
			2,
			expect.objectContaining({
				detailedStage: "comparing_signatures",
			}),
		)
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
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

	it("retires newly oversized files immediately during targeted updates", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		await engine.start()
		mocks.discoveryService.runTargetedDiscovery.mockClear()
		mocks.metadataStore.beginRun.mockResolvedValueOnce("oversized-run")
		mocks.metadataStore.getFileRecordByWorkspacePathOptional.mockResolvedValueOnce({
			fileId: "file-oversized",
			relativePath: "src/huge.pb.go",
		})
		mocks.metadataStore.getActiveRevisionForFile.mockResolvedValueOnce({
			revisionId: "active-revision",
		})
		mocks.metadataStore.getChunksForRevision.mockResolvedValueOnce([{ chunkId: "chunk-1" }, { chunkId: "chunk-2" }])
		mocks.workspaceAdapter.statFile.mockResolvedValueOnce({
			path: "/workspace/src/huge.pb.go",
			mtimeMs: 2,
			size: 1_048_577,
		})

		await (engine as any).runTargetedUpdate(["/workspace/src/huge.pb.go"], "watcher")

		expect(mocks.discoveryService.runTargetedDiscovery).not.toHaveBeenCalled()
		expect(mocks.metadataStore.beginRun).toHaveBeenCalledWith("oversized-watcher")
		expect(mocks.metadataStore.enqueueJobs).toHaveBeenCalledWith([
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
		expect(mocks.metadataStore.markFileTombstoned).toHaveBeenCalledWith("file-oversized", true)
	})

	it("clears live V2 state instead of leaving watcher status behind", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)

		;(engine as any)._watcherCoordinator = mocks.watcherCoordinator
		;(engine as any)._reconciliationTimer = setInterval(() => undefined, 60_000)
		;(engine as any)._embeddingAdapter = mocks.embeddingAdapter
		;(engine as any)._vectorStore = mocks.vectorStore
		;(engine as any)._started = true

		await engine.clear()

		expect(mocks.watcherCoordinator.dispose).toHaveBeenCalled()
		expect(mocks.vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
		expect(mocks.vectorStore.recycleClient).toHaveBeenCalled()
		expect(mocks.embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(mocks.metadataStore.clearStorage).toHaveBeenCalledTimes(1)
		expect(mocks.stateManager.resetIndexingState).toHaveBeenCalledWith("Index data cleared successfully.")
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

	it("aborts an active run on stop and settles in standby instead of error", async () => {
		mocks.discoveryService.runWorkspaceDiscoveryWithProgress.mockResolvedValueOnce({
			runId: "run-1",
			discoveredFiles: 2,
			isPartial: false,
		})
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockImplementation(
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

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		const startPromise = engine.start()
		await vi.waitFor(() => {
			expect(mocks.statHashService.run).toHaveBeenCalledTimes(1)
		})

		await expect(engine.stop()).resolves.toBeUndefined()
		await expect(startPromise).resolves.toBeUndefined()

		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith("Stopping", "Stopping indexing...")
		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith("Standby", "Indexing stopped.")
		expect(mocks.metadataStore.markRunStopped).toHaveBeenCalledWith("run-1", "Stopped by user.")
		expect(mocks.metadataStore.dispose).toHaveBeenCalled()
		const status = await engine.getStatus()
		expect(status.state).toBe("idle")
		expect(status.message).toBe("Indexing stopped.")
	})

	it("plans and syncs preserved parsed revisions reused from a previous run", async () => {
		const backlog = zeroBacklog()

		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 5,
			skippedFiles: 0,
			changedFiles: 1,
			unchangedFiles: 0,
			oversizedFiles: 0,
			missingFiles: 0,
			reusedParsedRevisionIds: ["revision-reused"],
		})
		mocks.metadataStore.getChunksForRevision.mockResolvedValueOnce([
			{
				chunkId: "chunk-reused",
				revisionId: "revision-reused",
			},
			{
				chunkId: "chunk-reused-2",
				revisionId: "revision-reused",
			},
		])
		backlog.parsedRevisions = 1
		backlog.stagedChunks = 2
		mocks.parseChunkService.run.mockReset()
		mocks.parseChunkService.run.mockResolvedValueOnce({
			runId: "run-1",
			attemptedRevisions: 0,
			parsedRevisions: 0,
			parsedChunks: 0,
			parsedRevisionIds: [],
			retryingRevisions: 0,
			terminalFailedRevisions: 0,
		})
		mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		mocks.diffPlanner.run.mockReset()
		mocks.diffPlanner.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 1
			backlog.stagedChunks = 0
			backlog.queuedUpsertJobs = 2

			return {
				runId: "run-1",
				plannedRevisions: 1,
				upsertJobs: 2,
				deleteJobs: 0,
			}
		})
		mocks.embedUpsertWorker.run.mockReset()
		mocks.embedUpsertWorker.run.mockImplementation(async () => {
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			return {
				runId: "run-1",
				upsertedChunks: 2,
				deletedChunks: 0,
				committedRevisions: 1,
			}
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.anything(),
		)
		expect(mocks.embedUpsertWorker.run).toHaveBeenCalled()
	})

	it("keeps refilling the planner until runnable upsert work exists when embed lanes are underfed", async () => {
		const backlog = {
			...zeroBacklog(),
			parsedRevisions: 3,
			stagedChunks: 900,
		}

		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 65_000,
			skippedFiles: 0,
			changedFiles: 1,
			unchangedFiles: 0,
			oversizedFiles: 0,
			missingFiles: 0,
			reusedParsedRevisionIds: [],
		})
		mocks.parseChunkService.run.mockReset()
		mocks.parseChunkService.run
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
		mocks.metadataStore.getRunBacklogMetrics.mockImplementation(async () => ({ ...backlog }))
		mocks.diffPlanner.run.mockReset()
		mocks.diffPlanner.run
			.mockImplementationOnce(async () => {
				backlog.parsedRevisions = 2
				backlog.stagedChunks = 850
				backlog.queuedUpsertJobs = 0
				backlog.runningUpsertJobs = 0
				return {
					runId: "run-1",
					plannedRevisions: 1,
					upsertJobs: 0,
					deleteJobs: 0,
				}
			})
			.mockImplementationOnce(async () => {
				backlog.parsedRevisions = 1
				backlog.stagedChunks = 600
				backlog.queuedUpsertJobs = 350
				return {
					runId: "run-1",
					plannedRevisions: 1,
					upsertJobs: 350,
					deleteJobs: 0,
				}
			})
		mocks.embedUpsertWorker.run.mockReset()
		mocks.embedUpsertWorker.run.mockImplementation(async () => {
			backlog.parsedRevisions = 0
			backlog.plannedRevisions = 0
			backlog.queuedUpsertJobs = 0
			backlog.runningUpsertJobs = 0
			backlog.stagedChunks = 0
			return {
				runId: "run-1",
				upsertedChunks: 350,
				deletedChunks: 0,
				committedRevisions: 1,
			}
		})

		const logSpy = vi.spyOn(IndexDebugLoggerV2, "log").mockImplementation(() => {})
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.diffPlanner.run).toHaveBeenCalledTimes(2)
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
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
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

	it("reports raw parsed chunk totals to the state manager so embedding estimates are not double-extrapolated", async () => {
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 10,
			skippedFiles: 0,
			changedFiles: 10,
		})
		mocks.parseChunkService.run.mockReset()
		mocks.parseChunkService.run
			.mockImplementationOnce(async (_runId, _signal, onProgress) => {
				onProgress?.({ parsedRevisions: 2, parsedChunks: 10 })
				return {
					runId: "run-1",
					attemptedRevisions: 2,
					parsedRevisions: 2,
					parsedChunks: 10,
					parsedRevisionIds: ["revision-1", "revision-2"],
					retryingRevisions: 0,
					terminalFailedRevisions: 0,
				}
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
		mocks.embedUpsertWorker.run.mockReset()
		mocks.embedUpsertWorker.run.mockImplementationOnce(async (_runId, _signal, onProgress) => {
			onProgress?.({
				upsertedChunks: 4,
				deletedChunks: 0,
				committedRevisions: 0,
				batchesCompleted: 1,
				chunksPerSecond: 2,
				averageBatchLatencyMs: 2000,
				lastBatchLatencyMs: 2000,
			})
			return {
				runId: "run-1",
				upsertedChunks: 4,
				deletedChunks: 0,
				committedRevisions: 1,
			}
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.stateManager.startEmbedPhase).toHaveBeenCalledWith(
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
		expect(mocks.stateManager.reportEmbedProgress).toHaveBeenCalledWith(
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

	it("continues parsing after an all-failure batch instead of treating it as completion", async () => {
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 40,
			skippedFiles: 0,
			changedFiles: 40,
		})
		mocks.parseChunkService.run.mockReset()
		mocks.parseChunkService.run
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 20,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 20,
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 1,
				parsedRevisions: 1,
				parsedChunks: 2,
				parsedRevisionIds: ["revision-recovered"],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
		mocks.embedUpsertWorker.run.mockReset()
		mocks.embedUpsertWorker.run.mockResolvedValueOnce({
			runId: "run-1",
			upsertedChunks: 2,
			deletedChunks: 0,
			committedRevisions: 1,
		})
		mocks.embedUpsertWorker.run.mockResolvedValue({
			runId: "run-1",
			upsertedChunks: 2,
			deletedChunks: 0,
			committedRevisions: 1,
		})

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.parseChunkService.run).toHaveBeenCalledTimes(3)
		expect(mocks.diffPlanner.run).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({
				limit: 50,
				maxJobs: 1500,
			}),
			expect.any(Object),
		)
		expect(mocks.embedUpsertWorker.run).toHaveBeenCalled()
	})

	it("adopts retryable queued jobs from stale runs into the new run on startup", async () => {
		mocks.metadataStore.cleanupStaleRuns.mockResolvedValueOnce({
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
		mocks.metadataStore.adoptRetryableJobsFromStaleRuns.mockResolvedValueOnce(4)
		mocks.metadataStore.countOutstandingResumedJobs.mockResolvedValueOnce(4).mockResolvedValue(0)

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [
			"stale-run-1",
			"stale-run-2",
		])
		const status = await engine.getStatus()
		expect(status.message).toContain("V2 mapped 2 files")
		expect(status.message).not.toContain("queued retry jobs")
	})

	it("does not enter embedding for a no-op background reconcile on an already indexed workspace", async () => {
		mocks.statHashService.run.mockReset()
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-1",
			checkedFiles: 2,
			skippedFiles: 1,
			changedFiles: 1,
		})
		mocks.statHashService.run.mockResolvedValueOnce({
			runId: "run-reconcile",
			checkedFiles: 2,
			skippedFiles: 2,
			changedFiles: 0,
		})
		mocks.parseChunkService.run.mockReset()
		mocks.parseChunkService.run
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 1,
				parsedRevisions: 1,
				parsedChunks: 3,
				parsedRevisionIds: ["revision-1"],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
			.mockResolvedValueOnce({
				runId: "run-1",
				attemptedRevisions: 0,
				parsedRevisions: 0,
				parsedChunks: 0,
				parsedRevisionIds: [],
				retryingRevisions: 0,
				terminalFailedRevisions: 0,
			})
		mocks.embedUpsertWorker.run.mockClear()

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()
		mocks.stateManager.startEmbedPhase.mockClear()
		mocks.stateManager.reportEmbedProgress.mockClear()
		mocks.stateManager.reportCustomProgress.mockClear()

		await (engine as any).runReconciliation()

		expect(mocks.discoveryService.runReconciliationDiscovery).toHaveBeenCalledTimes(1)
		expect(mocks.embedUpsertWorker.run).toHaveBeenCalledTimes(1)
		expect(mocks.stateManager.startEmbedPhase).not.toHaveBeenCalled()
		expect(mocks.stateManager.reportEmbedProgress).not.toHaveBeenCalled()
		expect(mocks.stateManager.reportCustomProgress).toHaveBeenCalledWith(
			"Reconciling local state with the workspace",
			0,
			1,
			expect.objectContaining({
				detailedStage: "reconciling",
				isBackgroundReconcile: true,
			}),
		)
		expect(mocks.stateManager.setSystemState).toHaveBeenCalledWith("Standby", "V2 is current across 3 files")
	})

	it("resumes queued retry jobs from prior failed runs even without freshly detected stale runs", async () => {
		mocks.metadataStore.cleanupStaleRuns.mockResolvedValueOnce({
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
		mocks.metadataStore.adoptRetryableJobsFromStaleRuns.mockResolvedValueOnce(3)
		mocks.metadataStore.countOutstandingResumedJobs.mockResolvedValueOnce(3).mockResolvedValue(0)

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [])
		expect(mocks.stateManager.setResilienceStats).toHaveBeenCalledWith(
			expect.objectContaining({
				resumedRetryJobs: 3,
				resumedPendingJobs: 3,
			}),
		)
		const status = await engine.getStatus()
		expect(status.message).not.toContain("queued retry jobs")
	})

	it("passes warning sort through when fetching warning details", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.getWarningDetails(10, 5, "failed", "path")

		expect(mocks.metadataStore.listRevisionWarnings).toHaveBeenCalledWith("workspace-1", 5, 10, "failed", "path")
	})

	it("retries only warning-state files through a targeted update", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()
		mocks.discoveryService.runTargetedDiscovery.mockClear()
		mocks.metadataStore.listWarningRelativePaths.mockResolvedValueOnce([
			"src/problematic/parser.ts",
			"src/problematic/embed.ts",
		])
		mocks.discoveryService.runTargetedDiscovery.mockResolvedValueOnce({
			runId: "run-targeted",
			discoveredFiles: 2,
			isPartial: false,
		})

		const result = await engine.retryWarningFiles("all")

		expect(result).toEqual({ retriedFiles: 2 })
		expect(mocks.metadataStore.listWarningRelativePaths).toHaveBeenCalledWith("workspace-1", "all")
		expect(mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/problematic/parser.ts", "/workspace/src/problematic/embed.ts"],
			"manual",
			undefined,
		)
	})

	it("retries only the explicitly requested warning file when relative paths are provided", async () => {
		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()
		mocks.discoveryService.runTargetedDiscovery.mockClear()
		mocks.metadataStore.listWarningRelativePaths.mockClear()
		mocks.discoveryService.runTargetedDiscovery.mockResolvedValueOnce({
			runId: "run-targeted",
			discoveredFiles: 1,
			isPartial: false,
		})

		const result = await engine.retryWarningFiles("failed", ["src/problematic/embed.ts"])

		expect(result).toEqual({ retriedFiles: 1 })
		expect(mocks.metadataStore.listWarningRelativePaths).not.toHaveBeenCalled()
		expect(mocks.discoveryService.runTargetedDiscovery).toHaveBeenCalledWith(
			["/workspace/src/problematic/embed.ts"],
			"manual",
			undefined,
		)
	})
})
