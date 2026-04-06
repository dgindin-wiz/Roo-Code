import { beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"

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
		listRevisionWarnings: vi.fn().mockResolvedValue({ total: 0, items: [] }),
		listWarningRelativePaths: vi.fn().mockResolvedValue([]),
		beginRun: vi.fn().mockResolvedValue("delete-run"),
		getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		getFileRecordByWorkspacePathOptional: vi.fn().mockResolvedValue(undefined),
		getActiveRevisionForFile: vi.fn().mockResolvedValue(undefined),
		getChunksForRevision: vi.fn().mockResolvedValue([]),
		getActiveChunksByFingerprints: vi.fn().mockResolvedValue([]),
		getActiveChunksByRelativePaths: vi.fn().mockResolvedValue([]),
		searchActiveChunksLexically: vi.fn().mockResolvedValue([]),
		enqueueJobs: vi.fn().mockResolvedValue(undefined),
		markFileTombstoned: vi.fn().mockResolvedValue(undefined),
		markRunComplete: vi.fn().mockResolvedValue(undefined),
		markRunFailed: vi.fn().mockResolvedValue(undefined),
		markRunStopped: vi.fn().mockResolvedValue(undefined),
		clearStorage: vi.fn().mockResolvedValue(undefined),
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
	}

	const diffPlanner = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			plannedRevisions: 1,
			upsertJobs: 3,
			deleteJobs: 0,
		}),
	}

	const embedUpsertWorker = {
		run: vi.fn().mockResolvedValue({
			runId: "run-1",
			upsertedChunks: 3,
			deletedChunks: 0,
			committedRevisions: 1,
		}),
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
		reportCustomProgress: vi.fn(),
		reportHeartbeat: vi.fn(),
		setActivityDetail: vi.fn(),
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
		setContext: vi.fn(),
		log: vi.fn(),
		getMemorySnapshot: vi.fn(() => ({
			rssMB: 512,
			externalMB: 32,
			heapUsedMB: 128,
			heapTotalMB: 256,
		})),
	},
}))

describe("CodeIndexEngineV2 smoke", () => {
	const mockContext = {
		globalStorageUri: { fsPath: "/global-storage" },
	} as any

	const mockConfigManager = {
		currentEmbedderProvider: "ollama",
		currentModelId: "text-embedding-3-small",
		currentModelDimension: 1536,
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

		expect(mocks.metadataStore.initialize).toHaveBeenCalledTimes(1)
		expect(mocks.metadataStore.cleanupStaleRuns).toHaveBeenCalledTimes(1)
		expect(mocks.metadataStore.adoptRetryableJobsFromStaleRuns).toHaveBeenCalledWith("run-1", [])
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
			{
				limit: 20,
			},
		)
		expect(mocks.parseChunkService.run).toHaveBeenNthCalledWith(
			2,
			"run-1",
			expect.any(Object),
			expect.any(Function),
			{
				limit: 20,
			},
		)
		expect(mocks.diffPlanner.run).toHaveBeenCalledWith("run-1", expect.any(Object), {
			revisionIds: ["revision-1"],
		})
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
		expect(mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 15, 0.4)
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
		mocks.metadataStore.searchActiveChunksLexically.mockResolvedValueOnce([
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
		])

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
		mocks.metadataStore.searchActiveChunksLexically.mockResolvedValueOnce([
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
		])

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
		expect((engine as any)._embeddingAdapter).toBeUndefined()
		expect((engine as any)._vectorStore).toBeUndefined()
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

		const engine = new CodeIndexEngineV2(mockContext, "/workspace", mockConfigManager, mocks.stateManager as any)
		await engine.start()

		expect(mocks.diffPlanner.run).toHaveBeenCalledWith("run-1", expect.anything(), {
			revisionIds: ["revision-reused"],
		})
		expect(mocks.embedUpsertWorker.run).toHaveBeenCalled()
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
			false,
			expect.objectContaining({
				detailedStage: "embedding",
				hasKnownVectorWork: true,
				hasStartedVectorSync: true,
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
		expect(mocks.diffPlanner.run).toHaveBeenCalledWith("run-1", expect.any(Object), {
			revisionIds: ["revision-recovered"],
		})
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
