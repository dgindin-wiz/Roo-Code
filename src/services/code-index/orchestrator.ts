import * as vscode from "vscode"
import * as path from "path"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager, IndexingState } from "./state-manager"
import { IFileWatcher, IVectorStore, BatchProcessingSummary, ScanProgress } from "./interfaces"
import { DirectoryScanner } from "./processors"
import { CacheManager } from "./cache-manager"
import { QdrantTransientError } from "./vector-store/qdrant-client"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { t } from "../../i18n"
import { IndexDebugLogger } from "./debug-logger"

/**
 * Manages the code indexing workflow, coordinating between different services and managers.
 *
 * The orchestrator is now simple: it subscribes to the scanner's progress events
 * and forwards them to the state manager. The scanner handles all complexity
 * (phases, backpressure, fail-fast) internally.
 */
export class CodeIndexOrchestrator {
	private _fileWatcherSubscriptions: vscode.Disposable[] = []
	private _scannerSubscriptions: vscode.Disposable[] = []
	private _isProcessing: boolean = false
	private _abortController: AbortController | null = null
	private _retryTimer: ReturnType<typeof setTimeout> | null = null
	private _retryAttempt: number = 0
	private static readonly MAX_AUTO_RETRIES = 3
	private static readonly RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		private readonly scanner: DirectoryScanner,
		private readonly fileWatcher: IFileWatcher,
	) {}

	/**
	 * Starts the file watcher if not already running.
	 */
	private async _startWatcher(): Promise<void> {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error("Cannot start watcher: Service not configured.")
		}

		this.stateManager.setSystemState("Indexing", "Initializing file watcher...")

		try {
			await this.fileWatcher.initialize()

			this._fileWatcherSubscriptions = [
				this.fileWatcher.onDidStartBatchProcessing((_filePaths: string[]) => {}),
				this.fileWatcher.onBatchProgressUpdate(({ processedInBatch, totalInBatch, currentFile }) => {
					if (totalInBatch > 0 && this.stateManager.state !== "Indexing") {
						this.stateManager.setSystemState("Indexing", "Processing file changes...")
					}
					this.stateManager.reportFileQueueProgress(
						processedInBatch,
						totalInBatch,
						currentFile ? path.basename(currentFile) : undefined,
					)
					if (processedInBatch === totalInBatch) {
						if (totalInBatch > 0) {
							this.stateManager.setSystemState("Indexed", "File changes processed. Index up-to-date.")
						} else {
							if (this.stateManager.state === "Indexing") {
								this.stateManager.setSystemState("Indexed", "Index up-to-date. File queue empty.")
							}
						}
					}
				}),
				this.fileWatcher.onDidFinishBatchProcessing((summary: BatchProcessingSummary) => {
					if (summary.batchError) {
						const isTransient =
							summary.batchError instanceof QdrantTransientError ||
							summary.batchError.cause instanceof QdrantTransientError

						console.error(`[CodeIndexOrchestrator] Batch processing failed:`, summary.batchError)

						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: summary.batchError.message,
							location: "onDidFinishBatchProcessing",
							errorType: isTransient ? "transient_batch_error" : "permanent_batch_error",
						})

						if (!isTransient) {
							// Fix 4: Permanent batch error — transition to Error state and stop
							// the watcher. Without this, the UI stays on "Indexed" while every
							// batch silently fails.
							this.stateManager.setSystemState(
								"Error",
								`File watcher batch failed: ${summary.batchError.message}`,
							)
							this.stopWatcher()
						}
					}
				}),
			]
		} catch (error) {
			console.error("[CodeIndexOrchestrator] Failed to start file watcher:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_startWatcher",
			})
			throw error
		}
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 */
	public async startIndexing(): Promise<void> {
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			this.stateManager.setSystemState("Error", t("embeddings:orchestrator.indexingRequiresWorkspace"))
			console.warn("[CodeIndexOrchestrator] Start rejected: No workspace folder open.")
			return
		}

		if (!this.configManager.isFeatureEnabled) {
			this.stateManager.setSystemState("Standby", "Code indexing is disabled")
			console.warn("[CodeIndexOrchestrator] Start rejected: Feature not enabled.")
			return
		}

		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState("Standby", "Missing configuration. Save your settings to start indexing.")
			console.warn("[CodeIndexOrchestrator] Start rejected: Missing configuration.")
			return
		}

		if (
			this._isProcessing ||
			(this.stateManager.state !== "Standby" &&
				this.stateManager.state !== "Error" &&
				this.stateManager.state !== "Indexed")
		) {
			console.warn(
				`[CodeIndexOrchestrator] Start rejected: Already processing or in state ${this.stateManager.state}.`,
			)
			return
		}

		this._isProcessing = true
		this._abortController = new AbortController()
		const signal = this._abortController.signal
		this.stateManager.setSystemState("Indexing", "Initializing services...")
		this.stateManager.startIndexingTimer()

		let indexingStarted = false

		try {
			// Set session context for the debug logger — populates workspace name,
			// provider, elapsed timer, and writes a rich session header.
			IndexDebugLogger.setContext({
				workspacePath: this.workspacePath,
				embedderProvider: this.configManager.currentEmbedderProvider,
				modelId: this.configManager.currentModelId,
				qdrantUrl: this.configManager.qdrantConfig?.url,
			})

			const cacheCountBeforeInit = this.cacheManager.hashCount
			IndexDebugLogger.log("Orchestrator", "pre-initialize", {
				cacheFileCount: cacheCountBeforeInit,
				workspacePath: this.workspacePath,
				phaseTransition: true,
			})

			const collectionCreated = await this.vectorStore.initialize()
			indexingStarted = true

			IndexDebugLogger.log("Orchestrator", "post-initialize", {
				collectionCreated,
				cacheFileCount: cacheCountBeforeInit,
				phaseTransition: true,
			})

			// Guard: if user clicked Stop during initialize(), bail out before
			// making any cache-clearing decisions. This prevents losing all cache
			// entries when the user quickly starts and stops indexing.
			if (signal.aborted) {
				await this.cacheManager.flush()
				this.stopWatcher()
				this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingStopped"))
				return
			}

			if (collectionCreated) {
				console.log(`[CodeIndexOrchestrator] New collection created → clearing cache and starting full scan.`)
				IndexDebugLogger.log("Orchestrator", "clearCacheFile-collectionCreated", {
					reason: "collectionCreated=true",
					cacheEntriesBeingCleared: cacheCountBeforeInit,
					phaseTransition: true,
				})
				await this.cacheManager.clearCacheFile()
			}

			const hasExistingData = await this.vectorStore.hasIndexedData()

			// Edge case: Collection exists but is empty — data was wiped externally
			if (!collectionCreated && !hasExistingData) {
				console.log(`[CodeIndexOrchestrator] Collection exists but empty → clearing stale cache.`)
				IndexDebugLogger.log("Orchestrator", "clearCacheFile-emptyCollection", {
					reason: "collection exists but empty",
					cacheEntriesBeingCleared: this.cacheManager.hashCount,
					phaseTransition: true,
				})
				await this.cacheManager.clearCacheFile()
			}

			const isIncremental = hasExistingData && !collectionCreated
			IndexDebugLogger.log("Orchestrator", "scan-decision", {
				scanType: isIncremental ? "INCREMENTAL" : "FULL",
				collectionCreated,
				hasExistingData,
				cacheFileCountAfterDecisions: this.cacheManager.hashCount,
				phaseTransition: true,
			})
			console.log(
				`[CodeIndexOrchestrator] ${isIncremental ? "INCREMENTAL" : "FULL"} scan starting` +
					` (collectionCreated=${collectionCreated}, hasExistingData=${hasExistingData})`,
			)

			// Run the unified scan flow
			await this._runScan(signal, isIncremental)
		} catch (error: any) {
			if (error?.name === "AbortError" || signal.aborted) {
				console.log("[CodeIndexOrchestrator] Indexing aborted by user.")
				await this.cacheManager.flush()
				this.stopWatcher()
				this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingStopped"))
				return
			}

			console.error("[CodeIndexOrchestrator] Error during indexing:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "startIndexing",
			})

			this._handleIndexingError(error, indexingStarted)
		} finally {
			this._isProcessing = false
			this._abortController = null
			// Dispose scanner subscriptions
			this._scannerSubscriptions.forEach((sub) => sub.dispose())
			this._scannerSubscriptions = []
		}
	}

	/**
	 * Unified scan flow: subscribes to scanner progress, runs scan, handles completion.
	 * Works for both incremental and full scans — the scanner handles the distinction
	 * internally using the cache manager (mtime/hash checks).
	 */
	private async _runScan(signal: AbortSignal, isIncremental: boolean): Promise<void> {
		const cachedFileCount = this.cacheManager.hashCount

		if (isIncremental) {
			this.stateManager.setSystemState(
				"Indexing",
				cachedFileCount > 0
					? `Resuming — ${cachedFileCount} files already indexed, scanning for changes...`
					: "Resuming — checking for new or modified files...",
			)
		} else {
			this.stateManager.setSystemState("Indexing", "Services ready. Starting workspace scan...")
		}

		await this.vectorStore.markIndexingIncomplete()

		// Get pre-existing block count for resume display
		let startingBlockCount = 0
		if (isIncremental) {
			try {
				startingBlockCount = await this.vectorStore.getPointCount()
				if (startingBlockCount > 0) {
					console.log(`[CodeIndexOrchestrator] Resuming with ${startingBlockCount} existing blocks in Qdrant`)
				}
			} catch {
				// Non-critical
			}
		}

		// Subscribe to scanner progress events and forward to state manager
		let embedPhaseStarted = false

		this._scannerSubscriptions.push(
			this.scanner.onProgress((progress: ScanProgress) => {
				IndexDebugLogger.log("Orchestrator", "scanner-progress", {
					phase: progress.phase,
					filesChecked: progress.filesChecked,
					totalFiles: progress.totalFiles,
					blocksEmbedded: progress.blocksEmbedded,
					totalBlocksEstimate: progress.totalBlocksEstimate,
					isEstimatedTotal: progress.isEstimatedTotal,
				})

				switch (progress.phase) {
					case "discovering":
						this.stateManager.reportScanProgress(progress.filesChecked, progress.totalFiles)
						break

					case "parsing":
					case "embedding": {
						if (!embedPhaseStarted && progress.totalBlocksEstimate > 0) {
							// Transition to embed phase display.
							// totalBlocksEstimate already represents ALL blocks in the workspace
							// (from cache + newly parsed), so do NOT add startingBlockCount here.
							// startingBlockCount is only a display offset for blocksEmbedded.
							this.stateManager.startEmbedPhase(
								progress.totalBlocksEstimate,
								progress.isEstimatedTotal,
								undefined,
								isIncremental ? startingBlockCount : undefined,
							)
							embedPhaseStarted = true
						}

						if (embedPhaseStarted) {
							this.stateManager.reportEmbedProgress(
								progress.blocksEmbedded,
								progress.totalBlocksEstimate,
								progress.filesChecked,
								!progress.isEstimatedTotal,
							)
						} else {
							// Still discovering/parsing, no blocks yet — show file progress
							this.stateManager.reportScanProgress(progress.filesChecked, progress.totalFiles)
						}
						break
					}

					case "complete":
						// Will be handled after scanDirectory returns
						break
				}
			}),
		)

		this._scannerSubscriptions.push(
			this.scanner.onError((error: Error) => {
				console.error(`[CodeIndexOrchestrator] Scanner error: ${error.message}`)
			}),
		)

		// Run the scan
		const result = await this.scanner.scanDirectory(this.workspacePath, signal)

		if (signal.aborted) {
			await this.cacheManager.flush()
			this.stopWatcher()
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexingStopped"))
			return
		}

		// Validate results
		this._validateScanResults(result.blocksEmbedded, result.totalBlocks, result.errors)

		// Log results
		if (result.totalBlocks > 0) {
			const summary =
				`Scan completed: ${result.blocksEmbedded} blocks indexed, ` +
				`${result.skippedFiles} files skipped, ${result.processedFiles} files changed`
			console.log(`[CodeIndexOrchestrator] ${summary}`)
			IndexDebugLogger.logToChannel(summary)
		} else {
			const summary = `No new or changed files found (${result.skippedFiles} files skipped)`
			console.log(`[CodeIndexOrchestrator] ${summary}`)
			IndexDebugLogger.logToChannel(summary)
		}

		await this._startWatcher()
		await this.cacheManager.flush()
		IndexDebugLogger.log("Orchestrator", "post-scan-flush", {
			cacheFileCountAfterFlush: this.cacheManager.hashCount,
			phaseTransition: true,
		})
		await this.vectorStore.markIndexingComplete()

		// Reset retry counter on success
		this._retryAttempt = 0

		// Report completion
		let totalBlocks = this.cacheManager.getTotalCachedBlockCount()
		if (totalBlocks === 0) {
			try {
				totalBlocks = await this.vectorStore.getPointCount()
				console.log(`[CodeIndexOrchestrator] Block count cache empty, got ${totalBlocks} from vector store.`)
			} catch {
				// Non-critical
			}
		}
		this.stateManager.reportComplete(totalBlocks, result.totalFiles)
	}

	/**
	 * Validates scan results and throws on critical failures.
	 */
	private _validateScanResults(blocksEmbedded: number, blocksFound: number, errors: Error[]): void {
		if (blocksEmbedded === 0 && blocksFound > 0) {
			if (errors.length > 0) {
				throw new Error(`Indexing failed: ${errors[0].message}`)
			} else {
				throw new Error(t("embeddings:orchestrator.indexingFailedNoBlocks"))
			}
		}

		if (blocksFound > 0) {
			const failureRate = (blocksFound - blocksEmbedded) / blocksFound
			if (errors.length > 0 && failureRate > 0.1) {
				throw new Error(
					`Indexing partially failed: Only ${blocksEmbedded} of ${blocksFound} blocks were indexed. ${errors[0].message}`,
				)
			}
		}

		if (errors.length > 0 && blocksEmbedded === 0) {
			throw new Error(`Indexing failed completely: ${errors[0].message}`)
		}

		if (blocksFound > 0 && blocksEmbedded === 0) {
			throw new Error(t("embeddings:orchestrator.indexingFailedCritical"))
		}
	}

	/**
	 * Handles indexing errors with appropriate cleanup strategy.
	 */
	private _handleIndexingError(error: any, indexingStarted: boolean): void {
		const isTransientQdrantError = error instanceof QdrantTransientError
		const isDimensionMismatch = error instanceof Error && error.cause !== undefined

		if (isTransientQdrantError) {
			console.log("[CodeIndexOrchestrator] Transient Qdrant error. Preserving data for retry.")
			this.cacheManager
				.flush()
				.catch((e) => console.error("[CodeIndexOrchestrator] Failed to flush cache after transient error:", e))
			this._scheduleTransientRetry()
		} else if (!indexingStarted) {
			console.log("[CodeIndexOrchestrator] Failed to connect to Qdrant. Preserving cache.")
		} else if (isDimensionMismatch) {
			console.log("[CodeIndexOrchestrator] Qdrant data corruption detected. Clearing collection and cache.")
			this.vectorStore.clearCollection().catch((cleanupError) => {
				console.error("[CodeIndexOrchestrator] Failed to clean up after error:", cleanupError)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
					location: "startIndexing.cleanup",
				})
			})
			this.cacheManager
				.clearCacheFile()
				.catch((e) => console.error("[CodeIndexOrchestrator] Failed to clear cache after corruption:", e))
		} else {
			console.log("[CodeIndexOrchestrator] Indexing failed. Preserving Qdrant data and flushing cache.")
			this.cacheManager
				.flush()
				.catch((e) => console.error("[CodeIndexOrchestrator] Failed to flush cache after error:", e))
		}

		const errorMessage = error.message || t("embeddings:orchestrator.unknownError")
		IndexDebugLogger.logToChannel(`ERROR: ${errorMessage}`)

		this.stateManager.setSystemState(
			"Error",
			t("embeddings:orchestrator.failedDuringInitialScan", { errorMessage }),
		)
		this.stopWatcher()
	}

	/**
	 * Schedules an automatic retry after a transient Qdrant error.
	 */
	private _scheduleTransientRetry(): void {
		if (this._retryAttempt >= CodeIndexOrchestrator.MAX_AUTO_RETRIES) {
			console.log(
				`[CodeIndexOrchestrator] Max auto-retries (${CodeIndexOrchestrator.MAX_AUTO_RETRIES}) exhausted.`,
			)
			this._retryAttempt = 0
			return
		}

		const delay = CodeIndexOrchestrator.RETRY_DELAYS_MS[this._retryAttempt] ?? 30_000
		this._retryAttempt++

		console.log(
			`[CodeIndexOrchestrator] Scheduling auto-retry ${this._retryAttempt}/${CodeIndexOrchestrator.MAX_AUTO_RETRIES} in ${delay / 1000}s...`,
		)

		this._retryTimer = setTimeout(() => {
			this._retryTimer = null
			console.log(
				`[CodeIndexOrchestrator] Auto-retry ${this._retryAttempt}/${CodeIndexOrchestrator.MAX_AUTO_RETRIES} starting...`,
			)
			this._isProcessing = false
			this.startIndexing()
		}, delay)
	}

	/**
	 * Cancels any pending auto-retry timer.
	 */
	private _cancelRetryTimer(): void {
		if (this._retryTimer) {
			clearTimeout(this._retryTimer)
			this._retryTimer = null
		}
	}

	/**
	 * Stops any in-progress indexing.
	 */
	public stopIndexing(): void {
		this._cancelRetryTimer()
		this._retryAttempt = 0
		if (this._abortController) {
			this.stateManager.setSystemState("Stopping", t("embeddings:orchestrator.indexingStoppedPartial"))
			this._abortController.abort()
			this._abortController = null
		}
		this.stopWatcher()
	}

	/**
	 * Stops the file watcher and cleans up resources.
	 */
	public stopWatcher(): void {
		this.fileWatcher.dispose()
		this._fileWatcherSubscriptions.forEach((sub) => sub.dispose())
		this._fileWatcherSubscriptions = []

		if (this.stateManager.state !== "Error" && this.stateManager.state !== "Stopping") {
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.fileWatcherStopped"))
		}
		this._isProcessing = false
	}

	/**
	 * Clears all index data.
	 */
	public async clearIndexData(): Promise<void> {
		this._isProcessing = true

		try {
			await this.stopWatcher()

			try {
				if (this.configManager.isFeatureConfigured) {
					await this.vectorStore.deleteCollection()
				} else {
					console.warn("[CodeIndexOrchestrator] Service not configured, skipping vector collection clear.")
				}
			} catch (error: any) {
				console.error("[CodeIndexOrchestrator] Failed to clear vector collection:", error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "clearIndexData",
				})
				this.stateManager.setSystemState("Error", `Failed to clear vector collection: ${error.message}`)
			}

			await this.cacheManager.clearCacheFile()

			if (this.stateManager.state !== "Error") {
				this.stateManager.setSystemState("Standby", "Index data cleared successfully.")
			}
		} finally {
			this._isProcessing = false
		}
	}

	/**
	 * Gets the current state of the indexing system.
	 */
	public get state(): IndexingState {
		return this.stateManager.state
	}
}
