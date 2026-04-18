import * as vscode from "vscode"
import { ContextProxy } from "../../core/config/ContextProxy"
import { IndexDebugLogger } from "./debug-logger"
import { VectorStoreSearchResult } from "./interfaces"
import { IndexingState } from "./interfaces/manager"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { CodeIndexServiceFactory } from "./service-factory"
import { CodeIndexSearchService } from "./search-service"
import { CodeIndexOrchestrator } from "./orchestrator"
import { CacheManager } from "./cache-manager"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { t } from "../../i18n"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { getConfiguredCodeIndexEngine } from "../code-index-v2/settings"
import { CODE_INDEX_V2_ENGINE_ID, CodeIndexEngineKind } from "../code-index-v2/shared/constants"
import {
	CodeIndexDebugSearchTrace,
	CodeIndexEngineV2,
	CodeIndexMetadataCompactionResult,
	ICodeIndexEngine,
	IndexDebugLoggerV2,
} from "../code-index-v2"
import { ensureWorkspaceCodeIndexConfig, getWorkspaceCodeIndexConfig } from "./workspace-config"
import { getCurrentWorkspaceFolder, getWorkspaceFolderForPath } from "../../utils/path"

export class CodeIndexManager {
	private static readonly V2_STARTUP_IDLE_DELAY_MS = 6_000
	private static readonly V2_STARTUP_RETRY_COOLDOWN_MS = 60_000
	private static readonly V2_STARTUP_WATCHDOG_INTERVAL_MS = 2_000
	private static readonly V2_STARTUP_STALL_TIMEOUT_MS = 30_000
	private static readonly V2_STARTUP_MEMORY_LIMIT_MB = 900

	// --- Singleton Implementation ---
	private static instances = new Map<string, CodeIndexManager>() // Map workspace path to instance

	// Specialized class instances
	private _configManager: CodeIndexConfigManager | undefined
	private readonly _stateManager: CodeIndexStateManager
	private _serviceFactory: CodeIndexServiceFactory | undefined
	private _orchestrator: CodeIndexOrchestrator | undefined
	private _searchService: CodeIndexSearchService | undefined
	private _cacheManager: CacheManager | undefined
	private _engineV2: ICodeIndexEngine | undefined

	// Flag to prevent race conditions during error recovery
	private _isRecoveringFromError = false
	private _deferredV2StartTimer: ReturnType<typeof setTimeout> | undefined
	private _deferredV2StartProgressTimer: ReturnType<typeof setInterval> | undefined
	private _deferredV2StartScheduledAt = 0
	private _startupV2StartPromise: Promise<void> | undefined
	private _v2EngineStartPromise: Promise<void> | undefined
	private _v2EngineStopPromise: Promise<void> | undefined
	private _v2EngineStarted = false
	private _v2StartupCooldownUntil = 0
	private _startupV2AbortMessage: string | undefined

	public static getInstance(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		// Resolve the workspace folder to get both fsPath and the real URI
		let folder: vscode.WorkspaceFolder | undefined

		if (workspacePath) {
			folder = getWorkspaceFolderForPath(workspacePath)
			if (folder) {
				workspacePath = folder.uri.fsPath
			}
		} else {
			folder = getCurrentWorkspaceFolder()
			if (!folder) {
				return undefined
			}
			workspacePath = folder.uri.fsPath
		}

		if (!CodeIndexManager.instances.has(workspacePath)) {
			// folder may be undefined when workspacePath was provided but doesn't match
			// any workspace folder (e.g. cwd passed from a tool). Fall back to file:// URI.
			const folderUri =
				folder?.uri ??
				({
					fsPath: workspacePath,
					scheme: "file",
					authority: "",
					path: workspacePath,
					toString: () => `file://${workspacePath}`,
				} as unknown as vscode.Uri)
			CodeIndexManager.instances.set(workspacePath, new CodeIndexManager(workspacePath, folderUri, context))
		}
		return CodeIndexManager.instances.get(workspacePath)!
	}

	public static getAllInstances(): CodeIndexManager[] {
		return Array.from(CodeIndexManager.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of CodeIndexManager.instances.values()) {
			instance.dispose()
		}
		CodeIndexManager.instances.clear()
	}

	/**
	 * Flushes all pending cache writes across all manager instances.
	 * Called from deactivate() to ensure partial indexing progress is saved
	 * before the extension process exits. Unlike dispose(), this is fully
	 * async and awaited, guaranteeing the writes complete.
	 */
	public static async flushAllCaches(): Promise<void> {
		const promises: Promise<void>[] = []
		for (const instance of CodeIndexManager.instances.values()) {
			if (instance._cacheManager && typeof instance._cacheManager.flush === "function") {
				const cacheCountBeforeFlush = instance._cacheManager.hashCount
				IndexDebugLogger.log("Manager", "flushAllCaches-start", {
					workspacePath: instance.workspacePath,
					cacheHashCount: cacheCountBeforeFlush,
					phaseTransition: true,
				})
				promises.push(
					instance._cacheManager
						.flush()
						.then(() => {
							IndexDebugLogger.log("Manager", "flushAllCaches-done", {
								workspacePath: instance.workspacePath,
								cacheHashCount: instance._cacheManager!.hashCount,
								phaseTransition: true,
							})
						})
						.catch((error: unknown) => {
							const msg = error instanceof Error ? error.message : String(error)
							console.error(
								`[CodeIndexManager] Failed to flush cache for ${instance.workspacePath}:`,
								error,
							)
							IndexDebugLogger.log("Manager", "flushAllCaches-error", {
								workspacePath: instance.workspacePath,
								error: msg,
								phaseTransition: true,
							})
						}),
				)
			}
		}
		await Promise.all(promises)
	}

	private readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext
	private _contextProxy: ContextProxy | undefined

	// Private constructor for singleton pattern
	private constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this._stateManager = new CodeIndexStateManager()
	}

	// --- Public API ---

	/**
	 * Returns the workspaceState key for per-folder indexing enablement,
	 * keyed by the real workspace folder URI so local/remote schemes cannot collide.
	 */
	private _workspaceEnabledKey(): string {
		return "codeIndexWorkspaceEnabled:" + this._folderUri.toString(true)
	}

	public get isWorkspaceEnabled(): boolean {
		const explicit = this.context.workspaceState.get<boolean | undefined>(this._workspaceEnabledKey(), undefined)
		if (explicit !== undefined) return explicit
		return this.autoEnableDefault
	}

	public async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		await this.context.workspaceState.update(this._workspaceEnabledKey(), enabled)
	}

	public get autoEnableDefault(): boolean {
		return this.context.globalState.get("codeIndexAutoEnableDefault", true)
	}

	public async setAutoEnableDefault(enabled: boolean): Promise<void> {
		await this.context.globalState.update("codeIndexAutoEnableDefault", enabled)
	}

	public get onProgressUpdate() {
		return this._stateManager.onProgressUpdate
	}

	private assertInitialized() {
		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			if (!this._configManager || !this._engineV2) {
				throw new Error("CodeIndexManager not initialized. Call initialize() first.")
			}
			return
		}

		if (!this._configManager || !this._orchestrator || !this._searchService || !this._cacheManager) {
			throw new Error("CodeIndexManager not initialized. Call initialize() first.")
		}
	}

	public get state(): IndexingState {
		if (!this.isFeatureEnabled) {
			return "Standby"
		}

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			return this._stateManager.state
		}

		this.assertInitialized()
		return this._orchestrator!.state
	}

	public get isFeatureEnabled(): boolean {
		return this._configManager?.isFeatureEnabled ?? false
	}

	public get selectedEngine(): CodeIndexEngineKind {
		return getConfiguredCodeIndexEngine()
	}

	public get isFeatureConfigured(): boolean {
		return this._configManager?.isFeatureConfigured ?? false
	}

	public get isInitialized(): boolean {
		try {
			this.assertInitialized()
			return true
		} catch (error) {
			return false
		}
	}

	/**
	 * Initializes the manager with configuration and dependent services.
	 * Must be called before using any other methods.
	 * @returns Object indicating if a restart is needed
	 */
	public async initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		// Store contextProxy for later re-initialization (e.g. recovery from Error state)
		this._contextProxy = contextProxy
		const legacyCodeIndexConfig = this.getLegacyCodeIndexConfig(contextProxy)
		await ensureWorkspaceCodeIndexConfig(this.context, this.workspacePath, legacyCodeIndexConfig, this._folderUri)

		// 1. ConfigManager Initialization and Configuration Loading
		if (!this._configManager) {
			this._configManager = new CodeIndexConfigManager(contextProxy, () =>
				getWorkspaceCodeIndexConfig(
					this.context,
					this.workspacePath,
					this.getLegacyCodeIndexConfig(contextProxy),
					this._folderUri,
				),
			)
		}
		// Load configuration once to get current state and restart requirements
		const { requiresRestart } = await this._configManager.loadConfiguration()
		this._stateManager.setLoggerContext(
			this.selectedEngine === CODE_INDEX_V2_ENGINE_ID ? "v2" : "legacy",
			this.workspacePath,
		)

		// 2. Check if feature is enabled
		if (!this.isFeatureEnabled) {
			if (this._orchestrator) {
				this._orchestrator.stopWatcher()
			}
			return { requiresRestart }
		}

		// 3. Check if workspace is available
		const workspacePath = this.workspacePath
		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "No workspace folder open")
			return { requiresRestart }
		}

		// 4. Check workspace-level enablement (before creating expensive services)
		if (!this.isWorkspaceEnabled) {
			this._stateManager.setSystemState("Standby", "Indexing not enabled for this workspace")
			return { requiresRestart }
		}

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			if (!this._engineV2) {
				this._engineV2 = new CodeIndexEngineV2(
					this.context,
					this.workspacePath,
					this._configManager,
					this._stateManager,
				)
			}

			IndexDebugLoggerV2.log("basic", "CodeIndexManager", "initialize-v2-selected", {
				engine: this.selectedEngine,
				workspacePath: this.workspacePath,
			})

			if (this.isV2StartPendingOrRunning()) {
				return { requiresRestart: false }
			}

			if (this.isV2StartupCooldownActive()) {
				this._stateManager.setSystemState("Standby", this.getV2StartupCooldownMessage())
				return { requiresRestart: false }
			}

			this.cancelDeferredV2Start()
			this._stateManager.setSystemState("Standby", "Code Index V2 is ready to start.")
			await this._engineV2.hydrateStandbyStatus?.()
			return { requiresRestart: false }
		}

		// 5. CacheManager Initialization
		if (!this._cacheManager) {
			this._cacheManager = new CacheManager(this.context, this.workspacePath)
			await this._cacheManager.initialize()
			// NOTE: pruneStaleEntries() was previously called here on every startup.
			// This was removed because it does fs.access() on every cached file path,
			// and for large workspaces (65K+ files), files can be briefly inaccessible
			// during VS Code startup — causing valid cache entries to be permanently
			// deleted. This forced full re-indexing on every restart.
			// Stale entries are harmless (tiny memory/disk overhead) and deleted files
			// are handled lazily by the scanner and file watcher.
		}

		// 6. Determine if Core Services Need Recreation
		const needsServiceRecreation = !this._serviceFactory || requiresRestart

		if (needsServiceRecreation) {
			console.log(
				`[CodeIndexManager] [REINDEX-DECISION] Recreating services: requiresRestart=${requiresRestart}, hadFactory=${!!this._serviceFactory}`,
			)
			await this._recreateServices()
		}

		// 7. Handle Indexing Start/Restart
		const shouldStartOrRestartIndexing =
			requiresRestart ||
			(needsServiceRecreation && (!this._orchestrator || this._orchestrator.state !== "Indexing"))

		console.log(
			`[CodeIndexManager] [REINDEX-DECISION] shouldStartOrRestartIndexing=${shouldStartOrRestartIndexing}, ` +
				`requiresRestart=${requiresRestart}, needsServiceRecreation=${needsServiceRecreation}, ` +
				`orchestratorState=${this._orchestrator?.state ?? "none"}`,
		)

		if (shouldStartOrRestartIndexing) {
			this._orchestrator?.startIndexing()
		}

		return { requiresRestart }
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 * Automatically recovers from error state if needed before starting.
	 *
	 * @important This method should NEVER be awaited as it starts a long-running background process.
	 * The indexing will continue asynchronously and progress will be reported through events.
	 */
	public async startIndexing(): Promise<void> {
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			return
		}

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			const currentStatus = this.getCurrentStatus()
			if (currentStatus.systemStatus === "Error") {
				await this.recoverFromError()

				if (this._contextProxy) {
					await this.initialize(this._contextProxy)
				}
			}

			this.assertInitialized()
			this.cancelDeferredV2Start()
			await this.startV2Engine("manual")
			return
		}

		// Check if we're in error state and recover if needed
		const currentStatus = this.getCurrentStatus()
		if (currentStatus.systemStatus === "Error") {
			await this.recoverFromError()

			// After recovery, services are cleared. Re-initialize so we can
			// actually start indexing instead of silently returning.
			if (this._contextProxy) {
				await this.initialize(this._contextProxy)
			}
		}

		this.assertInitialized()
		await this._orchestrator!.startIndexing()
	}

	public async refreshAllIndexData(): Promise<void> {
		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			if (!this.isInitialized) {
				if (!this._contextProxy) {
					throw new Error("CodeIndexManager not initialized. Call initialize() first.")
				}
				await this.initialize(this._contextProxy)
			}
			if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
				return
			}
			this.assertInitialized()
			this.cancelDeferredV2Start()
			this._stateManager.setSystemState("Indexing", "Refreshing the workspace index...")
			try {
				await this._engineV2!.refreshAll()
				const status = await this._engineV2!.getStatus()
				const latestState = this._stateManager.getCurrentStatus()?.systemStatus
				if (latestState !== "Indexed") {
					this._stateManager.setSystemState("Standby", status.message ?? "Workspace index refresh complete")
				}
			} catch (error) {
				if (this.isUserStopAbort(error)) {
					this._stateManager.setSystemState("Standby", "Index refresh stopped.")
					return
				}
				this._stateManager.setSystemState(
					"Error",
					error instanceof Error ? error.message : "Workspace index refresh failed",
				)
				throw error
			}
			return
		}

		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			return
		}

		await this.startIndexing()
	}

	/**
	 * Stops any in-progress indexing operation and the file watcher.
	 */
	public async stopIndexing(): Promise<void> {
		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			IndexDebugLoggerV2.log("basic", "CodeIndexManager", "v2-stop-requested", {
				engine: this.selectedEngine,
				workspacePath: this.workspacePath,
			})
			this.cancelDeferredV2Start()
			this._v2StartupCooldownUntil = Date.now() + CodeIndexManager.V2_STARTUP_RETRY_COOLDOWN_MS
			this._stateManager.setSystemState("Stopping", "Stopping indexing...")
			if (this._engineV2) {
				await this.stopV2Engine()
			}
			this._v2EngineStarted = false
			this._stateManager.setSystemState("Standby", "Indexing stopped.")
			IndexDebugLoggerV2.log("basic", "CodeIndexManager", "v2-stop-complete", {
				engine: this.selectedEngine,
				workspacePath: this.workspacePath,
			})
			return
		}

		if (this._orchestrator) {
			this._orchestrator.stopIndexing()
		}
	}

	/**
	 * Stops the file watcher and potentially cleans up resources.
	 */
	public stopWatcher(): void {
		if (!this.isFeatureEnabled) {
			return
		}
		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			return
		}
		if (this._orchestrator) {
			this._orchestrator.stopWatcher()
		}
	}

	/**
	 * Recovers from error state by clearing the error and resetting internal state.
	 * This allows the manager to be re-initialized after a recoverable error.
	 *
	 * This method clears runtime service instances (serviceFactory, orchestrator, searchService)
	 * to force service re-creation on the next operation. The configManager is intentionally
	 * PRESERVED to maintain accurate previous-config snapshots — clearing it would cause
	 * the next loadConfiguration() to see a false "unconfigured → configured" transition
	 * and trigger an unnecessary full re-index.
	 *
	 * @remarks
	 * - Safe to call even when not in error state (idempotent)
	 * - Does not restart indexing automatically - call initialize() after recovery
	 * - Service instances will be recreated on next initialize() call
	 * - Prevents race conditions from multiple concurrent recovery attempts
	 * - ConfigManager is preserved to avoid false restart detection (RC-4)
	 */
	public async recoverFromError(): Promise<void> {
		// Prevent race conditions from multiple rapid recovery attempts
		if (this._isRecoveringFromError) {
			return
		}

		this._isRecoveringFromError = true
		try {
			// Clear error state
			this._stateManager.setSystemState("Standby", "")
			if (this._engineV2) {
				await this.stopV2Engine({ clearReference: true })
			}
		} catch (error) {
			// Log error but continue with recovery - clearing service instances is more important
			console.error("Failed to clear error state during recovery:", error)
		} finally {
			// Force re-initialization of runtime services by clearing them.
			// IMPORTANT: _configManager is intentionally NOT cleared here.
			// Clearing it would create a fresh instance with empty defaults on next initialize(),
			// causing doesConfigChangeRequireRestart() to see a false transition from
			// "unconfigured" to "configured" and unnecessarily trigger a full re-index.
			this._serviceFactory = undefined
			this._orchestrator = undefined
			this._searchService = undefined
			this._engineV2 = undefined

			// Reset the flag after recovery is complete
			this._isRecoveringFromError = false
		}
	}

	/**
	 * Cleans up the manager instance.
	 * Flushes any pending cache writes to prevent data loss on extension deactivation.
	 */
	public dispose(): void {
		this.cancelDeferredV2Start()
		void this.stopIndexing()
		// Flush pending debounced cache writes so they aren't lost on exit.
		// Fire-and-forget since dispose() is synchronous but flush() is async.
		if (this._cacheManager && typeof this._cacheManager.flush === "function") {
			this._cacheManager.flush().catch((error: unknown) => {
				console.error("[CodeIndexManager] Failed to flush cache on dispose:", error)
			})
		}
		this._stateManager.dispose()
	}

	/**
	 * Clears all index data by stopping the watcher, clearing the Qdrant collection,
	 * and deleting the cache file.
	 */
	public async clearIndexData(): Promise<void> {
		if (!this.isFeatureEnabled) {
			return
		}
		this.assertInitialized()

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			this.cancelDeferredV2Start()
			await this._engineV2!.clear()
			this.resetV2StartupState()
			return
		}

		// Stop any in-progress scan before clearing data to prevent
		// the running scan from writing to the collection while we delete it.
		await this.stopIndexing()
		await this._orchestrator!.clearIndexData()
		await this._cacheManager!.clearCacheFile()
	}

	public async clearIndexDatabase(): Promise<void> {
		if (!this.isFeatureEnabled) {
			return
		}
		this.assertInitialized()

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			this.cancelDeferredV2Start()
			await (this._engineV2!.clearDatabase?.() ?? this._engineV2!.clear())
			this.resetV2StartupState()
			return
		}

		// Stop any in-progress scan before clearing data to prevent
		// the running scan from writing to the collection while we delete it.
		await this.stopIndexing()
		await this._orchestrator!.clearIndexData()
		await this._cacheManager!.clearCacheFile()
	}

	public async compactIndexMetadataDatabase(): Promise<CodeIndexMetadataCompactionResult> {
		if (!this.isFeatureEnabled) {
			throw new Error("Code indexing is disabled.")
		}
		this.assertInitialized()

		if (this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID || !this._engineV2?.compactMetadataDatabase) {
			throw new Error("Metadata DB compaction is only available for Code Index V2.")
		}

		return this._engineV2.compactMetadataDatabase()
	}

	// --- Private Helpers ---

	private resetV2StartupState(): void {
		this._v2EngineStarted = false
		this._v2EngineStartPromise = undefined
		this._startupV2StartPromise = undefined
		this._v2StartupCooldownUntil = 0
		this._startupV2AbortMessage = undefined
	}

	public getCurrentStatus() {
		const status = this._stateManager.getCurrentStatus()
		return {
			...status,
			workspacePath: this.workspacePath,
			workspaceEnabled: this.isWorkspaceEnabled,
			autoEnableDefault: this.autoEnableDefault,
		}
	}

	public async getIndexWarningDetails(
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
		if (this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID || !this._engineV2) {
			return {
				total: 0,
				items: [],
			}
		}

		return this._engineV2.getWarningDetails(offset, limit, filter, sort)
	}

	public async getOversizedFileDetails(
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
		if (this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID || !this._engineV2) {
			return {
				total: 0,
				actionable: 0,
				items: [],
			}
		}

		return this._engineV2.getOversizedFileDetails(offset, limit)
	}

	public async retryIndexWarningFiles(
		filter: "all" | "parser_failed" | "failed" | "degraded",
		relativePaths?: string[],
	): Promise<{ retriedFiles: number }> {
		if (this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID || !this._engineV2) {
			return { retriedFiles: 0 }
		}

		return this._engineV2.retryWarningFiles(filter, relativePaths)
	}

	public async searchIndex(
		query: string,
		options?: {
			directoryPrefix?: string
			limit?: number
		},
	): Promise<VectorStoreSearchResult[]> {
		if (!this.isFeatureEnabled) {
			return []
		}
		this.assertInitialized()

		const directoryPrefix = options?.directoryPrefix
		const limit = options?.limit

		if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
			return this._engineV2!.search(query, limit ?? this._configManager!.currentSearchMaxResults, {
				directoryPrefix,
			})
		}

		const results = await this._searchService!.searchIndex(query, directoryPrefix)
		return typeof limit === "number" ? results.slice(0, Math.max(1, limit)) : results
	}

	public async searchIndexDebug(query: string, limit: number): Promise<CodeIndexDebugSearchTrace | undefined> {
		if (!this.isFeatureEnabled) {
			return undefined
		}

		this.assertInitialized()
		if (this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID || !this._engineV2?.searchDebug) {
			return undefined
		}

		return this._engineV2.searchDebug(query, limit)
	}

	/**
	 * Private helper method to recreate services with current configuration.
	 * Used by both initialize() and handleSettingsChange().
	 */
	private async _recreateServices(): Promise<void> {
		// Stop watcher if it exists
		if (this._orchestrator) {
			this.stopWatcher()
		}
		// Clear existing services to ensure clean state
		this._orchestrator = undefined
		this._searchService = undefined

		// (Re)Initialize service factory
		this._serviceFactory = new CodeIndexServiceFactory(
			this._configManager!,
			this.workspacePath,
			this._cacheManager!,
		)

		const ignoreInstance = ignore()
		const workspacePath = this.workspacePath

		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "")
			return
		}

		if (this._configManager?.currentRespectGitIgnore !== false) {
			// Create .gitignore instance
			const ignorePath = path.join(workspacePath, ".gitignore")
			try {
				const content = await fs.readFile(ignorePath, "utf8")
				ignoreInstance.add(content)
				ignoreInstance.add(".gitignore")
			} catch (error) {
				// Should never happen: reading file failed even though it exists
				console.error("Unexpected error loading .gitignore:", error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "_recreateServices",
				})
			}
		}

		// Create RooIgnoreController instance
		const rooIgnoreController = new RooIgnoreController(workspacePath)
		await rooIgnoreController.initialize()

		// (Re)Create shared service instances
		const { embedder, vectorStore, scanner, fileWatcher } = this._serviceFactory.createServices(
			this.context,
			this._cacheManager!,
			ignoreInstance,
			rooIgnoreController,
		)

		// Validate embedder configuration before proceeding
		const validationResult = await this._serviceFactory.validateEmbedder(embedder)
		if (!validationResult.valid) {
			const errorMessage = validationResult.error || "Embedder configuration validation failed"
			this._stateManager.setSystemState("Error", errorMessage)
			throw new Error(errorMessage)
		}

		// (Re)Initialize orchestrator
		this._orchestrator = new CodeIndexOrchestrator(
			this._configManager!,
			this._stateManager,
			this.workspacePath,
			this._cacheManager!,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// (Re)Initialize search service
		this._searchService = new CodeIndexSearchService(
			this._configManager!,
			this._stateManager,
			embedder,
			vectorStore,
		)

		// Clear any error state after successful recreation
		this._stateManager.setSystemState("Standby", "")
	}

	/**
	 * Handle code index settings changes.
	 * This method should be called when code index settings are updated
	 * to ensure the CodeIndexConfigManager picks up the new configuration.
	 * If the configuration changes require a restart, the service will be restarted.
	 */
	public async handleSettingsChange(): Promise<void> {
		if (this._configManager) {
			const { requiresRestart } = await this._configManager.loadConfiguration()
			this._stateManager.setLoggerContext(
				this.selectedEngine === CODE_INDEX_V2_ENGINE_ID ? "v2" : "legacy",
				this.workspacePath,
			)

			const isFeatureEnabled = this.isFeatureEnabled
			const isFeatureConfigured = this.isFeatureConfigured

			// If feature is disabled, stop the service (including any active scan)
			if (!isFeatureEnabled) {
				if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
					this.cancelDeferredV2Start()
					await this.stopV2Engine()
				} else {
					await this.stopIndexing()
				}
				this._stateManager.setSystemState("Standby", "Code indexing is disabled")
				return
			}

			if (this.selectedEngine === CODE_INDEX_V2_ENGINE_ID) {
				if (requiresRestart && isFeatureEnabled && isFeatureConfigured) {
					this.cancelDeferredV2Start()
					await this.stopV2Engine()
					if (this.isWorkspaceEnabled) {
						this._stateManager.setSystemState(
							"Standby",
							"Code Index V2 needs to restart. Start indexing to continue.",
						)
					}
				}
				return
			}

			if (requiresRestart && isFeatureEnabled && isFeatureConfigured) {
				try {
					// Ensure cacheManager is initialized before recreating services
					if (!this._cacheManager) {
						this._cacheManager = new CacheManager(this.context, this.workspacePath)
						await this._cacheManager.initialize()
					}

					// Recreate services with new configuration
					await this._recreateServices()
				} catch (error) {
					// Error state already set in _recreateServices
					console.error("Failed to recreate services:", error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						location: "handleSettingsChange",
					})
					// Re-throw the error so the caller knows validation failed
					throw error
				}
			}
		}
	}

	private async stopV2Engine(options?: { clearReference?: boolean }): Promise<void> {
		if (!this._engineV2) {
			return
		}

		const engine = this._engineV2
		if (this._v2EngineStopPromise) {
			await this._v2EngineStopPromise
			if (options?.clearReference && this._engineV2 === engine) {
				this._engineV2 = undefined
			}
			return
		}

		const stopPromise = engine.stop().finally(() => {
			this._v2EngineStarted = false
			if (this._v2EngineStopPromise === stopPromise) {
				this._v2EngineStopPromise = undefined
			}
			if (options?.clearReference && this._engineV2 === engine) {
				this._engineV2 = undefined
			}
		})

		this._v2EngineStopPromise = stopPromise
		await stopPromise
	}

	private isUserStopAbort(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error)
		return /stopped by user|aborted/i.test(message)
	}

	private scheduleDeferredV2Start(): void {
		if (
			this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID ||
			!this.isFeatureEnabled ||
			!this.isWorkspaceEnabled ||
			this._isRecoveringFromError ||
			this.isV2StartPendingOrRunning() ||
			this.isV2StartupCooldownActive()
		) {
			return
		}

		this._deferredV2StartTimer = setTimeout(() => {
			this._deferredV2StartTimer = undefined
			this.cancelDeferredV2StartProgressTimer()
			void this.runDeferredV2Start()
		}, CodeIndexManager.V2_STARTUP_IDLE_DELAY_MS)
		this._deferredV2StartScheduledAt = Date.now()
		this.startDeferredV2StartProgressTimer()
		IndexDebugLoggerV2.log("basic", "CodeIndexManager", "startup-idle-wait-scheduled", {
			engine: this.selectedEngine,
			workspacePath: this.workspacePath,
			idleDelayMs: CodeIndexManager.V2_STARTUP_IDLE_DELAY_MS,
		})
	}

	private cancelDeferredV2Start(): void {
		this.cancelDeferredV2StartProgressTimer()
		if (!this._deferredV2StartTimer) {
			return
		}

		clearTimeout(this._deferredV2StartTimer)
		this._deferredV2StartTimer = undefined
	}

	private startDeferredV2StartProgressTimer(): void {
		this.cancelDeferredV2StartProgressTimer()
		this._deferredV2StartProgressTimer = setInterval(() => {
			const scheduledAt = this._deferredV2StartScheduledAt
			const elapsedMs = scheduledAt > 0 ? Date.now() - scheduledAt : undefined
			const remainingMs =
				elapsedMs === undefined ? undefined : Math.max(CodeIndexManager.V2_STARTUP_IDLE_DELAY_MS - elapsedMs, 0)
			IndexDebugLoggerV2.log("basic", "CodeIndexManager", "startup-idle-wait", {
				engine: this.selectedEngine,
				workspacePath: this.workspacePath,
				elapsedMs,
				remainingMs,
			})
		}, 2_000)
	}

	private cancelDeferredV2StartProgressTimer(): void {
		if (!this._deferredV2StartProgressTimer) {
			return
		}

		clearInterval(this._deferredV2StartProgressTimer)
		this._deferredV2StartProgressTimer = undefined
		this._deferredV2StartScheduledAt = 0
	}

	private async runDeferredV2Start(): Promise<void> {
		if (
			this.selectedEngine !== CODE_INDEX_V2_ENGINE_ID ||
			!this.isFeatureEnabled ||
			!this.isWorkspaceEnabled ||
			this._isRecoveringFromError ||
			this.isV2StartupCooldownActive()
		) {
			return
		}

		IndexDebugLoggerV2.log("basic", "CodeIndexManager", "startup-idle-wait-complete", {
			engine: this.selectedEngine,
			workspacePath: this.workspacePath,
		})
		await this.startV2Engine("startup")
	}

	private async startV2Engine(source: "startup" | "manual"): Promise<void> {
		if (!this._engineV2) {
			throw new Error("Code Index V2 not initialized")
		}

		IndexDebugLoggerV2.log("basic", "CodeIndexManager", "v2-start-requested", {
			engine: this.selectedEngine,
			workspacePath: this.workspacePath,
			source,
		})

		if (this._v2EngineStopPromise) {
			await this._v2EngineStopPromise
		}

		if (this._v2EngineStartPromise) {
			await this._v2EngineStartPromise
			return
		}

		const startPromise = this.runV2EngineStart(source)
		this._v2EngineStartPromise = startPromise.finally(() => {
			if (this._v2EngineStartPromise === startPromise) {
				this._v2EngineStartPromise = undefined
			}
		})

		if (source === "startup") {
			this._startupV2StartPromise = this._v2EngineStartPromise.finally(() => {
				this._startupV2StartPromise = undefined
			})
			await this._startupV2StartPromise
			return
		}

		await this._v2EngineStartPromise
	}

	private async runV2EngineStart(source: "startup" | "manual"): Promise<void> {
		this._startupV2AbortMessage = undefined
		this._stateManager.setSystemState(
			"Indexing",
			source === "startup" ? "Code Index V2 is starting in the background..." : "Code Index V2 is running...",
		)

		const disposeWatchdog = source === "startup" ? this.startV2StartupWatchdog() : undefined

		try {
			await this._engineV2!.start()
			let status = await this._engineV2!.getStatus()
			if (this.shouldRearmStoppedV2Start(status, source)) {
				IndexDebugLoggerV2.log("basic", "CodeIndexManager", "v2-start-rearm-after-stale-stop", {
					engine: this.selectedEngine,
					workspacePath: this.workspacePath,
					source,
					state: status.state,
					message: status.message,
				})
				await this.stopV2Engine()
				await this._engineV2!.start()
				status = await this._engineV2!.getStatus()
			}
			this._v2EngineStarted = status.state !== "error" && !this.isStoppedV2Status(status)
			const latestState = this._stateManager.getCurrentStatus()?.systemStatus
			if (latestState !== "Indexed") {
				this._stateManager.setSystemState("Standby", status.message ?? "Code Index V2 initialized")
			}
		} catch (error) {
			this._v2EngineStarted = false
			if (this.isUserStopAbort(error)) {
				this._stateManager.setSystemState("Standby", this._startupV2AbortMessage ?? "Indexing stopped.")
				return
			}
			this._stateManager.setSystemState(
				"Error",
				error instanceof Error ? error.message : "Code Index V2 failed to start",
			)
			throw error
		} finally {
			disposeWatchdog?.()
		}
	}

	private shouldRearmStoppedV2Start(
		status: Awaited<ReturnType<ICodeIndexEngine["getStatus"]>>,
		source: "startup" | "manual",
	): boolean {
		return source === "manual" && this.isStoppedV2Status(status)
	}

	private isStoppedV2Status(status: Awaited<ReturnType<ICodeIndexEngine["getStatus"]>>): boolean {
		return status.state === "idle" && /indexing stopped/i.test(status.message ?? "")
	}

	private getLegacyCodeIndexConfig(contextProxy: Pick<ContextProxy, "getGlobalState"> | undefined) {
		if (!contextProxy || typeof contextProxy.getGlobalState !== "function") {
			return undefined
		}
		return contextProxy.getGlobalState("codebaseIndexConfig")
	}

	private startV2StartupWatchdog(): () => void {
		let lastSnapshot = this.getStartupProgressSnapshot()
		let lastProgressAt = Date.now()
		let triggered = false
		const interval = setInterval(() => {
			if (triggered || !this._engineV2) {
				return
			}

			const nextSnapshot = this.getStartupProgressSnapshot()
			if (nextSnapshot !== lastSnapshot) {
				lastSnapshot = nextSnapshot
				lastProgressAt = Date.now()
			}

			const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024))
			let abortMessage: string | undefined
			if (rssMb >= CodeIndexManager.V2_STARTUP_MEMORY_LIMIT_MB) {
				abortMessage = `Startup indexing paused after extension host memory reached ${rssMb} MB.`
			} else if (Date.now() - lastProgressAt >= CodeIndexManager.V2_STARTUP_STALL_TIMEOUT_MS) {
				abortMessage = "Startup indexing paused because it stopped making progress."
			}

			if (!abortMessage) {
				return
			}

			triggered = true
			this._startupV2AbortMessage = abortMessage
			this._v2StartupCooldownUntil = Date.now() + CodeIndexManager.V2_STARTUP_RETRY_COOLDOWN_MS
			this._v2EngineStarted = false
			this._stateManager.setSystemState("Standby", abortMessage)
			void this.stopV2Engine()
		}, CodeIndexManager.V2_STARTUP_WATCHDOG_INTERVAL_MS)

		return () => clearInterval(interval)
	}

	private getStartupProgressSnapshot(): string {
		const status = this._stateManager.getCurrentStatus()
		return JSON.stringify({
			systemStatus: status?.systemStatus,
			message: status?.message,
			phase: status?.phase,
			detailedStage: status?.detailedStage,
			processedItems: status?.processedItems,
			totalItems: status?.totalItems,
			processedFiles: status?.processedFiles,
			totalFiles: status?.totalFiles,
			currentItemUnit: status?.currentItemUnit,
		})
	}

	private isV2StartPendingOrRunning(): boolean {
		const systemStatus = this._stateManager.getCurrentStatus()?.systemStatus
		return Boolean(
			this._deferredV2StartTimer ||
				this._v2EngineStartPromise ||
				this._startupV2StartPromise ||
				this._v2EngineStarted ||
				systemStatus === "Indexing" ||
				systemStatus === "Stopping" ||
				systemStatus === "Indexed",
		)
	}

	private isV2StartupCooldownActive(): boolean {
		return Date.now() < this._v2StartupCooldownUntil
	}

	private getV2StartupCooldownMessage(): string {
		return this._startupV2AbortMessage ?? "Startup indexing is paused to keep VS Code responsive."
	}
}
