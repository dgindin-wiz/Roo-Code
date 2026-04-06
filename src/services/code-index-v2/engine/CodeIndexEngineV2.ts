import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
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
	StatHashService,
	type OversizedFileDetail,
} from "../pipeline"
import { ReconciliationService } from "../reconciliation/ReconciliationService"
import { MetadataStore } from "../store/MetadataStore"
import { CODE_INDEX_V2_ENGINE_ID } from "../shared/constants"
import { WatcherCoordinator } from "../watcher"
import { CodeIndexStatus, ICodeIndexEngine } from "./interfaces"

export class CodeIndexEngineV2 implements ICodeIndexEngine {
	private static readonly REVISION_BATCH_SIZE = 20
	private static readonly HEARTBEAT_INTERVAL_MS = 2_000
	public readonly engine = CODE_INDEX_V2_ENGINE_ID
	private _status: CodeIndexStatus = {
		engine: CODE_INDEX_V2_ENGINE_ID,
		state: "idle",
	}
	private readonly metadataStore: MetadataStore
	private _embeddingAdapter: ExistingEmbedderAdapter | undefined
	private _vectorStore: QdrantRestVectorStoreAdapter | undefined
	private _workspaceAdapter: VsCodeWorkspaceAdapter | undefined
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

		IndexDebugLoggerV2.setContext({
			engine: this.engine,
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
		})

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
		})
		await this._workspaceAdapter.initialize()
		await this.refreshTrackedOversizedFiles()
		try {
			await this.runSerialized(async (signal) => {
				await this.runFullIndex("start", signal)
			})
		} catch (error) {
			if (this.isAbortError(error) && this._stopRequested) {
				return
			}
			throw error
		}
		await this.ensureWatcher()
		this.startReconciliationTimer()
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
		this._status = {
			engine: this.engine,
			state: "stopping",
			message: "Stopping indexing",
		}
		this._stopRequested = true
		this.stateManager.setSystemState("Stopping", "Stopping indexing...")
		this._activeAbortController?.abort()
		await this._operationChain.catch(() => undefined)
		this._watcherCoordinator?.dispose()
		this._watcherCoordinator = undefined
		if (this._reconciliationTimer) {
			clearInterval(this._reconciliationTimer)
			this._reconciliationTimer = undefined
		}
		this.stopActivityHeartbeat()
		await this._embeddingAdapter?.recycleClient()
		await this._vectorStore?.recycleClient()
		await this.metadataStore.dispose()
		this._started = false
		this._activeAbortController = undefined
		this._status = {
			engine: this.engine,
			state: "idle",
			message: "Indexing stopped.",
		}
		this.stateManager.setSystemState("Standby", "Indexing stopped.")
	}

	async clear(): Promise<void> {
		await this.runSerialized(async () => {
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "clear-requested", {
				engine: this.engine,
				workspacePath: this.workspacePath,
			})

			this._status = {
				engine: this.engine,
				state: "running",
				message: "Clearing Code Index V2 data",
			}
			this.stateManager.reportCustomProgress("Clearing indexed data", 0, 1, {
				currentItemUnit: "phases",
				phase: "embedding",
				detailedStage: "deleting_vectors",
				hasKnownVectorWork: true,
				hasStartedVectorSync: false,
			})

			this._watcherCoordinator?.dispose()
			this._watcherCoordinator = undefined
			if (this._reconciliationTimer) {
				clearInterval(this._reconciliationTimer)
				this._reconciliationTimer = undefined
			}
			this.stopActivityHeartbeat()

			try {
				const { vectorStore } = this.getOrCreateSearchDependencies()
				await vectorStore.deleteCollection()
				await vectorStore.recycleClient()
				await this._embeddingAdapter?.recycleClient()
				this._vectorStore = undefined
				this._embeddingAdapter = undefined
				await this.metadataStore.clearStorage()
				this._workspaceAdapter = undefined
				this._started = false
				this._staleRunIdsToResume = []
				this._resumedRetryJobsCount = 0
				this._resumedPendingJobsCount = 0
				this._lastCpuSample = undefined
				this._status = {
					engine: this.engine,
					state: "idle",
					message: "Index data cleared successfully.",
				}
				this.stateManager.resetIndexingState("Index data cleared successfully.")
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

	async search(query: string, limit: number): Promise<VectorStoreSearchResult[]> {
		const { embeddingAdapter, vectorStore } = this.getOrCreateSearchDependencies()
		await vectorStore.initialize()
		const embeddingResponse = await embeddingAdapter.createEmbeddings([query], { isQuery: true })
		const vector = embeddingResponse.embeddings[0]
		const candidateLimit = Math.max(limit * 3, limit)

		const vectorResults = vector
			? await vectorStore.search(vector, candidateLimit, this.configManager.currentSearchMinScore)
			: []
		const lexicalResults = await this.metadataStore.searchActiveChunksLexically(query, candidateLimit)
		const mergedResults = this.mergeSearchCandidates(
			query,
			vectorResults,
			lexicalResults.map((chunk) => this.createLexicalSearchResult(chunk)),
		)
		const rerankedResults = this.rerankSearchResults(query, mergedResults)
		return this.expandSearchResultsWithParents(rerankedResults, limit)
	}

	private getEffectiveMaxFileSizeBytes(relativePath: string): number {
		return this.configManager.getEffectiveMaxFileSizeBytes(this.workspacePath, relativePath)
	}

	private buildOversizedSummarySuffix(oversizedFiles: number): string {
		return oversizedFiles > 0 ? ` with ${oversizedFiles.toLocaleString()} oversized files skipped` : ""
	}

	private rerankSearchResults(query: string, results: VectorStoreSearchResult[]): VectorStoreSearchResult[] {
		const normalizedQuery = this.normalizeSearchText(query)
		const queryTokens = this.tokenizeSearchText(query)
		const desiredChunkKinds = this.inferDesiredChunkKinds(queryTokens)
		const queryIntent = this.parseQueryIntent(query)

		return [...results]
			.map((result, index) => {
				const payload = result.payload
				const matchReasons = new Set<string>(result.matchReasons ?? [])
				let rerankScore = result.score

				const symbolName = this.normalizeSearchText(payload?.symbolName)
				const symbolQualifiedName = this.normalizeSearchText(payload?.symbolQualifiedName)
				const parentSymbolName = this.normalizeSearchText(payload?.parentSymbolName)
				const filePath = this.normalizeSearchText(payload?.filePath)
				const fileBasename = this.getPathBasename(filePath)
				const summary = this.normalizeSearchText(payload?.summary)
				const chunkKind = this.normalizeSearchText(payload?.chunkKind)

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

				if (normalizedQuery && parentSymbolName?.includes(normalizedQuery)) {
					rerankScore += 0.08
					matchReasons.add("parent symbol match")
				}

				if (normalizedQuery && filePath?.includes(normalizedQuery)) {
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

				for (const symbolHint of queryIntent.symbolHints) {
					if (!symbolHint) {
						continue
					}
					if (symbolQualifiedName === symbolHint) {
						rerankScore += 0.32
						matchReasons.add("exact hinted symbol match")
					} else if (symbolName === symbolHint) {
						rerankScore += 0.26
						matchReasons.add("exact hinted symbol match")
					} else if (symbolQualifiedName?.includes(symbolHint) || symbolName?.includes(symbolHint)) {
						rerankScore += 0.18
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
					} else if (filePath?.endsWith(pathHint) || filePath?.includes(pathHint)) {
						rerankScore += 0.2
						matchReasons.add("hinted path match")
					}
				}

				const symbolTokenHits = this.countTokenHits(
					queryTokens,
					symbolQualifiedName,
					symbolName,
					parentSymbolName,
				)
				if (symbolTokenHits > 0) {
					rerankScore += Math.min(0.14, symbolTokenHits * 0.04)
					matchReasons.add("symbol token overlap")
				}

				const pathTokenHits = this.countTokenHits(queryTokens, filePath)
				if (pathTokenHits > 0) {
					rerankScore += Math.min(0.1, pathTokenHits * 0.03)
					matchReasons.add("path token overlap")
				}

				const summaryTokenHits = this.countTokenHits(queryTokens, summary)
				if (summaryTokenHits > 0) {
					rerankScore += Math.min(0.08, summaryTokenHits * 0.02)
					matchReasons.add("summary token overlap")
				}

				if (chunkKind && desiredChunkKinds.size > 0 && desiredChunkKinds.has(chunkKind)) {
					rerankScore += 0.05
					matchReasons.add("chunk kind match")
				}

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

	private mergeSearchCandidates(
		query: string,
		vectorResults: VectorStoreSearchResult[],
		lexicalResults: VectorStoreSearchResult[],
	): VectorStoreSearchResult[] {
		const queryIntent = this.parseQueryIntent(query)
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

	private applyVariantScoring(
		result: VectorStoreSearchResult,
		queryIntent: ReturnType<CodeIndexEngineV2["parseQueryIntent"]>,
	): VectorStoreSearchResult {
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

	private parseQueryIntent(query: string): {
		pathHints: string[]
		symbolHints: string[]
		looksLikeNaturalLanguage: boolean
	} {
		const normalizedQuery = this.normalizeSearchText(query)
		const rawTokens = query.match(/[A-Za-z0-9_./-]+/g) ?? []
		const pathHints = new Set<string>()
		const symbolHints = new Set<string>()

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
			const looksLikeIdentifier =
				/[A-Z][A-Za-z0-9_]+/.test(token) ||
				/[a-z]+[A-Z][A-Za-z0-9_]*/.test(token) ||
				/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(token)
			if (looksLikeQualifiedSymbol || looksLikeIdentifier) {
				symbolHints.add(normalizedToken)
			}
		}

		if (normalizedQuery.includes("/") || /\.[a-z0-9_-]{1,8}$/.test(normalizedQuery)) {
			pathHints.add(normalizedQuery.replace(/\\/g, "/"))
		}
		if (normalizedQuery.includes(".") && /[a-z_]/.test(normalizedQuery)) {
			symbolHints.add(normalizedQuery)
		}

		return {
			pathHints: Array.from(pathHints),
			symbolHints: Array.from(symbolHints),
			looksLikeNaturalLanguage:
				query.trim().includes(" ") && pathHints.size === 0 && symbolHints.size === 0 && rawTokens.length >= 3,
		}
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

		const joined = haystacks.filter(Boolean).join(" ")
		if (!joined) {
			return 0
		}

		return tokens.reduce((count, token) => count + (joined.includes(token) ? 1 : 0), 0)
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

	private getOrCreateSearchDependencies(): {
		embeddingAdapter: ExistingEmbedderAdapter
		vectorStore: QdrantRestVectorStoreAdapter
	} {
		if (!this._embeddingAdapter) {
			const cacheManager = new CacheManager(this.context, this.workspacePath)
			const serviceFactory = new CodeIndexServiceFactory(this.configManager, this.workspacePath, cacheManager)
			const runtimeMetadata = this.getEmbeddingRuntimeMetadata()
			this._embeddingAdapter = new ExistingEmbedderAdapter(serviceFactory.createEmbedder(), {
				modelId: this.configManager.currentModelId,
				runtimeKind: runtimeMetadata.runtimeKind,
				runtimeLabel: runtimeMetadata.runtimeLabel,
				deviceHint: runtimeMetadata.deviceHint,
			})
		}

		if (!this._vectorStore) {
			const vectorSize = this.configManager.currentModelDimension
			const qdrantUrl = this.configManager.qdrantConfig.url
			if (!vectorSize || !qdrantUrl) {
				throw new Error("Code Index V2 requires a configured embedder dimension and Qdrant URL")
			}

			this._vectorStore = new QdrantRestVectorStoreAdapter(
				this.workspacePath,
				qdrantUrl,
				vectorSize,
				this.configManager.qdrantConfig.apiKey,
			)
		}

		return {
			embeddingAdapter: this._embeddingAdapter,
			vectorStore: this._vectorStore,
		}
	}

	private async runFullIndex(mode: "start" | "refresh", signal?: AbortSignal): Promise<void> {
		const workspaceAdapter = this.requireWorkspaceAdapter()
		await this.preflightIndexingDependencies(signal)
		const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
		const isRefresh = mode === "refresh"
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
		updateDiscoveryDetail()
		this.startActivityHeartbeat(() => discoveryMessage)
		const summary = await discoveryService.runWorkspaceDiscoveryWithProgress(
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
			},
		)
		this.stopActivityHeartbeat()
		this.stateManager.setActivityDetail("")
		this._status = {
			engine: this.engine,
			state: "running",
			message: isRefresh
				? `Re-evaluated ${summary.discoveredFiles.toLocaleString()} files, now checking what changed`
				: `Mapped ${summary.discoveredFiles.toLocaleString()} files, now checking what changed`,
		}
		this.stateManager.reportScanProgress(summary.discoveredFiles, summary.discoveredFiles)
		const pipelineSummary = await this.runPipelineForRun(
			summary.runId,
			summary.discoveredFiles,
			undefined,
			undefined,
			signal,
		)
		await this.refreshTrackedOversizedFiles(pipelineSummary.oversizedDetails, summary.runId)
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
		this.stateManager.reportComplete(indexedChunks, indexedFiles)
		if (
			pipelineSummary.oversizedFiles > 0 ||
			pipelineSummary.terminalFailedParseRevisions > 0 ||
			pipelineSummary.degradedRevisions > 0 ||
			pipelineSummary.terminalFailedRevisions > 0
		) {
			this.stateManager.setSystemState("Indexed", this._status.message)
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

		const dependencies = this.getOrCreateSearchDependencies()
		const embedUpsertWorker = new EmbedUpsertWorker(
			this.metadataStore,
			dependencies.embeddingAdapter,
			dependencies.vectorStore,
		)
		try {
			await embedUpsertWorker.run(runId, signal)
			await this.metadataStore.markRunComplete(runId)
		} catch (error) {
			if (this.isAbortError(error) && this._stopRequested) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, this.getStopAwareErrorMessage(error))
			}
			throw error
		} finally {
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
			{ isBackgroundReconcile: true },
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
		},
		signal?: AbortSignal,
	): Promise<{
		changedFiles: number
		parsedChunks: number
		syncedChunks: number
		oversizedFiles: number
		oversizedDetails: OversizedFileDetail[]
		retryingParseRevisions: number
		terminalFailedParseRevisions: number
		degradedRevisions: number
		terminalFailedRevisions: number
		terminallyFailedChunks: number
		retryingChunks: number
	}> {
		const workspaceAdapter = this.requireWorkspaceAdapter()
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
		this.stopActivityHeartbeat()
		this.stateManager.setActivityDetail("")
		const parserAdapter = new CodeIndexParserAdapter()
		const parseChunkService = new ParseChunkService(
			this.metadataStore,
			workspaceAdapter,
			parserAdapter,
			(relativePath) => this.getEffectiveMaxFileSizeBytes(relativePath),
		)
		const diffPlanner = new DiffPlanner(this.metadataStore)
		const dependencies = this.getOrCreateSearchDependencies()
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
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
		}
		if (statHashSummary.changedFiles === 0 && this._resumedPendingJobsCount === 0) {
			await this.metadataStore.markRunComplete(runId)
			return {
				changedFiles: 0,
				parsedChunks: 0,
				syncedChunks: 0,
				oversizedFiles: statHashSummary.oversizedFiles,
				oversizedDetails: statHashSummary.oversizedDetails,
				retryingParseRevisions: 0,
				terminalFailedParseRevisions: 0,
				degradedRevisions: 0,
				terminalFailedRevisions: 0,
				terminallyFailedChunks: 0,
				retryingChunks: 0,
			}
		}
		try {
			const embedUpsertWorker = new EmbedUpsertWorker(
				this.metadataStore,
				dependencies.embeddingAdapter,
				dependencies.vectorStore,
			)
			const totalChangedFiles = Math.max(statHashSummary.changedFiles, 1)
			let parsedRevisionsCompleted = 0
			let parsedChunksCompleted = 0
			let retryingParseRevisions = 0
			let terminalFailedParseRevisions = 0
			let syncedChunksCompleted = 0
			let embedPhaseStarted = false
			let latestSyncTelemetry:
				| {
						chunksPerSecond?: number
						averageBatchLatencyMs?: number
						lastBatchLatencyMs?: number
						batchesCompleted?: number
						retryingChunks?: number
						terminallyFailedChunks?: number
						degradedRevisions?: number
						terminalFailedRevisions?: number
				  }
				| undefined
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
				this.stateManager.setActivityDetail(
					[
						`Parsing ${parsedRevisionsCompleted.toLocaleString()} of ${totalChangedFiles.toLocaleString()} files • Streaming ${syncedChunksCompleted.toLocaleString()} of ${Math.max(parsedChunksCompleted, 1).toLocaleString()} parsed chunks${buildFailureSuffix()}`,
						this.getEmbeddingRuntimeStatusText(dependencies.embeddingAdapter, latestSyncTelemetry),
					].join("\n"),
				)
			}
			const countChunksForRevisions = async (revisionIds: string[]) => {
				let totalChunks = 0
				for (const revisionId of revisionIds) {
					totalChunks += (await this.metadataStore.getChunksForRevision(revisionId)).length
				}
				return totalChunks
			}
			const syncVectorWork = async (parsedRevisionIds: string[], parsedChunkCount: number) => {
				this._status = {
					engine: this.engine,
					state: "running",
					message: `Planning vector updates for ${parsedChunkCount.toLocaleString()} chunks`,
				}
				if (!embedPhaseStarted) {
					this.stateManager.startEmbedPhase(
						Math.max(parsedChunksCompleted, syncedChunksCompleted, parsedChunkCount, 1),
						true,
						totalChangedFiles,
						0,
						{
							runtimeKind: dependencies.embeddingAdapter.runtimeKind === "local" ? "local" : "remote",
							detailedStage: "planning_vectors",
							hasKnownVectorWork: parsedChunkCount > 0 || this._resumedPendingJobsCount > 0,
							hasStartedVectorSync: false,
							isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
						},
					)
					embedPhaseStarted = true
				}
				this.stateManager.setActivityDetail(
					[
						`Parsing ${parsedRevisionsCompleted.toLocaleString()} of ${totalChangedFiles.toLocaleString()} files • Preparing ${Math.max(parsedChunksCompleted, 0).toLocaleString()} parsed chunks for vector sync${buildFailureSuffix()}`,
						this.getEmbeddingRuntimeStatusText(dependencies.embeddingAdapter, latestSyncTelemetry),
					].join("\n"),
				)
				await diffPlanner.run(runId, signal, { revisionIds: parsedRevisionIds })

				this._status = {
					engine: this.engine,
					state: "running",
					message: `Building embeddings and streaming to Qdrant`,
				}
				this.startActivityHeartbeat(() => `Building embeddings and streaming to Qdrant`)
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
						chunksPerSecond,
						averageBatchLatencyMs,
						lastBatchLatencyMs,
						batchesCompleted,
					}) => {
						const totalSyncedChunks = syncedChunksCompleted + upsertedChunks + deletedChunks
						latestSyncTelemetry = {
							chunksPerSecond,
							averageBatchLatencyMs,
							lastBatchLatencyMs,
							batchesCompleted,
							retryingChunks,
							terminallyFailedChunks,
							degradedRevisions,
							terminalFailedRevisions,
						}
						this.stateManager.setActivityDetail(
							[
								`Parsing ${parsedRevisionsCompleted.toLocaleString()} of ${totalChangedFiles.toLocaleString()} files • Streaming ${totalSyncedChunks.toLocaleString()} of ${Math.max(parsedChunksCompleted, 1).toLocaleString()} chunks${buildFailureSuffix()}`,
								this.getEmbeddingRuntimeStatusText(dependencies.embeddingAdapter, latestSyncTelemetry),
							].join("\n"),
						)
						this.stateManager.setResilienceStats({
							resumedRetryJobs: this._resumedRetryJobsCount,
							resumedPendingJobs: this._resumedPendingJobsCount,
							retryingParseRevisions,
							terminalFailedParseRevisions,
							retryingChunks,
							terminallyFailedChunks,
							degradedRevisions,
							terminalFailedRevisions,
						})
						this.stateManager.reportEmbedProgress(
							totalSyncedChunks,
							Math.max(parsedChunksCompleted, totalSyncedChunks, 1),
							parsedRevisionsCompleted,
							parsedRevisionsCompleted >= statHashSummary.changedFiles,
							{
								detailedStage: "embedding",
								hasKnownVectorWork: true,
								hasStartedVectorSync: totalSyncedChunks > 0,
								isBackgroundReconcile: options?.isBackgroundReconcile ?? false,
							},
						)
					},
				)
				this.stopActivityHeartbeat()
				syncedChunksCompleted += syncSummary.upsertedChunks + syncSummary.deletedChunks
				await this.refreshOutstandingResumedJobs(runId)
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
				updateEmbeddingDetail()
			}

			this._status = {
				engine: this.engine,
				state: "running",
				message: `Preparing changed files for indexing`,
			}
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
			updateEmbeddingDetail()

			const reusedParsedRevisionIds = statHashSummary.reusedParsedRevisionIds ?? []
			if (reusedParsedRevisionIds.length > 0) {
				const reusedParsedChunks = await countChunksForRevisions(reusedParsedRevisionIds)
				parsedRevisionsCompleted += reusedParsedRevisionIds.length
				parsedChunksCompleted += reusedParsedChunks
				updateEmbeddingDetail()
				await syncVectorWork(reusedParsedRevisionIds, reusedParsedChunks)
			}

			for (;;) {
				this.startActivityHeartbeat(() => `Building embeddings and streaming to Qdrant`)
				const parseChunkSummary = await parseChunkService.run(
					runId,
					signal,
					({ parsedRevisions, parsedChunks }) => {
						const totalParsedRevisions = parsedRevisionsCompleted + parsedRevisions
						const totalParsedChunks = parsedChunksCompleted + parsedChunks
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
						this.stateManager.setActivityDetail(
							[
								`Parsing ${totalParsedRevisions.toLocaleString()} of ${totalChangedFiles.toLocaleString()} files • Streaming ${syncedChunksCompleted.toLocaleString()} of ${Math.max(totalParsedChunks, 1).toLocaleString()} parsed chunks`,
								this.getEmbeddingRuntimeStatusText(dependencies.embeddingAdapter, latestSyncTelemetry),
							].join("\n"),
						)
					},
					{ limit: CodeIndexEngineV2.REVISION_BATCH_SIZE },
				)
				this.stopActivityHeartbeat()

				retryingParseRevisions += parseChunkSummary.retryingRevisions
				terminalFailedParseRevisions += parseChunkSummary.terminalFailedRevisions
				this.stateManager.setResilienceStats({
					resumedRetryJobs: this._resumedRetryJobsCount,
					resumedPendingJobs: this._resumedPendingJobsCount,
					retryingParseRevisions,
					terminalFailedParseRevisions,
					degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
					terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
					terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
					retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
				})

				if (parseChunkSummary.attemptedRevisions === 0) {
					break
				}

				parsedRevisionsCompleted += parseChunkSummary.parsedRevisions
				parsedChunksCompleted += parseChunkSummary.parsedChunks
				updateEmbeddingDetail()

				if (parseChunkSummary.parsedChunks === 0 && this._resumedPendingJobsCount === 0) {
					continue
				}

				await syncVectorWork(parseChunkSummary.parsedRevisionIds, parseChunkSummary.parsedChunks)
			}
			this.stateManager.setActivityDetail("")

			await this.metadataStore.markRunComplete(runId)

			return {
				changedFiles: statHashSummary.changedFiles,
				parsedChunks: parsedChunksCompleted,
				syncedChunks: syncedChunksCompleted,
				oversizedFiles: statHashSummary.oversizedFiles,
				oversizedDetails: statHashSummary.oversizedDetails,
				retryingParseRevisions,
				terminalFailedParseRevisions,
				degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
				terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
				terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
				retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
			}
		} catch (error) {
			if (this.isAbortError(error) && this._stopRequested) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, this.getStopAwareErrorMessage(error))
			}
			throw error
		} finally {
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
			await dependencies.embeddingAdapter.recycleClient?.()
			await dependencies.vectorStore.recycleClient?.()
		}
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
		const { embeddingAdapter, vectorStore } = this.getOrCreateSearchDependencies()
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Verifying indexing services",
		}
		this.stateManager.reportCustomProgress("Verifying indexing services", 0, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})

		if (signal?.aborted) {
			throw new Error("Indexing preflight aborted")
		}

		await vectorStore.initialize()
		this.stateManager.reportCustomProgress("Verifying indexing services", 1, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})

		if (signal?.aborted) {
			throw new Error("Indexing preflight aborted")
		}

		await embeddingAdapter.createEmbeddings(["preflight"], {
			isQuery: true,
			signal,
		})
		this.stateManager.reportCustomProgress("Verifying indexing services", 2, 2, {
			currentItemUnit: "checks",
			phase: "scanning",
			detailedStage: "preparing",
		})
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
}
