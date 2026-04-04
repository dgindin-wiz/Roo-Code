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
import { DiffPlanner, EmbedUpsertWorker, ParseChunkService, StatHashService } from "../pipeline"
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
	private _lastCpuSample:
		| {
				cpuUsage: NodeJS.CpuUsage
				timeNs: bigint
		  }
		| undefined
	private _started = false
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
		})
		this._workspaceAdapter = new VsCodeWorkspaceAdapter(this.workspacePath, {
			respectGitIgnore: this.configManager.currentRespectGitIgnore,
		})
		await this._workspaceAdapter.initialize()
		await this.runSerialized(async () => {
			await this.runFullIndex()
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
			message: "Stopping Code Index V2 scaffolding",
		}
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
		this._status = {
			engine: this.engine,
			state: "idle",
		}
	}

	async clear(): Promise<void> {
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
			this._status = {
				engine: this.engine,
				state: "idle",
				message: "Index data cleared successfully.",
			}
			this.stateManager.setSystemState("Standby", "Index data cleared successfully.")
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
	}

	async search(query: string, limit: number): Promise<VectorStoreSearchResult[]> {
		const { embeddingAdapter, vectorStore } = this.getOrCreateSearchDependencies()
		await vectorStore.initialize()
		const embeddingResponse = await embeddingAdapter.createEmbeddings([query], { isQuery: true })
		const vector = embeddingResponse.embeddings[0]

		if (!vector) {
			return []
		}

		return vectorStore.search(vector, limit, this.configManager.currentSearchMinScore)
	}

	async enqueuePathsChanged(paths: string[], reason: "watcher" | "manual" | "reconcile"): Promise<void> {
		await this.runSerialized(async () => {
			IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "paths-enqueued", {
				engine: this.engine,
				workspacePath: this.workspacePath,
				component: "WatcherCoordinator",
				jobId: `${reason}:${paths.length}`,
			})

			if (reason === "reconcile") {
				await this.runReconciliation()
				return
			}

			await this.runTargetedUpdate(paths, reason)
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

	private async runFullIndex(): Promise<void> {
		const workspaceAdapter = this.requireWorkspaceAdapter()
		const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Walking the workspace",
		}
		this.stateManager.reportCustomProgress("Walking the workspace", 0, 1, {
			currentItemUnit: "files",
			phase: "scanning",
		})
		let discoveredFiles = 0
		let processedDirectories = 0
		let pendingDirectories = 1
		const discoveryMessage = "Walking the workspace"
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
				`${discoveredFiles.toLocaleString()} candidate files found • Estimated total ~${getDiscoveryEstimate().toLocaleString()} files • ${processedDirectories.toLocaleString()} dirs visited • ${this.getMemoryStatusText()}`,
			)
		}
		updateDiscoveryDetail()
		this.startActivityHeartbeat(() => discoveryMessage)
		const summary = await discoveryService.runWorkspaceDiscoveryWithProgress(
			"initial-discovery",
			undefined,
			(progress) => {
				discoveredFiles = progress.discoveredFiles
				processedDirectories = Math.max(processedDirectories, progress.processedDirectories)
				pendingDirectories = Math.max(progress.pendingDirectories, 0)
				this.stateManager.reportCustomProgress(discoveryMessage, discoveredFiles, getDiscoveryEstimate(), {
					currentItemUnit: "files",
					phase: "scanning",
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
			message: `Mapped ${summary.discoveredFiles.toLocaleString()} files, now checking what changed`,
		}
		this.stateManager.reportScanProgress(summary.discoveredFiles, summary.discoveredFiles)
		const pipelineSummary = await this.runPipelineForRun(summary.runId, summary.discoveredFiles)
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
						? `V2 is current after a partial scan of ${summary.discoveredFiles.toLocaleString()} files`
						: `V2 is current across ${summary.discoveredFiles.toLocaleString()} files`
					: summary.isPartial
						? `Partial V2 scan mapped ${summary.discoveredFiles.toLocaleString()} files, refreshed ${pipelineSummary.changedFiles.toLocaleString()} changed files, and synced ${pipelineSummary.syncedChunks.toLocaleString()} chunks`
						: `V2 mapped ${summary.discoveredFiles.toLocaleString()} files, refreshed ${pipelineSummary.changedFiles.toLocaleString()} changed files, and synced ${pipelineSummary.syncedChunks.toLocaleString()} chunks`,
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
		this.stateManager.reportComplete(indexedChunks, indexedFiles)
		if (
			pipelineSummary.terminalFailedParseRevisions > 0 ||
			pipelineSummary.degradedRevisions > 0 ||
			pipelineSummary.terminalFailedRevisions > 0
		) {
			this.stateManager.setSystemState("Indexed", this._status.message)
		}
	}

	private async runTargetedUpdate(paths: string[], reason: "watcher" | "manual"): Promise<void> {
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
		const deletedPaths: string[] = []

		for (const filePath of normalizedPaths) {
			try {
				await fs.access(filePath)
				existingPaths.push(filePath)
			} catch {
				deletedPaths.push(filePath)
			}
		}

		if (existingPaths.length > 0) {
			const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
			const summary = await discoveryService.runTargetedDiscovery(existingPaths, reason)
			await this.runPipelineForRun(
				summary.runId,
				summary.discoveredFiles,
				existingPaths.map((filePath) => path.relative(this.workspacePath, filePath)),
			)
		}

		if (deletedPaths.length > 0) {
			await this.runDeletionPipeline(deletedPaths, `delete-${reason}`)
		}

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

	private async runDeletionPipeline(paths: string[], triggerType: string): Promise<void> {
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
			await embedUpsertWorker.run(runId)
			await this.metadataStore.markRunComplete(runId)
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

	private async runReconciliation(): Promise<void> {
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Reconciling local state with the workspace",
		}
		this.stateManager.reportCustomProgress("Reconciling local state with the workspace", 0, 1, {
			currentItemUnit: "passes",
			phase: "scanning",
		})
		IndexDebugLoggerV2.log("basic", "CodeIndexEngineV2", "reconciliation-start", {
			component: "CodeIndexEngineV2",
			workspacePath: this.workspacePath,
		})
		const workspaceAdapter = this.requireWorkspaceAdapter()
		const discoveryService = new DiscoveryService(this.metadataStore, workspaceAdapter)
		const reconciliationService = new ReconciliationService(this.metadataStore, workspaceAdapter)
		const summary = await discoveryService.runReconciliationDiscovery()
		const reconciliationSummary = await reconciliationService.findMissingFiles(summary)

		if (reconciliationSummary.missingFiles.length > 0) {
			await this.runDeletionPipeline(
				reconciliationSummary.missingFiles.map((relativePath) => path.join(this.workspacePath, relativePath)),
				"reconcile-delete",
			)
		}

		await this.runPipelineForRun(summary.runId, summary.discoveredFiles)
	}

	private async runPipelineForRun(
		runId: string,
		knownTotalFiles?: number,
		relativePaths?: string[],
	): Promise<{
		changedFiles: number
		parsedChunks: number
		syncedChunks: number
		retryingParseRevisions: number
		terminalFailedParseRevisions: number
		degradedRevisions: number
		terminalFailedRevisions: number
		terminallyFailedChunks: number
		retryingChunks: number
	}> {
		const workspaceAdapter = this.requireWorkspaceAdapter()
		const statHashService = new StatHashService(this.metadataStore, workspaceAdapter)
		this._status = {
			engine: this.engine,
			state: "running",
			message: "Comparing file signatures",
		}
		const initialTotalFiles = Math.max(knownTotalFiles ?? relativePaths?.length ?? 0, 1)
		this.stateManager.reportCustomProgress("Comparing file signatures", 0, initialTotalFiles, {
			currentItemUnit: "files",
			phase: "scanning",
		})
		let checkedFiles = 0
		let changedFiles = 0
		let skippedFiles = 0
		const getStatHashForecast = () => {
			const totalFiles = Math.max(knownTotalFiles ?? relativePaths?.length ?? checkedFiles, checkedFiles, 1)
			if (checkedFiles <= 0) {
				return {
					totalFiles,
					projectedChangedFiles: changedFiles,
					projectedSkippedFiles: skippedFiles,
				}
			}

			const changedRatio = changedFiles / checkedFiles
			const projectedChangedFiles = Math.max(changedFiles, Math.round(totalFiles * changedRatio))
			const projectedSkippedFiles = Math.max(skippedFiles, totalFiles - projectedChangedFiles)

			return {
				totalFiles,
				projectedChangedFiles,
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
			const projectionSuffix =
				checkedFiles > 0 && checkedFiles < forecast.totalFiles
					? ` • Projecting ~${forecast.projectedChangedFiles.toLocaleString()} changed, ~${forecast.projectedSkippedFiles.toLocaleString()} unchanged`
					: ""
			this.stateManager.setActivityDetail(
				`${changedFiles.toLocaleString()} changed • ${skippedFiles.toLocaleString()} unchanged${projectionSuffix} • ${this.getMemoryStatusText()}`,
			)
		}
		updateHashDetail()
		this.startActivityHeartbeat(() => {
			const forecast = getStatHashForecast()
			const projectedChanged =
				checkedFiles > 0 && checkedFiles < forecast.totalFiles
					? `, projecting ~${forecast.projectedChangedFiles.toLocaleString()} changed`
					: ""
			return `Comparing file signatures... ${checkedFiles.toLocaleString()} checked, ${changedFiles.toLocaleString()} changed, ${skippedFiles.toLocaleString()} unchanged${projectedChanged}`
		})
		let statHashSummary = await statHashService.run(runId, undefined, relativePaths, {
			onProgress: (progress) => {
				checkedFiles = progress.checkedFiles
				changedFiles = progress.changedFiles
				skippedFiles = progress.skippedFiles
				const forecast = getStatHashForecast()
				this.stateManager.reportCustomProgress(
					`Comparing file signatures... ${checkedFiles.toLocaleString()} checked, ${changedFiles.toLocaleString()} changed, ${skippedFiles.toLocaleString()} unchanged${
						checkedFiles < forecast.totalFiles
							? ` • ~${forecast.projectedChangedFiles.toLocaleString()} changed by completion`
							: ""
					}`,
					checkedFiles,
					forecast.totalFiles,
					{
						currentItemUnit: "files",
						phase: "scanning",
						estimationConfidence: getStatHashConfidence(),
					},
				)
				updateHashDetail()
			},
		})
		this.stopActivityHeartbeat()
		this.stateManager.setActivityDetail("")
		const parserAdapter = new CodeIndexParserAdapter()
		const parseChunkService = new ParseChunkService(this.metadataStore, workspaceAdapter, parserAdapter)
		const diffPlanner = new DiffPlanner(this.metadataStore)
		const dependencies = this.getOrCreateSearchDependencies()
		const resumedJobs = await this.metadataStore.adoptRetryableJobsFromStaleRuns(runId, this._staleRunIdsToResume)
		this._resumedRetryJobsCount = resumedJobs
		await this.refreshOutstandingResumedJobs(runId)
		if (resumedJobs > 0) {
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
				},
			)
			this.startActivityHeartbeat(
				() => `Remote index is empty, rebuilding ${checkedFiles.toLocaleString()} files from local metadata`,
			)
			statHashSummary = await statHashService.run(runId, undefined, relativePaths, {
				forceReindex: true,
				onProgress: (progress) => {
					checkedFiles = progress.checkedFiles
					changedFiles = progress.changedFiles
					skippedFiles = progress.skippedFiles
					this.stateManager.reportCustomProgress(
						`Remote index is empty, rebuilding ${checkedFiles.toLocaleString()} files from local metadata`,
						checkedFiles,
						Math.max(statHashSummary.checkedFiles, progress.checkedFiles, 1),
						{
							currentItemUnit: "files",
							phase: "scanning",
						},
					)
					this.stateManager.setActivityDetail(this.getMemoryStatusText())
				},
			})
			this.stopActivityHeartbeat()
			this.stateManager.setActivityDetail("")
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

			this._status = {
				engine: this.engine,
				state: "running",
				message: `Building embeddings and streaming to Qdrant`,
			}
			this.stateManager.startEmbedPhase(1, true, totalChangedFiles, 0, {
				runtimeKind: dependencies.embeddingAdapter.runtimeKind === "local" ? "local" : "remote",
			})
			updateEmbeddingDetail()

			for (;;) {
				this.startActivityHeartbeat(() => `Building embeddings and streaming to Qdrant`)
				const parseChunkSummary = await parseChunkService.run(
					runId,
					undefined,
					({ parsedRevisions, parsedChunks }) => {
						const totalParsedRevisions = parsedRevisionsCompleted + parsedRevisions
						const totalParsedChunks = parsedChunksCompleted + parsedChunks
						this.stateManager.reportCustomProgress(
							`Building embeddings and streaming to Qdrant`,
							totalParsedRevisions,
							totalChangedFiles,
							{
								currentItemUnit: "files",
								phase: "embedding",
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
						this.stateManager.reportEmbedProgress(
							syncedChunksCompleted,
							Math.max(totalParsedChunks, syncedChunksCompleted, 1),
							totalParsedRevisions,
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

				this._status = {
					engine: this.engine,
					state: "running",
					message: `Planning vector updates for ${parseChunkSummary.parsedChunks.toLocaleString()} chunks`,
				}
				await diffPlanner.run(runId, undefined, { revisionIds: parseChunkSummary.parsedRevisionIds })

				this._status = {
					engine: this.engine,
					state: "running",
					message: `Building embeddings and streaming to Qdrant`,
				}
				this.startActivityHeartbeat(() => `Building embeddings and streaming to Qdrant`)
				const syncSummary = await embedUpsertWorker.run(
					runId,
					undefined,
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
			this.stateManager.setActivityDetail("")

			await this.metadataStore.markRunComplete(runId)

			return {
				changedFiles: statHashSummary.changedFiles,
				parsedChunks: parsedChunksCompleted,
				syncedChunks: syncedChunksCompleted,
				retryingParseRevisions,
				terminalFailedParseRevisions,
				degradedRevisions: latestSyncTelemetry?.degradedRevisions ?? 0,
				terminalFailedRevisions: latestSyncTelemetry?.terminalFailedRevisions ?? 0,
				terminallyFailedChunks: latestSyncTelemetry?.terminallyFailedChunks ?? 0,
				retryingChunks: latestSyncTelemetry?.retryingChunks ?? 0,
			}
		} catch (error) {
			await this.metadataStore.markRunFailed(runId, error instanceof Error ? error.message : String(error))
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

	private async runSerialized(task: () => Promise<void>): Promise<void> {
		const next = this._operationChain.then(task, task)
		this._operationChain = next.catch(() => undefined)
		return next
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
