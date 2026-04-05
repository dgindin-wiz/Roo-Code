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
		expect(mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 5, 0.4)
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
		for (let i = 0; i < 10; i++) {
			await Promise.resolve()
		}
		expect(mocks.statHashService.run).toHaveBeenCalledTimes(1)

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
