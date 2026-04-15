import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import type {
	IndexingHealthState,
	IndexingPipelineRunMode,
	IndexingServiceMetric,
	IndexingServiceSnapshot,
	IndexingServiceState,
} from "@roo-code/types"
import { CodeIndexStateManager } from "../../code-index/state-manager"
import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { CacheManager } from "../../code-index/cache-manager"
import { CodeIndexConfigManager } from "../../code-index/config-manager"
import { CodeIndexServiceFactory } from "../../code-index/service-factory"
import { ExistingEmbedderAdapter } from "../adapters/ExistingEmbedderAdapter"
import { QdrantRestVectorStoreAdapter } from "../adapters/QdrantRestVectorStoreAdapter"
import { VsCodeWorkspaceAdapter } from "../adapters/VsCodeWorkspaceAdapter"
import { CodeIndexParserAdapter } from "../adapters/CodeIndexParserAdapter"
import { DiscoveryService } from "../discovery"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import {
	describeOversizedFile,
	DiffPlanner,
	EmbedUpsertWorker,
	ParseChunkService,
	SidecarParseExecutor,
	SidecarEmbedUpsertExecutor,
	StatHashService,
	type OversizedFileDetail,
} from "../pipeline"
import { ReconciliationService } from "../reconciliation/ReconciliationService"
import { EmbeddingRuntimeProfileStore } from "../store/EmbeddingRuntimeProfileStore"
import { MetadataStore } from "../store/MetadataStore"
import { CODE_INDEX_V2_ENGINE_ID } from "../shared/constants"
import {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
	buildEmbeddingRuntimeProfileKey,
	normalizeEmbeddingEndpointFingerprint,
} from "../shared/adaptiveEmbeddingController"
import { WatcherCoordinator } from "../watcher"
import {
	CodeIndexDebugLexicalMode,
	CodeIndexDebugLexicalStatus,
	CodeIndexDebugSearchTrace,
	CodeIndexStatus,
	ICodeIndexEngine,
} from "./interfaces"
import { CodeIndexV2GpuSnapshot } from "../logging/log-types"
import {
	buildPipelineBacklogSample,
	getParseThrottleReason,
	shouldPrioritizePlannerRefill,
	shouldResumeParseFromThrottle,
} from "./pipelineDiagnostics"

type QueryIntent = {
	pathHints: string[]
	symbolHints: string[]
	lexicalExpansionTerms: string[]
	looksLikeNaturalLanguage: boolean
	looksLikeCodeQuestion: boolean
	looksLikeImplementationQuery: boolean
	looksLikeSearchResultsDisplayQuery: boolean
	looksLikeEvalRunnerQuery: boolean
	looksLikePreflightQuery: boolean
	looksLikeLowValueFilesQuery: boolean
	looksLikeOversizedWebviewHandlerQuery: boolean
	looksLikeRetrievalExpansionQuery: boolean
	looksLikeHybridRetrievalQuery: boolean
	looksLikeStartupTrackingQuery: boolean
	looksLikeFullRefreshManagerQuery: boolean
	looksLikeSchemaQuery: boolean
	ddlHints: string[]
	contentHints: string[]
	implementationHints: string[]
}

type SearchRerankContext = {
	normalizedQuery: string
	queryTokens: string[]
	desiredChunkKinds: Set<string>
	queryIntent: QueryIntent
}

type SearchResultFeatures = {
	symbolName: string
	symbolQualifiedName: string
	parentSymbolName: string
	filePath: string
	fileBasename: string
	summary: string
	codeChunk: string
	searchText: string
	chunkKind: string
}

type SearchSurfaceCategories = {
	isEngineModuleSurface: boolean
	isEvalSurface: boolean
	isStorageSurface: boolean
	isParserAdapterSurface: boolean
	isHandlerSurface: boolean
	isUiDisplaySurface: boolean
	isToolOrWrapperSurface: boolean
	isConfigOrTypesSurface: boolean
	isTestSurface: boolean
	isFixtureSurface: boolean
	isCliOrHarnessSurface: boolean
	isI18nSurface: boolean
	isContextManagementSurface: boolean
}

export class CodeIndexEngineV2 implements ICodeIndexEngine {
	private static readonly REVISION_BATCH_SIZE = 20
	private static readonly LARGE_WORKSPACE_FILE_THRESHOLD = 20_000
	private static readonly EMBED_QUEUE_HIGH_WATERMARK = 2_000
	private static readonly EMBED_QUEUE_LOW_WATERMARK = 500
	private static readonly STAGED_BYTES_HIGH_WATERMARK = 96 * 1024 * 1024
	private static readonly STAGED_BYTES_LOW_WATERMARK = 32 * 1024 * 1024
	private static readonly PARSED_REVISION_HIGH_WATERMARK = 300
	private static readonly PARSED_REVISION_LOW_WATERMARK = 75
	private static readonly PLANNER_REVISION_SLICE = 50
	private static readonly PLANNER_JOB_BUDGET = 1_500
	private static readonly RUN_HEARTBEAT_INTERVAL_MS = 5_000
	private static readonly SQLITE_MAINTENANCE_INTERVAL_MS = 30_000
	private static readonly PIPELINE_POLL_INTERVAL_MS = 250
	private static readonly HEARTBEAT_INTERVAL_MS = 2_000
	private static readonly PREFLIGHT_QDRANT_TIMEOUT_MS = 10_000
	private static readonly PREFLIGHT_EMBEDDER_TIMEOUT_MS = 15_000
	public readonly engine = CODE_INDEX_V2_ENGINE_ID
	private _status: CodeIndexStatus = {
		engine: CODE_INDEX_V2_ENGINE_ID,
		state: "idle",
	}
	private readonly metadataStore: MetadataStore
	private readonly embeddingRuntimeProfileStore: EmbeddingRuntimeProfileStore
	private _indexEmbeddingAdapter: ExistingEmbedderAdapter | undefined
	private _indexVectorStore: QdrantRestVectorStoreAdapter | undefined
	private _searchEmbeddingAdapter: ExistingEmbedderAdapter | undefined
	private _searchVectorStore: QdrantRestVectorStoreAdapter | undefined
	private _workspaceAdapter: VsCodeWorkspaceAdapter | undefined
	private _activeParseChunkService: ParseChunkService | undefined
	private _activeEmbedUpsertWorker: EmbedUpsertWorker | undefined
	private _watcherCoordinator: WatcherCoordinator | undefined
	private _reconciliationTimer: NodeJS.Timeout | undefined
	private _activityHeartbeatTimer: NodeJS.Timeout | undefined
	private _activeAbortController: AbortController | undefined
	private _lastCpuSample:
		| {
				cpuUsage: NodeJS.CpuUsage
				timeNs: bigint
		  }
		| undefined
	private _started = false
	private _stopRequested = false
	private _operationChain: Promise<void> = Promise.resolve()
	private _staleRunIdsToResume: string[] = []
	private _resumedRetryJobsCount = 0
	private _resumedPendingJobsCount = 0

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly workspacePath: string,
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
	) {
		this.metadataStore = new MetadataStore(context, workspacePath)
		this.embeddingRuntimeProfileStore = new EmbeddingRuntimeProfileStore(context)
	}

	async start(): Promise<void> {
		if (this._started) {
			return
		}

		this._stopRequested = false
		this._started = true
		this._status = {
			engine: this.engine,
			state: "starting",
			message: "Warming up the V2 index engine",
		}

		// Point the logger at the workspace-scoped diagnostics file before the
		// first session-start write so early startup events do not land in the
		// home-directory fallback log.
		IndexDebugLoggerV2.configureDiagnosticsDirectory(
			this.metadataStore.getDiagnosticsDirectoryPath(),
			this.workspacePath,
		)
		IndexDebugLoggerV2.setContext({
			engine: this.engine,
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
		})

		try {
			await this.metadataStore.initialize()
			const staleRunCleanup = await this.metadataStore.cleanupStaleRuns()
			this._staleRunIdsToResume = staleRunCleanup.staleRunIds
			this._resumedRetryJobsCount = 0
			this._resumedPendingJobsCount = 0
			if (staleRunCleanup.staleRunIds.length > 0) {
				this.stateManager.setRecoveryContext("stale_recovery", "reusable_revisions")
			}
			if (staleRunCleanup.staleRunsMarkedFailed > 0) {
				IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stale-v2-runs-cleaned", {
					component: "CodeIndexEngineV2",
					workspacePath: this.workspacePath,
					jobId: `${staleRunCleanup.staleRunsMarkedFailed}:${staleRunCleanup.staleJobsAbandoned}:${staleRunCleanup.staleJobsPreservedForResume}:${staleRunCleanup.staleRevisionsFailed}:${staleRunCleanup.staleChunksAbandoned}`,
				})
			}
			this._status = {
				engine: this.engine,
				state: "running",
				message: "Preparing the workspace map",
			}
			this.stateManager.startIndexingTimer()
			this.stateManager.reportCustomProgress("Preparing the workspace map", 0, 1, {
				currentItemUnit: "phases",
				phase: "scanning",
				detailedStage: "preparing",
			})
			this._workspaceAdapter = new VsCodeWorkspaceAdapter(this.workspacePath, {
				respectGitIgnore: this.configManager.currentRespectGitIgnore,
				includeDefaultIgnoredGeneratedPaths: this.configManager.currentIncludeDefaultIgnoredGeneratedPaths,
			})
			await this._workspaceAdapter.initialize()
			await this.refreshTrackedOversizedFiles()
			await this.runSerialized(async (signal) => {
				await this.runFullIndex("start", signal)
			})
			await this.ensureWatcher()
			this.startReconciliationTimer()
		} catch (error) {
			this._started = false
			this._activeAbortController = undefined
			this.stopActivityHeartbeat()
			if (this._reconciliationTimer) {
				clearInterval(this._reconciliationTimer)
				this._reconciliationTimer = undefined
			}
			this._watcherCoordinator?.dispose()
			this._watcherCoordinator = undefined
			this._status = {
				engine: this.engine,
				state: "error",
				message: this.getStopAwareErrorMessage(error),
			}
			if (!this._stopRequested) {
				this.stateManager.setSystemState("Error", this.getStopAwareErrorMessage(error))
			}
			if (this.isAbortError(error) && this._stopRequested) {
				return
			}
			throw error
		}
	}

	async refreshAll(): Promise<void> {
		if (!this._started) {
			await this.start()
			return
		}

		this._stopRequested = false
		await this.runSerialized(async (signal) => {
			await this.runFullIndex("refresh", signal)
		})
		await this.ensureWatcher()
		this.startReconciliationTimer()
	}

	private async refreshOutstandingResumedJobs(runId: string): Promise<number> {
		this._resumedPendingJobsCount =
			this._resumedRetryJobsCount > 0 ? await this.metadataStore.countOutstandingResumedJobs(runId) : 0
		return this._resumedPendingJobsCount
	}

	async stop(): Promise<void> {
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stop-requested", {
			engine: this.engine,
			workspacePath: this.workspacePath,
		})
		this._status = {
			engine: this.engine,
			state: "stopping",
			message: "Stopping indexing",
		}
		this._stopRequested = true
		this.stateManager.setSystemState("Stopping", "Stopping indexing...")
		this._activeAbortController?.abort()
		const parseChunkService = this._activeParseChunkService
		const embedUpsertWorker = this._activeEmbedUpsertWorker
		if (parseChunkService || embedUpsertWorker) {
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stop-disposing-active-workers", {
				engine: this.engine,
				workspacePath: this.workspacePath,
				hasParseChunkService: Boolean(parseChunkService),
				hasEmbedUpsertWorker: Boolean(embedUpsertWorker),
			})
			await Promise.allSettled([parseChunkService?.dispose(), embedUpsertWorker?.dispose()])
		}
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stop-awaiting-operation-chain", {
			engine: this.engine,
			workspacePath: this.workspacePath,
		})
		await this._operationChain.catch(() => undefined)
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stop-operation-chain-settled", {
			engine: this.engine,
			workspacePath: this.workspacePath,
		})
		this._watcherCoordinator?.dispose()
		this._watcherCoordinator = undefined
		if (this._reconciliationTimer) {
			clearInterval(this._reconciliationTimer)
			this._reconciliationTimer = undefined
		}
		this.stopActivityHeartbeat()
		await this._searchEmbeddingAdapter?.recycleClient()
		await this._searchVectorStore?.recycleClient()
		await this._indexEmbeddingAdapter?.recycleClient()
		await this._indexVectorStore?.recycleClient()
		this._searchEmbeddingAdapter = undefined
		this._searchVectorStore = undefined
		this._indexEmbeddingAdapter = undefined
		this._indexVectorStore = undefined
		await this.embeddingRuntimeProfileStore.flush()
		await this.metadataStore.dispose()
		this._started = false
		this._activeAbortController = undefined
		this._status = {
			engine: this.engine,
			state: "idle",
			message: "Indexing stopped.",
		}
		this.stateManager.setSystemState("Standby", "Indexing stopped.")
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stop-complete", {
			engine: this.engine,
			workspacePath: this.workspacePath,
		})
	}

	async clear(): Promise<void> {
		await this.performClear(false)
	}

	async clearDatabase(): Promise<void> {
		await this.performClear(true)
	}

	private async performClear(includeTelemetry: boolean): Promise<void> {
		await this.runSerialized(async () => {
			IndexDebugLoggerV2.log(
				"basic",
				"CodeIndexEngineV2",
				includeTelemetry ? "clear-database-requested" : "clear-requested",
				{
					engine: this.engine,
					workspacePath: this.workspacePath,
				},
			)

			this._status = {
				engine: this.engine,
				state: "running",
				message: includeTelemetry ? "Clearing Code Index V2 database" : "Clearing Code Index V2 data",
			}
			this.stateManager.reportCustomProgress(
				includeTelemetry ? "Clearing index database" : "Clearing indexed data",
				0,
				1,
				{
					currentItemUnit: "phases",
					phase: "embedding",
					detailedStage: "deleting_vectors",
					hasKnownVectorWork: true,
					hasStartedVectorSync: false,
				},
			)

			this._watcherCoordinator?.dispose()
			this._watcherCoordinator = undefined
			if (this._reconciliationTimer) {
				clearInterval(this._reconciliationTimer)
				this._reconciliationTimer = undefined
			}
			this.stopActivityHeartbeat()

			try {
				const { vectorStore } = this.getOrCreateIndexDependencies()
				await vectorStore.deleteCollection()
				await vectorStore.recycleClient()
				await this._indexEmbeddingAdapter?.recycleClient()
				await this._searchEmbeddingAdapter?.recycleClient()
				await this._searchVectorStore?.recycleClient()
				this._indexVectorStore = undefined
				this._indexEmbeddingAdapter = undefined
				this._searchVectorStore = undefined
				this._searchEmbeddingAdapter = undefined
				await this.metadataStore.clearStorage({ includeTelemetry })
				this._workspaceAdapter = undefined
				this._started = false
				this._staleRunIdsToResume = []
				this._resumedRetryJobsCount = 0
				this._resumedPendingJobsCount = 0
				this._lastCpuSample = undefined
				this._status = {
					engine: this.engine,
					state: "idle",
					message: includeTelemetry
						? "Index database cleared successfully."
						: "Index data cleared successfully.",
				}
				this.stateManager.resetIndexingState(
					includeTelemetry ? "Index database cleared successfully." : "Index data cleared successfully.",
				)
			} catch (error) {
				this._status = {
					engine: this.engine,
					state: "error",
					message: error instanceof Error ? error.message : String(error),
				}
				this.stateManager.setSystemState(
					"Error",
					error instanceof Error ? error.message : "Failed to clear Code Index V2 data.",
				)
				throw error
			}
		})
	}

	async search(
		query: string,
		limit: number,
		options?: { directoryPrefix?: string },
	): Promise<VectorStoreSearchResult[]> {
		const trace = await this.buildSearchTrace(query, limit, options)
		return trace.stages.final
	}

	async searchDebug(query: string, limit: number): Promise<CodeIndexDebugSearchTrace> {
		return this.buildSearchTrace(query, limit)
	}

	private async buildSearchTrace(
		query: string,
		limit: number,
		options?: { directoryPrefix?: string },
	): Promise<CodeIndexDebugSearchTrace> {
		const traceStartedAt = Date.now()
		const { embeddingAdapter, vectorStore } = this.getOrCreateSearchDependencies()
		await vectorStore.initialize()
		const embeddingStartedAt = Date.now()
		const embeddingResponse = await embeddingAdapter.createEmbeddings([query], { isQuery: true })
		this.maybePersistAdaptiveRuntimeState(embeddingResponse.adaptiveControllerState)
		const queryEmbeddingMs = Date.now() - embeddingStartedAt
		const vector = embeddingResponse.embeddings[0]
		const normalizedDirectoryPrefix = this.normalizeDirectoryPrefix(options?.directoryPrefix)
		const candidateLimit = this.computeSearchCandidateLimit(limit, normalizedDirectoryPrefix)
		const queryTokens = this.tokenizeSearchText(query)
		const queryIntent = this.parseQueryIntent(query)
		const lexicalQuery = this.buildExpandedLexicalQuery(query, queryIntent)

		const vectorStartedAt = Date.now()
		const vectorResults = vector
			? await vectorStore.search(vector, candidateLimit, this.configManager.currentSearchMinScore)
			: []
		const vectorRetrievalMs = Date.now() - vectorStartedAt
		const lexicalMode = this.determineLexicalSearchMode(queryTokens, queryIntent)
		const {
			results: lexicalResults,
			lexicalFtsMs,
			lexicalFallbackMs,
			lexicalRetrievalMs,
			lexicalStatus,
		} = await this.runLexicalSearch(lexicalQuery, candidateLimit, lexicalMode)
		const scopedVectorResults = this.filterResultsByDirectoryPrefix(vectorResults, normalizedDirectoryPrefix)
		const scopedLexicalResults = this.filterResultsByDirectoryPrefix(lexicalResults, normalizedDirectoryPrefix)
		const mergeStartedAt = Date.now()
		const mergedResults = this.mergeSearchCandidates(queryIntent, scopedVectorResults, scopedLexicalResults)
		const mergeMs = Date.now() - mergeStartedAt
		const rerankStartedAt = Date.now()
		const rerankedResults = this.rerankSearchResults(query, queryIntent, mergedResults)
		const rerankMs = Date.now() - rerankStartedAt
		const expansionStartedAt = Date.now()
		const finalResults = await this.expandSearchResultsWithParents(rerankedResults, limit)
		const expansionMs = Date.now() - expansionStartedAt
		const totalMs = Date.now() - traceStartedAt

		return {
			query,
			limit,
			candidateLimit,
			lexicalStatus,
			lexicalMode,
			timingsMs: {
				queryEmbeddingMs,
				vectorRetrievalMs,
				lexicalFtsMs,
				lexicalFallbackMs,
				lexicalRetrievalMs,
				mergeMs,
				rerankMs,
				expansionMs,
				totalMs,
			},
			stages: {
				vector: [...scopedVectorResults],
				lexical: [...scopedLexicalResults],
				merged: [...mergedResults],
				final: [...finalResults],
			},
		}
	}

	private async runLexicalSearch(
		query: string,
		candidateLimit: number,
		lexicalMode: CodeIndexDebugLexicalMode,
	): Promise<{
		results: VectorStoreSearchResult[]
		lexicalFtsMs: number
		lexicalFallbackMs: number
		lexicalRetrievalMs: number
		lexicalStatus: CodeIndexDebugLexicalStatus
	}> {
		if (lexicalMode === "none") {
			return {
				results: [],
				lexicalFtsMs: 0,
				lexicalFallbackMs: 0,
				lexicalRetrievalMs: 0,
				lexicalStatus: "skipped",
			}
		}

		const lexicalResponse = await this.metadataStore.searchActiveChunksLexicallyWithStatus(query, candidateLimit, {
			allowExactFallback: lexicalMode === "fts_plus_exact_fallback",
		})

		return {
			results: lexicalResponse.results.map((chunk) => this.createLexicalSearchResult(chunk)),
			lexicalFtsMs: lexicalResponse.timingsMs.ftsMs,
			lexicalFallbackMs: lexicalResponse.timingsMs.fallbackMs,
			lexicalRetrievalMs: lexicalResponse.timingsMs.totalMs,
			lexicalStatus: lexicalResponse.status,
		}
	}

	private determineLexicalSearchMode(queryTokens: string[], queryIntent: QueryIntent): CodeIndexDebugLexicalMode {
		if (
			queryIntent.pathHints.length > 0 ||
			queryIntent.symbolHints.length > 0 ||
			queryIntent.looksLikeSchemaQuery
		) {
			return "fts_plus_exact_fallback"
		}

		if (
			queryIntent.looksLikeRetrievalExpansionQuery ||
			queryIntent.looksLikeHybridRetrievalQuery ||
			queryIntent.looksLikeEvalRunnerQuery ||
			queryIntent.looksLikePreflightQuery ||
			queryIntent.looksLikeLowValueFilesQuery ||
			queryIntent.looksLikeOversizedWebviewHandlerQuery ||
			queryIntent.looksLikeFullRefreshManagerQuery ||
			queryIntent.looksLikeStartupTrackingQuery
		) {
			return "fts_only"
		}

		if (
			queryIntent.looksLikeNaturalLanguage &&
			queryTokens.length >= 8 &&
			queryIntent.pathHints.length === 0 &&
			queryIntent.symbolHints.length === 0
		) {
			return "none"
		}

		return queryTokens.length <= 2 ? "fts_plus_exact_fallback" : "fts_only"
	}

	private computeSearchCandidateLimit(limit: number, directoryPrefix?: string): number {
		if (directoryPrefix) {
			return Math.min(Math.max(limit * 6, 60), 300)
		}

		return Math.max(limit * 3, 20)
	}

	private getEffectiveMaxFileSizeBytes(relativePath: string): number {
		return this.configManager.getEffectiveMaxFileSizeBytes(this.workspacePath, relativePath)
	}

	private buildOversizedSummarySuffix(oversizedFiles: number): string {
		return oversizedFiles > 0 ? ` with ${oversizedFiles.toLocaleString()} oversized files skipped` : ""
	}

	private rerankSearchResults(
		query: string,
		queryIntent: QueryIntent,
		results: VectorStoreSearchResult[],
	): VectorStoreSearchResult[] {
		const queryTokens = this.tokenizeSearchText(query)
		const rerankContext: SearchRerankContext = {
			normalizedQuery: this.normalizeSearchText(query),
			queryTokens,
			desiredChunkKinds: this.inferDesiredChunkKinds(queryTokens),
			queryIntent,
		}

		return [...results]
			.map((result, index) => {
				const payload = result.payload
				const matchReasons = new Set<string>(result.matchReasons ?? [])
				let rerankScore = result.score

				const features = this.extractSearchResultFeatures(result)

				rerankScore = this.applyGenericQueryMatches(rerankContext, features, rerankScore, matchReasons)
				rerankScore = this.applyHintMatches(rerankContext, features, rerankScore, matchReasons)
				rerankScore = this.applyGenericTokenOverlap(rerankContext, features, rerankScore, matchReasons)
				rerankScore = this.applyGenericSurfaceScoring(rerankContext, features, rerankScore, matchReasons)
				rerankScore = this.applyCompatibilityRerankRules(rerankContext, features, rerankScore, matchReasons)

				return {
					...result,
					rerankScore,
					matchReasons: Array.from(matchReasons),
					payload,
					_sortIndex: index,
				} as VectorStoreSearchResult & { _sortIndex: number }
			})
			.sort((left, right) => {
				if ((right.rerankScore ?? right.score) !== (left.rerankScore ?? left.score)) {
					return (right.rerankScore ?? right.score) - (left.rerankScore ?? left.score)
				}
				if (right.score !== left.score) {
					return right.score - left.score
				}
				return left._sortIndex - right._sortIndex
			})
			.map(({ _sortIndex, ...result }) => result)
	}

	private extractSearchResultFeatures(result: VectorStoreSearchResult): SearchResultFeatures {
		const payload = result.payload
		const filePath = this.normalizeSearchText(payload?.filePath)
		return {
			symbolName: this.normalizeSearchText(payload?.symbolName),
			symbolQualifiedName: this.normalizeSearchText(payload?.symbolQualifiedName),
			parentSymbolName: this.normalizeSearchText(payload?.parentSymbolName),
			filePath,
			fileBasename: this.getPathBasename(filePath),
			summary: this.normalizeSearchText(payload?.summary),
			codeChunk: this.normalizeSearchText(payload?.codeChunk),
			searchText: this.normalizeSearchText(payload?.searchText),
			chunkKind: this.normalizeSearchText(payload?.chunkKind),
		}
	}

	private classifySearchSurface(features: SearchResultFeatures): SearchSurfaceCategories {
		const { filePath } = features
		return {
			isEngineModuleSurface:
				filePath.includes("/services/code-index-v2/engine/") || filePath.includes("/code-index-v2/engine/"),
			isEvalSurface:
				filePath.includes("/services/code-index-v2/eval/") || filePath.includes("/code-index-v2/eval/"),
			isStorageSurface:
				filePath.includes("/services/code-index-v2/store/") || filePath.includes("/code-index-v2/store/"),
			isParserAdapterSurface: filePath.includes("/adapters/codeindexparseradapter"),
			isHandlerSurface:
				filePath.includes("/core/webview/webviewmessagehandler.") ||
				filePath.includes("/core/webview/webviewmessagehandler.ts"),
			isUiDisplaySurface: filePath.includes("/components/chat/codebasesearchresultsdisplay"),
			isToolOrWrapperSurface: filePath.includes("/components/chat/") || filePath.includes("/core/tools/"),
			isConfigOrTypesSurface:
				filePath.includes("/services/code-index/config-manager") || filePath.includes("/packages/types/"),
			isTestSurface: filePath.includes("/__tests__/") || filePath.includes(".spec."),
			isFixtureSurface: filePath.includes("/eval/fixtures/"),
			isCliOrHarnessSurface:
				filePath.includes("apps/cli/scripts/integration/") || filePath.includes("apps/cli/src/"),
			isI18nSurface: filePath.includes("package.nls") || filePath.includes("/i18n/locales/"),
			isContextManagementSurface: filePath.includes("/core/context/context-management/"),
		}
	}

	private applyGenericQueryMatches(
		context: SearchRerankContext,
		features: SearchResultFeatures,
		rerankScore: number,
		matchReasons: Set<string>,
	): number {
		const { normalizedQuery } = context
		const { symbolQualifiedName, symbolName, parentSymbolName, filePath, fileBasename } = features

		if (normalizedQuery && symbolQualifiedName) {
			if (symbolQualifiedName === normalizedQuery) {
				rerankScore += 0.3
				matchReasons.add("exact qualified symbol match")
			} else if (symbolQualifiedName.includes(normalizedQuery)) {
				rerankScore += 0.22
				matchReasons.add("qualified symbol match")
			}
		}

		if (normalizedQuery && symbolName) {
			if (symbolName === normalizedQuery) {
				rerankScore += 0.24
				matchReasons.add("exact symbol match")
			} else if (symbolName.includes(normalizedQuery)) {
				rerankScore += 0.16
				matchReasons.add("symbol name match")
			}
		}

		if (normalizedQuery && parentSymbolName.includes(normalizedQuery)) {
			rerankScore += 0.08
			matchReasons.add("parent symbol match")
		}

		if (normalizedQuery && filePath.includes(normalizedQuery)) {
			rerankScore += 0.14
			matchReasons.add("path match")
		}

		if (normalizedQuery && fileBasename) {
			if (fileBasename === normalizedQuery) {
				rerankScore += 0.26
				matchReasons.add("exact filename match")
			} else if (fileBasename.includes(normalizedQuery) || normalizedQuery.includes(fileBasename)) {
				rerankScore += 0.12
				matchReasons.add("filename match")
			}
		}

		return rerankScore
	}

	private applyHintMatches(
		context: SearchRerankContext,
		features: SearchResultFeatures,
		rerankScore: number,
		matchReasons: Set<string>,
	): number {
		const { queryIntent } = context
		const { symbolQualifiedName, symbolName, filePath, fileBasename, searchText } = features
		const isEnginePath =
			filePath.includes("/services/code-index-v2/engine/") || filePath.includes("/code-index-v2/engine/")

		for (const symbolHint of queryIntent.symbolHints) {
			if (!symbolHint) {
				continue
			}
			if (symbolQualifiedName === symbolHint) {
				rerankScore += 0.32
				matchReasons.add("exact hinted symbol match")
				if (queryIntent.looksLikeImplementationQuery && isEnginePath) {
					rerankScore += 0.18
					matchReasons.add("exact implementation symbol match")
				}
			} else if (symbolName === symbolHint) {
				rerankScore += 0.26
				matchReasons.add("exact hinted symbol match")
				if (queryIntent.looksLikeImplementationQuery && isEnginePath) {
					rerankScore += 0.18
					matchReasons.add("exact implementation symbol match")
				}
			} else if (symbolQualifiedName.includes(symbolHint) || symbolName.includes(symbolHint)) {
				rerankScore += 0.18
				matchReasons.add("hinted symbol match")
			} else if (searchText.includes(symbolHint)) {
				rerankScore += 0.12
				matchReasons.add("hinted symbol match")
			}
		}

		for (const pathHint of queryIntent.pathHints) {
			if (!pathHint) {
				continue
			}
			if (filePath === pathHint) {
				rerankScore += 0.28
				matchReasons.add("exact hinted path match")
			} else if (fileBasename === this.getPathBasename(pathHint)) {
				rerankScore += 0.24
				matchReasons.add("exact hinted filename match")
			} else if (filePath.endsWith(pathHint) || filePath.includes(pathHint)) {
				rerankScore += 0.2
				matchReasons.add("hinted path match")
			}
		}

		if (
			queryIntent.looksLikeFullRefreshManagerQuery &&
			(filePath.includes("/services/code-index/manager.ts") || filePath.endsWith("/manager.ts"))
		) {
			rerankScore += 0.24
			matchReasons.add("full refresh manager path match")
		}

		if (
			queryIntent.looksLikeFullRefreshManagerQuery &&
			(symbolQualifiedName === "codeindexmanager.refreshallindexdata" ||
				symbolName === "refreshallindexdata" ||
				searchText.includes("refreshallindexdata"))
		) {
			rerankScore += 0.38
			matchReasons.add("exact full refresh manager match")
		}

		return rerankScore
	}

	private applyGenericTokenOverlap(
		context: SearchRerankContext,
		features: SearchResultFeatures,
		rerankScore: number,
		matchReasons: Set<string>,
	): number {
		const { queryTokens, queryIntent } = context
		const { symbolQualifiedName, symbolName, parentSymbolName, filePath, summary, codeChunk, searchText } = features

		const symbolTokenHits = this.countStructuredTokenHits(
			queryTokens,
			symbolQualifiedName,
			symbolName,
			parentSymbolName,
		)
		if (symbolTokenHits > 0) {
			rerankScore += Math.min(0.14, symbolTokenHits * 0.04)
			matchReasons.add("symbol token overlap")
		}

		const pathTokenHits = this.countStructuredTokenHits(queryTokens, filePath)
		if (pathTokenHits > 0) {
			rerankScore += Math.min(0.1, pathTokenHits * 0.03)
			matchReasons.add("path token overlap")
		}

		const summaryTokenHits = this.countTokenHits(queryTokens, summary)
		if (summaryTokenHits > 0) {
			rerankScore += Math.min(0.08, summaryTokenHits * 0.02)
			matchReasons.add("summary token overlap")
		}

		const contentTokenHits = this.countTokenHits(queryIntent.contentHints, codeChunk, searchText)
		if (contentTokenHits > 0) {
			rerankScore += Math.min(0.14, contentTokenHits * 0.03)
			matchReasons.add("content token overlap")
		}

		const implementationTokenHits = this.countStructuredTokenHits(
			queryIntent.implementationHints,
			symbolQualifiedName,
			symbolName,
			parentSymbolName,
			codeChunk,
			searchText,
			summary,
		)
		if (implementationTokenHits > 0) {
			rerankScore += Math.min(0.18, implementationTokenHits * 0.05)
			matchReasons.add("implementation token overlap")
		}

		if (queryIntent.looksLikeSchemaQuery) {
			if (features.fileBasename === "schema.ts" || filePath.endsWith("/schema.ts")) {
				rerankScore += 0.2
				matchReasons.add("schema file match")
			}

			if (filePath.includes("/services/code-index-v2/store/") || filePath.includes("/code-index-v2/store/")) {
				rerankScore += 0.14
				matchReasons.add("schema storage path match")
			}

			const ddlTokenHits = this.countTokenHits(queryIntent.ddlHints, codeChunk, searchText, summary)
			if (ddlTokenHits > 0) {
				rerankScore += Math.min(0.12, ddlTokenHits * 0.04)
				matchReasons.add("ddl token overlap")
			}
		}

		if (
			features.chunkKind &&
			context.desiredChunkKinds.size > 0 &&
			context.desiredChunkKinds.has(features.chunkKind)
		) {
			rerankScore += 0.05
			matchReasons.add("chunk kind match")
		}

		return rerankScore
	}

	private applyGenericSurfaceScoring(
		context: SearchRerankContext,
		features: SearchResultFeatures,
		rerankScore: number,
		matchReasons: Set<string>,
	): number {
		const { queryIntent } = context
		const { filePath } = features
		const surfaces = this.classifySearchSurface(features)

		if (
			queryIntent.looksLikeImplementationQuery &&
			(surfaces.isToolOrWrapperSurface ||
				surfaces.isConfigOrTypesSurface ||
				surfaces.isFixtureSurface ||
				surfaces.isTestSurface ||
				surfaces.isI18nSurface)
		) {
			rerankScore -= 0.22
			matchReasons.add("wrapper surface penalty")
		}

		if (
			queryIntent.looksLikeImplementationQuery &&
			(surfaces.isFixtureSurface || filePath.includes("/engine/interfaces.ts"))
		) {
			rerankScore -= 0.18
			matchReasons.add("implementation indirection penalty")
		}

		if (queryIntent.looksLikeImplementationQuery && surfaces.isTestSurface) {
			rerankScore -= 0.18
			matchReasons.add("test surface penalty")
		}

		if (queryIntent.looksLikeImplementationQuery && surfaces.isConfigOrTypesSurface) {
			rerankScore -= 0.08
			matchReasons.add("implementation config surface penalty")
		}

		if (
			queryIntent.looksLikeRetrievalExpansionQuery &&
			!queryIntent.looksLikeSearchResultsDisplayQuery &&
			(surfaces.isToolOrWrapperSurface || filePath.includes("/core/tools/codebasesearchtool"))
		) {
			rerankScore -= 0.24
			matchReasons.add("retrieval expansion surface penalty")
		}

		if (queryIntent.looksLikeCodeQuestion && this.isLikelyNonCodeContentPath(filePath)) {
			rerankScore -= 0.32
			matchReasons.add("non-code content penalty")
		}

		return rerankScore
	}

	private applyCompatibilityRerankRules(
		context: SearchRerankContext,
		features: SearchResultFeatures,
		rerankScore: number,
		matchReasons: Set<string>,
	): number {
		const { queryIntent } = context
		const { symbolQualifiedName, symbolName, filePath, searchText } = features
		const surfaces = this.classifySearchSurface(features)

		if (queryIntent.looksLikeRetrievalExpansionQuery && surfaces.isEngineModuleSurface) {
			rerankScore += 0.28
			matchReasons.add("retrieval engine surface match")
		}

		if (queryIntent.looksLikeStartupTrackingQuery && surfaces.isEngineModuleSurface) {
			rerankScore += 0.18
			matchReasons.add("startup tracking engine surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// startup-tracking implementation identifiers.
		if (
			queryIntent.looksLikeStartupTrackingQuery &&
			(symbolQualifiedName === "codeindexenginev2.refreshtrackedoversizedfiles" ||
				symbolName === "refreshtrackedoversizedfiles" ||
				searchText.includes("refreshtrackedoversizedfiles"))
		) {
			rerankScore += 0.34
			matchReasons.add("exact startup tracking match")
		}

		if (queryIntent.looksLikeHybridRetrievalQuery && surfaces.isEngineModuleSurface) {
			rerankScore += 0.18
			matchReasons.add("hybrid retrieval engine surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// hybrid-retrieval implementation identifiers.
		if (
			queryIntent.looksLikeHybridRetrievalQuery &&
			(symbolQualifiedName.includes("mergesearchcandidates") ||
				symbolName.includes("mergesearchcandidates") ||
				symbolQualifiedName.includes("createlexicalsearchresult") ||
				symbolName.includes("createlexicalsearchresult") ||
				searchText.includes("mergesearchcandidates") ||
				searchText.includes("hybrid retrieval"))
		) {
			rerankScore += 0.26
			matchReasons.add("hybrid retrieval implementation match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// retrieval-expansion implementation identifiers.
		if (
			queryIntent.looksLikeRetrievalExpansionQuery &&
			(symbolQualifiedName.includes("expandsearchresultswithparents") ||
				symbolName.includes("expandsearchresultswithparents") ||
				symbolQualifiedName.includes("createparentcontextresult") ||
				symbolName.includes("createparentcontextresult") ||
				symbolQualifiedName.includes("createsiblingcontextresult") ||
				symbolName.includes("createsiblingcontextresult") ||
				symbolQualifiedName.includes("findbestsiblingcontextchunk") ||
				symbolName.includes("findbestsiblingcontextchunk"))
		) {
			rerankScore += 0.54
			matchReasons.add("retrieval expansion implementation match")
		}

		if (queryIntent.looksLikeSearchResultsDisplayQuery && surfaces.isUiDisplaySurface) {
			rerankScore += 0.42
			matchReasons.add("search results display surface match")
		}

		if (queryIntent.looksLikePreflightQuery && surfaces.isEngineModuleSurface) {
			rerankScore += 0.22
			matchReasons.add("preflight engine surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// preflight implementation identifiers.
		if (
			queryIntent.looksLikePreflightQuery &&
			(symbolQualifiedName.includes("preflightindexingdependencies") ||
				symbolName.includes("preflightindexingdependencies") ||
				searchText.includes("verification timed out") ||
				searchText.includes("preflight"))
		) {
			rerankScore += 0.34
			matchReasons.add("preflight implementation match")
		}

		if (
			queryIntent.looksLikeLowValueFilesQuery &&
			(filePath.includes("/services/code-index/shared/low-value-files.") ||
				filePath.includes("/code-index/shared/low-value-files."))
		) {
			rerankScore += 0.24
			matchReasons.add("low value files surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// low-value-files implementation identifiers.
		if (
			queryIntent.looksLikeLowValueFilesQuery &&
			(symbolQualifiedName.includes("low_value_file_names") ||
				symbolName.includes("low_value_file_names") ||
				symbolQualifiedName.includes("islowvaluefile") ||
				symbolName.includes("islowvaluefile") ||
				searchText.includes("low value file"))
		) {
			rerankScore += 0.34
			matchReasons.add("low value files implementation match")
		}

		if (queryIntent.looksLikeOversizedWebviewHandlerQuery && surfaces.isHandlerSurface) {
			rerankScore += 0.26
			matchReasons.add("oversized webview handler surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// oversized-webview implementation identifiers.
		if (
			queryIntent.looksLikeOversizedWebviewHandlerQuery &&
			(symbolQualifiedName.includes("fullrefreshindexdata") ||
				symbolName.includes("fullrefreshindexdata") ||
				searchText.includes("requestoversizedfiledetails") ||
				searchText.includes("webview message handler"))
		) {
			rerankScore += 0.34
			matchReasons.add("oversized webview handler implementation match")
		}

		if (queryIntent.looksLikeEvalRunnerQuery && surfaces.isEvalSurface) {
			rerankScore += 0.18
			matchReasons.add("eval runner surface match")
		}

		// Temporary compatibility rule kept until a later broader feature pass replaces exact
		// eval-runner implementation identifiers.
		if (
			queryIntent.looksLikeEvalRunnerQuery &&
			(symbolQualifiedName.includes("codeindexevalrunner") ||
				symbolName.includes("codeindexevalrunner") ||
				searchText.includes("stage aggregates") ||
				searchText.includes("searchdebug"))
		) {
			rerankScore += 0.3
			matchReasons.add("eval runner implementation match")
		}

		if (queryIntent.looksLikeRetrievalExpansionQuery && surfaces.isParserAdapterSurface) {
			rerankScore -= 0.32
			matchReasons.add("parser/adapter surface penalty")
		}

		if (queryIntent.looksLikeRetrievalExpansionQuery && surfaces.isStorageSurface) {
			rerankScore -= 0.34
			matchReasons.add("storage surface penalty")
		}

		if (queryIntent.looksLikeRetrievalExpansionQuery && surfaces.isFixtureSurface) {
			rerankScore -= 0.3
			matchReasons.add("fixture surface penalty")
		}

		if (queryIntent.looksLikePreflightQuery && surfaces.isCliOrHarnessSurface) {
			rerankScore -= 0.22
			matchReasons.add("preflight cli surface penalty")
		}

		if (queryIntent.looksLikeLowValueFilesQuery && (surfaces.isFixtureSurface || surfaces.isI18nSurface)) {
			rerankScore -= 0.28
			matchReasons.add("low value files non-code surface penalty")
		}

		if (
			queryIntent.looksLikeOversizedWebviewHandlerQuery &&
			(surfaces.isCliOrHarnessSurface || surfaces.isTestSurface)
		) {
			rerankScore -= 0.22
			matchReasons.add("oversized webview handler unrelated surface penalty")
		}

		if (queryIntent.looksLikeRetrievalExpansionQuery && surfaces.isContextManagementSurface) {
			rerankScore -= 0.42
			matchReasons.add("context-management surface penalty")
		}

		return rerankScore
	}

	private mergeSearchCandidates(
		queryIntent: QueryIntent,
		vectorResults: VectorStoreSearchResult[],
		lexicalResults: VectorStoreSearchResult[],
	): VectorStoreSearchResult[] {
		const mergedByChunkKey = new Map<string, VectorStoreSearchResult>()

		for (const result of [...vectorResults, ...lexicalResults]) {
			const normalizedResult = this.applyVariantScoring(result, queryIntent)
			const chunkKey = this.getResultChunkKey(result) ?? `result:${String(result.id)}`
			const existing = mergedByChunkKey.get(chunkKey)
			if (!existing) {
				mergedByChunkKey.set(chunkKey, normalizedResult)
				continue
			}

			const mergedReasons = Array.from(
				new Set([...(existing.matchReasons ?? []), ...(normalizedResult.matchReasons ?? [])]),
			)
			const bestScore = Math.max(existing.score, normalizedResult.score)
			const bestRerankScore = Math.max(
				existing.rerankScore ?? existing.score,
				normalizedResult.rerankScore ?? normalizedResult.score,
			)
			mergedByChunkKey.set(chunkKey, {
				...(this.shouldPreferPayload(normalizedResult, existing) ? normalizedResult : existing),
				score: bestScore,
				rerankScore: bestRerankScore,
				matchReasons: mergedReasons,
			})
		}

		return Array.from(mergedByChunkKey.values())
	}

	private applyVariantScoring(result: VectorStoreSearchResult, queryIntent: QueryIntent): VectorStoreSearchResult {
		const variantType = result.payload?.variantType
		if (!variantType) {
			return result
		}

		const matchReasons = new Set(result.matchReasons ?? [])
		let adjustedScore = result.score
		let adjustedRerankScore = result.rerankScore ?? result.score

		if (variantType === "symbol_signature" && queryIntent.symbolHints.length > 0) {
			adjustedScore += 0.08
			adjustedRerankScore += 0.08
			matchReasons.add("symbol signature variant match")
		}

		if (variantType === "summary" && queryIntent.looksLikeNaturalLanguage) {
			adjustedScore += 0.06
			adjustedRerankScore += 0.06
			matchReasons.add("summary variant match")
		}

		if (variantType === "raw_code") {
			matchReasons.add("raw code grounding")
		}

		return {
			...result,
			score: adjustedScore,
			rerankScore: adjustedRerankScore,
			matchReasons: Array.from(matchReasons),
		}
	}

	private shouldPreferPayload(candidate: VectorStoreSearchResult, existing: VectorStoreSearchResult): boolean {
		const candidateVariant = candidate.payload?.variantType
		const existingVariant = existing.payload?.variantType

		if (candidateVariant === "raw_code" && existingVariant !== "raw_code") {
			return true
		}
		if (existingVariant === "raw_code" && candidateVariant !== "raw_code") {
			return false
		}

		return (candidate.rerankScore ?? candidate.score) > (existing.rerankScore ?? existing.score)
	}

	private async expandSearchResultsWithParents(
		results: VectorStoreSearchResult[],
		limit: number,
	): Promise<VectorStoreSearchResult[]> {
		const parentReferences = results
			.map((result) => {
				const payload = result.payload
				if (!payload?.filePath || !payload.parentChunkFingerprint) {
					return null
				}
				return {
					relativePath: payload.filePath,
					chunkFingerprint: payload.parentChunkFingerprint,
				}
			})
			.filter((reference): reference is { relativePath: string; chunkFingerprint: string } => Boolean(reference))

		const parentChunks = await this.metadataStore.getActiveChunksByFingerprints(parentReferences)
		const activeFileChunks = await this.metadataStore.getActiveChunksByRelativePaths(
			results
				.map((result) => result.payload?.filePath)
				.filter((filePath): filePath is string => Boolean(filePath)),
		)
		const parentChunkMap = new Map<string, (typeof parentChunks)[number]>(
			parentChunks.map((chunk) => [`${chunk.relativePath}::${chunk.chunkFingerprint}`, chunk] as const),
		)
		const siblingChunksByParent = new Map<
			string,
			Awaited<ReturnType<MetadataStore["getActiveChunksByRelativePaths"]>>
		>()
		for (const chunk of activeFileChunks) {
			if (!chunk.parentChunkFingerprint) {
				continue
			}
			const key = `${chunk.relativePath}::${chunk.parentChunkFingerprint}`
			const siblings = siblingChunksByParent.get(key) ?? []
			siblings.push(chunk)
			siblingChunksByParent.set(key, siblings)
		}

		const expandedResults: VectorStoreSearchResult[] = []
		const seenChunkKeys = new Set<string>()
		const expandedParentGroups = new Set<string>()

		for (const result of results) {
			if (expandedResults.length >= limit) {
				break
			}

			const payload = result.payload
			const parentGroupKey =
				payload?.filePath && payload.parentChunkFingerprint
					? `${payload.filePath}::${payload.parentChunkFingerprint}`
					: null
			if (parentGroupKey && expandedParentGroups.has(parentGroupKey)) {
				continue
			}

			const childKey = this.getResultChunkKey(result)
			if (childKey && seenChunkKeys.has(childKey)) {
				continue
			}

			expandedResults.push(result)
			if (childKey) {
				seenChunkKeys.add(childKey)
			}

			if (expandedResults.length >= limit) {
				break
			}

			if (!payload?.filePath || !payload.parentChunkFingerprint) {
				continue
			}

			const groupKey = `${payload.filePath}::${payload.parentChunkFingerprint}`
			expandedParentGroups.add(groupKey)

			const parentChunk = parentChunkMap.get(groupKey)
			if (!parentChunk) {
				continue
			}

			const parentKey = `${parentChunk.relativePath}::${parentChunk.chunkFingerprint}`
			if (seenChunkKeys.has(parentKey)) {
				continue
			}

			expandedResults.push(this.createParentContextResult(parentChunk, result))
			seenChunkKeys.add(parentKey)

			if (expandedResults.length >= limit) {
				break
			}

			const siblingChunk = this.findBestSiblingContextChunk(
				siblingChunksByParent.get(groupKey) ?? [],
				result,
				seenChunkKeys,
			)
			if (!siblingChunk) {
				continue
			}

			const siblingKey = `${siblingChunk.relativePath}::${siblingChunk.chunkFingerprint}`
			expandedResults.push(this.createSiblingContextResult(siblingChunk, result))
			seenChunkKeys.add(siblingKey)
		}

		return expandedResults
	}

	private createParentContextResult(
		chunk: Awaited<ReturnType<MetadataStore["getActiveChunksByFingerprints"]>>[number],
		childResult: VectorStoreSearchResult,
	): VectorStoreSearchResult {
		const childReasons = childResult.matchReasons ?? []
		const parentReasons = Array.from(new Set([...childReasons, "expanded parent context"]))
		const baseScore = childResult.rerankScore ?? childResult.score

		return {
			id: chunk.vectorPointId ?? `parent:${chunk.chunkId}`,
			score: Math.max(childResult.score - 0.001, 0),
			rerankScore: Math.max(baseScore - 0.001, 0),
			matchReasons: parentReasons,
			payload: {
				filePath: chunk.relativePath,
				chunkFingerprint: chunk.chunkFingerprint,
				codeChunk: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language ?? undefined,
				chunkKind: chunk.chunkKind ?? undefined,
				symbolName: chunk.symbolName ?? undefined,
				symbolQualifiedName: chunk.symbolQualifiedName ?? undefined,
				parentSymbolName: chunk.parentSymbolName ?? undefined,
				parentChunkFingerprint: chunk.parentChunkFingerprint ?? undefined,
				summary: chunk.summary ?? undefined,
				searchText: chunk.searchText ?? undefined,
			},
		}
	}

	private createSiblingContextResult(
		chunk: Awaited<ReturnType<MetadataStore["getActiveChunksByRelativePaths"]>>[number],
		childResult: VectorStoreSearchResult,
	): VectorStoreSearchResult {
		const childReasons = childResult.matchReasons ?? []
		const siblingReasons = Array.from(new Set([...childReasons, "expanded sibling context"]))
		const baseScore = childResult.rerankScore ?? childResult.score

		return {
			id: chunk.vectorPointId ?? `sibling:${chunk.chunkId}`,
			score: Math.max(childResult.score - 0.002, 0),
			rerankScore: Math.max(baseScore - 0.002, 0),
			matchReasons: siblingReasons,
			payload: {
				filePath: chunk.relativePath,
				chunkFingerprint: chunk.chunkFingerprint,
				codeChunk: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language ?? undefined,
				chunkKind: chunk.chunkKind ?? undefined,
				symbolName: chunk.symbolName ?? undefined,
				symbolQualifiedName: chunk.symbolQualifiedName ?? undefined,
				parentSymbolName: chunk.parentSymbolName ?? undefined,
				parentChunkFingerprint: chunk.parentChunkFingerprint ?? undefined,
				summary: chunk.summary ?? undefined,
				searchText: chunk.searchText ?? undefined,
			},
		}
	}

	private createLexicalSearchResult(
		chunk: Awaited<ReturnType<MetadataStore["searchActiveChunksLexically"]>>[number],
	): VectorStoreSearchResult {
		const normalizedScore = Math.min(0.95, Math.max(0.3, chunk.lexicalScore / 20))
		return {
			id: chunk.vectorPointId ?? `lexical:${chunk.chunkId}`,
			score: normalizedScore,
			rerankScore: normalizedScore,
			matchReasons: ["lexical match"],
			payload: {
				filePath: chunk.relativePath,
				chunkFingerprint: chunk.chunkFingerprint,
				codeChunk: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language ?? undefined,
				chunkKind: chunk.chunkKind ?? undefined,
				symbolName: chunk.symbolName ?? undefined,
				symbolQualifiedName: chunk.symbolQualifiedName ?? undefined,
				parentSymbolName: chunk.parentSymbolName ?? undefined,
				parentChunkFingerprint: chunk.parentChunkFingerprint ?? undefined,
				summary: chunk.summary ?? undefined,
				searchText: chunk.searchText ?? undefined,
			},
		}
	}

	private findBestSiblingContextChunk(
		siblings: Awaited<ReturnType<MetadataStore["getActiveChunksByRelativePaths"]>>,
		result: VectorStoreSearchResult,
		seenChunkKeys: Set<string>,
	): Awaited<ReturnType<MetadataStore["getActiveChunksByRelativePaths"]>>[number] | undefined {
		const resultFingerprint =
			typeof result.payload?.chunkFingerprint === "string" ? result.payload.chunkFingerprint : null
		const resultStartLine = result.payload?.startLine ?? 0
		const resultEndLine = result.payload?.endLine ?? resultStartLine

		return [...siblings]
			.filter((chunk) => {
				const chunkKey = `${chunk.relativePath}::${chunk.chunkFingerprint}`
				if (seenChunkKeys.has(chunkKey)) {
					return false
				}
				if (resultFingerprint && chunk.chunkFingerprint === resultFingerprint) {
					return false
				}
				return true
			})
			.sort((left, right) => {
				const leftDistance = this.chunkLineDistance(
					left.startLine,
					left.endLine,
					resultStartLine,
					resultEndLine,
				)
				const rightDistance = this.chunkLineDistance(
					right.startLine,
					right.endLine,
					resultStartLine,
					resultEndLine,
				)
				if (leftDistance !== rightDistance) {
					return leftDistance - rightDistance
				}
				return left.startLine - right.startLine
			})[0]
	}

	private chunkLineDistance(startLineA: number, endLineA: number, startLineB: number, endLineB: number): number {
		if (endLineA < startLineB) {
			return startLineB - endLineA
		}
		if (endLineB < startLineA) {
			return startLineA - endLineB
		}
		return 0
	}

	private getResultChunkKey(result: VectorStoreSearchResult): string | null {
		const filePath = result.payload?.filePath
		const chunkFingerprint =
			typeof result.payload?.chunkFingerprint === "string" ? result.payload.chunkFingerprint : undefined

		if (!filePath || !chunkFingerprint) {
			return null
		}

		return `${filePath}::${chunkFingerprint}`
	}

	private normalizeSearchText(value: string | null | undefined): string {
		return (value ?? "").trim().toLowerCase()
	}

	private getPathBasename(value: string | null | undefined): string {
		const normalized = this.normalizeSearchText(value)
		if (!normalized) {
			return ""
		}
		const segments = normalized.split(/[\\/]/).filter(Boolean)
		return segments[segments.length - 1] ?? normalized
	}

	private normalizeDirectoryPrefix(directoryPrefix?: string): string | undefined {
		if (!directoryPrefix) {
			return undefined
		}

		const normalized = directoryPrefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim()
		return normalized || undefined
	}

	private filterResultsByDirectoryPrefix(
		results: VectorStoreSearchResult[],
		directoryPrefix?: string,
	): VectorStoreSearchResult[] {
		if (!directoryPrefix) {
			return [...results]
		}

		const normalizedPrefix = directoryPrefix.toLowerCase()
		return results.filter((result) => {
			const filePath = result.payload?.filePath
			if (!filePath) {
				return false
			}

			const normalizedFilePath = filePath.replace(/\\/g, "/").toLowerCase()
			return normalizedFilePath === normalizedPrefix || normalizedFilePath.startsWith(`${normalizedPrefix}/`)
		})
	}

	private buildExpandedLexicalQuery(query: string, queryIntent: QueryIntent): string {
		const normalizedQuery = query.toLowerCase()
		const extraTerms = queryIntent.lexicalExpansionTerms.filter(
			(term) => term && term.length >= 2 && !normalizedQuery.includes(term),
		)
		if (extraTerms.length === 0) {
			return query
		}

		return `${query} ${extraTerms.slice(0, 8).join(" ")}`
	}

	private expandIdentifierHintVariants(value: string): string[] {
		const normalizedValue = value.replace(/\\/g, "/").trim()
		if (!normalizedValue) {
			return []
		}

		const rawSegments = normalizedValue.split(/[./]/).filter(Boolean)
		const normalizedSegments = rawSegments.map((segment) => segment.toLowerCase())
		const forms = new Set<string>([normalizedValue.toLowerCase()])
		const segmentWords = rawSegments.map((segment) => this.splitIdentifierWords(segment))
		const flattenedWords = segmentWords.flat()

		if (normalizedSegments.length > 1) {
			forms.add(normalizedSegments.join("."))
			forms.add(normalizedSegments.join(" "))
		}

		for (const words of segmentWords) {
			if (words.length === 0) {
				continue
			}

			forms.add(words.join(" "))
			forms.add(words.join("_"))
			forms.add(words.join(""))
			forms.add(words.join("-"))
		}

		if (flattenedWords.length > 0) {
			forms.add(flattenedWords.join(" "))
			forms.add(flattenedWords.join("_"))
			forms.add(flattenedWords.join(""))
		}

		return Array.from(forms).filter((form) => form.length >= 2)
	}

	private splitIdentifierWords(value: string): string[] {
		return value
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.replace(/[^A-Za-z0-9 ]+/g, " ")
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean)
	}

	private parseQueryIntent(query: string): QueryIntent {
		const normalizedQuery = this.normalizeSearchText(query)
		const rawTokens = query.match(/[A-Za-z0-9_./-]+/g) ?? []
		const pathHints = new Set<string>()
		const symbolHints = new Set<string>()
		const lexicalExpansionTerms = new Set<string>()
		const ddlHints = new Set<string>()
		const ddlTokens = new Set(["create", "table", "alter", "index", "column", "constraint", "primary", "foreign"])
		const pascalCaseStopwords = new Set(["how", "what", "where", "when", "why", "does", "roo", "code"])
		const questionLeadPattern = /^(how|what|where|when|why|does|is|are|can|should)\b/i
		const codeQuestionTokens = new Set([
			"code",
			"index",
			"search",
			"results",
			"parent",
			"sibling",
			"context",
			"retrieval",
			"reranking",
			"rerank",
			"lexical",
			"vector",
			"chunk",
			"chunks",
			"tool",
			"manager",
			"engine",
			"schema",
			"qdrant",
			"embedder",
			"oversized",
			"approval",
			"approvals",
			"startup",
			"reconcile",
			"refresh",
			"eval",
			"runner",
			"aggregate",
			"aggregates",
			"debug",
		])
		const retrievalExpansionTokens = new Set(["parent", "sibling", "context", "search", "results", "codebase"])
		const startupTrackingTokens = new Set(["oversized", "startup", "reconcile", "refresh", "approval", "approvals"])
		const evalRunnerTokens = new Set(["eval", "runner", "aggregate", "aggregates", "searchdebug", "retrieval"])
		const implementationTokens = new Set([
			"parent",
			"sibling",
			"context",
			"expand",
			"expanded",
			"hybrid",
			"lexical",
			"vector",
			"merge",
			"merged",
			"rerank",
			"reranking",
			"refreshtrackedoversizedfiles",
			"refreshallindexdata",
			"full",
			"startup",
			"reconcile",
			"eval",
			"runner",
			"aggregate",
			"aggregates",
			"searchdebug",
		])

		for (const rawToken of rawTokens) {
			const token = rawToken.trim()
			if (token.length < 2) {
				continue
			}

			const normalizedToken = token.toLowerCase()
			const looksLikePath =
				token.includes("/") ||
				token.includes("\\") ||
				/\.[A-Za-z0-9_-]{1,8}$/.test(token) ||
				normalizedToken.startsWith("src/") ||
				normalizedToken.startsWith("app/") ||
				normalizedToken.startsWith("lib/")
			if (looksLikePath) {
				pathHints.add(normalizedToken.replace(/\\/g, "/"))
			}

			const looksLikeQualifiedSymbol = token.includes(".") && /[A-Za-z_]/.test(token)
			const looksLikePascalCaseSymbol = /^[A-Z][A-Za-z0-9_]+$/.test(token) && token.length >= 5
			const looksLikeIdentifier =
				(looksLikePascalCaseSymbol && !pascalCaseStopwords.has(normalizedToken)) ||
				/[a-z]+[A-Z][A-Za-z0-9_]*/.test(token) ||
				/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(token)
			if (looksLikeQualifiedSymbol || looksLikeIdentifier) {
				for (const expansion of this.expandIdentifierHintVariants(token)) {
					symbolHints.add(expansion)
					lexicalExpansionTerms.add(expansion)
				}
			}

			if (ddlTokens.has(normalizedToken)) {
				ddlHints.add(normalizedToken)
			}
		}

		if (normalizedQuery.includes("/") || /\.[a-z0-9_-]{1,8}$/.test(normalizedQuery)) {
			pathHints.add(normalizedQuery.replace(/\\/g, "/"))
		}
		if (normalizedQuery.includes(".") && /[a-z_]/.test(normalizedQuery)) {
			for (const expansion of this.expandIdentifierHintVariants(query.trim())) {
				symbolHints.add(expansion)
				lexicalExpansionTerms.add(expansion)
			}
		}

		const normalizedTokens = this.tokenizeSearchText(query)
		const contentHints = normalizedTokens.filter(
			(token) =>
				token.length >= 3 &&
				!pathHints.has(token) &&
				token !== "how" &&
				token !== "what" &&
				token !== "where" &&
				token !== "when" &&
				token !== "why" &&
				token !== "does" &&
				token !== "with" &&
				token !== "this" &&
				token !== "that",
		)
		const looksLikeCodeQuestion =
			questionLeadPattern.test(query.trim()) &&
			normalizedTokens.some((token) => codeQuestionTokens.has(token) || token.includes("code-index"))
		const looksLikeRetrievalExpansionQuery =
			normalizedTokens.filter((token) => retrievalExpansionTokens.has(token)).length >= 3
		const looksLikeSearchResultsDisplayQuery =
			(normalizedTokens.some((token) => token === "display") ||
				normalizedTokens.some((token) => token === "resultsdisplay") ||
				symbolHints.has("codebasesearchresultsdisplay")) &&
			normalizedTokens.some((token) => token === "search") &&
			normalizedTokens.some((token) => token === "results")
		const looksLikeHybridRetrievalQuery =
			normalizedTokens.some((token) => token === "hybrid" || token === "combine") &&
			normalizedTokens.some((token) => token === "lexical") &&
			normalizedTokens.some((token) => token === "vector")
		const looksLikeStartupTrackingQuery =
			normalizedTokens.some((token) => startupTrackingTokens.has(token)) &&
			(normalizedTokens.some((token) => token === "startup" || token === "reconcile" || token === "refresh") ||
				symbolHints.has("refreshtrackedoversizedfiles"))
		const looksLikeEvalRunnerQuery =
			(symbolHints.has("codeindexevalrunner") || symbolHints.has("searchdebug")) &&
			normalizedTokens.filter((token) => evalRunnerTokens.has(token)).length >= 2
		const looksLikePreflightQuery =
			normalizedTokens.some((token) => token === "preflight") &&
			(normalizedTokens.some((token) => token === "qdrant") ||
				normalizedTokens.some((token) => token === "verification") ||
				normalizedTokens.some((token) => token === "timeout") ||
				normalizedTokens.some((token) => token === "timed"))
		const looksLikeLowValueFilesQuery =
			normalizedTokens.some((token) => token === "low") &&
			normalizedTokens.some((token) => token === "value") &&
			(normalizedTokens.some((token) => token === "file") || normalizedTokens.some((token) => token === "files"))
		const looksLikeOversizedWebviewHandlerQuery =
			(normalizedTokens.some((token) => token === "fullrefreshindexdata") ||
				symbolHints.has("fullrefreshindexdata")) &&
			(normalizedTokens.some((token) => token === "requestoversizedfiledetails") ||
				symbolHints.has("requestoversizedfiledetails")) &&
			(normalizedTokens.some((token) => token === "webview") ||
				normalizedTokens.some((token) => token === "handler"))
		const looksLikeFullRefreshManagerQuery =
			(symbolHints.has("refreshallindexdata") ||
				(normalizedTokens.some((token) => token === "full") &&
					normalizedTokens.some((token) => token === "refresh") &&
					normalizedTokens.some((token) => token === "manager"))) &&
			(normalizedTokens.some((token) => token === "manager") ||
				normalizedTokens.some((token) => token === "index"))
		const looksLikeImplementationQuery =
			looksLikeCodeQuestion &&
			(looksLikeRetrievalExpansionQuery ||
				looksLikeHybridRetrievalQuery ||
				looksLikeEvalRunnerQuery ||
				looksLikePreflightQuery ||
				looksLikeLowValueFilesQuery ||
				looksLikeOversizedWebviewHandlerQuery ||
				looksLikeSearchResultsDisplayQuery ||
				looksLikeFullRefreshManagerQuery ||
				looksLikeStartupTrackingQuery ||
				normalizedTokens.some((token) => token === "how") ||
				normalizedTokens.some((token) => token === "does"))
		const implementationHints = normalizedTokens.filter((token) => implementationTokens.has(token))

		return {
			pathHints: Array.from(pathHints),
			symbolHints: Array.from(symbolHints),
			lexicalExpansionTerms: Array.from(lexicalExpansionTerms),
			looksLikeNaturalLanguage: query.trim().includes(" ") && rawTokens.length >= 3,
			looksLikeCodeQuestion,
			looksLikeImplementationQuery,
			looksLikeSearchResultsDisplayQuery,
			looksLikeEvalRunnerQuery,
			looksLikePreflightQuery,
			looksLikeLowValueFilesQuery,
			looksLikeOversizedWebviewHandlerQuery,
			looksLikeRetrievalExpansionQuery,
			looksLikeHybridRetrievalQuery,
			looksLikeStartupTrackingQuery,
			looksLikeFullRefreshManagerQuery,
			looksLikeSchemaQuery:
				ddlHints.size > 0 ||
				normalizedQuery.includes("schema.ts") ||
				normalizedQuery.includes("chunk_variants") ||
				normalizedQuery.includes("create table"),
			ddlHints: Array.from(ddlHints),
			contentHints,
			implementationHints,
		}
	}

	private isLikelyNonCodeContentPath(filePath: string): boolean {
		return (
			filePath.endsWith(".md") ||
			filePath.includes("/content/blog/") ||
			filePath.includes("/content/docs/") ||
			filePath.includes("/blog/")
		)
	}

	private tokenizeSearchText(value: string): string[] {
		return Array.from(new Set(value.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [])).filter(
			(token) => token.length > 1,
		)
	}

	private countTokenHits(tokens: string[], ...haystacks: Array<string | null | undefined>): number {
		if (tokens.length === 0) {
			return 0
		}

		const haystackTokens = this.buildTokenSet(...haystacks)
		if (haystackTokens.size === 0) {
			return 0
		}

		return tokens.reduce((count, token) => count + (haystackTokens.has(token) ? 1 : 0), 0)
	}

	private countStructuredTokenHits(tokens: string[], ...haystacks: Array<string | null | undefined>): number {
		if (tokens.length === 0) {
			return 0
		}

		const haystackTokens = Array.from(this.buildTokenSet(...haystacks))
		if (haystackTokens.length === 0) {
			return 0
		}

		return tokens.reduce((count, token) => {
			const matched = haystackTokens.some(
				(haystackToken) =>
					haystackToken === token ||
					(this.isStructuredToken(token) && haystackToken.includes(token)) ||
					(this.isStructuredToken(haystackToken) && haystackToken.includes(token)) ||
					(this.isStructuredToken(haystackToken) && token.includes(haystackToken)),
			)
			return count + (matched ? 1 : 0)
		}, 0)
	}

	private buildTokenSet(...haystacks: Array<string | null | undefined>): Set<string> {
		const tokenSet = new Set<string>()
		for (const haystack of haystacks) {
			for (const token of this.tokenizeSearchText(haystack ?? "")) {
				tokenSet.add(token)
			}
		}
		return tokenSet
	}

	private isStructuredToken(token: string): boolean {
		return token.includes("/") || token.includes(".") || token.includes("_") || token.includes("-")
	}

	private inferDesiredChunkKinds(tokens: string[]): Set<string> {
		const chunkKinds = new Set<string>()
		for (const token of tokens) {
			if (token === "class" || token === "classes") {
				chunkKinds.add("class")
			}
			if (token === "method" || token === "methods") {
				chunkKinds.add("method")
			}
			if (token === "function" || token === "functions") {
				chunkKinds.add("function")
			}
			if (token === "enum" || token === "enums") {
				chunkKinds.add("enum")
			}
			if (token === "interface" || token === "interfaces" || token === "type" || token === "types") {
				chunkKinds.add("type")
			}
			if (token === "module" || token === "modules" || token === "namespace" || token === "namespaces") {
				chunkKinds.add("module")
			}
			if (token === "constant" || token === "constants" || token === "const") {
				chunkKinds.add("constant")
			}
			if (token === "json") {
				chunkKinds.add("json_key")
				chunkKinds.add("json_array_item")
			}
			if (token === "yaml" || token === "yml") {
				chunkKinds.add("yaml_key")
			}
			if (token === "toml") {
				chunkKinds.add("toml_table")
			}
		}
		return chunkKinds
	}

	async enqueuePathsChanged(paths: string[], reason: "watcher" | "manual" | "reconcile"): Promise<void> {
		await this.runSerialized(async (signal) => {
			try {
				IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "paths-enqueued", {
					engine: this.engine,
					workspacePath: this.workspacePath,
					component: "WatcherCoordinator",
					jobId: `${reason}:${paths.length}`,
				})

				if (reason === "reconcile") {
					await this.runReconciliation(signal)
					return
				}

				await this.runTargetedUpdate(paths, reason, signal)
			} catch (error) {
				if (this.isAbortError(error) && this._stopRequested) {
					return
				}
				throw error
			}
		})
	}

	async getStatus(): Promise<CodeIndexStatus> {
		return this._status
	}

	async getWarningDetails(
		offset: number,
		limit: number,
		filter: "all" | "parser_failed" | "failed" | "degraded",
		sort: "severity" | "recent" | "path",
	): Promise<{
		total: number
		items: Array<{
			relativePath: string
			state: "degraded" | "terminal_failed" | "failed"
			category?: "parser_failed" | "failed" | "degraded"
			failureReason?: string | null
		}>
	}> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const details = await this.metadataStore.listRevisionWarnings(workspaceId, limit, offset, filter, sort)
		return {
			total: details.total,
			items: details.items.map((detail) => ({
				relativePath: detail.relativePath,
				state: detail.state,
				category: detail.category,
				failureReason: detail.failureReason,
			})),
		}
	}

	async getOversizedFileDetails(
		offset: number,
		limit: number,
	): Promise<{
		total: number
		actionable: number
		items: Array<{
			relativePath: string
			normalizedPath: string
			status: "skipped" | "needs_reapproval" | "approved" | "eligible" | "missing"
			sizeBytes: number
			lastModifiedMtimeMs: number | null
			recommendation: "likely_useful" | "review_manually" | "probably_skip"
			reason: string
			approvedMaxBytes: number | null
			lastEvaluatedAt: number
		}>
	}> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const details = (await this.metadataStore.listTrackedOversizedFiles?.(workspaceId, limit, offset)) ?? {
			total: 0,
			actionable: 0,
			items: [],
		}
		return {
			total: details.total,
			actionable: details.actionable,
			items: details.items.map((detail) => ({
				relativePath: detail.relativePath,
				normalizedPath: detail.normalizedPath,
				status: detail.status,
				sizeBytes: detail.sizeBytes,
				lastModifiedMtimeMs: detail.lastModifiedMtimeMs,
				recommendation: detail.recommendation,
				reason: detail.reason,
				approvedMaxBytes: detail.approvedMaxBytes,
				lastEvaluatedAt: detail.lastEvaluatedAt,
			})),
		}
	}

	async retryWarningFiles(
		filter: "all" | "parser_failed" | "failed" | "degraded",
		relativePaths?: string[],
	): Promise<{ retriedFiles: number }> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const pathsToRetry =
			relativePaths && relativePaths.length > 0
				? Array.from(new Set(relativePaths.map((relativePath) => path.normalize(relativePath))))
				: await this.metadataStore.listWarningRelativePaths(workspaceId, filter)

		if (pathsToRetry.length === 0) {
			return { retriedFiles: 0 }
		}

		await this.runSerialized(async () => {
			await this.runTargetedUpdate(
				pathsToRetry.map((relativePath) => path.join(this.workspacePath, relativePath)),
				"manual",
			)
		})

		return { retriedFiles: pathsToRetry.length }
	}

	private async refreshTrackedOversizedFiles(
		extraOversizedDetails: OversizedFileDetail[] = [],
		sourceRunId?: string,
	): Promise<void> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const workspaceAdapter = this._workspaceAdapter
		const approvalEntries = this.configManager.getOversizedFileApprovalsForWorkspace?.(this.workspacePath) ?? []
		const trackedRelativePaths = (await this.metadataStore.listTrackedOversizedRelativePaths?.(workspaceId)) ?? []
		const trackedPathSet = new Set<string>([
			...trackedRelativePaths,
			...approvalEntries.map((entry) => entry.relativePath),
			...extraOversizedDetails.map((detail) => detail.relativePath),
		])

		if (trackedPathSet.size === 0) {
			await this.metadataStore.replaceTrackedOversizedFiles?.(workspaceId, [])
			return
		}

		const defaultMaxBytes = this.configManager.currentMaxFileSizeBytes
		const evaluatedAt = Date.now()
		const oversizedByPath = new Map(extraOversizedDetails.map((detail) => [detail.relativePath, detail]))
		const entries: Array<{
			workspaceId: string
			relativePath: string
			normalizedPath: string
			status: "skipped" | "needs_reapproval" | "approved" | "eligible" | "missing"
			sizeBytes: number
			lastModifiedMtimeMs?: number | null
			recommendation: "likely_useful" | "review_manually" | "probably_skip"
			reason: string
			approvedMaxBytes?: number | null
			sourceRunId?: string | null
			lastEvaluatedAt?: number
		}> = []

		for (const relativePath of Array.from(trackedPathSet).sort((left, right) => left.localeCompare(right))) {
			const normalizedPath = path.join(this.workspacePath, relativePath)
			const approval = this.configManager.getOversizedFileApproval(this.workspacePath, relativePath)
			const approvedMaxBytes = approval?.approvedMaxBytes

			try {
				const fileStat = workspaceAdapter
					? await workspaceAdapter.statFile(normalizedPath)
					: await fs.stat(normalizedPath)
				if ("isFile" in fileStat && typeof fileStat.isFile === "function" && !fileStat.isFile()) {
					continue
				}

				const sizeBytes = fileStat.size
				const lastModifiedMtimeMs = "mtimeMs" in fileStat ? fileStat.mtimeMs : null
				const detail =
					oversizedByPath.get(relativePath) ??
					describeOversizedFile(relativePath, sizeBytes, approvedMaxBytes)
				const effectiveMaxBytes = Math.max(defaultMaxBytes, approvedMaxBytes ?? 0)
				const status =
					sizeBytes > effectiveMaxBytes
						? approvedMaxBytes && sizeBytes > approvedMaxBytes
							? "needs_reapproval"
							: "skipped"
						: approvedMaxBytes && sizeBytes > defaultMaxBytes
							? "approved"
							: "eligible"
				const reason =
					status === "approved"
						? `${detail.reason} Approved for indexing above the default size limit.`
						: status === "eligible"
							? "This file is now within the current size limit and can be indexed without an oversized override."
							: detail.reason

				entries.push({
					workspaceId,
					relativePath,
					normalizedPath,
					status,
					sizeBytes,
					lastModifiedMtimeMs,
					recommendation: detail.recommendation,
					reason,
					approvedMaxBytes: approvedMaxBytes ?? null,
					sourceRunId: sourceRunId ?? null,
					lastEvaluatedAt: evaluatedAt,
				})
			} catch (error) {
				if (this.isMissingFileError(error)) {
					entries.push({
						workspaceId,
						relativePath,
						normalizedPath,
						status: "missing",
						sizeBytes: 0,
						lastModifiedMtimeMs: null,
						recommendation: "review_manually",
						reason: "This tracked file is no longer present in the workspace.",
						approvedMaxBytes: approvedMaxBytes ?? null,
						sourceRunId: sourceRunId ?? null,
						lastEvaluatedAt: evaluatedAt,
					})
					continue
				}
				throw error
			}
		}

		await this.metadataStore.replaceTrackedOversizedFiles?.(workspaceId, entries)
	}

	private getOrCreateIndexDependencies(): {
		embeddingAdapter: ExistingEmbedderAdapter
		vectorStore: QdrantRestVectorStoreAdapter
	} {
		if (!this._indexEmbeddingAdapter) {
			const cacheManager = new CacheManager(this.context, this.workspacePath)
			const serviceFactory = new CodeIndexServiceFactory(this.configManager, this.workspacePath, cacheManager)
			const runtimeMetadata = this.getEmbeddingRuntimeMetadata()
			this._indexEmbeddingAdapter = new ExistingEmbedderAdapter(serviceFactory.createEmbedder(), {
				modelId: this.configManager.currentModelId,
				runtimeKind: runtimeMetadata.runtimeKind,
				runtimeLabel: runtimeMetadata.runtimeLabel,
				deviceHint: runtimeMetadata.deviceHint,
				workspacePath: this.workspacePath,
			})
			this.seedAdaptiveRuntimeProfile(this._indexEmbeddingAdapter)
		}

		if (!this._indexVectorStore) {
			const vectorSize = this.configManager.currentModelDimension
			const qdrantUrl = this.configManager.qdrantConfig.url
			if (!vectorSize || !qdrantUrl) {
				throw new Error("Code Index V2 requires a configured embedder dimension and Qdrant URL")
			}

			this._indexVectorStore = new QdrantRestVectorStoreAdapter(
				this.workspacePath,
				qdrantUrl,
				vectorSize,
				this.configManager.qdrantConfig.apiKey,
			)
		}

		return {
			embeddingAdapter: this._indexEmbeddingAdapter,
			vectorStore: this._indexVectorStore,
		}
	}

	private createIndexingSidecarExecutor(embeddingAdapter: ExistingEmbedderAdapter): SidecarEmbedUpsertExecutor {
		const vectorSize = this.configManager.currentModelDimension
		if (!vectorSize) {
			throw new Error("Code Index V2 sidecar requires a configured embedder dimension")
		}
		return new SidecarEmbedUpsertExecutor(
			this.workspacePath,
			this.configManager.getConfig(),
			vectorSize,
			{
				provider: embeddingAdapter.provider,
				modelId: embeddingAdapter.modelId,
				runtimeKind: embeddingAdapter.runtimeKind,
				runtimeLabel: embeddingAdapter.runtimeLabel,
				deviceHint: embeddingAdapter.deviceHint,
			},
			this.configManager.currentEmbeddingLaneConcurrency,
			{
				profile: this.getAdaptiveRuntimeProfile(),
				onRuntimeObservations: (observations, reportedProfile) =>
					this.handleAdaptiveRuntimeObservations(observations, reportedProfile),
			},
		)
	}

	private createParseSidecarExecutor(): SidecarParseExecutor {
		return new SidecarParseExecutor(this.workspacePath, this.configManager.currentEmbeddingLaneConcurrency)
	}

	private getOrCreateSearchDependencies(): {
		embeddingAdapter: ExistingEmbedderAdapter
		vectorStore: QdrantRestVectorStoreAdapter
	} {
		if (!this._searchEmbeddingAdapter) {
			const cacheManager = new CacheManager(this.context, this.workspacePath)
			const serviceFactory = new CodeIndexServiceFactory(this.configManager, this.workspacePath, cacheManager)
			const runtimeMetadata = this.getEmbeddingRuntimeMetadata()
			this._searchEmbeddingAdapter = new ExistingEmbedderAdapter(serviceFactory.createEmbedder(), {
				modelId: this.configManager.currentModelId,
				runtimeKind: runtimeMetadata.runtimeKind,
				runtimeLabel: runtimeMetadata.runtimeLabel,
				deviceHint: runtimeMetadata.deviceHint,
				workspacePath: this.workspacePath,
			})
			this.seedAdaptiveRuntimeProfile(this._searchEmbeddingAdapter)
		}

		if (!this._searchVectorStore) {
			const vectorSize = this.configManager.currentModelDimension
			const qdrantUrl = this.configManager.qdrantConfig.url
			if (!vectorSize || !qdrantUrl) {
				throw new Error("Code Index V2 requires a configured embedder dimension and Qdrant URL")
			}

			this._searchVectorStore = new QdrantRestVectorStoreAdapter(
				this.workspacePath,
				qdrantUrl,
				vectorSize,
				this.configManager.qdrantConfig.apiKey,
			)
		}

		return {
			embeddingAdapter: this._searchEmbeddingAdapter,
			vectorStore: this._searchVectorStore,
		}
	}

	private async runFullIndex(mode: "start" | "refresh", signal?: AbortSignal): Promise<void> {
		const runStartedAt = Date.now()
		const workspaceAdapter = this.requireWorkspaceAdapter()
		const isRefresh = mode === "refresh"
		let summary: Awaited<ReturnType<DiscoveryService["runWorkspaceDiscoveryWithProgress"]>> | undefined
		let pipelineSummary: Awaited<ReturnType<CodeIndexEngineV2["runPipelineForRun"]>> | undefined

		try {
			this.stateManager.beginPipelineRun(isRefresh ? "refresh" : "start")
			await this.preflightIndexingDependencies(signal)
			const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
			const discoveryMessage = isRefresh ? "Refreshing the workspace map" : "Walking the workspace"
			this._status = {
				engine: this.engine,
				state: "running",
				message: discoveryMessage,
			}
			this.stateManager.reportCustomProgress(discoveryMessage, 0, 1, {
				currentItemUnit: "files",
				phase: "scanning",
				detailedStage: "discovering",
			})
			let discoveredFiles = 0
			let processedDirectories = 0
			let pendingDirectories = 1
			const previousTrackedFiles = await this.metadataStore.countTrackedFilesForWorkspace(
				this.metadataStore.getWorkspaceId(),
			)
			const getDiscoveryEstimate = () => {
				const directoryForecast =
					processedDirectories > 0
						? Math.ceil(discoveredFiles + (discoveredFiles / processedDirectories) * pendingDirectories)
						: 0

				return Math.max(
					previousTrackedFiles,
					directoryForecast,
					discoveredFiles > 0 ? Math.ceil(discoveredFiles * 1.15) : 500,
					discoveredFiles > 0 ? Math.ceil(discoveredFiles / 0.9) : 0,
					discoveredFiles + pendingDirectories,
					discoveredFiles + 1,
				)
			}
			const getDiscoveryConfidence = (): "low" | "medium" | "high" => {
				if (processedDirectories >= 200 || discoveredFiles >= 10_000) {
					return "high"
				}
				if (processedDirectories >= 40 || discoveredFiles >= 2_000) {
					return "medium"
				}
				return "low"
			}
			const updateDiscoveryDetail = () => {
				this.stateManager.setActivityDetail(
					`${discoveredFiles.toLocaleString()} candidate files ${isRefresh ? "re-evaluated" : "found"} • Estimated total ~${getDiscoveryEstimate().toLocaleString()} files • ${processedDirectories.toLocaleString()} dirs visited • ${this.getMemoryStatusText()}`,
				)
			}
			const updateDiscoveryPipelineSnapshot = (state: "running" | "completed") => {
				this.stateManager.setPipelineSnapshot(
					{
						runMode: isRefresh ? "refresh" : "start",
						overallState: "running",
						etaMs: null,
						services: this.buildPipelineServicesSnapshot({
							discovery: {
								state,
								health: "healthy",
								summary:
									state === "completed"
										? `${summary?.discoveredFiles?.toLocaleString() ?? discoveredFiles.toLocaleString()} files discovered`
										: discoveryMessage,
								detail:
									state === "completed"
										? `Visited ${processedDirectories.toLocaleString()} directories`
										: `${discoveredFiles.toLocaleString()} candidate files found`,
								progressCurrent: discoveredFiles,
								progressTotal:
									state === "completed" ? Math.max(discoveredFiles, 1) : getDiscoveryEstimate(),
								progressUnit: "files",
								progressPercent:
									state === "completed"
										? 100
										: Math.min(
												99,
												Math.round(
													(discoveredFiles / Math.max(getDiscoveryEstimate(), 1)) * 100,
												),
											),
								metrics: [
									this.createServiceMetric("found", "Found", discoveredFiles.toLocaleString()),
									this.createServiceMetric(
										"estimate",
										"Estimate",
										`~${getDiscoveryEstimate().toLocaleString()}`,
									),
									this.createServiceMetric("dirs", "Dirs", processedDirectories.toLocaleString()),
									this.createServiceMetric(
										"confidence",
										"Confidence",
										getDiscoveryConfidence(),
										"neutral",
									),
								],
							},
						}),
					},
					{ forceImmediate: state === "completed" },
				)
			}
			updateDiscoveryDetail()
			updateDiscoveryPipelineSnapshot("running")
			this.startActivityHeartbeat(() => discoveryMessage)
			const discoveryStartedAt = Date.now()
			summary = await discoveryService.runWorkspaceDiscoveryWithProgress(
				"initial-discovery",
				signal,
				(progress) => {
					discoveredFiles = progress.discoveredFiles
					processedDirectories = Math.max(processedDirectories, progress.processedDirectories)
					pendingDirectories = Math.max(progress.pendingDirectories, 0)
					this.stateManager.reportCustomProgress(discoveryMessage, discoveredFiles, getDiscoveryEstimate(), {
						currentItemUnit: "files",
						phase: "scanning",
						detailedStage: "discovering",
						estimationConfidence: getDiscoveryConfidence(),
					})
					updateDiscoveryDetail()
					updateDiscoveryPipelineSnapshot("running")
				},
			)
			const discoveryMs = Date.now() - discoveryStartedAt
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
			updateDiscoveryPipelineSnapshot("completed")
			this._status = {
				engine: this.engine,
				state: "running",
				message: isRefresh
					? `Re-evaluated ${summary.discoveredFiles.toLocaleString()} files, now checking what changed`
					: `Mapped ${summary.discoveredFiles.toLocaleString()} files, now checking what changed`,
			}
			this.stateManager.reportScanProgress(summary.discoveredFiles, summary.discoveredFiles)
			pipelineSummary = await this.runPipelineForRun(
				summary.runId,
				summary.discoveredFiles,
				undefined,
				{ runMode: isRefresh ? "refresh" : "start" },
				signal,
			)
			const totalRunMs = Date.now() - runStartedAt
			await this.refreshTrackedOversizedFiles(pipelineSummary.oversizedDetails, summary.runId)
			this.logIndexRunPerformanceSummary(
				isRefresh ? "refresh" : "start",
				summary.runId,
				{
					discoveryMs,
					totalRunMs,
					discoveredFiles: summary.discoveredFiles,
					isPartial: summary.isPartial,
				},
				pipelineSummary,
			)
			await this.persistRunTelemetrySummary(summary.runId, {
				triggerType: isRefresh ? "refresh" : "start",
				state: "complete",
				startedAt: runStartedAt,
				completedAt: Date.now(),
				totalRunMs,
				discoveryMs,
				discoveredFiles: summary.discoveredFiles,
				pipelineSummary,
			})
			this.stateManager.setResilienceStats({
				resumedRetryJobs: this._resumedRetryJobsCount,
				resumedPendingJobs: this._resumedPendingJobsCount,
				retryingParseRevisions: pipelineSummary.retryingParseRevisions,
				terminalFailedParseRevisions: pipelineSummary.terminalFailedParseRevisions,
				degradedRevisions: pipelineSummary.degradedRevisions,
				terminalFailedRevisions: pipelineSummary.terminalFailedRevisions,
				terminallyFailedChunks: pipelineSummary.terminallyFailedChunks,
				retryingChunks: pipelineSummary.retryingChunks,
			})
			if (this._resumedRetryJobsCount === 0 && this._resumedPendingJobsCount === 0) {
				this.stateManager.setRecoveryContext("none", "none")
			}

			this._status = {
				engine: this.engine,
				state: "idle",
				message:
					pipelineSummary.changedFiles === 0
						? summary.isPartial
							? `V2 is current after a partial ${isRefresh ? "refresh" : "scan"} of ${summary.discoveredFiles.toLocaleString()} files${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`
							: isRefresh
								? `V2 refresh re-evaluated ${summary.discoveredFiles.toLocaleString()} files${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`
								: `V2 is current across ${summary.discoveredFiles.toLocaleString()} files${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`
						: summary.isPartial
							? `Partial V2 ${isRefresh ? "refresh" : "scan"} processed ${summary.discoveredFiles.toLocaleString()} files, refreshed ${pipelineSummary.changedFiles.toLocaleString()} changed files, and synced ${pipelineSummary.syncedChunks.toLocaleString()} chunks${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`
							: isRefresh
								? `V2 refresh re-evaluated ${summary.discoveredFiles.toLocaleString()} files, refreshed ${pipelineSummary.changedFiles.toLocaleString()} changed files, and synced ${pipelineSummary.syncedChunks.toLocaleString()} chunks${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`
								: `V2 mapped ${summary.discoveredFiles.toLocaleString()} files, refreshed ${pipelineSummary.changedFiles.toLocaleString()} changed files, and synced ${pipelineSummary.syncedChunks.toLocaleString()} chunks${this.buildOversizedSummarySuffix(pipelineSummary.oversizedFiles)}`,
			}
			if (
				pipelineSummary.terminalFailedParseRevisions > 0 ||
				pipelineSummary.degradedRevisions > 0 ||
				pipelineSummary.terminalFailedRevisions > 0
			) {
				const warningParts: string[] = []
				if (pipelineSummary.terminalFailedParseRevisions > 0) {
					warningParts.push(
						`${pipelineSummary.terminalFailedParseRevisions.toLocaleString()} parser-failed files`,
					)
				}
				if (pipelineSummary.degradedRevisions > 0) {
					warningParts.push(`${pipelineSummary.degradedRevisions.toLocaleString()} degraded files`)
				}
				if (pipelineSummary.terminalFailedRevisions > 0) {
					warningParts.push(`${pipelineSummary.terminalFailedRevisions.toLocaleString()} failed files`)
				}
				this._status.message = `${this._status.message} with warnings (${warningParts.join(", ")})`
			}
			const workspaceId = this.metadataStore.getWorkspaceId()
			const indexedFiles = await this.metadataStore.countActiveIndexedFilesForWorkspace(workspaceId)
			const indexedChunks = await this.metadataStore.countActiveChunksForWorkspace(workspaceId)
			const warningDetails = await this.metadataStore.listRevisionWarnings(workspaceId, 8, 0)
			this.stateManager.setResilienceStats({
				resumedRetryJobs: this._resumedRetryJobsCount,
				resumedPendingJobs: this._resumedPendingJobsCount,
				retryingParseRevisions: pipelineSummary.retryingParseRevisions,
				terminalFailedParseRevisions: pipelineSummary.terminalFailedParseRevisions,
				degradedRevisions: pipelineSummary.degradedRevisions,
				terminalFailedRevisions: pipelineSummary.terminalFailedRevisions,
				terminallyFailedChunks: pipelineSummary.terminallyFailedChunks,
				retryingChunks: pipelineSummary.retryingChunks,
				warningDetails: warningDetails.items.map((detail) => ({
					relativePath: detail.relativePath,
					state: detail.state,
					category: detail.category,
					failureReason: detail.failureReason,
				})),
			})
			this.stateManager.setOversizedDetails(pipelineSummary.oversizedDetails)
			this.stateManager.preserveCompletedPipelineSnapshot()
			this.stateManager.reportComplete(indexedChunks, indexedFiles)
			if (
				pipelineSummary.oversizedFiles > 0 ||
				pipelineSummary.terminalFailedParseRevisions > 0 ||
				pipelineSummary.degradedRevisions > 0 ||
				pipelineSummary.terminalFailedRevisions > 0
			) {
				this.stateManager.setSystemState("Indexed", this._status.message)
			}

			this.logFullIndexTerminalEvent("full-index-complete", mode, {
				runId: summary.runId,
				discoveredFiles: summary.discoveredFiles,
				changedFiles: pipelineSummary.changedFiles,
				parsedChunks: pipelineSummary.parsedChunks,
				syncedChunks: pipelineSummary.syncedChunks,
				oversizedFiles: pipelineSummary.oversizedFiles,
				message: this._status.message,
			})
		} catch (error) {
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
			this.stateManager.setPipelineTerminalState(
				this.isAbortError(error) && this._stopRequested ? "stopped" : "failed",
			)
			if (summary?.runId) {
				await this.persistRunTelemetrySummary(summary.runId, {
					triggerType: mode,
					state: this.isAbortError(error) && this._stopRequested ? "stopped" : "failed",
					startedAt: runStartedAt,
					completedAt: Date.now(),
					totalRunMs: Date.now() - runStartedAt,
					discoveryMs: summary ? Date.now() - runStartedAt : undefined,
					discoveredFiles: summary?.discoveredFiles,
					pipelineSummary,
					errorMessage: this.getStopAwareErrorMessage(error),
				}).catch(() => undefined)
			}
			this.logFullIndexTerminalEvent("full-index-failed", mode, {
				runId: summary?.runId,
				discoveredFiles: summary?.discoveredFiles,
				changedFiles: pipelineSummary?.changedFiles,
				syncedChunks: pipelineSummary?.syncedChunks,
				message: this._status.message,
				errorMessage: this.getStopAwareErrorMessage(error),
			})
			throw error
		}
	}

	private async runTargetedUpdate(
		paths: string[],
		reason: "watcher" | "manual",
		signal?: AbortSignal,
	): Promise<void> {
		if (paths.length === 0) {
			return
		}

		this._status = {
			engine: this.engine,
			state: "running",
			message: `Refreshing ${paths.length.toLocaleString()} changed paths`,
		}
		this.stateManager.reportCustomProgress(
			`Refreshing ${paths.length.toLocaleString()} changed paths`,
			0,
			paths.length,
			{
				currentItemUnit: "files",
				phase: "scanning",
				detailedStage: "reconciling",
			},
		)
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "targeted-update-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			jobId: `${reason}:${paths.length}`,
		})

		const workspaceAdapter = this.requireWorkspaceAdapter()
		const normalizedPaths = Array.from(new Set(paths.map((filePath) => path.normalize(filePath))))
		const existingPaths: string[] = []
		const oversizedPaths: string[] = []
		const oversizedDetails: OversizedFileDetail[] = []
		const deletedPaths: string[] = []

		for (const filePath of normalizedPaths) {
			if (signal?.aborted) {
				throw new Error("Targeted update aborted")
			}
			try {
				await fs.access(filePath)
				const stat = await workspaceAdapter.statFile(filePath)
				const relativePath = path.relative(this.workspacePath, filePath)
				if (stat.size > this.getEffectiveMaxFileSizeBytes(relativePath)) {
					oversizedPaths.push(filePath)
					oversizedDetails.push(
						describeOversizedFile(
							relativePath,
							stat.size,
							this.configManager.getOversizedFileApproval(this.workspacePath, relativePath)
								?.approvedMaxBytes,
						),
					)
				} else {
					existingPaths.push(filePath)
				}
			} catch {
				deletedPaths.push(filePath)
			}
		}

		if (existingPaths.length > 0) {
			const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
			const summary = await discoveryService.runTargetedDiscovery(existingPaths, reason, signal)
			await this.runPipelineForRun(
				summary.runId,
				summary.discoveredFiles,
				existingPaths.map((filePath) => path.relative(this.workspacePath, filePath)),
				undefined,
				signal,
			)
		}

		if (deletedPaths.length > 0) {
			await this.runDeletionPipeline(deletedPaths, `delete-${reason}`, signal)
		}

		if (oversizedPaths.length > 0) {
			await this.runDeletionPipeline(oversizedPaths, `oversized-${reason}`, signal)
		}
		await this.refreshTrackedOversizedFiles(oversizedDetails)

		const workspaceId = this.metadataStore.getWorkspaceId()
		const indexedFiles = await this.metadataStore.countActiveIndexedFilesForWorkspace(workspaceId)
		const liveMessage = `V2 is current across ${indexedFiles.toLocaleString()} files`

		this._status = {
			engine: this.engine,
			state: "idle",
			message: liveMessage,
		}
		this.stateManager.setSystemState("Standby", liveMessage)
	}

	private async runDeletionPipeline(paths: string[], triggerType: string, signal?: AbortSignal): Promise<void> {
		this._status = {
			engine: this.engine,
			state: "running",
			message: `Removing ${paths.length.toLocaleString()} deleted paths from the index`,
		}
		this.stateManager.reportCustomProgress(
			`Removing ${paths.length.toLocaleString()} deleted paths from the index`,
			0,
			paths.length,
			{
				currentItemUnit: "files",
				phase: "embedding",
				detailedStage: "deleting_vectors",
				hasKnownVectorWork: true,
				hasStartedVectorSync: false,
			},
		)
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "deletion-pipeline-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			jobId: `${triggerType}:${paths.length}`,
		})
		const runId = await this.metadataStore.beginRun(triggerType)
		const workspaceId = this.metadataStore.getWorkspaceId()
		let deleteJobs = 0

		for (const filePath of paths) {
			if (signal?.aborted) {
				throw new Error("Deletion pipeline aborted")
			}
			const relativePath = path.relative(this.workspacePath, filePath)
			const fileRecord = await this.metadataStore.getFileRecordByWorkspacePathOptional(workspaceId, relativePath)
			if (!fileRecord) {
				continue
			}

			const activeRevision = await this.metadataStore.getActiveRevisionForFile(fileRecord.fileId)
			const activeChunks = activeRevision
				? await this.metadataStore.getChunksForRevision(activeRevision.revisionId)
				: []

			if (activeChunks.length > 0) {
				await this.metadataStore.enqueueJobs(
					activeChunks.map((chunk) => ({
						workspaceId,
						runId,
						jobType: "delete",
						entityId: chunk.chunkId,
					})),
				)
				deleteJobs += activeChunks.length
			}

			await this.metadataStore.markFileTombstoned(fileRecord.fileId, true)
		}

		const dependencies = this.getOrCreateIndexDependencies()
		const sidecarExecutor = this.createIndexingSidecarExecutor(dependencies.embeddingAdapter)
		const embedUpsertWorker = new EmbedUpsertWorker(
			this.metadataStore,
			dependencies.embeddingAdapter,
			dependencies.vectorStore,
			sidecarExecutor,
			this.workspacePath,
		)
		let drainPromise: Promise<void> | undefined
		try {
			await embedUpsertWorker.run(runId, signal)
			await this.metadataStore.markRunComplete(runId)
		} catch (error) {
			if (!signal?.aborted) {
				this._activeAbortController?.abort()
			}
			if (this.isAbortError(error) && this._stopRequested) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, this.getStopAwareErrorMessage(error))
			}
			throw error
		} finally {
			await embedUpsertWorker.dispose()
			await dependencies.embeddingAdapter.recycleClient?.()
			await dependencies.vectorStore.recycleClient?.()
		}

		this._status = {
			engine: this.engine,
			state: "idle",
			message: `V2 processed ${paths.length} deleted files and queued ${deleteJobs} chunk deletions`,
		}
		this.stateManager.reportComplete(deleteJobs, paths.length)
	}

	private async runReconciliation(signal?: AbortSignal): Promise<void> {
		this.stateManager.beginPipelineRun("reconcile")
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Reconciling local state with the workspace",
		}
		this.stateManager.reportCustomProgress("Reconciling local state with the workspace", 0, 1, {
			currentItemUnit: "passes",
			phase: "scanning",
			detailedStage: "reconciling",
			isBackgroundReconcile: true,
		})
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "reconciliation-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
		})
		const workspaceAdapter = this.requireWorkspaceAdapter()
		const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
		const reconciliationService = new ReconciliationService(this.metadataStore, workspaceAdapter, (relativePath) =>
			this.getEffectiveMaxFileSizeBytes(relativePath),
		)
		const summary = await discoveryService.runReconciliationDiscovery(signal)
		const reconciliationSummary = await reconciliationService.findMissingFiles(summary)

		if (reconciliationSummary.missingFiles.length > 0) {
			await this.runDeletionPipeline(
				reconciliationSummary.missingFiles.map((relativePath) => path.join(this.workspacePath, relativePath)),
				"reconcile-delete",
				signal,
			)
		}

		await this.runPipelineForRun(
			summary.runId,
			summary.discoveredFiles,
			undefined,
			{ isBackgroundReconcile: true, runMode: "reconcile" },
			signal,
		)
		const indexedFiles = await this.metadataStore.countActiveIndexedFilesForWorkspace(
			this.metadataStore.getWorkspaceId(),
		)
		const liveMessage = `V2 is current across ${indexedFiles.toLocaleString()} files`
		this._status = {
			engine: this.engine,
			state: "idle",
			message: liveMessage,
		}
		this.stateManager.setSystemState("Standby", liveMessage)
	}

	private async runPipelineForRun(
		runId: string,
		knownTotalFiles?: number,
		relativePaths?: string[],
		options?: {
			isBackgroundReconcile?: boolean
			runMode?: "start" | "refresh" | "reconcile"
		},
		signal?: AbortSignal,
	): Promise<{
		changedFiles: number
		parsedChunks: number
		syncedChunks: number
		upsertedChunks: number
		deletedChunks: number
		oversizedFiles: number
		oversizedDetails: OversizedFileDetail[]
		retryingParseRevisions: number
		terminalFailedParseRevisions: number
		degradedRevisions: number
		terminalFailedRevisions: number
		terminallyFailedChunks: number
		retryingChunks: number
		performance: {
			statHashMs: number
			parseChunkMs: number
			diffPlanningMs: number
			embedUpsertMs: number
			totalPipelineMs: number
			filesScanned: number
			filesChanged: number
			chunksParsed: number
			vectorsCreated: number
			vectorDeletes: number
			chunksPerSecond?: number
			vectorsPerSecond?: number
			averageBatchLatencyMs?: number
			averageEmbedLatencyMs?: number
			averageUpsertLatencyMs?: number
			averageMetadataCommitLatencyMs?: number
			averageIdleGapMs?: number
			variantEmbeddingsCreated?: number
			batchesCompleted?: number
			peakChunksPerSecond?: number
			peakBatchLatencyMs?: number
			peakIdleGapMs?: number
			peakBatchSize?: number
			peakEmbeddingCount?: number
			laneConcurrency?: number
			effectiveBatchSize?: number
			peakInFlightChunkCount?: number
			pressureState?: string
			pressureReasons?: string[]
			pressureSoftTransitions?: number
			pressureHardTransitions?: number
			pressureSoftDurationMs?: number
			pressureHardDurationMs?: number
			waitingForJobsMs?: number
			waitingForInFlightCapacityMs?: number
			waitingForPressureMs?: number
			providerBatchUtilization?: number
			embeddingsPerChunk?: number
			laneOccupancyPercent?: number
			embedActivePercent?: number
			averageGpuUtilizationPercent?: number
			peakGpuUtilizationPercent?: number
			averageGpuInUseBytes?: number
			peakGpuInUseBytes?: number
			gpuSampleCount?: number
			blockedOnParsedRevisionsMs?: number
			blockedOnStagedChunksMs?: number
			gpu?: CodeIndexV2GpuSnapshot | null
		}
	}> {
		const pipelineStartedAt = Date.now()
		const workspaceAdapter = this.requireWorkspaceAdapter()
		await this.retireExcludedTrackedFilesBeforeStatHash(workspaceAdapter, relativePaths)
		const statHashService = new StatHashService(this.metadataStore, workspaceAdapter)
		const baselineIndexedFiles = await this.metadataStore.countActiveIndexedFilesForWorkspace(
			this.metadataStore.getWorkspaceId(),
		)
		const hasComparableBaseline = baselineIndexedFiles > 0
		const statHashStage = hasComparableBaseline ? "comparing_signatures" : "hashing_initial"
		const statHashHeadline = hasComparableBaseline ? "Comparing file signatures" : "Preparing files for indexing"
		this._status = {
			engine: this.engine,
			state: "running",
			message: statHashHeadline,
		}
		const initialTotalFiles = Math.max(knownTotalFiles ?? relativePaths?.length ?? 0, 1)
		this.stateManager.reportCustomProgress(statHashHeadline, 0, initialTotalFiles, {
			currentItemUnit: "files",
			phase: "scanning",
			detailedStage: statHashStage,
			isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
		})
		let checkedFiles = 0
		let changedFiles = 0
		let skippedFiles = 0
		let unchangedFiles = 0
		let oversizedFiles = 0
		let missingFiles = 0
		let statHashComplete = false
		const getStatHashForecast = () => {
			const totalFiles = Math.max(knownTotalFiles ?? relativePaths?.length ?? checkedFiles, checkedFiles, 1)
			if (checkedFiles <= 0) {
				return {
					totalFiles,
					projectedChangedFiles: changedFiles,
					projectedUnchangedFiles: unchangedFiles,
					projectedSkippedFiles: skippedFiles,
				}
			}

			const changedRatio = changedFiles / checkedFiles
			const projectedChangedFiles = Math.max(changedFiles, Math.round(totalFiles * changedRatio))
			const unchangedRatio = unchangedFiles / checkedFiles
			const projectedUnchangedFiles = Math.max(unchangedFiles, Math.round(totalFiles * unchangedRatio))
			const projectedSkippedFiles = Math.max(skippedFiles, totalFiles - projectedChangedFiles)

			return {
				totalFiles,
				projectedChangedFiles,
				projectedUnchangedFiles,
				projectedSkippedFiles,
			}
		}
		const getStatHashConfidence = (): "low" | "medium" | "high" => {
			const totalFiles = Math.max(relativePaths?.length ?? checkedFiles, checkedFiles, 1)
			const completion = checkedFiles / totalFiles
			if (completion >= 0.75 || checkedFiles >= 10_000) {
				return "high"
			}
			if (completion >= 0.3 || checkedFiles >= 2_000) {
				return "medium"
			}
			return "low"
		}
		const updateStatHashPipelineSnapshot = (state: "running" | "completed", forceImmediate = false) => {
			this.stateManager.setPipelineSnapshot(
				{
					runMode:
						this._resumedRetryJobsCount > 0 || this._resumedPendingJobsCount > 0
							? "resume"
							: (options?.runMode ?? "unknown"),
					overallState: state === "completed" ? "running" : "running",
					etaMs: this.stateManager.getCurrentStatus().estimatedTimeRemainingMs ?? null,
					services: this.buildPipelineServicesSnapshot({
						discovery: {
							state: "completed",
							health: "healthy",
							summary: `${Math.max(knownTotalFiles ?? 0, checkedFiles).toLocaleString()} files discovered`,
							progressCurrent: Math.max(knownTotalFiles ?? 0, checkedFiles, 1),
							progressTotal: Math.max(knownTotalFiles ?? 0, checkedFiles, 1),
							progressUnit: "files",
							progressPercent: 100,
							metrics: [
								this.createServiceMetric(
									"files",
									"Files",
									Math.max(knownTotalFiles ?? 0, checkedFiles).toLocaleString(),
								),
								this.createServiceMetric("mode", "Mode", options?.runMode ?? "unknown"),
							],
						},
						file_checks: {
							state,
							health: missingFiles > 0 || oversizedFiles > 0 ? "watch" : "healthy",
							summary: state === "completed" ? "File checks completed" : "Checking file signatures",
							detail: `${changedFiles.toLocaleString()} changed • ${unchangedFiles.toLocaleString()} unchanged`,
							progressCurrent: Math.max(checkedFiles, 0),
							progressTotal: Math.max(knownTotalFiles ?? checkedFiles, checkedFiles, 1),
							progressUnit: "files",
							progressPercent:
								state === "completed"
									? 100
									: Math.min(
											99,
											Math.round(
												(checkedFiles /
													Math.max(knownTotalFiles ?? checkedFiles, checkedFiles, 1)) *
													100,
											),
										),
							metrics: [
								this.createServiceMetric("changed", "Changed", changedFiles.toLocaleString()),
								this.createServiceMetric("unchanged", "Unchanged", unchangedFiles.toLocaleString()),
								this.createServiceMetric(
									"oversized",
									"Oversized",
									oversizedFiles.toLocaleString(),
									oversizedFiles > 0 ? "warning" : "neutral",
								),
								this.createServiceMetric(
									"missing",
									"Missing",
									missingFiles.toLocaleString(),
									missingFiles > 0 ? "warning" : "neutral",
								),
							],
						},
					}),
				},
				{ forceImmediate },
			)
		}
		const updateHashDetail = () => {
			const forecast = getStatHashForecast()
			const detailParts = [`${changedFiles.toLocaleString()} changed`]
			if (unchangedFiles > 0) {
				detailParts.push(`${unchangedFiles.toLocaleString()} unchanged`)
			}
			if (oversizedFiles > 0) {
				detailParts.push(`${oversizedFiles.toLocaleString()} oversized`)
			}
			if (missingFiles > 0) {
				detailParts.push(`${missingFiles.toLocaleString()} missing`)
			}
			const projectionSuffix =
				checkedFiles > 0 && checkedFiles < forecast.totalFiles
					? hasComparableBaseline && oversizedFiles === 0 && missingFiles === 0
						? ` • Projecting ~${forecast.projectedChangedFiles.toLocaleString()} changed, ~${forecast.projectedUnchangedFiles.toLocaleString()} unchanged`
						: ` • Projecting ~${forecast.projectedChangedFiles.toLocaleString()} changed`
					: ""
			this.stateManager.setActivityDetail(
				`${detailParts.join(" • ")}${projectionSuffix} • ${this.getMemoryStatusText()}`,
			)
		}
		updateHashDetail()
		updateStatHashPipelineSnapshot("running", true)
		this.startActivityHeartbeat(() => {
			const forecast = getStatHashForecast()
			const summaryParts = [
				`${checkedFiles.toLocaleString()} checked`,
				`${changedFiles.toLocaleString()} changed`,
			]
			if (unchangedFiles > 0) {
				summaryParts.push(`${unchangedFiles.toLocaleString()} unchanged`)
			}
			if (oversizedFiles > 0) {
				summaryParts.push(`${oversizedFiles.toLocaleString()} oversized`)
			}
			if (missingFiles > 0) {
				summaryParts.push(`${missingFiles.toLocaleString()} missing`)
			}
			const projectedChanged =
				checkedFiles > 0 && checkedFiles < forecast.totalFiles
					? `, projecting ~${forecast.projectedChangedFiles.toLocaleString()} changed`
					: ""
			return `${statHashHeadline}... ${summaryParts.join(", ")}${projectedChanged}`
		})
		let statHashSummary: Awaited<ReturnType<StatHashService["run"]>>
		let statHashMs = 0
		const statHashStartedAt = Date.now()
		try {
			statHashSummary = await statHashService.run(runId, signal, relativePaths, {
				maxFileSizeBytes: this.configManager.currentMaxFileSizeBytes,
				resolveApprovedMaxBytes: (relativePath) =>
					this.configManager.getOversizedFileApproval(this.workspacePath, relativePath)?.approvedMaxBytes,
				onProgress: (progress) => {
					checkedFiles = progress.checkedFiles
					changedFiles = progress.changedFiles
					skippedFiles = progress.skippedFiles
					unchangedFiles = progress.unchangedFiles
					oversizedFiles = progress.oversizedFiles
					missingFiles = progress.missingFiles
					const forecast = getStatHashForecast()
					const summaryParts = [
						`${checkedFiles.toLocaleString()} checked`,
						`${changedFiles.toLocaleString()} changed`,
					]
					if (unchangedFiles > 0) {
						summaryParts.push(`${unchangedFiles.toLocaleString()} unchanged`)
					}
					if (oversizedFiles > 0) {
						summaryParts.push(`${oversizedFiles.toLocaleString()} oversized`)
					}
					if (missingFiles > 0) {
						summaryParts.push(`${missingFiles.toLocaleString()} missing`)
					}
					this.stateManager.reportCustomProgress(
						`${statHashHeadline}... ${summaryParts.join(", ")}${
							checkedFiles < forecast.totalFiles
								? ` • ~${forecast.projectedChangedFiles.toLocaleString()} changed by completion`
								: ""
						}`,
						checkedFiles,
						forecast.totalFiles,
						{
							currentItemUnit: "files",
							phase: "scanning",
							detailedStage: statHashStage,
							changedFiles,
							unchangedFiles,
							oversizedFiles,
							missingFiles,
							estimationConfidence: getStatHashConfidence(),
							isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
						},
					)
					updateHashDetail()
					updateStatHashPipelineSnapshot("running")
				},
			})
		} catch (error) {
			if (this.isAbortError(error) && this._stopRequested) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, this.getStopAwareErrorMessage(error))
			}
			throw error
		}
		statHashMs += Date.now() - statHashStartedAt
		this.stopActivityHeartbeat()
		this.stateManager.setActivityDetail("")
		statHashComplete = true
		updateStatHashPipelineSnapshot("completed", true)
		const parserAdapter = new CodeIndexParserAdapter()
		const parseSidecarExecutor = this.createParseSidecarExecutor()
		const parseChunkService = new ParseChunkService(
			this.metadataStore,
			workspaceAdapter,
			parserAdapter,
			(relativePath) => this.getEffectiveMaxFileSizeBytes(relativePath),
			parseSidecarExecutor,
		)
		this._activeParseChunkService = parseChunkService
		const diffPlanner = new DiffPlanner(this.metadataStore)
		const dependencies = this.getOrCreateIndexDependencies()
		const resumedJobs = await this.metadataStore.adoptRetryableJobsFromStaleRuns(runId, this._staleRunIdsToResume)
		this._resumedRetryJobsCount = resumedJobs
		await this.refreshOutstandingResumedJobs(runId)
		if (resumedJobs > 0) {
			this.stateManager.setRecoveryContext("stale_recovery", "stale_jobs")
			this.stateManager.setResilienceStats({
				resumedRetryJobs: resumedJobs,
				resumedPendingJobs: this._resumedPendingJobsCount,
			})
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "stale-run-jobs-adopted", {
				component: "CodeIndexEngineV2",
				workspacePath: this.workspacePath,
				runId,
				jobId: `${resumedJobs}`,
			})
		}
		this._staleRunIdsToResume = []
		await dependencies.vectorStore.initialize()
		const hasIndexedPoints = await dependencies.vectorStore.hasIndexedPoints()
		if (!hasIndexedPoints && statHashSummary.changedFiles === 0 && statHashSummary.checkedFiles > 0) {
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "remote-index-empty-force-reindex", {
				component: "CodeIndexEngineV2",
				workspacePath: this.workspacePath,
				runId,
				jobId: `${statHashSummary.checkedFiles}`,
			})
			this._status = {
				engine: this.engine,
				state: "running",
				message: `Remote index is empty, rebuilding ${statHashSummary.checkedFiles.toLocaleString()} files`,
			}
			this.stateManager.reportCustomProgress(
				`Remote index is empty, rebuilding ${statHashSummary.checkedFiles.toLocaleString()} files`,
				0,
				Math.max(statHashSummary.checkedFiles, 1),
				{
					currentItemUnit: "files",
					phase: "scanning",
					detailedStage: "hashing_initial",
					isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
				},
			)
			this.startActivityHeartbeat(
				() => `Rebuilding from local index metadata... ${checkedFiles.toLocaleString()} checked`,
			)
			const forcedStatHashStartedAt = Date.now()
			try {
				statHashSummary = await statHashService.run(runId, signal, relativePaths, {
					forceReindex: true,
					maxFileSizeBytes: this.configManager.currentMaxFileSizeBytes,
					resolveApprovedMaxBytes: (relativePath) =>
						this.configManager.getOversizedFileApproval(this.workspacePath, relativePath)?.approvedMaxBytes,
					onProgress: (progress) => {
						checkedFiles = progress.checkedFiles
						changedFiles = progress.changedFiles
						skippedFiles = progress.skippedFiles
						unchangedFiles = progress.unchangedFiles
						oversizedFiles = progress.oversizedFiles
						missingFiles = progress.missingFiles
						this.stateManager.reportCustomProgress(
							`Rebuilding from local index metadata... ${checkedFiles.toLocaleString()} checked`,
							checkedFiles,
							Math.max(statHashSummary.checkedFiles, progress.checkedFiles, 1),
							{
								currentItemUnit: "files",
								phase: "scanning",
								detailedStage: "hashing_initial",
								changedFiles,
								unchangedFiles,
								oversizedFiles,
								missingFiles,
								isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
							},
						)
						this.stateManager.setActivityDetail(this.getMemoryStatusText())
						updateStatHashPipelineSnapshot("running")
					},
				})
			} catch (error) {
				if (this.isAbortError(error) && this._stopRequested) {
					await this.metadataStore.markRunStopped(runId, "Stopped by user.")
				} else {
					await this.metadataStore.markRunFailed(runId, this.getStopAwareErrorMessage(error))
				}
				throw error
			}
			statHashMs += Date.now() - forcedStatHashStartedAt
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
			statHashComplete = true
			updateStatHashPipelineSnapshot("completed", true)
		}
		if (statHashSummary.changedFiles === 0 && this._resumedPendingJobsCount === 0) {
			this.stateManager.setPipelineSnapshot(
				{
					overallState: "completed",
					etaMs: null,
					services: this.buildPipelineServicesSnapshot({
						discovery: {
							state: "completed",
							health: "healthy",
							summary: `${Math.max(statHashSummary.checkedFiles, checkedFiles).toLocaleString()} files discovered`,
							progressCurrent: Math.max(statHashSummary.checkedFiles, checkedFiles, 1),
							progressTotal: Math.max(statHashSummary.checkedFiles, checkedFiles, 1),
							progressUnit: "files",
							progressPercent: 100,
							metrics: [
								this.createServiceMetric(
									"files",
									"Files",
									Math.max(statHashSummary.checkedFiles, checkedFiles).toLocaleString(),
								),
							],
						},
						file_checks: {
							state: "completed",
							health: missingFiles > 0 || oversizedFiles > 0 ? "watch" : "healthy",
							summary: "File checks completed",
							detail: `${changedFiles.toLocaleString()} changed • ${unchangedFiles.toLocaleString()} unchanged`,
							progressCurrent: Math.max(statHashSummary.checkedFiles, checkedFiles, 1),
							progressTotal: Math.max(statHashSummary.checkedFiles, checkedFiles, 1),
							progressUnit: "files",
							progressPercent: 100,
							metrics: [
								this.createServiceMetric("changed", "Changed", changedFiles.toLocaleString()),
								this.createServiceMetric("unchanged", "Unchanged", unchangedFiles.toLocaleString()),
								this.createServiceMetric(
									"oversized",
									"Oversized",
									oversizedFiles.toLocaleString(),
									oversizedFiles > 0 ? "warning" : "neutral",
								),
								this.createServiceMetric(
									"missing",
									"Missing",
									missingFiles.toLocaleString(),
									missingFiles > 0 ? "warning" : "neutral",
								),
							],
						},
					}),
				},
				{ forceImmediate: true },
			)
			await this.metadataStore.markRunComplete(runId)
			this.logPipelineTerminalEvent("run-complete", runId, {
				message: "No changed files required indexing work.",
				changedFiles: 0,
				parsedChunks: 0,
				syncedChunks: 0,
				oversizedFiles: statHashSummary.oversizedFiles,
				totalPipelineMs: Date.now() - pipelineStartedAt,
			})
			return {
				changedFiles: 0,
				parsedChunks: 0,
				syncedChunks: 0,
				upsertedChunks: 0,
				deletedChunks: 0,
				oversizedFiles: statHashSummary.oversizedFiles,
				oversizedDetails: statHashSummary.oversizedDetails,
				retryingParseRevisions: 0,
				terminalFailedParseRevisions: 0,
				degradedRevisions: 0,
				terminalFailedRevisions: 0,
				terminallyFailedChunks: 0,
				retryingChunks: 0,
				performance: {
					statHashMs,
					parseChunkMs: 0,
					diffPlanningMs: 0,
					embedUpsertMs: 0,
					totalPipelineMs: Date.now() - pipelineStartedAt,
					filesScanned: statHashSummary.checkedFiles,
					filesChanged: statHashSummary.changedFiles,
					chunksParsed: 0,
					vectorsCreated: 0,
					vectorDeletes: 0,
					variantEmbeddingsCreated: 0,
					batchesCompleted: 0,
				},
			}
		}
		const sidecarExecutor = this.createIndexingSidecarExecutor(dependencies.embeddingAdapter)
		const embedUpsertWorker = new EmbedUpsertWorker(
			this.metadataStore,
			dependencies.embeddingAdapter,
			dependencies.vectorStore,
			sidecarExecutor,
			this.workspacePath,
		)
		this._activeEmbedUpsertWorker = embedUpsertWorker
		let drainPromise: Promise<void> | undefined
		try {
			const totalChangedFiles = Math.max(statHashSummary.changedFiles, 1)
			const schedulerProfile = this.getSchedulerProfile(statHashSummary.checkedFiles)
			const runHeartbeatOwner = `engine:${process.pid}:${runId}`
			let parsedRevisionsCompleted = 0
			let parsedChunksCompleted = 0
			let retryingParseRevisions = 0
			let terminalFailedParseRevisions = 0
			let syncedChunksCompleted = 0
			let upsertedChunksCompleted = 0
			let deletedChunksCompleted = 0
			let embedPhaseStarted = false
			let parseChunkMs = 0
			let diffPlanningMs = 0
			let embedUpsertMs = 0
			let parseSchedulingThrottled = false
			let parseThrottleReason: "high_watermark" | "planner_starvation_guard" | null = null
			let parseFinished = false
			let drainError: unknown
			let lastBacklogRefreshAt = 0
			let lastBacklogSampleAt = 0
			let lastRunHeartbeatAt = 0
			let lastMaintenanceAt = 0
			let totalParseThrottleMs = 0
			let peakStagedChunks = 0
			let peakQueuedJobs = 0
			let blockedOnParsedRevisionsMs = 0
			let blockedOnStagedChunksMs = 0
			let latestPlannerRefillPasses: number | undefined
			let latestSyncTelemetry:
				| {
						chunksPerSecond?: number
						peakChunksPerSecond?: number
						averageBatchLatencyMs?: number
						averageEmbedLatencyMs?: number
						averageUpsertLatencyMs?: number
						averageMetadataCommitLatencyMs?: number
						averageSidecarRoundTripLatencyMs?: number
						averageSidecarDeliveryDelayMs?: number
						averageHostFinalizeLatencyMs?: number
						averagePressureLatencyMs?: number
						averageIdleGapMs?: number
						lastBatchLatencyMs?: number
						lastSidecarRoundTripLatencyMs?: number
						lastSidecarDeliveryDelayMs?: number
						lastHostFinalizeLatencyMs?: number
						lastPressureLatencyMs?: number
						batchesCompleted?: number
						retryingChunks?: number
						terminallyFailedChunks?: number
						degradedRevisions?: number
						terminalFailedRevisions?: number
						laneConcurrency?: number
						effectiveBatchSize?: number
						peakInFlightChunkCount?: number
						peakBatchLatencyMs?: number
						peakIdleGapMs?: number
						peakBatchSize?: number
						peakEmbeddingCount?: number
						pressureState?: string
						pressureReasons?: string[]
						pressureSoftTransitions?: number
						pressureHardTransitions?: number
						pressureSoftDurationMs?: number
						pressureHardDurationMs?: number
						waitingForJobsMs?: number
						waitingForInFlightCapacityMs?: number
						waitingForPressureMs?: number
						providerBatchUtilization?: number
						embeddingsPerChunk?: number
						laneOccupancyPercent?: number
						embedActivePercent?: number
						averageGpuUtilizationPercent?: number
						peakGpuUtilizationPercent?: number
						averageGpuInUseBytes?: number
						peakGpuInUseBytes?: number
						gpuSampleCount?: number
						activationBurstLatencyMs?: number
						readyRevisionCount?: number
						activatedChunkCount?: number
						supersededChunkCount?: number
						activeLaneCount?: number
						inFlightChunkCount?: number
						gpu?: CodeIndexV2GpuSnapshot | null
				  }
				| undefined
			let latestBacklogMetrics = await this.metadataStore.getRunBacklogMetrics(runId)
			let lastBlockingReason = latestBacklogMetrics.blockingReason
			let lastBlockingReasonAt = pipelineStartedAt
			let latestTelemetryStage:
				| "discovery"
				| "stat_hash"
				| "parse"
				| "planner"
				| "embed"
				| "delete"
				| "complete"
				| "error" = "stat_hash"
			let lastSampledPressureState: string | undefined
			const getTrackedSidecarMetrics = () => {
				const tracked = (IndexDebugLoggerV2.getTrackedProcessSummary() ?? {}) as {
					totalTrackedRssMB?: number
					byGroup?: Record<string, { totalRssMB?: number }>
				}
				return {
					totalTrackedRssMB: tracked.totalTrackedRssMB ?? 0,
					parseSidecarRssMB: tracked.byGroup?.parseSidecars?.totalRssMB ?? 0,
					embedSidecarRssMB: tracked.byGroup?.embedSidecars?.totalRssMB ?? 0,
				}
			}
			const getPipelineRunMode = (): IndexingPipelineRunMode =>
				this._resumedRetryJobsCount > 0 || this._resumedPendingJobsCount > 0
					? "resume"
					: (options?.runMode ?? "unknown")
			const syncPipelineSnapshot = (forceImmediate = false) => {
				const parseIssueCount =
					retryingParseRevisions +
					terminalFailedParseRevisions +
					(latestSyncTelemetry?.degradedRevisions ?? 0) +
					(latestSyncTelemetry?.terminalFailedRevisions ?? 0)
				const parseHealth: IndexingHealthState =
					terminalFailedParseRevisions > 0
						? "critical"
						: parseIssueCount > 0
							? "watch"
							: parseFinished || parsedRevisionsCompleted > 0
								? "healthy"
								: "unknown"
				const planBacklog = latestBacklogMetrics.parsedRevisions + latestBacklogMetrics.plannedRevisions
				const planHasDeleteWork =
					latestBacklogMetrics.queuedDeleteJobs > 0 || latestBacklogMetrics.runningDeleteJobs > 0
				const planHasWork =
					planBacklog > 0 ||
					latestBacklogMetrics.stagedChunks > 0 ||
					latestBacklogMetrics.queuedUpsertJobs > 0 ||
					latestBacklogMetrics.runningUpsertJobs > 0 ||
					planHasDeleteWork
				const vectorSyncOutstandingWork =
					latestBacklogMetrics.stagedChunks > 0 ||
					latestBacklogMetrics.queuedUpsertJobs > 0 ||
					latestBacklogMetrics.runningUpsertJobs > 0
				const embedObserved =
					embedPhaseStarted || syncedChunksCompleted > 0 || (latestSyncTelemetry?.batchesCompleted ?? 0) > 0
				const embedActivelyRunning =
					embedPhaseStarted &&
					(!parseFinished ||
						vectorSyncOutstandingWork ||
						(latestSyncTelemetry?.activeLaneCount ?? 0) > 0 ||
						(latestSyncTelemetry?.inFlightChunkCount ?? 0) > 0)
				const cleanupHasWork = deletedChunksCompleted > 0 || planHasDeleteWork
				const embeddingUnderfed =
					embedActivelyRunning &&
					(latestSyncTelemetry?.laneOccupancyPercent ?? 100) < 50 &&
					(latestSyncTelemetry?.gpu?.utilizationPercent ?? 100) < 70 &&
					(latestSyncTelemetry?.embedActivePercent ?? 0) >= 85
				const embeddingHealth: IndexingHealthState = latestSyncTelemetry?.terminallyFailedChunks
					? "critical"
					: latestSyncTelemetry?.pressureState === "hard"
						? "critical"
						: latestSyncTelemetry?.pressureState === "soft" ||
							  (latestSyncTelemetry?.retryingChunks ?? 0) > 0 ||
							  embeddingUnderfed
							? "watch"
							: embedObserved
								? "healthy"
								: "unknown"
				const vectorSyncHealth: IndexingHealthState = latestSyncTelemetry?.terminallyFailedChunks
					? "critical"
					: parseFinished && vectorSyncOutstandingWork
						? "watch"
						: embedObserved
							? "healthy"
							: "unknown"
				const cleanupHealth: IndexingHealthState =
					planHasDeleteWork && deletedChunksCompleted === 0 && parseFinished
						? "watch"
						: cleanupHasWork
							? "healthy"
							: "unknown"
				const embedProgressTotal = Math.max(
					parsedChunksCompleted,
					syncedChunksCompleted +
						latestBacklogMetrics.stagedChunks +
						latestBacklogMetrics.queuedUpsertJobs +
						latestBacklogMetrics.runningUpsertJobs,
					1,
				)
				const planProgressTotal = Math.max(parsedRevisionsCompleted, totalChangedFiles, 1)
				const overallState =
					parseFinished &&
					this._resumedPendingJobsCount === 0 &&
					this.isRunBacklogDrained(latestBacklogMetrics)
						? "completed"
						: "running"
				this.stateManager.setPipelineSnapshot(
					{
						runMode: getPipelineRunMode(),
						overallState,
						etaMs: this.stateManager.getCurrentStatus().estimatedTimeRemainingMs ?? null,
						services: this.buildPipelineServicesSnapshot({
							discovery: {
								state: "completed",
								health: "healthy",
								summary: `${Math.max(knownTotalFiles ?? 0, checkedFiles).toLocaleString()} files discovered`,
								progressCurrent: Math.max(knownTotalFiles ?? 0, checkedFiles, 1),
								progressTotal: Math.max(knownTotalFiles ?? 0, checkedFiles, 1),
								progressUnit: "files",
								progressPercent: 100,
								metrics: [
									this.createServiceMetric(
										"files",
										"Files",
										Math.max(knownTotalFiles ?? 0, checkedFiles).toLocaleString(),
									),
									this.createServiceMetric("mode", "Mode", getPipelineRunMode()),
								],
							},
							file_checks: {
								state: statHashComplete ? "completed" : "running",
								health: missingFiles > 0 ? "watch" : "healthy",
								summary: statHashComplete ? "File checks completed" : "Checking file signatures",
								detail: `${changedFiles.toLocaleString()} changed • ${unchangedFiles.toLocaleString()} unchanged`,
								progressCurrent: Math.max(checkedFiles, 0),
								progressTotal: Math.max(knownTotalFiles ?? checkedFiles, checkedFiles, 1),
								progressUnit: "files",
								progressPercent: statHashComplete
									? 100
									: Math.min(
											100,
											Math.round(
												(checkedFiles /
													Math.max(knownTotalFiles ?? checkedFiles, checkedFiles, 1)) *
													100,
											),
										),
								metrics: [
									this.createServiceMetric("changed", "Changed", changedFiles.toLocaleString()),
									this.createServiceMetric("unchanged", "Unchanged", unchangedFiles.toLocaleString()),
									this.createServiceMetric(
										"oversized",
										"Oversized",
										oversizedFiles.toLocaleString(),
										oversizedFiles > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"missing",
										"Missing",
										missingFiles.toLocaleString(),
										missingFiles > 0 ? "warning" : "neutral",
									),
								],
							},
							parse: {
								state: parseFinished ? (parseIssueCount > 0 ? "warning" : "completed") : "running",
								health: parseHealth,
								summary: parseFinished ? "Parse complete" : "Parsing changed files",
								detail: `${parsedChunksCompleted.toLocaleString()} chunks prepared`,
								progressCurrent: Math.max(parsedRevisionsCompleted, 0),
								progressTotal: Math.max(totalChangedFiles, 1),
								progressUnit: "files",
								progressPercent: Math.min(
									100,
									Math.round(
										(Math.max(parsedRevisionsCompleted, 0) / Math.max(totalChangedFiles, 1)) * 100,
									),
								),
								issueCount: parseIssueCount,
								metrics: [
									this.createServiceMetric(
										"parsedFiles",
										"Parsed files",
										parsedRevisionsCompleted.toLocaleString(),
									),
									this.createServiceMetric(
										"parsedChunks",
										"Parsed chunks",
										parsedChunksCompleted.toLocaleString(),
									),
									this.createServiceMetric(
										"parseRetries",
										"Retries",
										retryingParseRevisions.toLocaleString(),
										retryingParseRevisions > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"parserFailures",
										"Parser failures",
										terminalFailedParseRevisions.toLocaleString(),
										terminalFailedParseRevisions > 0 ? "critical" : "neutral",
									),
								],
							},
							plan: {
								state: planHasWork ? "running" : parseFinished ? "completed" : "pending",
								health: latestBacklogMetrics.blockingReason
									? "watch"
									: planHasWork
										? "healthy"
										: "unknown",
								summary: planHasWork ? "Preparing vector workload" : "No planner backlog",
								detail: latestBacklogMetrics.blockingReason
									? this.describeBlockingReason(latestBacklogMetrics.blockingReason, {
											parseThrottled: parseSchedulingThrottled,
											parseThrottleReason,
											activationCatchUp:
												latestBacklogMetrics.plannedRevisions > 0 &&
												this.getRunnableEmbedQueueDepth(latestBacklogMetrics) === 0 &&
												(latestSyncTelemetry?.readyRevisionCount ?? 0) > 0,
										})
									: `${latestBacklogMetrics.stagedChunks.toLocaleString()} staged chunks`,
								progressCurrent: Math.max(
									parsedRevisionsCompleted - latestBacklogMetrics.parsedRevisions,
									0,
								),
								progressTotal: planProgressTotal,
								progressUnit: "files",
								progressPercent: Math.min(
									100,
									Math.round(
										(Math.max(parsedRevisionsCompleted - latestBacklogMetrics.parsedRevisions, 0) /
											Math.max(planProgressTotal, 1)) *
											100,
									),
								),
								metrics: [
									this.createServiceMetric(
										"parsedBacklog",
										"Parsed backlog",
										latestBacklogMetrics.parsedRevisions.toLocaleString(),
										latestBacklogMetrics.parsedRevisions > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"plannedBacklog",
										"Planned backlog",
										latestBacklogMetrics.plannedRevisions.toLocaleString(),
										latestBacklogMetrics.plannedRevisions > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"stagedChunks",
										"Staged chunks",
										latestBacklogMetrics.stagedChunks.toLocaleString(),
										latestBacklogMetrics.stagedChunks > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"queuedUpserts",
										"Queued upserts",
										latestBacklogMetrics.queuedUpsertJobs.toLocaleString(),
										latestBacklogMetrics.queuedUpsertJobs > 0 ? "warning" : "neutral",
									),
								],
							},
							embedding: {
								state: embedActivelyRunning
									? embeddingHealth === "critical" || embeddingHealth === "watch"
										? "warning"
										: "running"
									: embedObserved
										? "completed"
										: parseFinished
											? "skipped"
											: "pending",
								health: embeddingHealth,
								summary: embedActivelyRunning
									? "Creating vector embeddings"
									: embedObserved
										? "Embedding complete"
										: "Waiting for embedding work",
								detail: latestSyncTelemetry?.pressureState
									? `Pressure: ${this.summarizePressureState(latestSyncTelemetry.pressureState, latestSyncTelemetry.pressureReasons)}`
									: latestSyncTelemetry?.averageEmbedLatencyMs != null
										? `Average embed latency ${this.formatCompactDuration(latestSyncTelemetry.averageEmbedLatencyMs)}`
										: undefined,
								indeterminate: embedActivelyRunning,
								issueCount:
									(latestSyncTelemetry?.retryingChunks ?? 0) +
									(latestSyncTelemetry?.terminallyFailedChunks ?? 0),
								metrics: [
									this.createServiceMetric(
										"avgEmbed",
										"Avg embed",
										this.formatCompactDuration(latestSyncTelemetry?.averageEmbedLatencyMs),
									),
									this.createServiceMetric(
										"gpu",
										"GPU",
										latestSyncTelemetry?.gpu?.utilizationPercent != null
											? `${Math.round(latestSyncTelemetry.gpu.utilizationPercent)}% util`
											: "n/a",
									),
									this.createServiceMetric(
										"gpuMemory",
										"GPU memory",
										this.formatGpuMemoryStatus(latestSyncTelemetry?.gpu),
									),
									this.createServiceMetric(
										"laneOccupancy",
										"Lane occupancy",
										latestSyncTelemetry?.laneOccupancyPercent != null
											? `${Math.round(latestSyncTelemetry.laneOccupancyPercent)}%`
											: "n/a",
										embeddingUnderfed ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"embedActive",
										"Embed active",
										latestSyncTelemetry?.embedActivePercent != null
											? `${Math.round(latestSyncTelemetry.embedActivePercent)}%`
											: "n/a",
									),
									this.createServiceMetric(
										"activeLanes",
										"Active lanes",
										latestSyncTelemetry?.activeLaneCount ?? 0,
									),
									this.createServiceMetric(
										"pressure",
										"Pressure",
										this.summarizePressureState(
											latestSyncTelemetry?.pressureState,
											latestSyncTelemetry?.pressureReasons,
										),
										embeddingHealth === "critical"
											? "critical"
											: embeddingHealth === "watch"
												? "warning"
												: "neutral",
									),
								],
							},
							vector_sync: {
								state:
									embedActivelyRunning || vectorSyncOutstandingWork
										? vectorSyncHealth === "critical" || vectorSyncHealth === "watch"
											? "warning"
											: "running"
										: embedObserved
											? "completed"
											: parseFinished
												? "skipped"
												: "pending",
								health: vectorSyncHealth,
								summary:
									embedActivelyRunning || vectorSyncOutstandingWork
										? "Syncing vectors to Qdrant"
										: embedObserved
											? "Vector sync complete"
											: "Waiting for vector sync work",
								detail: latestBacklogMetrics.blockingReason
									? this.describeBlockingReason(latestBacklogMetrics.blockingReason, {
											parseThrottled: parseSchedulingThrottled,
											parseThrottleReason,
											activationCatchUp:
												latestBacklogMetrics.plannedRevisions > 0 &&
												this.getRunnableEmbedQueueDepth(latestBacklogMetrics) === 0 &&
												(latestSyncTelemetry?.readyRevisionCount ?? 0) > 0,
										})
									: `${syncedChunksCompleted.toLocaleString()} chunks synced`,
								progressCurrent: Math.max(syncedChunksCompleted, 0),
								progressTotal: embedProgressTotal,
								progressUnit: "chunks",
								progressPercent: Math.min(
									100,
									Math.round(
										(Math.max(syncedChunksCompleted, 0) / Math.max(embedProgressTotal, 1)) * 100,
									),
								),
								metrics: [
									this.createServiceMetric(
										"avgUpsert",
										"Avg sync",
										this.formatCompactDuration(latestSyncTelemetry?.averageUpsertLatencyMs),
									),
									this.createServiceMetric(
										"throughput",
										"Synced/sec",
										latestSyncTelemetry?.chunksPerSecond != null
											? `${latestSyncTelemetry.chunksPerSecond.toFixed(0)} chunks/sec`
											: "n/a",
										latestSyncTelemetry?.chunksPerSecond ? "good" : "neutral",
									),
									this.createServiceMetric(
										"stagedChunks",
										"Staged chunks",
										latestBacklogMetrics.stagedChunks.toLocaleString(),
										latestBacklogMetrics.stagedChunks > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"queuedUpserts",
										"Queued upserts",
										latestBacklogMetrics.queuedUpsertJobs.toLocaleString(),
										latestBacklogMetrics.queuedUpsertJobs > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"runningUpserts",
										"Running upserts",
										latestBacklogMetrics.runningUpsertJobs.toLocaleString(),
										latestBacklogMetrics.runningUpsertJobs > 0 ? "warning" : "neutral",
									),
								],
							},
							cleanup: {
								state: cleanupHasWork
									? cleanupHealth === "watch"
										? "warning"
										: parseFinished && !planHasDeleteWork
											? "completed"
											: "running"
									: parseFinished
										? "skipped"
										: "pending",
								health: cleanupHealth,
								summary: cleanupHasWork
									? "Cleaning stale vectors"
									: parseFinished
										? "No cleanup required"
										: "Waiting for delete work",
								detail: `${deletedChunksCompleted.toLocaleString()} vectors removed`,
								progressCurrent: deletedChunksCompleted,
								progressTotal: Math.max(
									deletedChunksCompleted +
										latestBacklogMetrics.queuedDeleteJobs +
										latestBacklogMetrics.runningDeleteJobs,
									cleanupHasWork ? 1 : 0,
								),
								progressUnit: "vectors",
								progressPercent: cleanupHasWork
									? Math.min(
											100,
											Math.round(
												(deletedChunksCompleted /
													Math.max(
														deletedChunksCompleted +
															latestBacklogMetrics.queuedDeleteJobs +
															latestBacklogMetrics.runningDeleteJobs,
														1,
													)) *
													100,
											),
										)
									: 100,
								metrics: [
									this.createServiceMetric(
										"deleted",
										"Deleted",
										deletedChunksCompleted.toLocaleString(),
									),
									this.createServiceMetric(
										"queuedDeletes",
										"Queued deletes",
										latestBacklogMetrics.queuedDeleteJobs.toLocaleString(),
										latestBacklogMetrics.queuedDeleteJobs > 0 ? "warning" : "neutral",
									),
									this.createServiceMetric(
										"runningDeletes",
										"Running deletes",
										latestBacklogMetrics.runningDeleteJobs.toLocaleString(),
										latestBacklogMetrics.runningDeleteJobs > 0 ? "warning" : "neutral",
									),
								],
							},
						}),
					},
					{ forceImmediate },
				)
			}
			const emitBacklogSample = (force = false) => {
				const now = Date.now()
				if (!force && now - lastBacklogSampleAt < CodeIndexEngineV2.PIPELINE_POLL_INTERVAL_MS) {
					return
				}
				lastBacklogSampleAt = now
				IndexDebugLoggerV2.log(
					"basic",
					"CodeIndexEngineV2",
					"pipeline-backlog-sample",
					buildPipelineBacklogSample({
						engine: this.engine,
						runId,
						workspacePath: this.workspacePath,
						stage: latestTelemetryStage,
						metrics: latestBacklogMetrics,
						parseSchedulingThrottled,
						parseThrottleReason,
						plannerRefillPasses: latestPlannerRefillPasses,
						latestSyncTelemetry,
					}),
				)
			}
			const refreshBacklogMetrics = async (force = false) => {
				const now = Date.now()
				if (force || now - lastBacklogRefreshAt >= CodeIndexEngineV2.PIPELINE_POLL_INTERVAL_MS) {
					const elapsed = Math.max(now - lastBlockingReasonAt, 0)
					if (lastBlockingReason === "parsed_revisions_waiting_for_planning") {
						blockedOnParsedRevisionsMs += elapsed
					}
					if (lastBlockingReason === "staged_chunks_waiting_for_upsert") {
						blockedOnStagedChunksMs += elapsed
					}
					latestBacklogMetrics = await this.metadataStore.getRunBacklogMetrics(runId)
					lastBlockingReason = latestBacklogMetrics.blockingReason
					lastBlockingReasonAt = now
					lastBacklogRefreshAt = now
					peakStagedChunks = Math.max(peakStagedChunks, latestBacklogMetrics.stagedChunks)
					peakQueuedJobs = Math.max(
						peakQueuedJobs,
						latestBacklogMetrics.queuedUpsertJobs + latestBacklogMetrics.queuedDeleteJobs,
					)
				}
				syncPipelineSnapshot(force)
				emitBacklogSample(force)
				return latestBacklogMetrics
			}
			const updateResilienceStats = () => {
				this.stateManager.setResilienceStats({
					resumedRetryJobs: this._resumedRetryJobsCount,
					resumedPendingJobs: this._resumedPendingJobsCount,
					retryingParseRevisions,
					terminalFailedParseRevisions,
					retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
					terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
					degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
					terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
				})
			}
			const persistRunSnapshot = async (force = false) => {
				const now = Date.now()
				if (!force && now - lastRunHeartbeatAt < CodeIndexEngineV2.RUN_HEARTBEAT_INTERVAL_MS) {
					return
				}
				const hostMemory = IndexDebugLoggerV2.getMemorySnapshot()
				const hostCpu = IndexDebugLoggerV2.getCpuSnapshot()
				const trackedSidecars = getTrackedSidecarMetrics()

				await (
					this.metadataStore as MetadataStore & {
						heartbeatRun?: (runId: string, owner: string, progress?: unknown) => Promise<void>
					}
				).heartbeatRun?.(runId, runHeartbeatOwner, {
					filesDiscovered: statHashSummary.checkedFiles,
					filesHashed: statHashSummary.checkedFiles,
					filesParsed: parsedRevisionsCompleted,
					filesPlanned: Math.max(parsedRevisionsCompleted - latestBacklogMetrics.parsedRevisions, 0),
					filesCommitted:
						(latestSyncTelemetry?.degradedRevisions ?? 0) +
						(latestSyncTelemetry?.terminalFailedRevisions ?? 0) +
						Math.min(
							parsedRevisionsCompleted,
							Math.max(parsedRevisionsCompleted - latestBacklogMetrics.plannedRevisions, 0),
						),
					stagedChunks: latestBacklogMetrics.stagedChunks,
					stagedChunkBytes: latestBacklogMetrics.stagedChunkBytes,
					queuedUpsertJobs: latestBacklogMetrics.queuedUpsertJobs,
					runningUpsertJobs: latestBacklogMetrics.runningUpsertJobs,
					queuedDeleteJobs: latestBacklogMetrics.queuedDeleteJobs,
					runningDeleteJobs: latestBacklogMetrics.runningDeleteJobs,
					retryingParseRevisions,
					terminalFailedParseRevisions,
					retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
					terminalFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
					degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
					terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
					parseThrottleMs: totalParseThrottleMs,
					averageParseBatchMs:
						parsedRevisionsCompleted > 0 ? parseChunkMs / Math.max(parsedRevisionsCompleted, 1) : undefined,
					averagePlanBatchMs:
						parsedRevisionsCompleted > 0
							? diffPlanningMs / Math.max(parsedRevisionsCompleted, 1)
							: undefined,
					averageEmbedBatchMs: latestSyncTelemetry?.averageBatchLatencyMs,
					peakStagedChunks,
					peakQueuedJobs,
					blockingReason: parseSchedulingThrottled
						? `parse_throttled:${parseThrottleReason ?? latestBacklogMetrics.blockingReason ?? "unknown"}`
						: latestBacklogMetrics.blockingReason,
				})
				const sampleEventType =
					force && lastSampledPressureState !== latestSyncTelemetry?.pressureState
						? "pressure_transition"
						: force
							? "stage_transition"
							: "heartbeat"
				await (
					this.metadataStore as MetadataStore & {
						appendRunSample?: (input: Record<string, unknown>) => Promise<void>
					}
				).appendRunSample?.({
					runId,
					workspaceId: this.metadataStore.getWorkspaceId(),
					recordedAt: now,
					stage: latestTelemetryStage,
					eventType: sampleEventType,
					blockingReason: latestBacklogMetrics.blockingReason,
					pressureState: latestSyncTelemetry?.pressureState,
					pressureReasons: latestSyncTelemetry?.pressureReasons,
					laneConcurrency: latestSyncTelemetry?.laneConcurrency,
					effectiveBatchSize: latestSyncTelemetry?.effectiveBatchSize,
					activeLaneCount: latestSyncTelemetry?.activeLaneCount,
					inFlightChunkCount: latestSyncTelemetry?.inFlightChunkCount,
					peakInFlightChunkCount: latestSyncTelemetry?.peakInFlightChunkCount,
					chunksPerSecond: latestSyncTelemetry?.chunksPerSecond,
					peakChunksPerSecond: latestSyncTelemetry?.peakChunksPerSecond,
					averageBatchLatencyMs: latestSyncTelemetry?.averageBatchLatencyMs,
					averageEmbedLatencyMs: latestSyncTelemetry?.averageEmbedLatencyMs,
					averageUpsertLatencyMs: latestSyncTelemetry?.averageUpsertLatencyMs,
					averageMetadataCommitLatencyMs: latestSyncTelemetry?.averageMetadataCommitLatencyMs,
					averageIdleGapMs: latestSyncTelemetry?.averageIdleGapMs,
					waitingForJobsMs: latestSyncTelemetry?.waitingForJobsMs,
					waitingForInFlightCapacityMs: latestSyncTelemetry?.waitingForInFlightCapacityMs,
					waitingForPressureMs: latestSyncTelemetry?.waitingForPressureMs,
					providerBatchUtilization: latestSyncTelemetry?.providerBatchUtilization,
					embeddingsPerChunk: latestSyncTelemetry?.embeddingsPerChunk,
					laneOccupancyPercent: latestSyncTelemetry?.laneOccupancyPercent,
					embedActivePercent: latestSyncTelemetry?.embedActivePercent,
					stagedChunks: latestBacklogMetrics.stagedChunks,
					stagedChunkBytes: latestBacklogMetrics.stagedChunkBytes,
					queuedUpsertJobs: latestBacklogMetrics.queuedUpsertJobs,
					runningUpsertJobs: latestBacklogMetrics.runningUpsertJobs,
					queuedDeleteJobs: latestBacklogMetrics.queuedDeleteJobs,
					runningDeleteJobs: latestBacklogMetrics.runningDeleteJobs,
					parsedRevisions: latestBacklogMetrics.parsedRevisions,
					plannedRevisions: latestBacklogMetrics.plannedRevisions,
					hostRssMB: hostMemory.rssMB,
					hostHeapUsedMB: hostMemory.heapUsedMB,
					hostExternalMB: hostMemory.externalMB,
					hostCpuPercent: hostCpu.processPercent,
					trackedSidecarRssMB: trackedSidecars.totalTrackedRssMB,
					parseSidecarRssMB: trackedSidecars.parseSidecarRssMB,
					embedSidecarRssMB: trackedSidecars.embedSidecarRssMB,
					gpuSampler: latestSyncTelemetry?.gpu?.sampler,
					gpuUtilizationPercent: latestSyncTelemetry?.gpu?.utilizationPercent,
					gpuMemoryPressurePercent: latestSyncTelemetry?.gpu?.memoryPressurePercent,
					gpuInUseBytes: latestSyncTelemetry?.gpu?.inUseBytes,
					gpuAllocatedBytes: latestSyncTelemetry?.gpu?.allocatedBytes,
					gpuPowerW: latestSyncTelemetry?.gpu?.powerW,
				})
				lastSampledPressureState = latestSyncTelemetry?.pressureState
				lastRunHeartbeatAt = now

				if (now - lastMaintenanceAt >= CodeIndexEngineV2.SQLITE_MAINTENANCE_INTERVAL_MS) {
					await (
						this.metadataStore as MetadataStore & {
							checkpointWal?: (mode?: "PASSIVE" | "RESTART" | "TRUNCATE") => Promise<void>
						}
					).checkpointWal?.("PASSIVE")
					lastMaintenanceAt = now
				}
			}
			const ensureEmbedPhaseStarted = (
				hasStartedVectorSync: boolean,
				detailedStage: "planning_vectors" | "embedding",
			) => {
				if (embedPhaseStarted) {
					return
				}
				latestTelemetryStage = detailedStage === "embedding" ? "embed" : "planner"

				this.stateManager.startEmbedPhase(
					Math.max(parsedChunksCompleted, syncedChunksCompleted, latestBacklogMetrics.stagedChunks, 1),
					true,
					totalChangedFiles,
					0,
					{
						runtimeKind: dependencies.embeddingAdapter.runtimeKind === "local" ? "local" : "remote",
						detailedStage,
						hasKnownVectorWork:
							latestBacklogMetrics.stagedChunks > 0 ||
							latestBacklogMetrics.plannedRevisions > 0 ||
							latestBacklogMetrics.queuedUpsertJobs > 0 ||
							latestBacklogMetrics.runningUpsertJobs > 0 ||
							latestBacklogMetrics.queuedDeleteJobs > 0 ||
							latestBacklogMetrics.runningDeleteJobs > 0 ||
							this._resumedPendingJobsCount > 0,
						hasStartedVectorSync,
						isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
					},
				)
				embedPhaseStarted = true
			}
			const buildFailureSuffix = () => {
				const fragments: string[] = []
				if (retryingParseRevisions) {
					fragments.push(`${retryingParseRevisions.toLocaleString()} parser retries`)
				}
				if (terminalFailedParseRevisions) {
					fragments.push(`${terminalFailedParseRevisions.toLocaleString()} parser-failed files`)
				}
				if (!latestSyncTelemetry) {
					return fragments.length > 0 ? ` • ${fragments.join(" • ")}` : ""
				}
				if (latestSyncTelemetry.retryingChunks) {
					fragments.push(`${latestSyncTelemetry.retryingChunks.toLocaleString()} retrying`)
				}
				if (latestSyncTelemetry.terminallyFailedChunks) {
					fragments.push(`${latestSyncTelemetry.terminallyFailedChunks.toLocaleString()} failed chunks`)
				}
				if (latestSyncTelemetry.degradedRevisions) {
					fragments.push(`${latestSyncTelemetry.degradedRevisions.toLocaleString()} degraded files`)
				}
				if (latestSyncTelemetry.terminalFailedRevisions) {
					fragments.push(`${latestSyncTelemetry.terminalFailedRevisions.toLocaleString()} failed files`)
				}

				return fragments.length > 0 ? ` • ${fragments.join(" • ")}` : ""
			}
			const updateEmbeddingDetail = () => {
				const blockingReasonText = this.describeBlockingReason(latestBacklogMetrics.blockingReason, {
					parseThrottled: parseSchedulingThrottled,
					parseThrottleReason,
					activationCatchUp:
						latestBacklogMetrics.plannedRevisions > 0 &&
						this.getRunnableEmbedQueueDepth(latestBacklogMetrics) === 0 &&
						(latestSyncTelemetry?.readyRevisionCount ?? 0) > 0,
				})
				const throttleSuffix = parseSchedulingThrottled
					? ` • ${blockingReasonText ?? `Parse throttled while ${latestBacklogMetrics.stagedChunks.toLocaleString()} parsed chunks and ${this.getRunnableEmbedQueueDepth(latestBacklogMetrics).toLocaleString()} runnable vector jobs drain`}`
					: ""
				this.stateManager.setActivityDetail(
					[
						`Parsing ${parsedRevisionsCompleted.toLocaleString()} of ${totalChangedFiles.toLocaleString()} files • Streaming ${syncedChunksCompleted.toLocaleString()} of ${Math.max(parsedChunksCompleted, 1).toLocaleString()} parsed chunks${buildFailureSuffix()}${throttleSuffix}`,
						this.getEmbeddingRuntimeStatusText(dependencies.embeddingAdapter, latestSyncTelemetry),
					].join("\n"),
				)
			}
			const countChunksForRevisions = async (revisionIds: string[]) => {
				const countChunksForRevisionsMethod = (
					this.metadataStore as MetadataStore & {
						countChunksForRevisions?: (revisionIds: string[]) => Promise<number>
					}
				).countChunksForRevisions
				if (countChunksForRevisionsMethod) {
					return countChunksForRevisionsMethod.call(this.metadataStore, revisionIds)
				}
				let totalChunks = 0
				for (const revisionId of revisionIds) {
					totalChunks += (await this.metadataStore.getChunksForRevision(revisionId)).length
				}
				return totalChunks
			}
			const runEmbedDrainPass = async () => {
				latestTelemetryStage = "embed"
				this._status = {
					engine: this.engine,
					state: "running",
					message: `Building embeddings and streaming to Qdrant`,
				}
				ensureEmbedPhaseStarted(true, "embedding")
				const embedUpsertStartedAt = Date.now()
				const syncSummary = await embedUpsertWorker.run(
					runId,
					signal,
					({
						upsertedChunks,
						deletedChunks,
						retryingChunks,
						terminallyFailedChunks,
						degradedRevisions,
						terminalFailedRevisions,
						laneConcurrency,
						effectiveBatchSize,
						peakInFlightChunkCount,
						chunksPerSecond,
						peakChunksPerSecond,
						averageBatchLatencyMs,
						averageEmbedLatencyMs,
						averageUpsertLatencyMs,
						averageMetadataCommitLatencyMs,
						averageSidecarRoundTripLatencyMs,
						averageSidecarDeliveryDelayMs,
						averageHostFinalizeLatencyMs,
						averagePressureLatencyMs,
						averageIdleGapMs,
						lastBatchLatencyMs,
						lastSidecarRoundTripLatencyMs,
						lastSidecarDeliveryDelayMs,
						lastHostFinalizeLatencyMs,
						lastPressureLatencyMs,
						peakBatchLatencyMs,
						peakIdleGapMs,
						peakBatchSize,
						peakEmbeddingCount,
						batchesCompleted,
						pressureState,
						pressureReasons,
						pressureSoftTransitions,
						pressureHardTransitions,
						pressureSoftDurationMs,
						pressureHardDurationMs,
						waitingForJobsMs,
						waitingForInFlightCapacityMs,
						waitingForPressureMs,
						providerBatchUtilization,
						embeddingsPerChunk,
						laneOccupancyPercent,
						embedActivePercent,
						averageGpuUtilizationPercent,
						peakGpuUtilizationPercent,
						averageGpuInUseBytes,
						peakGpuInUseBytes,
						gpuSampleCount,
						activationBurstLatencyMs,
						readyRevisionCount,
						activatedChunkCount,
						supersededChunkCount,
						activeLaneCount,
						inFlightChunkCount,
						gpu,
					}) => {
						const totalSyncedChunks = syncedChunksCompleted + upsertedChunks + deletedChunks
						latestSyncTelemetry = {
							laneConcurrency,
							effectiveBatchSize,
							peakInFlightChunkCount,
							chunksPerSecond,
							peakChunksPerSecond,
							averageBatchLatencyMs,
							averageEmbedLatencyMs,
							averageUpsertLatencyMs,
							averageMetadataCommitLatencyMs,
							averageSidecarRoundTripLatencyMs,
							averageSidecarDeliveryDelayMs,
							averageHostFinalizeLatencyMs,
							averagePressureLatencyMs,
							averageIdleGapMs,
							lastBatchLatencyMs,
							lastSidecarRoundTripLatencyMs,
							lastSidecarDeliveryDelayMs,
							lastHostFinalizeLatencyMs,
							lastPressureLatencyMs,
							peakBatchLatencyMs,
							peakIdleGapMs,
							peakBatchSize,
							peakEmbeddingCount,
							batchesCompleted,
							retryingChunks,
							terminallyFailedChunks,
							degradedRevisions,
							terminalFailedRevisions,
							pressureState,
							pressureReasons,
							pressureSoftTransitions,
							pressureHardTransitions,
							pressureSoftDurationMs,
							pressureHardDurationMs,
							waitingForJobsMs,
							waitingForInFlightCapacityMs,
							waitingForPressureMs,
							providerBatchUtilization,
							embeddingsPerChunk,
							laneOccupancyPercent,
							embedActivePercent,
							averageGpuUtilizationPercent,
							peakGpuUtilizationPercent,
							averageGpuInUseBytes,
							peakGpuInUseBytes,
							gpuSampleCount,
							activationBurstLatencyMs,
							readyRevisionCount,
							activatedChunkCount,
							supersededChunkCount,
							activeLaneCount,
							inFlightChunkCount,
							gpu,
						}
						updateEmbeddingDetail()
						updateResilienceStats()
						this.stateManager.reportEmbedProgress(
							totalSyncedChunks,
							Math.max(parsedChunksCompleted, totalSyncedChunks, latestBacklogMetrics.stagedChunks, 1),
							parsedRevisionsCompleted,
							parseFinished,
							{
								detailedStage: "embedding",
								hasKnownVectorWork: true,
								hasStartedVectorSync: totalSyncedChunks > 0,
								isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
							},
						)
					},
				)
				embedUpsertMs += Date.now() - embedUpsertStartedAt
				syncedChunksCompleted += syncSummary.upsertedChunks + syncSummary.deletedChunks
				upsertedChunksCompleted += syncSummary.upsertedChunks
				deletedChunksCompleted += syncSummary.deletedChunks
				await this.refreshOutstandingResumedJobs(runId)
				await refreshBacklogMetrics(true)
				updateResilienceStats()
				updateEmbeddingDetail()
				await persistRunSnapshot()
			}
			const drainVectorWork = async () => {
				for (;;) {
					if (signal?.aborted) {
						throw new Error("Vector drain aborted")
					}

					await refreshBacklogMetrics(true)
					const hasParsedToPlan = latestBacklogMetrics.parsedRevisions > 0

					if (hasParsedToPlan) {
						latestTelemetryStage = "planner"
						this._status = {
							engine: this.engine,
							state: "running",
							message: `Planning vector updates from staged chunks`,
						}
						ensureEmbedPhaseStarted(false, "planning_vectors")
						updateEmbeddingDetail()

						let plannerRefillPasses = 0
						for (;;) {
							const refillPriorityBeforePass = shouldPrioritizePlannerRefill({
								embedPhaseStarted,
								metrics: latestBacklogMetrics,
								stagedChunkLowWatermark: schedulerProfile.stagedChunkLowWatermark,
							})
							const diffPlanningStartedAt = Date.now()
							const plannerSummary = (await diffPlanner.run(runId, signal, {
								limit: schedulerProfile.plannerRevisionSlice,
								maxJobs: schedulerProfile.plannerJobBudget,
							})) ?? {
								runId,
								plannedRevisions: 0,
								upsertJobs: 0,
								deleteJobs: 0,
								reusedFingerprintUpserts: 0,
								deletedMissingFingerprintChunks: 0,
								safetyFallbackRevisions: 0,
								plannerSliceLatencyMs: 0,
							}
							diffPlanningMs += Date.now() - diffPlanningStartedAt
							await refreshBacklogMetrics(true)
							await persistRunSnapshot()
							if (refillPriorityBeforePass) {
								plannerRefillPasses++
							}

							const plannerMadeProgress =
								plannerSummary.plannedRevisions > 0 ||
								plannerSummary.upsertJobs > 0 ||
								plannerSummary.deleteJobs > 0
							const runnableEmbedQueueDepth = this.getRunnableEmbedQueueDepth(latestBacklogMetrics)
							if (
								!plannerMadeProgress ||
								latestBacklogMetrics.parsedRevisions === 0 ||
								runnableEmbedQueueDepth >= schedulerProfile.stagedChunkLowWatermark ||
								!refillPriorityBeforePass ||
								plannerRefillPasses >= 8
							) {
								break
							}
						}
						latestPlannerRefillPasses = plannerRefillPasses > 0 ? plannerRefillPasses : undefined
						if (plannerRefillPasses > 0) {
							IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "planner-refill-burst-complete", {
								component: "CodeIndexEngineV2",
								workspacePath: this.workspacePath,
								runId,
								plannerRefillPasses,
								parsedChunkBacklog: latestBacklogMetrics.stagedChunks,
								runnableEmbedQueueDepth: this.getRunnableEmbedQueueDepth(latestBacklogMetrics),
								totalVectorBacklog: this.getTotalVectorBacklog(latestBacklogMetrics),
								parsedRevisions: latestBacklogMetrics.parsedRevisions,
							})
						}
					} else {
						latestPlannerRefillPasses = undefined
					}

					if (
						latestBacklogMetrics.plannedRevisions > 0 ||
						latestBacklogMetrics.queuedUpsertJobs > 0 ||
						latestBacklogMetrics.runningUpsertJobs > 0 ||
						latestBacklogMetrics.queuedDeleteJobs > 0 ||
						latestBacklogMetrics.runningDeleteJobs > 0 ||
						this._resumedPendingJobsCount > 0
					) {
						await runEmbedDrainPass()
						continue
					}

					if (
						parseFinished &&
						this._resumedPendingJobsCount === 0 &&
						this.isRunBacklogDrained(latestBacklogMetrics)
					) {
						return
					}

					updateEmbeddingDetail()
					await persistRunSnapshot()
					if (!parseFinished) {
						// Yield on a real timer so the extension host event loop can process
						// stop commands, sidecar IPC, and init/heartbeat timeouts while parse
						// workers are still starting and no vector work is staged yet.
						await this.waitForPipelineTick(signal)
						continue
					}
					await this.waitForPipelineTick(signal)
				}
			}
			const waitForQueueCapacity = async () => {
				await refreshBacklogMetrics(true)
				const nextParseThrottleReason = this.getParseThrottleReason(
					latestBacklogMetrics,
					schedulerProfile,
					embedPhaseStarted,
				)
				if (!parseSchedulingThrottled && !nextParseThrottleReason) {
					return
				}

				parseSchedulingThrottled = true
				parseThrottleReason = nextParseThrottleReason
				const throttledStartedAt = Date.now()
				this._status = {
					engine: this.engine,
					state: "running",
					message:
						parseThrottleReason === "planner_starvation_guard"
							? `Pausing parse scheduling while the planner refills runnable vector work`
							: `Pausing parse scheduling while SQLite staging drains`,
				}
				updateEmbeddingDetail()
				await persistRunSnapshot(true)
				for (;;) {
					const currentParseThrottleReason = this.getParseThrottleReason(
						latestBacklogMetrics,
						schedulerProfile,
						embedPhaseStarted,
					)
					parseThrottleReason = currentParseThrottleReason
					if (this.shouldResumeParse(latestBacklogMetrics, schedulerProfile, currentParseThrottleReason)) {
						break
					}
					if (drainError) {
						throw drainError
					}
					if (signal?.aborted) {
						throw new Error("Parse scheduling aborted")
					}
					await this.waitForPipelineTick(signal)
					await refreshBacklogMetrics(true)
					updateEmbeddingDetail()
					await persistRunSnapshot()
				}
				totalParseThrottleMs += Date.now() - throttledStartedAt
				parseSchedulingThrottled = false
				parseThrottleReason = null
				updateEmbeddingDetail()
				await persistRunSnapshot(true)
			}

			this._status = {
				engine: this.engine,
				state: "running",
				message: `Preparing changed files for indexing`,
			}
			latestTelemetryStage = "parse"
			this.stateManager.reportCustomProgress("Preparing changed files for indexing", 0, totalChangedFiles, {
				currentItemUnit: "files",
				phase: "scanning",
				detailedStage: "parsing",
				isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
				resilienceStats: {
					resumedRetryJobs: this._resumedRetryJobsCount,
					resumedPendingJobs: this._resumedPendingJobsCount,
				},
			})
			this.startActivityHeartbeat(() => this._status.message ?? "Preparing changed files for indexing")
			updateEmbeddingDetail()
			await persistRunSnapshot(true)

			const reusedParsedRevisionIds = statHashSummary.reusedParsedRevisionIds ?? []
			if (reusedParsedRevisionIds.length > 0) {
				const reusedParsedChunks = await countChunksForRevisions(reusedParsedRevisionIds)
				parsedRevisionsCompleted += reusedParsedRevisionIds.length
				parsedChunksCompleted += reusedParsedChunks
				updateEmbeddingDetail()
				await persistRunSnapshot()
			}
			updateResilienceStats()

			drainPromise = drainVectorWork().catch((error) => {
				drainError = error
				throw error
			})

			this._status = {
				engine: this.engine,
				state: "running",
				message: "Starting parse workers...",
			}
			latestTelemetryStage = "parse"
			this.stateManager.reportCustomProgress("Starting parse workers...", 0, totalChangedFiles, {
				currentItemUnit: "files",
				phase: "scanning",
				detailedStage: "parsing",
				isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
				resilienceStats: {
					resumedRetryJobs: this._resumedRetryJobsCount,
					resumedPendingJobs: this._resumedPendingJobsCount,
				},
			})
			updateEmbeddingDetail()
			await persistRunSnapshot()

			for (;;) {
				if (drainError) {
					throw drainError
				}
				await waitForQueueCapacity()
				const parseStartedAt = Date.now()
				const parseChunkSummary = await parseChunkService.run(
					runId,
					signal,
					({ parsedRevisions }) => {
						const totalParsedRevisions = parsedRevisionsCompleted + parsedRevisions
						this.stateManager.reportCustomProgress(
							`Preparing changed files for indexing`,
							totalParsedRevisions,
							totalChangedFiles,
							{
								currentItemUnit: "files",
								phase: "scanning",
								detailedStage: "parsing",
								isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
								resilienceStats: {
									resumedRetryJobs: this._resumedRetryJobsCount,
									resumedPendingJobs: this._resumedPendingJobsCount,
									retryingParseRevisions,
									terminalFailedParseRevisions,
									degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
									terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
									terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
									retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
								},
							},
						)
						updateEmbeddingDetail()
					},
					{
						limit: schedulerProfile.parseBatchSize,
						concurrency: schedulerProfile.parseConcurrency,
					},
				)
				parseChunkMs += Date.now() - parseStartedAt

				retryingParseRevisions += parseChunkSummary.retryingRevisions
				terminalFailedParseRevisions += parseChunkSummary.terminalFailedRevisions
				updateResilienceStats()

				if (parseChunkSummary.attemptedRevisions === 0) {
					await persistRunSnapshot()
					break
				}

				parsedRevisionsCompleted += parseChunkSummary.parsedRevisions
				parsedChunksCompleted += parseChunkSummary.parsedChunks
				await refreshBacklogMetrics(true)
				updateEmbeddingDetail()
				await persistRunSnapshot()
			}

			parseFinished = true
			latestTelemetryStage = "embed"
			this._status = {
				engine: this.engine,
				state: "running",
				message: `Waiting for staged vector work to finish draining`,
			}
			updateEmbeddingDetail()
			await drainPromise

			await refreshBacklogMetrics(true)
			const finalBlockingElapsed = Math.max(Date.now() - lastBlockingReasonAt, 0)
			if (lastBlockingReason === "parsed_revisions_waiting_for_planning") {
				blockedOnParsedRevisionsMs += finalBlockingElapsed
			}
			if (lastBlockingReason === "staged_chunks_waiting_for_upsert") {
				blockedOnStagedChunksMs += finalBlockingElapsed
			}
			if (this._resumedPendingJobsCount > 0 || !this.isRunBacklogDrained(latestBacklogMetrics)) {
				throw new Error("Code Index V2 run still has staged vector work after drain completion.")
			}

			latestTelemetryStage = "complete"
			await persistRunSnapshot(true)
			await this.metadataStore.markRunComplete(runId)
			this.logPipelineTerminalEvent("run-complete", runId, {
				message: "Pipeline completed successfully.",
				changedFiles: statHashSummary.changedFiles,
				parsedChunks: parsedChunksCompleted,
				syncedChunks: syncedChunksCompleted,
				upsertedChunks: upsertedChunksCompleted,
				deletedChunks: deletedChunksCompleted,
				oversizedFiles: statHashSummary.oversizedFiles,
				retryingParseRevisions,
				terminalFailedParseRevisions,
				degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
				terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
				terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
				retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
				totalPipelineMs: Date.now() - pipelineStartedAt,
			})

			return {
				changedFiles: statHashSummary.changedFiles,
				parsedChunks: parsedChunksCompleted,
				syncedChunks: syncedChunksCompleted,
				upsertedChunks: upsertedChunksCompleted,
				deletedChunks: deletedChunksCompleted,
				oversizedFiles: statHashSummary.oversizedFiles,
				oversizedDetails: statHashSummary.oversizedDetails,
				retryingParseRevisions,
				terminalFailedParseRevisions,
				degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
				terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
				terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
				retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
				performance: {
					statHashMs,
					parseChunkMs,
					diffPlanningMs,
					embedUpsertMs,
					totalPipelineMs: Date.now() - pipelineStartedAt,
					filesScanned: statHashSummary.checkedFiles,
					filesChanged: statHashSummary.changedFiles,
					chunksParsed: parsedChunksCompleted,
					vectorsCreated: upsertedChunksCompleted,
					vectorDeletes: deletedChunksCompleted,
					chunksPerSecond: latestSyncTelemetry?.chunksPerSecond,
					vectorsPerSecond: latestSyncTelemetry?.chunksPerSecond,
					averageBatchLatencyMs: latestSyncTelemetry?.averageBatchLatencyMs,
					averageEmbedLatencyMs: latestSyncTelemetry?.averageEmbedLatencyMs,
					averageUpsertLatencyMs: latestSyncTelemetry?.averageUpsertLatencyMs,
					averageMetadataCommitLatencyMs: latestSyncTelemetry?.averageMetadataCommitLatencyMs,
					averageIdleGapMs: latestSyncTelemetry?.averageIdleGapMs,
					variantEmbeddingsCreated: upsertedChunksCompleted,
					batchesCompleted: latestSyncTelemetry?.batchesCompleted,
					peakChunksPerSecond: latestSyncTelemetry?.peakChunksPerSecond,
					peakBatchLatencyMs: latestSyncTelemetry?.peakBatchLatencyMs,
					peakIdleGapMs: latestSyncTelemetry?.peakIdleGapMs,
					peakBatchSize: latestSyncTelemetry?.peakBatchSize,
					peakEmbeddingCount: latestSyncTelemetry?.peakEmbeddingCount,
					laneConcurrency: latestSyncTelemetry?.laneConcurrency,
					effectiveBatchSize: latestSyncTelemetry?.effectiveBatchSize,
					peakInFlightChunkCount: latestSyncTelemetry?.peakInFlightChunkCount,
					pressureState: latestSyncTelemetry?.pressureState,
					pressureReasons: latestSyncTelemetry?.pressureReasons,
					pressureSoftTransitions: latestSyncTelemetry?.pressureSoftTransitions,
					pressureHardTransitions: latestSyncTelemetry?.pressureHardTransitions,
					pressureSoftDurationMs: latestSyncTelemetry?.pressureSoftDurationMs,
					pressureHardDurationMs: latestSyncTelemetry?.pressureHardDurationMs,
					waitingForJobsMs: latestSyncTelemetry?.waitingForJobsMs,
					waitingForInFlightCapacityMs: latestSyncTelemetry?.waitingForInFlightCapacityMs,
					waitingForPressureMs: latestSyncTelemetry?.waitingForPressureMs,
					providerBatchUtilization: latestSyncTelemetry?.providerBatchUtilization,
					embeddingsPerChunk: latestSyncTelemetry?.embeddingsPerChunk,
					laneOccupancyPercent: latestSyncTelemetry?.laneOccupancyPercent,
					embedActivePercent: latestSyncTelemetry?.embedActivePercent,
					averageGpuUtilizationPercent: latestSyncTelemetry?.averageGpuUtilizationPercent,
					peakGpuUtilizationPercent: latestSyncTelemetry?.peakGpuUtilizationPercent,
					averageGpuInUseBytes: latestSyncTelemetry?.averageGpuInUseBytes,
					peakGpuInUseBytes: latestSyncTelemetry?.peakGpuInUseBytes,
					gpuSampleCount: latestSyncTelemetry?.gpuSampleCount,
					blockedOnParsedRevisionsMs,
					blockedOnStagedChunksMs,
					gpu: latestSyncTelemetry?.gpu,
				},
			}
		} catch (error) {
			if (this.isAbortError(error) && this._stopRequested) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
				this.logPipelineTerminalEvent("run-stopped", runId, {
					message: "Run stopped by user.",
					errorMessage: "Stopped by user.",
					totalPipelineMs: Date.now() - pipelineStartedAt,
				})
			} else {
				const errorMessage = this.getStopAwareErrorMessage(error)
				await this.metadataStore.markRunFailed(runId, errorMessage)
				this.logPipelineTerminalEvent("run-failed", runId, {
					message: this._status.message,
					errorMessage,
					totalPipelineMs: Date.now() - pipelineStartedAt,
				})
			}
			throw error
		} finally {
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
			await drainPromise?.catch(() => undefined)
			await parseChunkService.dispose()
			await embedUpsertWorker.dispose()
			if (this._activeParseChunkService === parseChunkService) {
				this._activeParseChunkService = undefined
			}
			if (this._activeEmbedUpsertWorker === embedUpsertWorker) {
				this._activeEmbedUpsertWorker = undefined
			}
			await dependencies.embeddingAdapter.recycleClient?.()
			await dependencies.vectorStore.recycleClient?.()
		}
	}

	private createServiceMetric(
		key: string,
		label: string,
		value: string | number | undefined | null,
		tone: IndexingServiceMetric["tone"] = "neutral",
	): IndexingServiceMetric {
		return {
			key,
			label,
			value: value == null ? "n/a" : String(value),
			tone,
		}
	}

	private buildPipelineServicesSnapshot(
		overrides: Partial<Record<IndexingServiceSnapshot["id"], Partial<IndexingServiceSnapshot>>>,
	): IndexingServiceSnapshot[] {
		const serviceOrder: IndexingServiceSnapshot["id"][] = [
			"discovery",
			"file_checks",
			"parse",
			"plan",
			"embedding",
			"vector_sync",
			"cleanup",
		]
		const serviceTitles: Record<IndexingServiceSnapshot["id"], string> = {
			discovery: "Discovery",
			file_checks: "File checks",
			parse: "Parse",
			plan: "Plan",
			embedding: "Embedding",
			vector_sync: "Vector sync",
			embed: "Embed",
			cleanup: "Cleanup",
		}
		return serviceOrder.map((serviceId) => ({
			id: serviceId,
			title: serviceTitles[serviceId],
			state: "pending",
			health: "unknown",
			summary: "Waiting to start",
			progressPercent: null,
			...(overrides[serviceId] ?? {}),
			metrics: overrides[serviceId]?.metrics ?? [],
			updatedAt: Date.now(),
		}))
	}

	private getWorstHealthState(healthStates: Array<IndexingHealthState | undefined>): IndexingHealthState {
		if (healthStates.some((health) => health === "critical")) {
			return "critical"
		}
		if (healthStates.some((health) => health === "watch")) {
			return "watch"
		}
		if (healthStates.some((health) => health === "healthy")) {
			return "healthy"
		}
		return "unknown"
	}

	private summarizePressureState(pressureState?: string, pressureReasons?: string[]): string {
		if (!pressureState || pressureState === "normal") {
			return "Normal"
		}
		const reasons = pressureReasons?.length ? ` (${pressureReasons.join(", ")})` : ""
		return `${pressureState}${reasons}`
	}

	private formatCompactDuration(ms?: number | null): string {
		if (ms == null || !Number.isFinite(ms)) {
			return "n/a"
		}
		if (ms < 1_000) {
			return `${Math.round(ms)} ms`
		}
		return `${(ms / 1_000).toFixed(1)} s`
	}

	private formatCompactBytes(bytes?: number | null): string {
		if (bytes == null || !Number.isFinite(bytes)) {
			return "n/a"
		}
		if (bytes < 1024) {
			return `${bytes} B`
		}
		const kb = bytes / 1024
		if (kb < 1024) {
			return `${kb.toFixed(1)} KB`
		}
		const mb = kb / 1024
		if (mb < 1024) {
			return `${mb.toFixed(1)} MB`
		}
		return `${(mb / 1024).toFixed(2)} GB`
	}

	private formatGpuMemoryStatus(gpu?: CodeIndexV2GpuSnapshot | null): string {
		if (!gpu) {
			return "n/a"
		}
		if (gpu.inUseBytes != null && gpu.allocatedBytes != null) {
			return `${this.formatCompactBytes(gpu.inUseBytes)} / ${this.formatCompactBytes(gpu.allocatedBytes)}`
		}
		if (gpu.inUseBytes != null) {
			return `${this.formatCompactBytes(gpu.inUseBytes)} in use`
		}
		if (gpu.allocatedBytes != null) {
			return `${this.formatCompactBytes(gpu.allocatedBytes)} allocated`
		}
		if (gpu.memoryPressurePercent != null) {
			return `${Math.round(gpu.memoryPressurePercent)}% pressure`
		}
		return "n/a"
	}

	private describeBlockingReason(
		blockingReason?: string | null,
		options?: {
			parseThrottled?: boolean
			parseThrottleReason?: "high_watermark" | "planner_starvation_guard" | null
			activationCatchUp?: boolean
		},
	): string | undefined {
		if (!blockingReason || blockingReason === "idle") {
			return undefined
		}

		const normalized = blockingReason.trim()
		if (options?.parseThrottled) {
			if (options.parseThrottleReason === "planner_starvation_guard") {
				return "Parsing is temporarily throttled while the planner catches up."
			}
			if (options.parseThrottleReason === "high_watermark") {
				return "Parsing is temporarily throttled while staged SQLite work drains."
			}
		}
		if (normalized === "parse_throttled:planner_starvation_guard") {
			return "Parsing is temporarily throttled while the planner catches up."
		}
		if (normalized === "parse_throttled:high_watermark") {
			return "Parsing is temporarily throttled while staged SQLite work drains."
		}
		if (normalized === "parse_throttled:parsed_revisions_waiting_for_planning") {
			return "Parsing is temporarily throttled while the planner catches up."
		}
		if (options?.activationCatchUp && normalized === "parsed_revisions_waiting_for_planning") {
			return "Revision activation is catching up before more vector sync work starts."
		}

		switch (normalized) {
			case "parsed_revisions_waiting_for_planning":
				return "Planner is catching up before more parsed files are handed off."
			case "staged_chunks_waiting_for_upsert":
				return "Waiting for queued vector sync work to drain."
			default:
				return `Waiting on ${normalized.replace(/^parse_throttled:/, "").replace(/[_:]+/g, " ")}.`
		}
	}

	private async retireExcludedTrackedFilesBeforeStatHash(
		workspaceAdapter: VsCodeWorkspaceAdapter,
		relativePaths?: string[],
	): Promise<void> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const trackedFiles = relativePaths?.length
			? await this.metadataStore.getDiscoveredFilesByRelativePaths(workspaceId, relativePaths)
			: await this.metadataStore.getDiscoveredFilesForWorkspace(workspaceId)

		const retiredFiles = trackedFiles.filter((file) => !workspaceAdapter.isCandidateFile(file.normalizedPath))
		if (retiredFiles.length === 0) {
			return
		}

		await this.metadataStore.excludeFilesFromIndexing(retiredFiles.map((file) => file.fileId))
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "retired-excluded-tracked-files", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			jobId: `${retiredFiles.length}`,
		})
	}

	private getRunnableEmbedQueueDepth(metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>): number {
		return metrics.queuedUpsertJobs + metrics.runningUpsertJobs
	}

	private getTotalVectorBacklog(metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>): number {
		return metrics.stagedChunks + this.getRunnableEmbedQueueDepth(metrics)
	}

	private getParseThrottleReason(
		metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>,
		profile: ReturnType<CodeIndexEngineV2["getSchedulerProfile"]>,
		embedPhaseStarted: boolean,
	): "high_watermark" | "planner_starvation_guard" | null {
		return getParseThrottleReason({
			embedPhaseStarted,
			metrics,
			parsedRevisionHighWatermark: profile.parsedRevisionHighWatermark,
			stagedChunkHighWatermark: profile.stagedChunkHighWatermark,
			stagedChunkLowWatermark: profile.stagedChunkLowWatermark,
			stagedBytesHighWatermark: profile.stagedBytesHighWatermark,
		})
	}

	private getSchedulerProfile(checkedFiles: number) {
		const largeWorkspaceMode = checkedFiles >= CodeIndexEngineV2.LARGE_WORKSPACE_FILE_THRESHOLD
		return {
			largeWorkspaceMode,
			parseBatchSize: largeWorkspaceMode ? 10 : CodeIndexEngineV2.REVISION_BATCH_SIZE,
			parseConcurrency: largeWorkspaceMode ? 2 : 4,
			plannerRevisionSlice: largeWorkspaceMode ? 25 : CodeIndexEngineV2.PLANNER_REVISION_SLICE,
			plannerJobBudget: largeWorkspaceMode ? 800 : CodeIndexEngineV2.PLANNER_JOB_BUDGET,
			parsedRevisionHighWatermark: largeWorkspaceMode ? 150 : CodeIndexEngineV2.PARSED_REVISION_HIGH_WATERMARK,
			parsedRevisionLowWatermark: largeWorkspaceMode ? 40 : CodeIndexEngineV2.PARSED_REVISION_LOW_WATERMARK,
			stagedChunkHighWatermark: largeWorkspaceMode ? 1_200 : CodeIndexEngineV2.EMBED_QUEUE_HIGH_WATERMARK,
			stagedChunkLowWatermark: largeWorkspaceMode ? 300 : CodeIndexEngineV2.EMBED_QUEUE_LOW_WATERMARK,
			stagedBytesHighWatermark: largeWorkspaceMode
				? 48 * 1024 * 1024
				: CodeIndexEngineV2.STAGED_BYTES_HIGH_WATERMARK,
			stagedBytesLowWatermark: largeWorkspaceMode
				? 16 * 1024 * 1024
				: CodeIndexEngineV2.STAGED_BYTES_LOW_WATERMARK,
		}
	}

	private isRunBacklogDrained(metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>): boolean {
		return (
			metrics.parsedRevisions === 0 &&
			metrics.plannedRevisions === 0 &&
			metrics.stagedChunks === 0 &&
			metrics.queuedUpsertJobs === 0 &&
			metrics.runningUpsertJobs === 0 &&
			metrics.queuedDeleteJobs === 0 &&
			metrics.runningDeleteJobs === 0
		)
	}

	private shouldThrottleParse(
		metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>,
		profile: ReturnType<CodeIndexEngineV2["getSchedulerProfile"]>,
		options?: {
			embedPhaseStarted?: boolean
		},
	): boolean {
		return this.getParseThrottleReason(metrics, profile, options?.embedPhaseStarted ?? false) !== null
	}

	private shouldResumeParse(
		metrics: Awaited<ReturnType<MetadataStore["getRunBacklogMetrics"]>>,
		profile: ReturnType<CodeIndexEngineV2["getSchedulerProfile"]>,
		parseThrottleReason: "high_watermark" | "planner_starvation_guard" | null,
	): boolean {
		return shouldResumeParseFromThrottle({
			metrics,
			parseThrottleReason,
			parsedRevisionLowWatermark: profile.parsedRevisionLowWatermark,
			stagedChunkLowWatermark: profile.stagedChunkLowWatermark,
			stagedBytesLowWatermark: profile.stagedBytesLowWatermark,
		})
	}

	private async waitForPipelineTick(signal?: AbortSignal): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, CodeIndexEngineV2.PIPELINE_POLL_INTERVAL_MS)

			const onAbort = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				reject(new Error("Code Index V2 pipeline aborted"))
			}

			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	private logIndexRunPerformanceSummary(
		runType: "start" | "refresh",
		runId: string,
		runSummary: {
			discoveryMs: number
			totalRunMs: number
			discoveredFiles: number
			isPartial: boolean
		},
		pipelineSummary: Awaited<ReturnType<CodeIndexEngineV2["runPipelineForRun"]>>,
	): void {
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "index-performance-summary", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			runId,
			runType,
			discoveredFiles: runSummary.discoveredFiles,
			isPartial: runSummary.isPartial,
			discoveryMs: runSummary.discoveryMs,
			statHashMs: pipelineSummary.performance.statHashMs,
			parseChunkMs: pipelineSummary.performance.parseChunkMs,
			diffPlanningMs: pipelineSummary.performance.diffPlanningMs,
			embedUpsertMs: pipelineSummary.performance.embedUpsertMs,
			totalPipelineMs: pipelineSummary.performance.totalPipelineMs,
			totalRunMs: runSummary.totalRunMs,
			filesScanned: pipelineSummary.performance.filesScanned,
			filesChanged: pipelineSummary.performance.filesChanged,
			chunksParsed: pipelineSummary.performance.chunksParsed,
			vectorsCreated: pipelineSummary.performance.vectorsCreated,
			vectorDeletes: pipelineSummary.performance.vectorDeletes,
			chunksPerSecond: pipelineSummary.performance.chunksPerSecond,
			vectorsPerSecond: pipelineSummary.performance.vectorsPerSecond,
			averageBatchLatencyMs: pipelineSummary.performance.averageBatchLatencyMs,
			averageEmbedLatencyMs: pipelineSummary.performance.averageEmbedLatencyMs,
			averageUpsertLatencyMs: pipelineSummary.performance.averageUpsertLatencyMs,
			averageMetadataCommitLatencyMs: pipelineSummary.performance.averageMetadataCommitLatencyMs,
			averageIdleGapMs: pipelineSummary.performance.averageIdleGapMs,
			variantEmbeddingsCreated: pipelineSummary.performance.variantEmbeddingsCreated,
			batchesCompleted: pipelineSummary.performance.batchesCompleted,
			peakChunksPerSecond: pipelineSummary.performance.peakChunksPerSecond,
			peakBatchLatencyMs: pipelineSummary.performance.peakBatchLatencyMs,
			peakIdleGapMs: pipelineSummary.performance.peakIdleGapMs,
			peakBatchSize: pipelineSummary.performance.peakBatchSize,
			peakEmbeddingCount: pipelineSummary.performance.peakEmbeddingCount,
			laneConcurrency: pipelineSummary.performance.laneConcurrency,
			effectiveBatchSize: pipelineSummary.performance.effectiveBatchSize,
			peakInFlightChunkCount: pipelineSummary.performance.peakInFlightChunkCount,
			pressureState: pipelineSummary.performance.pressureState,
			pressureReasons: pipelineSummary.performance.pressureReasons,
			pressureSoftTransitions: pipelineSummary.performance.pressureSoftTransitions,
			pressureHardTransitions: pipelineSummary.performance.pressureHardTransitions,
			pressureSoftDurationMs: pipelineSummary.performance.pressureSoftDurationMs,
			pressureHardDurationMs: pipelineSummary.performance.pressureHardDurationMs,
			waitingForJobsMs: pipelineSummary.performance.waitingForJobsMs,
			waitingForInFlightCapacityMs: pipelineSummary.performance.waitingForInFlightCapacityMs,
			waitingForPressureMs: pipelineSummary.performance.waitingForPressureMs,
			providerBatchUtilization: pipelineSummary.performance.providerBatchUtilization,
			embeddingsPerChunk: pipelineSummary.performance.embeddingsPerChunk,
			laneOccupancyPercent: pipelineSummary.performance.laneOccupancyPercent,
			embedActivePercent: pipelineSummary.performance.embedActivePercent,
			averageGpuUtilizationPercent: pipelineSummary.performance.averageGpuUtilizationPercent,
			peakGpuUtilizationPercent: pipelineSummary.performance.peakGpuUtilizationPercent,
			averageGpuInUseBytes: pipelineSummary.performance.averageGpuInUseBytes,
			peakGpuInUseBytes: pipelineSummary.performance.peakGpuInUseBytes,
			gpuSampleCount: pipelineSummary.performance.gpuSampleCount,
			blockedOnParsedRevisionsMs: pipelineSummary.performance.blockedOnParsedRevisionsMs,
			blockedOnStagedChunksMs: pipelineSummary.performance.blockedOnStagedChunksMs,
			gpu: pipelineSummary.performance.gpu,
		})
	}

	private async persistRunTelemetrySummary(
		runId: string,
		input: {
			triggerType: string
			state: "complete" | "failed" | "stopped"
			startedAt: number
			completedAt: number
			totalRunMs: number
			discoveryMs?: number
			discoveredFiles?: number
			pipelineSummary?: Awaited<ReturnType<CodeIndexEngineV2["runPipelineForRun"]>>
			errorMessage?: string
		},
	): Promise<void> {
		const build = IndexDebugLoggerV2.getBuildInfo()
		const hostMemory = IndexDebugLoggerV2.getMemorySnapshot()
		const hostCpu = IndexDebugLoggerV2.getCpuSnapshot()
		const progressRecord = await (
			this.metadataStore as MetadataStore & {
				getRunProgressRecord?: (runId: string) => Promise<
					| {
							blockingReason: string | null
							progress: {
								parseThrottleMs?: number
								peakStagedChunks?: number
								peakQueuedJobs?: number
							} | null
					  }
					| undefined
				>
			}
		).getRunProgressRecord?.(runId)
		const tracked = (IndexDebugLoggerV2.getTrackedProcessSummary() ?? {}) as {
			totalTrackedRssMB?: number
			byGroup?: Record<string, { totalRssMB?: number }>
		}
		await (
			this.metadataStore as MetadataStore & {
				writeRunSummary?: (input: Record<string, unknown>) => Promise<void>
			}
		).writeRunSummary?.({
			runId,
			workspaceId: this.metadataStore.getWorkspaceId(),
			triggerType: input.triggerType,
			state: input.state,
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			totalRunMs: input.totalRunMs,
			discoveryMs: input.discoveryMs,
			discoveredFiles: input.discoveredFiles,
			filesScanned: input.pipelineSummary?.performance.filesScanned,
			filesChanged: input.pipelineSummary?.performance.filesChanged,
			parsedChunks: input.pipelineSummary?.parsedChunks,
			plannedRevisions: input.pipelineSummary?.changedFiles,
			syncedChunks: input.pipelineSummary?.syncedChunks,
			upsertedChunks: input.pipelineSummary?.upsertedChunks,
			deletedChunks: input.pipelineSummary?.deletedChunks,
			committedRevisions:
				(input.pipelineSummary?.changedFiles ?? 0) -
				(input.pipelineSummary?.degradedRevisions ?? 0) -
				(input.pipelineSummary?.terminalFailedRevisions ?? 0),
			retryingParseRevisions: input.pipelineSummary?.retryingParseRevisions,
			terminalFailedParseRevisions: input.pipelineSummary?.terminalFailedParseRevisions,
			retryingChunks: input.pipelineSummary?.retryingChunks,
			terminalFailedChunks: input.pipelineSummary?.terminallyFailedChunks,
			degradedRevisions: input.pipelineSummary?.degradedRevisions,
			terminalFailedRevisions: input.pipelineSummary?.terminalFailedRevisions,
			statHashMs: input.pipelineSummary?.performance.statHashMs,
			parseChunkMs: input.pipelineSummary?.performance.parseChunkMs,
			diffPlanningMs: input.pipelineSummary?.performance.diffPlanningMs,
			embedUpsertMs: input.pipelineSummary?.performance.embedUpsertMs,
			chunksPerSecond: input.pipelineSummary?.performance.chunksPerSecond,
			peakChunksPerSecond: input.pipelineSummary?.performance.peakChunksPerSecond,
			averageBatchLatencyMs: input.pipelineSummary?.performance.averageBatchLatencyMs,
			peakBatchLatencyMs: input.pipelineSummary?.performance.peakBatchLatencyMs,
			averageEmbedLatencyMs: input.pipelineSummary?.performance.averageEmbedLatencyMs,
			averageUpsertLatencyMs: input.pipelineSummary?.performance.averageUpsertLatencyMs,
			averageMetadataCommitLatencyMs: input.pipelineSummary?.performance.averageMetadataCommitLatencyMs,
			averageIdleGapMs: input.pipelineSummary?.performance.averageIdleGapMs,
			peakIdleGapMs: input.pipelineSummary?.performance.peakIdleGapMs,
			peakBatchSize: input.pipelineSummary?.performance.peakBatchSize,
			peakEmbeddingCount: input.pipelineSummary?.performance.peakEmbeddingCount,
			laneConcurrency: input.pipelineSummary?.performance.laneConcurrency,
			effectiveBatchSize: input.pipelineSummary?.performance.effectiveBatchSize,
			peakInFlightChunkCount: input.pipelineSummary?.performance.peakInFlightChunkCount,
			pressureSoftTransitions: input.pipelineSummary?.performance.pressureSoftTransitions,
			pressureHardTransitions: input.pipelineSummary?.performance.pressureHardTransitions,
			pressureSoftDurationMs: input.pipelineSummary?.performance.pressureSoftDurationMs,
			pressureHardDurationMs: input.pipelineSummary?.performance.pressureHardDurationMs,
			waitingForJobsMs: input.pipelineSummary?.performance.waitingForJobsMs,
			waitingForInFlightCapacityMs: input.pipelineSummary?.performance.waitingForInFlightCapacityMs,
			waitingForPressureMs: input.pipelineSummary?.performance.waitingForPressureMs,
			averageGpuUtilizationPercent: input.pipelineSummary?.performance.averageGpuUtilizationPercent,
			peakGpuUtilizationPercent: input.pipelineSummary?.performance.peakGpuUtilizationPercent,
			averageGpuInUseBytes: input.pipelineSummary?.performance.averageGpuInUseBytes,
			peakGpuInUseBytes: input.pipelineSummary?.performance.peakGpuInUseBytes,
			gpuSampleCount: input.pipelineSummary?.performance.gpuSampleCount,
			embeddingsPerChunk: input.pipelineSummary?.performance.embeddingsPerChunk,
			laneOccupancyPercent: input.pipelineSummary?.performance.laneOccupancyPercent,
			embedActivePercent: input.pipelineSummary?.performance.embedActivePercent,
			blockedOnParsedRevisionsMs: input.pipelineSummary?.performance.blockedOnParsedRevisionsMs,
			blockedOnStagedChunksMs: input.pipelineSummary?.performance.blockedOnStagedChunksMs,
			parseThrottleMs: progressRecord?.progress?.parseThrottleMs,
			peakStagedChunks: progressRecord?.progress?.peakStagedChunks,
			peakQueuedJobs: progressRecord?.progress?.peakQueuedJobs,
			hostRssMB: hostMemory.rssMB,
			hostHeapUsedMB: hostMemory.heapUsedMB,
			hostExternalMB: hostMemory.externalMB,
			hostCpuPercent: hostCpu.processPercent,
			trackedSidecarRssMB: tracked.totalTrackedRssMB ?? 0,
			parseSidecarRssMB: tracked.byGroup?.parseSidecars?.totalRssMB ?? 0,
			embedSidecarRssMB: tracked.byGroup?.embedSidecars?.totalRssMB ?? 0,
			gpuSampler: input.pipelineSummary?.performance.gpu?.sampler,
			gpuUtilizationPercent: input.pipelineSummary?.performance.gpu?.utilizationPercent,
			gpuMemoryPressurePercent: input.pipelineSummary?.performance.gpu?.memoryPressurePercent,
			gpuInUseBytes: input.pipelineSummary?.performance.gpu?.inUseBytes,
			gpuAllocatedBytes: input.pipelineSummary?.performance.gpu?.allocatedBytes,
			gpuPowerW: input.pipelineSummary?.performance.gpu?.powerW,
			buildVersion: build.version,
			buildTimestamp: build.buildTimestamp,
			buildSha: build.sha,
			engineVersion: build.version,
			provider: this._indexEmbeddingAdapter?.provider,
			modelId: this._indexEmbeddingAdapter?.modelId,
			runtimeKind: this._indexEmbeddingAdapter?.runtimeKind,
			deviceHint: this._indexEmbeddingAdapter?.deviceHint,
			lastBlockingReason: progressRecord?.blockingReason,
			errorMessage: input.errorMessage,
		})
	}

	private logPipelineTerminalEvent(
		event: "run-complete" | "run-failed" | "run-stopped",
		runId: string,
		context: Record<string, unknown>,
	): void {
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", event, {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			runId,
			...context,
		})
	}

	private logFullIndexTerminalEvent(
		event: "full-index-complete" | "full-index-failed",
		mode: "start" | "refresh",
		context: Record<string, unknown>,
	): void {
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", event, {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			runType: mode,
			...context,
		})
	}

	private async ensureWatcher(): Promise<void> {
		if (this._watcherCoordinator) {
			return
		}

		this._watcherCoordinator = new WatcherCoordinator(
			this.workspacePath,
			this.metadataStore,
			this.requireWorkspaceAdapter(),
			(paths, reason) => this.enqueuePathsChanged(paths, reason),
		)
		await this._watcherCoordinator.initialize()
	}

	private startReconciliationTimer(): void {
		if (this._reconciliationTimer) {
			return
		}

		this._reconciliationTimer = setInterval(
			() => {
				void this.enqueuePathsChanged([], "reconcile")
			},
			5 * 60 * 1000,
		)
	}

	private requireWorkspaceAdapter(): VsCodeWorkspaceAdapter {
		if (!this._workspaceAdapter) {
			throw new Error("Code Index V2 workspace adapter not initialized")
		}

		return this._workspaceAdapter
	}

	private async runSerialized(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const runTask = async () => {
			const controller = new AbortController()
			this._activeAbortController = controller
			try {
				await task(controller.signal)
			} finally {
				if (this._activeAbortController === controller) {
					this._activeAbortController = undefined
				}
			}
		}
		const next = this._operationChain.then(runTask, runTask)
		this._operationChain = next.catch(() => undefined)
		return next
	}

	private async preflightIndexingDependencies(signal?: AbortSignal): Promise<void> {
		const { embeddingAdapter, vectorStore } = this.getOrCreateIndexDependencies()
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Verifying indexing services",
		}
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "preflight-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			provider: embeddingAdapter.provider,
			modelId: embeddingAdapter.modelId,
			jobId: this.configManager.qdrantConfig.url,
		})
		this.stateManager.reportCustomProgress("Verifying indexing services: Qdrant", 0, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})

		await this.verifyVectorStoreReady(vectorStore, signal)
		this.stateManager.reportCustomProgress("Verifying indexing services: embedding provider", 1, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})

		await this.verifyEmbeddingProviderReady(embeddingAdapter, signal)
		this.stateManager.reportCustomProgress("Verifying indexing services: complete", 2, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})
	}

	private async verifyVectorStoreReady(
		vectorStore: QdrantRestVectorStoreAdapter,
		signal?: AbortSignal,
	): Promise<void> {
		await this.runPreflightStep({
			step: "qdrant",
			label: "Qdrant",
			timeoutMs: CodeIndexEngineV2.PREFLIGHT_QDRANT_TIMEOUT_MS,
			details: {
				jobId: this.configManager.qdrantConfig.url,
			},
			signal,
			action: (stepSignal) => vectorStore.initialize(stepSignal),
		})
	}

	private async verifyEmbeddingProviderReady(
		embeddingAdapter: ExistingEmbedderAdapter,
		signal?: AbortSignal,
	): Promise<void> {
		await this.runPreflightStep({
			step: "embedder",
			label: "embedding provider",
			timeoutMs: CodeIndexEngineV2.PREFLIGHT_EMBEDDER_TIMEOUT_MS,
			details: {
				provider: embeddingAdapter.provider,
				modelId: embeddingAdapter.modelId,
			},
			signal,
			action: (stepSignal) =>
				embeddingAdapter
					.createEmbeddings(["preflight"], {
						isQuery: true,
						signal: stepSignal,
					})
					.then((response) => {
						this.maybePersistAdaptiveRuntimeState(response.adaptiveControllerState)
						return response
					}),
		})
	}

	private async runPreflightStep(options: {
		step: "qdrant" | "embedder"
		label: string
		timeoutMs: number
		signal?: AbortSignal
		details?: Record<string, unknown>
		action: (signal: AbortSignal) => Promise<unknown>
	}): Promise<void> {
		if (options.signal?.aborted) {
			throw new Error("Indexing preflight aborted")
		}

		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "preflight-step-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
			jobId: options.step,
			timeoutMs: options.timeoutMs,
			...options.details,
		})

		const controller = new AbortController()
		const abortStep = () => controller.abort()
		options.signal?.addEventListener("abort", abortStep, { once: true })

		let timeoutHandle: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				options.action(controller.signal),
				new Promise<never>((_, reject) => {
					timeoutHandle = setTimeout(() => {
						controller.abort()
						const message = `${options.label === "Qdrant" ? "Qdrant" : "Embedding provider"} verification timed out after ${Math.round(options.timeoutMs / 1000)}s`
						IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "preflight-timeout", {
							component: "CodeIndexEngineV2",
							workspacePath: this.workspacePath,
							jobId: options.step,
							timeoutMs: options.timeoutMs,
							errorMessage: message,
							...options.details,
						})
						reject(new Error(message))
					}, options.timeoutMs)
				}),
			])
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "preflight-step-complete", {
				component: "CodeIndexEngineV2",
				workspacePath: this.workspacePath,
				jobId: options.step,
				timeoutMs: options.timeoutMs,
				...options.details,
			})
		} catch (error) {
			const message =
				options.signal?.aborted || (controller.signal.aborted && this.isAbortError(error))
					? "Indexing preflight aborted"
					: error instanceof Error
						? error.message
						: String(error)
			const normalizedError =
				options.signal?.aborted || /aborted/i.test(message)
					? new Error("Indexing preflight aborted")
					: /timed out/i.test(message)
						? new Error(message)
						: new Error(
								`${options.label === "Qdrant" ? "Qdrant" : "Embedding provider"} verification failed: ${message}`,
							)
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "preflight-step-failed", {
				component: "CodeIndexEngineV2",
				workspacePath: this.workspacePath,
				jobId: options.step,
				timeoutMs: options.timeoutMs,
				errorMessage: normalizedError.message,
				...options.details,
			})
			throw normalizedError
		} finally {
			options.signal?.removeEventListener("abort", abortStep)
			if (timeoutHandle) {
				clearTimeout(timeoutHandle)
			}
		}
	}

	private isAbortError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error)
		return /aborted/i.test(message)
	}

	private isMissingFileError(error: unknown): boolean {
		const errorCode =
			typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined
		const message = error instanceof Error ? error.message : String(error)
		return errorCode === "ENOENT" || /no such file or directory/i.test(message)
	}

	private getStopAwareErrorMessage(error: unknown): string {
		if (this.isAbortError(error) && this._stopRequested) {
			return "Stopped by user."
		}
		return error instanceof Error ? error.message : String(error)
	}

	private startActivityHeartbeat(messageFactory: () => string): void {
		this.stopActivityHeartbeat()
		this._activityHeartbeatTimer = setInterval(() => {
			this.stateManager.reportHeartbeat(messageFactory())
		}, CodeIndexEngineV2.HEARTBEAT_INTERVAL_MS)
	}

	private stopActivityHeartbeat(): void {
		if (this._activityHeartbeatTimer) {
			clearInterval(this._activityHeartbeatTimer)
			this._activityHeartbeatTimer = undefined
		}
	}

	private getMemoryStatusText(): string {
		const snapshot = IndexDebugLoggerV2.getMemorySnapshot()
		const cpuText = this.getCpuStatusText()
		return `Memory ${snapshot.rssMB.toLocaleString()} MB RSS • ${snapshot.externalMB.toLocaleString()} MB ext • ${snapshot.heapUsedMB.toLocaleString()} MB heap${cpuText ? ` • CPU ${cpuText}` : ""}`
	}

	private getCpuStatusText(): string | undefined {
		const currentSample = {
			cpuUsage: process.cpuUsage(),
			timeNs: process.hrtime.bigint(),
		}
		const previousSample = this._lastCpuSample
		this._lastCpuSample = currentSample

		if (!previousSample) {
			return undefined
		}

		const elapsedNs = Number(currentSample.timeNs - previousSample.timeNs)
		if (elapsedNs <= 0) {
			return undefined
		}

		const cpuDelta = process.cpuUsage(previousSample.cpuUsage)
		const cpuMicros = cpuDelta.user + cpuDelta.system
		const usagePercent = Math.max(0, Math.min(100, (cpuMicros / (elapsedNs / 1_000)) * 100))

		return `${usagePercent.toFixed(0)}%`
	}

	private getEmbeddingRuntimeMetadata(): {
		runtimeKind: "local" | "remote"
		runtimeLabel: string
		deviceHint?: string
	} {
		const provider = this.configManager.currentEmbedderProvider
		const config = this.configManager.getConfig()

		if (provider === "ollama") {
			return {
				runtimeKind: "local",
				runtimeLabel: "Local embedder",
				deviceHint: "Ollama auto-selects CPU/GPU",
			}
		}

		if (provider === "openai-compatible") {
			const baseUrl = config.openAiCompatibleOptions?.baseUrl ?? ""
			if (this.isLocalEndpoint(baseUrl)) {
				return {
					runtimeKind: "local",
					runtimeLabel: "Local endpoint",
					deviceHint: "Provider-managed device",
				}
			}
		}

		return {
			runtimeKind: "remote",
			runtimeLabel: "Remote embedder",
		}
	}

	private getEmbeddingRuntimeStatusText(
		embeddingAdapter: ExistingEmbedderAdapter,
		syncTelemetry?: {
			chunksPerSecond?: number
			averageBatchLatencyMs?: number
			lastBatchLatencyMs?: number
			batchesCompleted?: number
		},
	): string {
		const parts = [`${embeddingAdapter.provider}/${embeddingAdapter.modelId}`, embeddingAdapter.runtimeLabel]
		if (embeddingAdapter.deviceHint) {
			parts.push(embeddingAdapter.deviceHint)
		}
		if (syncTelemetry?.chunksPerSecond !== undefined) {
			parts.push(`${syncTelemetry.chunksPerSecond.toFixed(0)} chunks/sec`)
		}
		if (syncTelemetry?.averageBatchLatencyMs !== undefined) {
			parts.push(`${Math.round(syncTelemetry.averageBatchLatencyMs)} ms avg batch`)
		}
		if (syncTelemetry?.batchesCompleted !== undefined && syncTelemetry.batchesCompleted > 0) {
			parts.push(`${syncTelemetry.batchesCompleted.toLocaleString()} sync batches`)
		}
		parts.push(this.getMemoryStatusText())
		return parts.join(" • ")
	}

	private isLocalEndpoint(url: string): boolean {
		try {
			const parsedUrl = new URL(url)
			return ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)
		} catch {
			return false
		}
	}

	private getEmbeddingRuntimeProfileKey(): string | undefined {
		const runtimeMetadata = this.getEmbeddingRuntimeMetadata()
		const config = this.configManager.getConfig()
		let endpointFingerprint: string | undefined

		switch (this.configManager.currentEmbedderProvider) {
			case "openai-compatible":
				endpointFingerprint = normalizeEmbeddingEndpointFingerprint(config.openAiCompatibleOptions?.baseUrl)
				break
			case "ollama":
				endpointFingerprint = normalizeEmbeddingEndpointFingerprint(config.ollamaOptions?.ollamaBaseUrl)
				break
			case "bedrock":
				endpointFingerprint = normalizeEmbeddingEndpointFingerprint(
					`bedrock:${config.bedrockOptions?.region ?? ""}:${config.bedrockOptions?.profile ?? ""}`,
				)
				break
			default:
				endpointFingerprint = normalizeEmbeddingEndpointFingerprint(this.configManager.currentEmbedderProvider)
				break
		}

		return buildEmbeddingRuntimeProfileKey({
			provider: this.configManager.currentEmbedderProvider,
			modelId: this.configManager.currentModelId ?? "unknown-configured-model",
			runtimeKind: runtimeMetadata.runtimeKind,
			deviceHint: runtimeMetadata.deviceHint,
			endpointFingerprint,
		})
	}

	private getAdaptiveRuntimeProfile(): AdaptiveEmbeddingControllerState | undefined {
		const profileKey = this.getEmbeddingRuntimeProfileKey()
		return profileKey ? this.embeddingRuntimeProfileStore.getProfile(profileKey) : undefined
	}

	private seedAdaptiveRuntimeProfile(adapter: ExistingEmbedderAdapter | undefined) {
		if (!adapter) {
			return
		}

		adapter.seedAdaptiveControllerState?.(this.getAdaptiveRuntimeProfile())
	}

	private maybePersistAdaptiveRuntimeState(state: AdaptiveEmbeddingControllerState | undefined) {
		if (!state) {
			return
		}

		const profileKey = this.getEmbeddingRuntimeProfileKey()
		if (!profileKey) {
			return
		}

		this.embeddingRuntimeProfileStore.setProfile(profileKey, state)
	}

	private handleAdaptiveRuntimeObservations(
		observations: AdaptiveProviderObservation[],
		reportedProfile?: AdaptiveEmbeddingControllerState,
	): AdaptiveEmbeddingControllerState | undefined {
		const profileKey = this.getEmbeddingRuntimeProfileKey()
		if (!profileKey) {
			return reportedProfile
		}

		let nextProfile = this.embeddingRuntimeProfileStore.getProfile(profileKey)
		if (observations.length === 0 && reportedProfile) {
			nextProfile = this.embeddingRuntimeProfileStore.setProfile(profileKey, reportedProfile)
		} else {
			for (const observation of observations) {
				nextProfile = this.embeddingRuntimeProfileStore.applyObservation(profileKey, observation)
			}
		}

		this.seedAdaptiveRuntimeProfile(this._indexEmbeddingAdapter)
		this.seedAdaptiveRuntimeProfile(this._searchEmbeddingAdapter)
		return nextProfile
	}
}
