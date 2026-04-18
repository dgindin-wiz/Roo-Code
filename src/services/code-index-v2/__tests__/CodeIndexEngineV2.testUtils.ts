import { vi } from "vitest"

export const createDeferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})

	return { promise, resolve, reject }
}

export const createMockContext = (fsPath = "/global-storage") =>
	({
		globalStorageUri: { fsPath },
	}) as any

export const createMockConfigManager = (overrides: Record<string, unknown> = {}) =>
	({
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
		...overrides,
	}) as any

export const createMockStateManager = () => ({
	startIndexingTimer: vi.fn(),
	beginPipelineRun: vi.fn(),
	setPipelineSnapshot: vi.fn(),
	setPipelineRuntimeSnapshot: vi.fn(),
	setStandbyPipelineSnapshot: vi.fn(),
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
})

export const zeroBacklog = (overrides: Record<string, unknown> = {}) => ({
	parsedRevisions: 0,
	plannedRevisions: 0,
	stagedChunks: 0,
	queuedUpsertJobs: 0,
	runningUpsertJobs: 0,
	queuedDeleteJobs: 0,
	runningDeleteJobs: 0,
	...overrides,
})

export const createResolvedMetadataPaths = (workspacePath = "/workspace") => ({
	workspaceHash: "workspace-1",
	workspacePath,
	rootDir: "/global-storage/code-index-v2/workspace-1",
	persistentRootDir: "/global-storage/code-index-v2/persistent/workspace-1",
	diagnosticsRootDir: "/global-storage/code-index-v2/persistent/workspace-1/diagnostics",
	legacyDiagnosticsRootDir: "/global-storage/code-index-v2/workspace-1",
	dbPath: "/global-storage/code-index-v2/persistent/workspace-1/roo-code-index-v2.sqlite",
	telemetryDbPath: "/global-storage/code-index-v2/persistent/workspace-1/roo-code-index-v2-telemetry.sqlite",
	bootstrapPath: "/global-storage/code-index-v2/workspace-1/bootstrap.json",
})

export const createDiscoverySummary = (overrides: Record<string, unknown> = {}) => ({
	runId: "run-1",
	discoveredFiles: 2,
	isPartial: false,
	...overrides,
})

export const createStatHashSummary = (overrides: Record<string, unknown> = {}) => ({
	runId: "run-1",
	checkedFiles: 2,
	skippedFiles: 1,
	changedFiles: 1,
	unchangedFiles: 1,
	oversizedFiles: 0,
	missingFiles: 0,
	reusedParsedRevisionIds: [],
	...overrides,
})

export const createParseSummary = (overrides: Record<string, unknown> = {}) => ({
	runId: "run-1",
	attemptedRevisions: 1,
	parsedRevisions: 1,
	parsedChunks: 3,
	parsedRevisionIds: ["revision-1"],
	retryingRevisions: 0,
	terminalFailedRevisions: 0,
	...overrides,
})

export const createPlannerSummary = (overrides: Record<string, unknown> = {}) => ({
	runId: "run-1",
	plannedRevisions: 1,
	upsertJobs: 3,
	deleteJobs: 0,
	reusedFingerprintUpserts: 0,
	deletedMissingFingerprintChunks: 0,
	safetyFallbackRevisions: 0,
	plannerSliceLatencyMs: 0,
	...overrides,
})

export const createEmbedSummary = (overrides: Record<string, unknown> = {}) => ({
	runId: "run-1",
	upsertedChunks: 3,
	deletedChunks: 0,
	committedRevisions: 1,
	...overrides,
})

export const createSearchPayload = (overrides: Record<string, unknown> = {}) => ({
	filePath: "src/example.ts",
	chunkFingerprint: "fp-1",
	codeChunk: "const value = 1",
	startLine: 1,
	endLine: 1,
	...overrides,
})

export const createVectorHit = (overrides: Record<string, unknown> = {}) => {
	const payloadOverrides = (overrides.payload as Record<string, unknown> | undefined) ?? {}
	const { payload: _payload, ...hitOverrides } = overrides
	return {
		id: "point-1",
		score: 0.9,
		payload: createSearchPayload(payloadOverrides),
		...hitOverrides,
	}
}

export const createChunkRecord = (overrides: Record<string, unknown> = {}) => ({
	chunkId: "chunk-1",
	revisionId: "revision-1",
	chunkFingerprint: "fp-1",
	startLine: 1,
	endLine: 2,
	language: "ts",
	chunkKind: "function",
	symbolName: null,
	symbolQualifiedName: null,
	parentSymbolName: null,
	parentChunkFingerprint: null,
	summary: null,
	searchText: null,
	content: "export const value = 1",
	contentHash: "hash-1",
	tokenEstimate: 12,
	embeddingModel: null,
	vectorPointId: null,
	state: "upserted",
	createdAt: 1,
	updatedAt: 1,
	fileId: "file-1",
	workspaceId: "workspace-1",
	relativePath: "src/example.ts",
	normalizedPath: "/workspace/src/example.ts",
	parserVersion: "parser-v1",
	chunkerVersion: "chunker-v1",
	...overrides,
})

export const createLexicalChunk = (overrides: Record<string, unknown> = {}) => ({
	...createChunkRecord(overrides),
	lexicalScore: 18,
})

export const createFileRecord = (overrides: Record<string, unknown> = {}) => ({
	fileId: "file-1",
	workspaceId: "workspace-1",
	relativePath: "src/example.ts",
	normalizedPath: "/workspace/src/example.ts",
	lastSeenMtimeMs: 1,
	lastSeenSize: 128,
	ignoreState: "included",
	activeRevisionId: "revision-1",
	tombstoned: false,
	latestRevisionId: "revision-1",
	latestRevisionContentHash: "hash-1",
	latestRevisionFastFingerprint: "fp-1",
	latestRevisionState: "committed",
	...overrides,
})

export const createRevisionRecord = (overrides: Record<string, unknown> = {}) => ({
	revisionId: "revision-1",
	fileId: "file-1",
	runId: "run-1",
	...overrides,
})

export const createBaseEngineHarness = () => {
	const context = createMockContext()
	const configManager = createMockConfigManager()
	const resolvedPaths = createResolvedMetadataPaths("/workspace")
	const fsAccess = vi.fn().mockResolvedValue(undefined)
	const fsStat = vi.fn().mockResolvedValue({ size: 1024 })

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
		listRunSummaries: vi.fn().mockResolvedValue([]),
		getRunSummary: vi.fn().mockResolvedValue(undefined),
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
		listReadyRevisionResolutions: vi.fn().mockResolvedValue([]),
		listPlannedRevisionResolutions: vi.fn().mockResolvedValue([]),
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
		performMaintenance: vi.fn().mockResolvedValue({
			checkpointMode: "PASSIVE",
			shrinkMemory: true,
			operationalDbBytes: 0,
			operationalWalBytes: 0,
			telemetryDbBytes: 0,
			telemetryWalBytes: 0,
			memoryBefore: { rssMB: 0, heapUsedMB: 0, externalMB: 0, arrayBuffersMB: 0 },
			memoryAfter: { rssMB: 0, heapUsedMB: 0, externalMB: 0, arrayBuffersMB: 0 },
		}),
		countChunksForRevisions: vi.fn().mockResolvedValue(0),
		getRunProgressRecord: vi.fn().mockResolvedValue(undefined),
		listRecentRunProgress: vi.fn().mockResolvedValue([]),
		writeRunSummary: vi.fn().mockResolvedValue(undefined),
		clearStorage: vi.fn().mockResolvedValue(undefined),
		getDatabasePath: vi.fn().mockReturnValue(resolvedPaths.dbPath),
		getTelemetryDatabasePath: vi.fn().mockReturnValue(resolvedPaths.telemetryDbPath),
		getDiagnosticsDirectoryPath: vi.fn().mockReturnValue(resolvedPaths.diagnosticsRootDir),
		getDiagnosticsSnapshot: vi.fn(() => ({
			role: "writer",
			label: "metadata-writer-sidecar",
			state: "standby",
			pid: null,
			pendingRequestCount: 0,
			lastOperation: null,
			lastElapsedMs: null,
			lastTimeoutMs: null,
			lastError: null,
			updatedAt: 1,
		})),
	}
	const metadataReadStore = {
		...metadataStore,
		initialize: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
		getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		getDatabasePath: vi.fn().mockReturnValue(resolvedPaths.dbPath),
		getTelemetryDatabasePath: vi.fn().mockReturnValue(resolvedPaths.telemetryDbPath),
		getDiagnosticsDirectoryPath: vi.fn().mockReturnValue(resolvedPaths.diagnosticsRootDir),
		getDiagnosticsSnapshot: vi.fn(() => ({
			role: "reader",
			label: "metadata-reader-sidecar",
			state: "standby",
			pid: null,
			pendingRequestCount: 0,
			lastOperation: null,
			lastElapsedMs: null,
			lastTimeoutMs: null,
			lastError: null,
			updatedAt: 1,
		})),
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
		runInitialDiscovery: vi.fn().mockResolvedValue(createDiscoverySummary()),
		runWorkspaceDiscoveryWithProgress: vi.fn().mockImplementation(async (_triggerType, _signal, onProgress) => {
			onProgress?.({ discoveredFiles: 2 })
			return createDiscoverySummary()
		}),
		runReconciliationDiscovery: vi.fn().mockResolvedValue(createDiscoverySummary({ runId: "run-reconcile" })),
		runTargetedDiscovery: vi
			.fn()
			.mockResolvedValue(createDiscoverySummary({ runId: "run-targeted", discoveredFiles: 1 })),
	}

	const statHashService = {
		run: vi.fn().mockResolvedValue(createStatHashSummary()),
	}

	const parseChunkService = {
		run: vi
			.fn()
			.mockResolvedValueOnce(createParseSummary())
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
					runId: "run-reconcile",
					attemptedRevisions: 0,
					parsedRevisions: 0,
					parsedChunks: 0,
					parsedRevisionIds: [],
				}),
			),
		dispose: vi.fn().mockResolvedValue(undefined),
	}

	const diffPlanner = {
		run: vi.fn().mockResolvedValue(createPlannerSummary()),
	}
	metadataStore.runPlannerSlice = diffPlanner.run

	const embedUpsertWorker = {
		run: vi.fn().mockResolvedValue(createEmbedSummary()),
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
			createVectorHit({
				payload: {
					filePath: "src/example.ts",
					codeChunk: "const value = 1",
					startLine: 1,
					endLine: 1,
				},
			}),
		]),
		recycleClient: vi.fn().mockResolvedValue(undefined),
	}

	const serviceFactory = {
		createEmbedder: vi.fn().mockReturnValue({
			createEmbeddings: vi.fn(),
			embedderInfo: { name: "openai" },
		}),
	}

	const stateManager = createMockStateManager()
	const logger = {
		configureDiagnosticsDirectory: vi.fn(),
		setContext: vi.fn(),
		log: vi.fn(),
		getMemorySnapshot: vi.fn(() => ({
			rssMB: 512,
			externalMB: 32,
			heapUsedMB: 128,
			heapTotalMB: 256,
			arrayBuffersMB: 8,
		})),
		getCpuSnapshot: vi.fn(() => ({
			processPercent: 12,
		})),
		getTrackedProcessSummary: vi.fn(() => ({
			totalTrackedRssMB: 96,
			byGroup: {
				parseSidecars: { totalRssMB: 48 },
				embedSidecars: { totalRssMB: 48 },
				metadataWriterSidecar: { totalRssMB: 32, totalCpuPercent: 2, totalHeapUsedMB: 12 },
				metadataReaderSidecar: { totalRssMB: 16, totalCpuPercent: 1, totalHeapUsedMB: 6 },
			},
		})),
		getBuildInfo: vi.fn(() => ({
			version: "test-version",
			buildTimestamp: "2026-04-10T00:00:00.000Z",
			sha: "test-sha",
		})),
	}

	const harness = {
		context,
		configManager,
		resolvedPaths,
		fsAccess,
		fsStat,
		metadataStore,
		metadataReadStore,
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
		logger,
	}

	metadataStore.getRunBacklogMetrics.mockImplementation(async () => {
		if (harness.embedUpsertWorker.run.mock.calls.length > 0) {
			return zeroBacklog()
		}
		if (harness.diffPlanner.run.mock.calls.length > 0) {
			return zeroBacklog({
				plannedRevisions: 1,
				queuedUpsertJobs: 3,
			})
		}
		if (harness.parseChunkService.run.mock.calls.length > 0) {
			return zeroBacklog({
				parsedRevisions: 1,
				stagedChunks: 3,
			})
		}
		return zeroBacklog()
	})

	return harness
}

export type EngineHarness = ReturnType<typeof createBaseEngineHarness>
