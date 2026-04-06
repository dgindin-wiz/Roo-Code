import * as vscode from "vscode"
import { IndexDebugLogger } from "./debug-logger"

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"

export type IndexingPhase = "scanning" | "embedding" | "complete"
export type IndexingDetailedStage =
	| "preparing"
	| "discovering"
	| "hashing_initial"
	| "comparing_signatures"
	| "parsing"
	| "planning_vectors"
	| "embedding"
	| "deleting_vectors"
	| "reconciling"
	| "complete"
export type EstimationConfidence = "low" | "medium" | "high"
export type IndexingInterruptionKind = "none" | "user_stop" | "stale_recovery"
export type IndexingResumeContext = "none" | "stale_jobs" | "reusable_revisions"

interface IndexingResilienceStats {
	resumedRetryJobs: number
	resumedPendingJobs: number
	retryingParseRevisions: number
	terminalFailedParseRevisions: number
	degradedRevisions: number
	terminalFailedRevisions: number
	terminallyFailedChunks: number
	retryingChunks: number
	warningDetails: Array<{
		relativePath: string
		state: "degraded" | "terminal_failed" | "failed"
		category?: "parser_failed" | "failed" | "degraded"
		failureReason?: string | null
	}>
}

type OversizedDetail = {
	relativePath: string
	sizeBytes: number
	recommendation: "likely_useful" | "review_manually" | "probably_skip"
	reason: string
	needsReapproval?: boolean
	approvedMaxBytes?: number
}

/**
 * Formats milliseconds into a human-readable ETA string.
 */
export function formatEta(ms: number): string {
	if (ms < 10_000) return "almost done"
	if (ms < 60_000) return `~${Math.round(ms / 1000)} sec remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes} min remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours} hr remaining`
	return `~${hours} hr ${remainingMinutes} min remaining`
}

export class CodeIndexStateManager {
	private _systemStatus: IndexingState = "Standby"
	private _statusMessage: string = ""
	private _processedItems: number = 0
	private _totalItems: number = 0
	private _currentItemUnit: string = "blocks"
	private _progressEmitter = new vscode.EventEmitter<ReturnType<typeof this.getCurrentStatus>>()
	private _activityDetail: string = ""

	// Two-phase progress fields
	private _phase: IndexingPhase | undefined
	private _detailedStage: IndexingDetailedStage | undefined
	private _totalFiles: number = 0
	private _processedFiles: number = 0
	private _filesParsed: number = 0 // files actually parsed (not skipped), for ETA during estimated totals
	private _totalBlocks: number = 0
	private _blocksEmbedded: number = 0
	private _changedFiles: number = 0
	private _unchangedFiles: number = 0
	private _oversizedFiles: number = 0
	private _oversizedDetails: OversizedDetail[] = []
	private _missingFiles: number = 0
	private _startingBlockCount: number = 0 // pre-existing blocks in Qdrant from a previous session
	private _isEstimatedTotal: boolean = false
	private _embedStartedAt: number = 0
	private _estimatedTimeRemainingMs: number | null = null
	private _lastFilesParsedChangeTime: number = 0 // when _filesParsed last changed (for backpressure detection)
	private _estimationConfidence: EstimationConfidence | undefined
	private _isBackpressured = false
	private _hasKnownVectorWork = false
	private _hasStartedVectorSync = false
	private _isBackgroundReconcile = false
	private _interruptionKind: IndexingInterruptionKind = "none"
	private _resumeContext: IndexingResumeContext = "none"
	private _embeddingRuntimeKind: "local" | "remote" | "unknown" = "unknown"
	private _recentChunkDensitySamples: number[] = []
	private _recentThroughputSamples: number[] = []
	private _lastThroughputSampleAt: number = 0
	private _lastThroughputBlocksEmbedded: number = 0
	private _resilienceStats: IndexingResilienceStats = this.createEmptyResilienceStats()
	private static readonly MIN_PROGRESS_FOR_ETA = 0.01 // 1% — show ETA early; block-level progress is stable
	private static readonly BACKPRESSURE_DISPLAY_THRESHOLD_MS = 2_000 // show "waiting" hint after 2s of no file progress
	private static readonly MAX_RECENT_DENSITY_SAMPLES = 8
	private static readonly MAX_RECENT_THROUGHPUT_SAMPLES = 8

	// --- Public API ---

	public readonly onProgressUpdate = this._progressEmitter.event

	public get state(): IndexingState {
		return this._systemStatus
	}

	public getCurrentStatus() {
		// Effective counts include the pre-existing Qdrant blocks from a previous session.
		// This makes the UI show the real index size, not just this session's work.
		const effectiveBlocksEmbedded = this._startingBlockCount + this._blocksEmbedded
		return {
			systemStatus: this._systemStatus,
			message: this._statusMessage,
			processedItems: this._processedItems,
			totalItems: this._totalItems,
			currentItemUnit: this._currentItemUnit,
			// Two-phase fields
			phase: this._phase,
			detailedStage: this._detailedStage,
			totalFiles: this._totalFiles,
			processedFiles: this._processedFiles,
			totalBlocks: this._getExtrapolatedTotal(),
			blocksEmbedded: effectiveBlocksEmbedded,
			changedFiles: this._changedFiles,
			unchangedFiles: this._unchangedFiles,
			oversizedFiles: this._oversizedFiles,
			oversizedDetails: this._oversizedDetails,
			missingFiles: this._missingFiles,
			estimatedTimeRemainingMs: this._estimatedTimeRemainingMs,
			isEstimatedTotal: this._isEstimatedTotal,
			estimationConfidence: this._estimationConfidence,
			isBackpressured: this._isBackpressured,
			hasKnownVectorWork: this._hasKnownVectorWork,
			hasStartedVectorSync: this._hasStartedVectorSync,
			isBackgroundReconcile: this._isBackgroundReconcile,
			interruptionKind: this._interruptionKind,
			resumeContext: this._resumeContext,
			resumedRetryJobs: this._resilienceStats.resumedRetryJobs,
			resumedPendingJobs: this._resilienceStats.resumedPendingJobs,
			retryingParseRevisions: this._resilienceStats.retryingParseRevisions,
			terminalFailedParseRevisions: this._resilienceStats.terminalFailedParseRevisions,
			degradedRevisions: this._resilienceStats.degradedRevisions,
			terminalFailedRevisions: this._resilienceStats.terminalFailedRevisions,
			terminallyFailedChunks: this._resilienceStats.terminallyFailedChunks,
			retryingChunks: this._resilienceStats.retryingChunks,
			warningDetails: this._resilienceStats.warningDetails,
		}
	}

	// --- State Management ---

	public setSystemState(newState: IndexingState, message?: string): void {
		const stateChanged =
			newState !== this._systemStatus || (message !== undefined && message !== this._statusMessage)

		if (stateChanged) {
			this._systemStatus = newState
			if (message !== undefined) {
				this._statusMessage = message
			}

			// Reset progress counters if moving to a non-indexing state or starting fresh
			if (newState !== "Indexing") {
				this._processedItems = 0
				this._totalItems = 0
				this._currentItemUnit = "blocks" // Reset to default unit
				this._activityDetail = ""
				// Optionally clear the message or set a default for non-indexing states
				if (newState === "Standby" && message === undefined) this._statusMessage = "Ready."
				if (newState === "Indexed" && message === undefined) this._statusMessage = "Index up-to-date."
				if (newState === "Error" && message === undefined) this._statusMessage = "An error occurred."
				if (newState === "Standby" || newState === "Error") {
					this.resetResilienceStats()
				}
				// Reset two-phase fields
				if (newState !== "Stopping") {
					this.resetDetailedProgressFields({
						phase: newState === "Indexed" ? "complete" : undefined,
						detailedStage: newState === "Indexed" ? "complete" : undefined,
					})
				}
			}

			this._progressEmitter.fire(this.getCurrentStatus())
			IndexDebugLogger.log("StateManager", "setSystemState", {
				phaseTransition: true,
				newState,
				message: message?.substring(0, 80),
			})
		}
	}

	public resetIndexingState(message = "Ready."): void {
		this._systemStatus = "Standby"
		this._statusMessage = message
		this._processedItems = 0
		this._totalItems = 0
		this._currentItemUnit = "blocks"
		this._activityDetail = ""
		this.resetDetailedProgressFields()
		this.resetResilienceStats()

		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "resetIndexingState", {
			phaseTransition: true,
			message: message.substring(0, 120),
		})
	}

	// --- Two-Phase Progress ---

	/**
	 * Called when indexing begins to initialize timing.
	 */
	public startIndexingTimer(): void {
		this._estimatedTimeRemainingMs = null
		this._interruptionKind = "none"
		this._resumeContext = "none"
		this.resetResilienceStats()
	}

	public setRecoveryContext(
		interruptionKind: IndexingInterruptionKind = "none",
		resumeContext: IndexingResumeContext = "none",
	): void {
		this._interruptionKind = interruptionKind
		this._resumeContext = resumeContext
		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "setRecoveryContext", {
			interruptionKind,
			resumeContext,
		})
	}

	/**
	 * Reports progress during the scan phase (checking files for changes).
	 */
	public reportScanProgress(scannedFiles: number, totalFiles: number): void {
		if (this._systemStatus === "Stopping") return

		this._phase = "scanning"
		this._detailedStage = "discovering"
		this._totalFiles = totalFiles
		this._processedFiles = scannedFiles
		this._processedItems = scannedFiles
		this._totalItems = totalFiles
		this._currentItemUnit = "files"
		this._systemStatus = "Indexing"
		this._statusMessage = `Checking ${totalFiles.toLocaleString()} files for changes...`

		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "reportScanProgress", { scannedFiles, totalFiles })
	}

	/**
	 * Sets the total block estimate and transitions to embedding phase.
	 * @param totalBlocks Estimated total blocks across the entire workspace
	 * @param isEstimate Whether the total is an estimate (true) or exact (false)
	 * @param changedFiles Number of changed files to process
	 * @param startingBlockCount Pre-existing blocks in Qdrant from a previous session (for resume display)
	 */
	public startEmbedPhase(
		totalBlocks: number,
		isEstimate: boolean,
		changedFiles?: number,
		startingBlockCount?: number,
		options?: {
			runtimeKind?: "local" | "remote" | "unknown"
			detailedStage?: IndexingDetailedStage
			hasKnownVectorWork?: boolean
			hasStartedVectorSync?: boolean
			isBackgroundReconcile?: boolean
			interruptionKind?: IndexingInterruptionKind
			resumeContext?: IndexingResumeContext
		},
	): void {
		if (this._systemStatus === "Stopping") return

		this._phase = "embedding"
		this._detailedStage = options?.detailedStage ?? "embedding"
		this._totalBlocks = totalBlocks
		this._blocksEmbedded = 0
		this._startingBlockCount = startingBlockCount ?? 0
		this._isEstimatedTotal = isEstimate
		this._embedStartedAt = Date.now()
		this._estimatedTimeRemainingMs = null
		this._lastFilesParsedChangeTime = Date.now()
		this._activityDetail = ""
		this._estimationConfidence = isEstimate ? "low" : "high"
		this._isBackpressured = false
		this._hasKnownVectorWork = options?.hasKnownVectorWork ?? totalBlocks > 0
		this._hasStartedVectorSync = options?.hasStartedVectorSync ?? false
		this._isBackgroundReconcile = options?.isBackgroundReconcile ?? false
		this._interruptionKind = options?.interruptionKind ?? this._interruptionKind
		this._resumeContext = options?.resumeContext ?? this._resumeContext
		this._embeddingRuntimeKind = options?.runtimeKind ?? "unknown"
		this._recentChunkDensitySamples = []
		this._recentThroughputSamples = []
		this._lastThroughputSampleAt = Date.now()
		this._lastThroughputBlocksEmbedded = 0

		// Also update legacy fields for backward compat
		this._processedItems = this._startingBlockCount
		this._totalItems = totalBlocks
		this._currentItemUnit = "blocks"
		this._systemStatus = "Indexing"

		const prefix = isEstimate ? "~" : ""
		const changedSuffix = changedFiles !== undefined ? ` from ${changedFiles.toLocaleString()} files` : ""
		this._statusMessage = `${prefix}${totalBlocks.toLocaleString()} blocks to index${changedSuffix}`

		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "startEmbedPhase", {
			phaseTransition: true,
			totalBlocks,
			isEstimate,
			changedFiles,
			startingBlockCount,
		})
	}

	/**
	 * Reports progress during the embedding phase.
	 * Progress bar and ETA both use block-based metrics (uniform embedding cost per block).
	 * Message shows blocks progress + throughput + ETA.
	 *
	 * Display shows (startingBlockCount + blocksEmbedded) as the "Embedded X" count,
	 * so on resume the user sees the real index size growing, not starting from 0.
	 * ETA uses only blocksEmbedded (new work this session) for throughput calculation.
	 *
	 * @param isExact When true, clears the "~" prefix — parsing is complete and total is exact.
	 */
	public reportEmbedProgress(
		blocksEmbedded: number,
		revisedTotal?: number,
		filesParsed?: number,
		isExact?: boolean,
		options?: {
			detailedStage?: IndexingDetailedStage
			hasKnownVectorWork?: boolean
			hasStartedVectorSync?: boolean
			isBackgroundReconcile?: boolean
			interruptionKind?: IndexingInterruptionKind
			resumeContext?: IndexingResumeContext
		},
	): void {
		if (this._systemStatus === "Stopping") return

		const blocksChanged = blocksEmbedded !== this._blocksEmbedded
		const totalChanged = revisedTotal !== undefined && revisedTotal !== this._totalBlocks
		const filesChanged = filesParsed !== undefined && filesParsed !== this._filesParsed
		const changed = blocksChanged || totalChanged || filesChanged
		if (!changed && this._systemStatus === "Indexing") {
			IndexDebugLogger.logSuppressed("StateManager", "reportEmbedProgress", {
				blocksEmbedded,
				revisedTotal,
				filesParsed,
				storedBlocks: this._blocksEmbedded,
				storedTotal: this._totalBlocks,
				storedFiles: this._filesParsed,
			})
			return
		}

		const previousFilesParsed = this._filesParsed
		const previousObservedBlocks = this._totalBlocks
		this._blocksEmbedded = blocksEmbedded
		if (revisedTotal !== undefined) {
			this._totalBlocks = revisedTotal
		}
		if (isExact) {
			this._isEstimatedTotal = false
		}
		if (filesParsed !== undefined) {
			if (filesParsed !== this._filesParsed) {
				this._lastFilesParsedChangeTime = Date.now()
			}
			this._filesParsed = filesParsed
		}
		if (
			this._isEstimatedTotal &&
			revisedTotal !== undefined &&
			filesParsed !== undefined &&
			filesParsed > previousFilesParsed
		) {
			const deltaFiles = filesParsed - previousFilesParsed
			const deltaBlocks = revisedTotal - previousObservedBlocks
			if (deltaFiles > 0 && deltaBlocks >= 0) {
				this._pushRecentSample(
					this._recentChunkDensitySamples,
					deltaBlocks / deltaFiles,
					CodeIndexStateManager.MAX_RECENT_DENSITY_SAMPLES,
				)
			}
		}

		// Effective embedded = pre-existing + new this session
		const effectiveEmbedded = this._startingBlockCount + this._blocksEmbedded

		// Auto-revise total upward if embedded count exceeds the estimate.
		// This happens when the cache-based block estimate lags behind actual
		// embedding output (e.g. stale cache entries, concurrent parse/embed).
		if (effectiveEmbedded > this._totalBlocks) {
			IndexDebugLogger.log("StateManager", "auto-revise-total", {
				reason: "effectiveEmbedded > totalBlocks",
				oldTotal: this._totalBlocks,
				newTotal: effectiveEmbedded,
				effectiveEmbedded,
			})
			this._totalBlocks = effectiveEmbedded
		}

		// Use extrapolated total for progress bar + ETA when parsing is incomplete.
		// This prevents the progress bar from showing 98% when only 1% of files are parsed.
		const displayTotal = this._getExtrapolatedTotal()
		this._isBackpressured =
			this._filesParsed < this._totalFiles &&
			this._filesParsed > 0 &&
			Date.now() - this._lastFilesParsedChangeTime >= CodeIndexStateManager.BACKPRESSURE_DISPLAY_THRESHOLD_MS

		// Use block-level progress for bar + ETA (uniform cost per block)
		this._processedItems = effectiveEmbedded
		this._totalItems = displayTotal
		this._processedFiles = this._filesParsed
		this._currentItemUnit = "blocks"
		this._phase = "embedding"
		this._detailedStage = options?.detailedStage ?? "embedding"
		this._systemStatus = "Indexing"
		this._hasKnownVectorWork = options?.hasKnownVectorWork ?? true
		this._hasStartedVectorSync = options?.hasStartedVectorSync ?? blocksEmbedded > 0
		this._isBackgroundReconcile = options?.isBackgroundReconcile ?? this._isBackgroundReconcile
		this._interruptionKind = options?.interruptionKind ?? this._interruptionKind
		this._resumeContext = options?.resumeContext ?? this._resumeContext

		// Calculate ETA from block throughput (this session only)
		this._updateEta()

		// Calculate blocks/sec throughput for display (this session only)
		const elapsedSec = (Date.now() - this._embedStartedAt) / 1000
		const blocksPerSec = elapsedSec > 0 ? this._blocksEmbedded / elapsedSec : 0

		// Build message with two lines:
		// Line 1: "Embedded X of ~Y total blocks (N blocks/sec) — ~Z remaining"
		//   X = startingBlockCount + blocksEmbedded (real index size)
		//   Y = extrapolated total (projected from blocks/file ratio when parsing incomplete)
		// Line 2: "X of Y files checked"
		// "total blocks" makes it clear Y is the full workspace total, not remaining.
		const throughputPart =
			blocksPerSec >= 1
				? ` (${Math.round(blocksPerSec).toLocaleString()} blocks/sec)`
				: blocksPerSec > 0
					? " (<1 block/sec)"
					: ""
		const etaSuffix =
			this._estimatedTimeRemainingMs !== null
				? ` — ${formatEta(this._estimatedTimeRemainingMs)}`
				: this._blocksEmbedded > 0
					? " — estimating..."
					: ""
		const prefix = this._isEstimatedTotal ? "~" : ""
		const blockLine = `Embedded ${effectiveEmbedded.toLocaleString()} of ${prefix}${displayTotal.toLocaleString()} total blocks${throughputPart}${etaSuffix}`
		// Detect backpressure: file parsing hasn't advanced for a while but embedding is active.
		// This indicates the parse phase is blocked waiting for embed queue capacity.
		const backpressureHint = this._isBackpressured ? " (waiting for embeddings)" : ""
		const fileLine =
			this._totalFiles > 0
				? `\n${this._filesParsed.toLocaleString()} of ${this._totalFiles.toLocaleString()} files checked${backpressureHint}`
				: ""
		const detailLine = this._activityDetail ? `\n${this._activityDetail}` : ""
		this._statusMessage = `${blockLine}${fileLine}${detailLine}`

		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "reportEmbedProgress", {
			blocksEmbedded,
			revisedTotal,
			filesParsed,
			isExact,
			startingBlockCount: this._startingBlockCount,
			effectiveEmbedded,
			rawTotal: this._totalBlocks,
			extrapolatedTotal: displayTotal,
		})
	}

	/**
	 * Reports completion with final stats.
	 */
	public reportComplete(totalBlocks: number, totalFiles: number): void {
		this._phase = "complete"
		this._detailedStage = "complete"
		this._totalBlocks = totalBlocks
		this._blocksEmbedded = totalBlocks
		this._startingBlockCount = 0 // Reset — total already includes everything
		this._totalFiles = totalFiles
		this._isEstimatedTotal = false
		this._estimatedTimeRemainingMs = null
		this._hasKnownVectorWork = totalBlocks > 0
		this._hasStartedVectorSync = totalBlocks > 0
		this._isBackgroundReconcile = false
		this._processedItems = totalBlocks
		this._totalItems = totalBlocks
		this._systemStatus = "Indexed"

		if (totalBlocks > 0) {
			this._statusMessage = `Index complete — ${totalBlocks.toLocaleString()} blocks across ${totalFiles.toLocaleString()} files`
		} else {
			// Block count unknown (old cache without blockCounts, or vector store unreachable)
			this._statusMessage =
				totalFiles > 0 ? `Index up-to-date — ${totalFiles.toLocaleString()} files` : "Index up-to-date"
		}
		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "reportComplete", { phaseTransition: true, totalBlocks, totalFiles })
	}

	public setResilienceStats(stats: Partial<IndexingResilienceStats>): void {
		this.applyResilienceStats(stats)
		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "setResilienceStats", {
			...this._resilienceStats,
		})
	}

	public setOversizedDetails(details: OversizedDetail[]): void {
		this._oversizedDetails = details
		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "setOversizedDetails", {
			count: details.length,
		})
	}

	/**
	 * Reports custom progress for non-legacy index engines while still using
	 * the same progress payload shape the webview already understands.
	 */
	public reportCustomProgress(
		message: string,
		processedItems: number,
		totalItems: number,
		options?: {
			currentItemUnit?: string
			phase?: IndexingPhase
			detailedStage?: IndexingDetailedStage
			changedFiles?: number
			unchangedFiles?: number
			oversizedFiles?: number
			missingFiles?: number
			systemStatus?: IndexingState
			estimationConfidence?: EstimationConfidence
			isBackpressured?: boolean
			hasKnownVectorWork?: boolean
			hasStartedVectorSync?: boolean
			isBackgroundReconcile?: boolean
			interruptionKind?: IndexingInterruptionKind
			resumeContext?: IndexingResumeContext
			resilienceStats?: Partial<IndexingResilienceStats>
		},
	): void {
		if (this._systemStatus === "Stopping") return

		this._systemStatus = options?.systemStatus ?? "Indexing"
		this._statusMessage = this.composeStatusMessage(message)
		this._processedItems = processedItems
		this._totalItems = totalItems
		this._currentItemUnit = options?.currentItemUnit ?? "items"
		this._phase = options?.phase
		this._detailedStage = options?.detailedStage ?? this.inferDetailedStage(options?.phase)
		this._estimationConfidence = options?.estimationConfidence ?? this._estimationConfidence
		this._isBackpressured = options?.isBackpressured ?? false
		this._hasKnownVectorWork = options?.hasKnownVectorWork ?? this._hasKnownVectorWork
		this._hasStartedVectorSync = options?.hasStartedVectorSync ?? this._hasStartedVectorSync
		this._isBackgroundReconcile = options?.isBackgroundReconcile ?? this._isBackgroundReconcile
		this._interruptionKind = options?.interruptionKind ?? this._interruptionKind
		this._resumeContext = options?.resumeContext ?? this._resumeContext
		this._changedFiles = options?.changedFiles ?? this._changedFiles
		this._unchangedFiles = options?.unchangedFiles ?? this._unchangedFiles
		this._oversizedFiles = options?.oversizedFiles ?? this._oversizedFiles
		this._missingFiles = options?.missingFiles ?? this._missingFiles
		this.applyResilienceStats(options?.resilienceStats)
		if (this._phase === "scanning") {
			this._processedFiles = processedItems
			this._totalFiles = totalItems
		}

		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "reportCustomProgress", {
			message: message.substring(0, 120),
			processedItems,
			totalItems,
			currentItemUnit: this._currentItemUnit,
			phase: this._phase,
			detailedStage: this._detailedStage,
		})
	}

	/**
	 * Emits a lightweight heartbeat while preserving the current progress model.
	 * This keeps the UI feeling alive during long-running phases even when the
	 * numeric counters have not advanced enough to change the bar meaningfully.
	 */
	public reportHeartbeat(message?: string): void {
		if (this._systemStatus !== "Indexing") return
		if (message !== undefined) {
			this._statusMessage = this.composeStatusMessage(message)
		} else {
			this._statusMessage = this.composeStatusMessage(this._statusMessage.split("\n")[0] ?? this._statusMessage)
		}
		this._progressEmitter.fire(this.getCurrentStatus())
		IndexDebugLogger.log("StateManager", "reportHeartbeat", {
			message: this._statusMessage.substring(0, 120),
			phase: this._phase,
			detailedStage: this._detailedStage,
			processedItems: this._processedItems,
			totalItems: this._totalItems,
		})
	}

	public setActivityDetail(detail: string): void {
		this._activityDetail = detail
		if (this._systemStatus === "Indexing") {
			this._statusMessage = this.composeStatusMessage(this._statusMessage.split("\n")[0] ?? this._statusMessage)
			this._progressEmitter.fire(this.getCurrentStatus())
		}
		IndexDebugLogger.log("StateManager", "setActivityDetail", {
			detail: detail.substring(0, 120),
			phase: this._phase,
			detailedStage: this._detailedStage,
		})
	}

	private inferDetailedStage(phase?: IndexingPhase): IndexingDetailedStage | undefined {
		switch (phase) {
			case "scanning":
				return "discovering"
			case "embedding":
				return "embedding"
			case "complete":
				return "complete"
			default:
				return undefined
		}
	}

	/**
	 * Returns an extrapolated total block count when parsing is incomplete.
	 *
	 * During a from-scratch index, _totalBlocks only counts blocks from files
	 * parsed so far. On a 65K-file workspace with 1% parsed, the raw total
	 * vastly underestimates actual work — causing the ETA to say "almost done"
	 * when the scan is barely started.
	 *
	 * When parsing is incomplete (_isEstimatedTotal && _filesParsed < _totalFiles),
	 * we extrapolate: (blocks / files_parsed) * total_files.
	 * On resume scans, filesParsed includes unchanged files, so the ratio
	 * stays stable and extrapolation barely changes the total.
	 */
	private _getExtrapolatedTotal(): number {
		if (
			this._isEstimatedTotal &&
			this._filesParsed > 0 &&
			this._totalFiles > 0 &&
			this._filesParsed < this._totalFiles
		) {
			const globalBlocksPerFile = this._totalBlocks / this._filesParsed
			const recentBlocksPerFile =
				this._recentChunkDensitySamples.length >= 3
					? this._recentChunkDensitySamples.reduce((sum, value, index, samples) => {
							const weight = index + 1
							return sum + value * weight
						}, 0) / this._recentChunkDensitySamples.reduce((sum, _value, index) => sum + index + 1, 0)
					: globalBlocksPerFile
			const recentWeight =
				this._recentChunkDensitySamples.length >= 3
					? Math.min(0.7, this._recentChunkDensitySamples.length / 8)
					: 0
			const blocksPerFile = globalBlocksPerFile * (1 - recentWeight) + recentBlocksPerFile * recentWeight
			return Math.round(blocksPerFile * this._totalFiles)
		}
		return this._totalBlocks
	}

	private composeStatusMessage(baseMessage: string): string {
		return this._activityDetail ? `${baseMessage}\n${this._activityDetail}` : baseMessage
	}

	private createEmptyResilienceStats(): IndexingResilienceStats {
		return {
			resumedRetryJobs: 0,
			resumedPendingJobs: 0,
			retryingParseRevisions: 0,
			terminalFailedParseRevisions: 0,
			degradedRevisions: 0,
			terminalFailedRevisions: 0,
			terminallyFailedChunks: 0,
			retryingChunks: 0,
			warningDetails: [],
		}
	}

	private resetResilienceStats(): void {
		this._resilienceStats = this.createEmptyResilienceStats()
	}

	private resetDetailedProgressFields(options?: {
		phase?: IndexingPhase
		detailedStage?: IndexingDetailedStage
	}): void {
		this._phase = options?.phase
		this._detailedStage = options?.detailedStage
		this._totalFiles = 0
		this._processedFiles = 0
		this._filesParsed = 0
		this._totalBlocks = 0
		this._blocksEmbedded = 0
		this._changedFiles = 0
		this._unchangedFiles = 0
		this._oversizedFiles = 0
		this._oversizedDetails = []
		this._missingFiles = 0
		this._startingBlockCount = 0
		this._isEstimatedTotal = false
		this._embedStartedAt = 0
		this._estimatedTimeRemainingMs = null
		this._lastFilesParsedChangeTime = 0
		this._estimationConfidence = undefined
		this._isBackpressured = false
		this._hasKnownVectorWork = false
		this._hasStartedVectorSync = false
		this._isBackgroundReconcile = false
		this._interruptionKind = "none"
		this._resumeContext = "none"
		this._embeddingRuntimeKind = "unknown"
		this._recentChunkDensitySamples = []
		this._recentThroughputSamples = []
		this._lastThroughputSampleAt = 0
		this._lastThroughputBlocksEmbedded = 0
	}

	private applyResilienceStats(stats?: Partial<IndexingResilienceStats>): void {
		if (!stats) {
			return
		}
		this._resilienceStats = {
			...this._resilienceStats,
			...stats,
		}
	}

	/**
	 * Calculates ETA using block-level throughput.
	 *
	 * On resume, _startingBlockCount represents pre-existing blocks from Qdrant.
	 * ETA uses only _blocksEmbedded (new work this session) for throughput,
	 * then estimates time for remaining = extrapolatedTotal - startingBlockCount - blocksEmbedded.
	 *
	 * Uses _getExtrapolatedTotal() to project the true workspace total when
	 * parsing is incomplete, preventing grossly optimistic ETAs.
	 */
	private _updateEta(): void {
		const elapsed = Date.now() - this._embedStartedAt
		if (elapsed <= 0 || this._totalBlocks <= 0 || this._blocksEmbedded <= 0) {
			this._estimatedTimeRemainingMs = null
			return
		}

		const extrapolatedTotal = this._getExtrapolatedTotal()
		const effectiveEmbedded = this._startingBlockCount + this._blocksEmbedded
		const progress = effectiveEmbedded / extrapolatedTotal

		if (progress < CodeIndexStateManager.MIN_PROGRESS_FOR_ETA) {
			this._estimatedTimeRemainingMs = null
			return
		}

		// Throughput based on THIS session's work only (not pre-existing blocks)
		const now = Date.now()
		const deltaElapsed = Math.max(now - this._lastThroughputSampleAt, 1)
		const deltaBlocks = Math.max(0, this._blocksEmbedded - this._lastThroughputBlocksEmbedded)
		if (deltaBlocks > 0) {
			this._pushRecentSample(
				this._recentThroughputSamples,
				deltaBlocks / deltaElapsed,
				CodeIndexStateManager.MAX_RECENT_THROUGHPUT_SAMPLES,
			)
			this._lastThroughputSampleAt = now
			this._lastThroughputBlocksEmbedded = this._blocksEmbedded
		}
		const fallbackBlocksPerMs = this._blocksEmbedded / elapsed
		const smoothedBlocksPerMs = this._getSmoothedThroughput(fallbackBlocksPerMs)
		// Remaining blocks to embed this session (using extrapolated total)
		const remainingBlocks = Math.max(0, extrapolatedTotal - effectiveEmbedded)
		const rawEtaMs = smoothedBlocksPerMs > 0 ? Math.max(0, Math.round(remainingBlocks / smoothedBlocksPerMs)) : null
		this._estimatedTimeRemainingMs = rawEtaMs !== null ? this._smoothEta(rawEtaMs) : null
		this._estimationConfidence = this._getEmbeddingConfidence(progress)
	}

	private _getSmoothedThroughput(fallbackBlocksPerMs: number): number {
		if (this._recentThroughputSamples.length === 0) {
			return fallbackBlocksPerMs
		}

		const weightedAverage =
			this._recentThroughputSamples.reduce((sum, sample, index, samples) => {
				const weight = index + 1
				return sum + sample * weight
			}, 0) / this._recentThroughputSamples.reduce((sum, _sample, index) => sum + index + 1, 0)

		return weightedAverage > 0 ? weightedAverage : fallbackBlocksPerMs
	}

	private _smoothEta(rawEtaMs: number): number {
		if (this._estimatedTimeRemainingMs == null) {
			return rawEtaMs
		}

		const variance = this._getRelativeVariance(this._recentThroughputSamples)
		let alpha =
			this._embeddingRuntimeKind === "local" ? 0.45 : this._embeddingRuntimeKind === "remote" ? 0.25 : 0.35
		if (variance > 0.6) {
			alpha *= 0.4
		} else if (variance > 0.35) {
			alpha *= 0.6
		}
		if (this._isBackpressured) {
			alpha *= 0.5
		}

		return Math.round(this._estimatedTimeRemainingMs * (1 - alpha) + rawEtaMs * alpha)
	}

	private _getEmbeddingConfidence(progress: number): EstimationConfidence {
		const throughputSampleCount = this._recentThroughputSamples.length
		const variance = this._getRelativeVariance(this._recentThroughputSamples)
		const parseCoverage = this._totalFiles > 0 ? this._filesParsed / this._totalFiles : progress
		const estimateCoverage = this._isEstimatedTotal ? Math.max(progress, parseCoverage) : progress
		const hasStableHighSignal = throughputSampleCount >= 4 && variance < 0.35
		const hasStableMediumSignal = throughputSampleCount >= 3 && variance < 0.75

		if (!this._isEstimatedTotal && progress >= 0.5) {
			return "high"
		}

		// Backpressure means parsing is temporarily waiting on the embed queue, not that the
		// estimate is inherently bad. Keep the separate "waiting" hint, but allow confidence
		// to rise to medium once we've seen enough stable throughput and enough of the corpus.
		if (this._isBackpressured) {
			if (estimateCoverage >= 0.5 && hasStableHighSignal) {
				return "medium"
			}
			return "low"
		}

		if (this._isEstimatedTotal) {
			if (estimateCoverage >= 0.75 && hasStableHighSignal) {
				return "high"
			}
			if (estimateCoverage >= 0.2 && hasStableMediumSignal) {
				return "medium"
			}
			return "low"
		}

		if (estimateCoverage >= 0.4 && hasStableHighSignal) {
			return "high"
		}
		if (estimateCoverage >= 0.15 && hasStableMediumSignal) {
			return "medium"
		}
		return "low"
	}

	private _getRelativeVariance(samples: number[]): number {
		if (samples.length < 2) {
			return 0
		}
		const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
		if (mean <= 0) {
			return 0
		}
		const variance = samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) / samples.length
		return Math.sqrt(variance) / mean
	}

	private _pushRecentSample(samples: number[], value: number, maxSize: number): void {
		samples.push(value)
		if (samples.length > maxSize) {
			samples.shift()
		}
	}

	// --- Legacy methods (used by file watcher) ---

	public reportBlockIndexingProgress(
		processedItems: number,
		totalItems: number,
		options?: { skippedFiles?: number; totalFiles?: number },
	): void {
		const progressChanged = processedItems !== this._processedItems || totalItems !== this._totalItems

		// Don't override Stopping state with progress updates
		if (this._systemStatus === "Stopping") return
		// Update if progress changes OR if the system wasn't already in 'Indexing' state
		if (progressChanged || this._systemStatus !== "Indexing") {
			this._processedItems = processedItems
			this._totalItems = totalItems
			this._currentItemUnit = "blocks"

			// Build context suffix showing file-level info
			const parts: string[] = []
			if (options?.totalFiles && options.totalFiles > 0) {
				parts.push(`${options.totalFiles.toLocaleString()} files`)
			}
			if (options?.skippedFiles && options.skippedFiles > 0) {
				parts.push(`${options.skippedFiles.toLocaleString()} unchanged`)
			}
			const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : ""
			const message = `Indexed ${this._processedItems.toLocaleString()} / ${this._totalItems.toLocaleString()} blocks found${suffix}`
			const oldStatus = this._systemStatus
			const oldMessage = this._statusMessage

			this._systemStatus = "Indexing" // Ensure state is Indexing
			this._statusMessage = message

			// Only fire update if status, message or progress actually changed
			if (oldStatus !== this._systemStatus || oldMessage !== this._statusMessage || progressChanged) {
				this._progressEmitter.fire(this.getCurrentStatus())
			}
		}
	}

	public reportFileQueueProgress(processedFiles: number, totalFiles: number, currentFileBasename?: string): void {
		const progressChanged = processedFiles !== this._processedItems || totalFiles !== this._totalItems

		// Don't override Stopping state with progress updates
		if (this._systemStatus === "Stopping") return
		if (progressChanged || this._systemStatus !== "Indexing") {
			this._processedItems = processedFiles
			this._totalItems = totalFiles
			this._currentItemUnit = "files"
			this._systemStatus = "Indexing"

			let message: string
			if (totalFiles > 0 && processedFiles < totalFiles) {
				message = `Updating index: ${processedFiles} / ${totalFiles} files${
					currentFileBasename ? ` — ${currentFileBasename}` : ""
				}`
			} else if (totalFiles > 0 && processedFiles === totalFiles) {
				message = `Finished processing ${totalFiles} files from queue.`
			} else {
				message = `File queue processed.`
			}

			const oldStatus = this._systemStatus
			const oldMessage = this._statusMessage

			this._statusMessage = message

			if (oldStatus !== this._systemStatus || oldMessage !== this._statusMessage || progressChanged) {
				this._progressEmitter.fire(this.getCurrentStatus())
			}
		}
	}

	public dispose(): void {
		this._progressEmitter.dispose()
	}
}
