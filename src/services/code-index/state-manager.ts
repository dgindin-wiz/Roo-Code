import * as vscode from "vscode"
import type {
	IndexingCodebaseProgressSnapshot,
	IndexingHealthState,
	IndexingPipelineOverallState,
	IndexingPipelineRunMode,
	IndexingPipelineSnapshot,
	IndexingRunSummarySnapshot,
	IndexingRuntimeSnapshot,
	IndexingServiceId,
	IndexingServiceSnapshot,
} from "@roo-code/types"
import { IndexDebugLogger } from "./debug-logger"
import { IndexDebugLoggerV2 } from "../code-index-v2/logging/IndexDebugLoggerV2"

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

type PipelineSnapshotPatch = Partial<Omit<IndexingPipelineSnapshot, "services">> & {
	services?: IndexingServiceSnapshot[]
}

const PIPELINE_SERVICE_ORDER: IndexingServiceId[] = [
	"discovery",
	"file_checks",
	"parse",
	"plan",
	"embedding",
	"vector_sync",
	"cleanup",
]

const LEGACY_PIPELINE_SERVICE_ORDER: IndexingServiceId[] = [
	"discovery",
	"file_checks",
	"parse",
	"plan",
	"embed",
	"cleanup",
]

const RUN_SUMMARY_PRIMARY_SERVICE_ORDER: IndexingServiceId[] = [
	"embedding",
	"vector_sync",
	"embed",
	"cleanup",
	"plan",
	"parse",
	"file_checks",
	"discovery",
]

const PIPELINE_SERVICE_TITLES: Record<IndexingServiceId, string> = {
	discovery: "Discovery",
	file_checks: "File checks",
	parse: "Parse",
	plan: "Plan",
	embedding: "Embedding",
	vector_sync: "Vector sync",
	embed: "Embed",
	cleanup: "Cleanup",
}

/**
 * Formats milliseconds into a human-readable ETA string.
 */
export function formatEta(ms: number): string {
	if (ms < 10_000) return "<10 sec remaining"
	if (ms < 60_000) return `~${Math.round(ms / 1000)} sec remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes} min remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours} hr remaining`
	return `~${hours} hr ${remainingMinutes} min remaining`
}

function formatDurationCompact(ms: number | null | undefined): string | undefined {
	if (ms == null || ms <= 0) {
		return undefined
	}
	if (ms < 60_000) {
		return `${Math.max(1, Math.round(ms / 1000))} sec`
	}
	const minutes = Math.floor(ms / 60_000)
	const remainingSeconds = Math.round((ms % 60_000) / 1000)
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes} min ${remainingSeconds} sec` : `${minutes} min`
	}
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return remainingMinutes > 0 ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`
}

export class CodeIndexStateManager {
	private _loggerEngine: "legacy" | "v2" = "legacy"
	private _loggerWorkspacePath: string | undefined
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
	private static readonly FOREGROUND_NUMERIC_UPDATE_THROTTLE_MS = 500
	private static readonly BACKGROUND_NUMERIC_UPDATE_THROTTLE_MS = 2_000
	private _activePipelineSnapshot?: IndexingPipelineSnapshot
	private _lastCompletedPipelineSnapshot?: IndexingPipelineSnapshot
	private _lastProgressEmitAt = 0
	private _lastSemanticSignature = ""
	private _pendingProgressEmitTimer: ReturnType<typeof setTimeout> | undefined

	// --- Public API ---

	public readonly onProgressUpdate = this._progressEmitter.event

	public get state(): IndexingState {
		return this._systemStatus
	}

	public setLoggerContext(engine: "legacy" | "v2", workspacePath?: string): void {
		this._loggerEngine = engine
		this._loggerWorkspacePath = workspacePath
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
			pipeline: this.getPipelineSnapshotForStatus(),
		}
	}

	public beginPipelineRun(runMode: IndexingPipelineRunMode): void {
		this._activePipelineSnapshot = {
			overallState: "running",
			overallHealth: "unknown",
			runMode,
			etaMs: null,
			services: PIPELINE_SERVICE_ORDER.map((serviceId) => this.createDefaultServiceSnapshot(serviceId)),
		}
		this._lastCompletedPipelineSnapshot = undefined
		this.emitProgressUpdate({ forceImmediate: true })
	}

	public setPipelineSnapshot(snapshot: PipelineSnapshotPatch, options?: { forceImmediate?: boolean }): void {
		const baseSnapshot = this._activePipelineSnapshot ?? {
			overallState: "running" as IndexingPipelineOverallState,
			overallHealth: "unknown" as IndexingHealthState,
			runMode: "unknown" as IndexingPipelineRunMode,
			etaMs: null,
			services: PIPELINE_SERVICE_ORDER.map((serviceId) => this.createDefaultServiceSnapshot(serviceId)),
		}
		const merged: IndexingPipelineSnapshot = {
			...baseSnapshot,
			...snapshot,
			services: this.normalizePipelineServices(snapshot.services ?? baseSnapshot.services),
		}
		merged.etaMs = snapshot.etaMs ?? this._estimatedTimeRemainingMs ?? null
		merged.overallHealth = this.getPipelineOverallHealth(merged.services)
		this._activePipelineSnapshot = merged
		this.emitProgressUpdate({ forceImmediate: options?.forceImmediate })
	}

	public setPipelineRuntimeSnapshot(runtime: IndexingRuntimeSnapshot): void {
		if (this._activePipelineSnapshot) {
			this._activePipelineSnapshot = {
				...this._activePipelineSnapshot,
				runtime,
			}
			this.emitProgressUpdate()
			return
		}
		if (this._lastCompletedPipelineSnapshot) {
			this._lastCompletedPipelineSnapshot = {
				...this._lastCompletedPipelineSnapshot,
				runtime,
			}
			this.emitProgressUpdate()
		}
	}

	public preserveCompletedPipelineSnapshot(): void {
		if (!this._activePipelineSnapshot) {
			return
		}
		const preservedSnapshot: IndexingPipelineSnapshot = {
			...this._activePipelineSnapshot,
			overallState: "completed",
			overallHealth: this.getPipelineOverallHealth(this._activePipelineSnapshot.services),
			etaMs: null,
			lastCompletedAt: Date.now(),
			preservedFromPreviousRun: false,
			services: this.normalizePipelineServices(this._activePipelineSnapshot.services).map((service) =>
				service.state === "pending" ? { ...service, state: "skipped", summary: "No work required" } : service,
			),
		}
		this._lastCompletedPipelineSnapshot = preservedSnapshot
		this._activePipelineSnapshot = undefined
		this.emitProgressUpdate({ forceImmediate: true })
	}

	public setStandbyPipelineSnapshot(snapshot: IndexingPipelineSnapshot, message = "Code index is ready."): void {
		const services: IndexingServiceSnapshot[] = this.normalizePipelineServices(snapshot.services).map((service) =>
			service.state === "pending"
				? { ...service, state: "skipped" as const, summary: "No work required" }
				: service,
		)
		const standbyOverallState: IndexingPipelineOverallState =
			snapshot.overallState === "running" ? "idle" : snapshot.overallState
		const preservedSnapshot = this.decoratePipelineSnapshot({
			...snapshot,
			overallState: standbyOverallState,
			overallHealth: standbyOverallState === "failed" ? "critical" : this.getPipelineOverallHealth(services),
			etaMs: null,
			lastCompletedAt: standbyOverallState === "completed" ? snapshot.lastCompletedAt : undefined,
			preservedFromPreviousRun: true,
			services,
		})

		this._systemStatus = "Standby"
		this._statusMessage = message
		this._processedItems = 0
		this._totalItems = 0
		this._currentItemUnit = "blocks"
		this._activityDetail = ""
		this._activePipelineSnapshot = undefined
		this._lastCompletedPipelineSnapshot = preservedSnapshot
		this.resetDetailedProgressFields()
		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("setStandbyPipelineSnapshot", {
			phaseTransition: true,
			message: message.substring(0, 120),
			overallHealth: preservedSnapshot.overallHealth,
			runMode: preservedSnapshot.runMode,
		})
	}

	public setPipelineTerminalState(overallState: "failed" | "stopped"): void {
		if (!this._activePipelineSnapshot) {
			return
		}
		this._activePipelineSnapshot = {
			...this._activePipelineSnapshot,
			overallState,
			overallHealth:
				overallState === "failed"
					? "critical"
					: this.getPipelineOverallHealth(this._activePipelineSnapshot.services),
			etaMs: null,
		}
		this.emitProgressUpdate({ forceImmediate: true })
	}

	public clearPipelineSnapshots(): void {
		this._activePipelineSnapshot = undefined
		this._lastCompletedPipelineSnapshot = undefined
		this.emitProgressUpdate({ forceImmediate: true })
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
				if (newState === "Error" && this._activePipelineSnapshot) {
					this._activePipelineSnapshot = {
						...this._activePipelineSnapshot,
						overallState: "failed",
						overallHealth: "critical",
						etaMs: null,
					}
				}
				// Reset two-phase fields
				if (newState !== "Stopping") {
					this.resetDetailedProgressFields({
						phase: newState === "Indexed" ? "complete" : undefined,
						detailedStage: newState === "Indexed" ? "complete" : undefined,
					})
				}
			}

			this.emitProgressUpdate({ forceImmediate: true })
			this.logDebug("setSystemState", {
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
		this._activePipelineSnapshot = undefined
		this._lastCompletedPipelineSnapshot = undefined

		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("resetIndexingState", {
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
		this._activePipelineSnapshot = undefined
		this._lastCompletedPipelineSnapshot = undefined
	}

	public setRecoveryContext(
		interruptionKind: IndexingInterruptionKind = "none",
		resumeContext: IndexingResumeContext = "none",
	): void {
		this._interruptionKind = interruptionKind
		this._resumeContext = resumeContext
		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("setRecoveryContext", {
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

		this.emitProgressUpdate()
		this.logDebug("reportScanProgress", { scannedFiles, totalFiles })
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

		this.emitProgressUpdate()
		this.logDebug("startEmbedPhase", {
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
			if (this._loggerEngine === "legacy") {
				IndexDebugLogger.logSuppressed("StateManager", "reportEmbedProgress", {
					blocksEmbedded,
					revisedTotal,
					filesParsed,
					storedBlocks: this._blocksEmbedded,
					storedTotal: this._totalBlocks,
					storedFiles: this._filesParsed,
				})
			}
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
			this.logDebug("auto-revise-total", {
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

		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("reportEmbedProgress", {
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
		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("reportComplete", { phaseTransition: true, totalBlocks, totalFiles })
	}

	public setResilienceStats(stats: Partial<IndexingResilienceStats>): void {
		this.applyResilienceStats(stats)
		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("setResilienceStats", {
			...this._resilienceStats,
		})
	}

	public setOversizedDetails(details: OversizedDetail[]): void {
		this._oversizedDetails = details
		this.emitProgressUpdate({ forceImmediate: true })
		this.logDebug("setOversizedDetails", {
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

		this.emitProgressUpdate()
		this.logDebug("reportCustomProgress", {
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
		this.emitProgressUpdate()
		this.logDebug("reportHeartbeat", {
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
			this.emitProgressUpdate()
		}
		this.logDebug("setActivityDetail", {
			detail: detail.substring(0, 120),
			phase: this._phase,
			detailedStage: this._detailedStage,
		})
	}

	private getPipelineSnapshotForStatus(): IndexingPipelineSnapshot | undefined {
		if (this._activePipelineSnapshot) {
			return this.decoratePipelineSnapshot({
				...this._activePipelineSnapshot,
				etaMs: this._activePipelineSnapshot.etaMs ?? this._estimatedTimeRemainingMs ?? null,
				services: this.normalizePipelineServices(this._activePipelineSnapshot.services),
			})
		}

		if (this._lastCompletedPipelineSnapshot) {
			return this.decoratePipelineSnapshot({
				...this._lastCompletedPipelineSnapshot,
				preservedFromPreviousRun: true,
				services: this.normalizePipelineServices(this._lastCompletedPipelineSnapshot.services),
			})
		}

		return this.synthesizePipelineSnapshot()
	}

	private synthesizePipelineSnapshot(): IndexingPipelineSnapshot | undefined {
		const shouldRenderPipeline =
			this._systemStatus === "Indexing" ||
			this._systemStatus === "Indexed" ||
			(this._systemStatus === "Standby" &&
				/^(?:V2 is current|Index up-to-date|Code Index V2 is ready to start)/.test(this._statusMessage))
		if (!shouldRenderPipeline) {
			return undefined
		}

		const activeStage = this._detailedStage
		const stageOrder: IndexingServiceId[] = ["discovery", "file_checks", "parse", "plan", "embed", "cleanup"]
		const activeServiceId: IndexingServiceId | undefined =
			activeStage === "discovering"
				? "discovery"
				: activeStage === "hashing_initial" || activeStage === "comparing_signatures"
					? "file_checks"
					: activeStage === "parsing"
						? "parse"
						: activeStage === "planning_vectors"
							? "plan"
							: activeStage === "embedding"
								? "embed"
								: activeStage === "deleting_vectors"
									? "cleanup"
									: undefined
		const activeIndex = activeServiceId ? stageOrder.indexOf(activeServiceId) : -1

		const services: IndexingServiceSnapshot[] = stageOrder.map((serviceId, index) => {
			const base = this.createDefaultServiceSnapshot(serviceId)
			const isPast = activeIndex >= 0 && index < activeIndex
			const isCurrent = serviceId === activeServiceId
			const isAfter = activeIndex >= 0 && index > activeIndex
			let state = base.state
			if (this._systemStatus === "Indexed") {
				state = "completed"
			} else if (isCurrent) {
				state = "running"
			} else if (isPast) {
				state = "completed"
			} else if (isAfter) {
				state = "pending"
			}

			if (serviceId === "embed" && this._systemStatus === "Indexing" && this._phase === "embedding") {
				state = "running"
			}

			const summary =
				serviceId === activeServiceId && this._statusMessage
					? (this._statusMessage.split("\n")[0] ?? base.summary)
					: state === "completed"
						? "Completed"
						: state === "pending"
							? "Waiting to start"
							: base.summary

			return {
				...base,
				state,
				health: (isCurrent ? "healthy" : state === "completed" ? "healthy" : "unknown") as IndexingHealthState,
				summary,
			}
		})

		return this.decoratePipelineSnapshot({
			overallState:
				this._systemStatus === "Indexed"
					? "completed"
					: this._systemStatus === "Error"
						? "failed"
						: this._systemStatus === "Stopping"
							? "stopped"
							: this._systemStatus === "Indexing"
								? "running"
								: "idle",
			overallHealth:
				this._systemStatus === "Error" ? "critical" : this._systemStatus === "Indexing" ? "healthy" : "unknown",
			runMode: this._isBackgroundReconcile ? "reconcile" : "unknown",
			etaMs: this._estimatedTimeRemainingMs,
			services,
			preservedFromPreviousRun: this._systemStatus !== "Indexing",
		})
	}

	private createDefaultServiceSnapshot(serviceId: IndexingServiceId): IndexingServiceSnapshot {
		return {
			id: serviceId,
			title: PIPELINE_SERVICE_TITLES[serviceId],
			state: "pending",
			health: "unknown",
			summary: "Waiting to start",
			progressPercent: null,
			metrics: [],
		}
	}

	private normalizePipelineServices(services: IndexingServiceSnapshot[]): IndexingServiceSnapshot[] {
		const byId = new Map(services.map((service) => [service.id, service]))
		const serviceOrder =
			byId.has("embedding") || byId.has("vector_sync") || !byId.has("embed")
				? PIPELINE_SERVICE_ORDER
				: LEGACY_PIPELINE_SERVICE_ORDER
		return serviceOrder.map((serviceId) => {
			const current = byId.get(serviceId)
			if (!current) {
				return this.createDefaultServiceSnapshot(serviceId)
			}
			return {
				...this.createDefaultServiceSnapshot(serviceId),
				...current,
				title: current.title || PIPELINE_SERVICE_TITLES[serviceId],
				metrics: current.metrics ?? [],
			}
		})
	}

	private decoratePipelineSnapshot(snapshot: IndexingPipelineSnapshot): IndexingPipelineSnapshot {
		const normalizedServices = this.normalizePipelineServices(snapshot.services)
		const decoratedSnapshot: IndexingPipelineSnapshot = {
			...snapshot,
			services: normalizedServices,
		}
		decoratedSnapshot.summary = snapshot.summary ?? this.buildRunSummarySnapshot(decoratedSnapshot)
		return decoratedSnapshot
	}

	private buildRunSummarySnapshot(snapshot: IndexingPipelineSnapshot): IndexingRunSummarySnapshot {
		if (snapshot.overallState === "completed") {
			return this.buildCompletedRunSummarySnapshot(snapshot)
		}

		if (snapshot.overallState === "failed") {
			return {
				headline: "Indexing failed",
				secondaryLabel: "Review the service panels for the failing step.",
				indeterminate: true,
			}
		}

		if (snapshot.overallState === "stopped") {
			return {
				headline: "Indexing stopped",
				secondaryLabel: "You can restart indexing at any time.",
				indeterminate: true,
			}
		}

		const primaryService = this.selectRunSummaryPrimaryService(snapshot.services)
		if (!primaryService) {
			return {
				headline: this._systemStatus === "Indexing" ? "Preparing workspace index" : "Index ready",
				secondaryLabel: this._systemStatus === "Indexing" ? "Initializing indexing services." : undefined,
				indeterminate: true,
			}
		}

		const progressLabel = this.buildRunSummaryProgressLabel(snapshot, primaryService)
		const secondaryLabel =
			this.getRunSummaryBlockingReason(snapshot, primaryService) ??
			this.getRunSummaryOverlapNote(snapshot.services, primaryService) ??
			this.getRunSummaryFallbackDetail(primaryService)

		return {
			primaryServiceId: primaryService.id,
			headline: this.getRunSummaryHeadline(primaryService.id),
			progressLabel,
			secondaryLabel,
			recoveredProgressLabel: this.buildRecoveredProgressLabel(snapshot),
			elapsedLabel: this.buildElapsedSummaryLabel(snapshot, false),
			etaLabel: snapshot.etaMs != null ? formatEta(snapshot.etaMs) : undefined,
			progressCurrent: primaryService.progressCurrent,
			progressTotal: primaryService.progressTotal,
			progressUnit: primaryService.progressUnit,
			progressPercent: primaryService.progressPercent ?? null,
			elapsedMs: snapshot.elapsedMs ?? null,
			recoveredElapsedMs: snapshot.recoveredElapsedMs ?? null,
			investedElapsedMs: snapshot.investedElapsedMs ?? snapshot.elapsedMs ?? null,
			phaseTimingMs: snapshot.phaseTimingMs,
			codebaseProgress: snapshot.codebaseProgress,
			indeterminate: primaryService.indeterminate,
		}
	}

	private buildCompletedRunSummarySnapshot(snapshot: IndexingPipelineSnapshot): IndexingRunSummarySnapshot {
		const progressLabel = this.buildCompletedProgressLabel(snapshot)
		const warningCount = snapshot.services.filter(
			(service) => service.state === "warning" || service.state === "failed",
		).length
		const totalTimeMs = snapshot.investedElapsedMs ?? snapshot.elapsedMs ?? null

		return {
			primaryServiceId:
				this.getPipelineServiceById(snapshot.services, "vector_sync")?.id ??
				this.getPipelineServiceById(snapshot.services, "embedding")?.id ??
				this.getPipelineServiceById(snapshot.services, "embed")?.id,
			headline: snapshot.preservedFromPreviousRun ? "Index ready" : "Indexing complete",
			progressLabel,
			secondaryLabel:
				warningCount > 0 ? "Completed with warnings. Review the service panels for details." : undefined,
			recoveredProgressLabel: this.buildRecoveredProgressLabel(snapshot),
			elapsedLabel: this.buildElapsedSummaryLabel(snapshot, true),
			progressPercent: 100,
			elapsedMs: snapshot.elapsedMs ?? null,
			recoveredElapsedMs: snapshot.recoveredElapsedMs ?? null,
			investedElapsedMs: snapshot.investedElapsedMs ?? snapshot.elapsedMs ?? null,
			totalTimeMs,
			phaseTimingMs: snapshot.phaseTimingMs,
			codebaseProgress: snapshot.codebaseProgress,
			indeterminate: false,
		}
	}

	private buildCompletedProgressLabel(snapshot: IndexingPipelineSnapshot): string {
		const codebaseProgress = snapshot.codebaseProgress
		const progressParts: string[] = []
		const fileProgressLabel = this.formatCodebaseFilesProgress(codebaseProgress)
		if (fileProgressLabel) {
			progressParts.push(fileProgressLabel)
		}
		const chunkProgressLabel = this.formatCodebaseChunksProgress(codebaseProgress)
		if (chunkProgressLabel) {
			progressParts.push(chunkProgressLabel)
		}
		if (progressParts.length > 0) {
			return progressParts.join(" • ")
		}

		const fileCount =
			this.getPipelineServiceById(snapshot.services, "file_checks")?.progressTotal ??
			this.getPipelineServiceById(snapshot.services, "discovery")?.progressTotal ??
			0
		const syncedChunks =
			this.getPipelineServiceById(snapshot.services, "vector_sync")?.progressCurrent ??
			this.getPipelineServiceById(snapshot.services, "embedding")?.progressCurrent ??
			this.getPipelineServiceById(snapshot.services, "embed")?.progressCurrent ??
			this.getPipelineServiceById(snapshot.services, "cleanup")?.progressCurrent ??
			0
		const fallbackParts: string[] = []
		if (fileCount > 0) {
			fallbackParts.push(`${fileCount.toLocaleString()} files`)
		}
		if (syncedChunks > 0) {
			fallbackParts.push(`${syncedChunks.toLocaleString()} chunks synced`)
		}
		return fallbackParts.join(" • ") || "Last run available"
	}

	private formatCodebaseFilesProgress(progress?: IndexingCodebaseProgressSnapshot): string | undefined {
		const indexedFiles = progress?.indexedFiles ?? 0
		const totalFiles = progress?.totalFiles ?? 0
		if (indexedFiles <= 0 && totalFiles <= 0) {
			return undefined
		}
		if (progress?.fileTotalKind === "available" || totalFiles <= 0) {
			return `${indexedFiles.toLocaleString()} files indexed`
		}
		const totalLabel =
			progress?.fileTotalKind === "estimated"
				? `~${Math.max(totalFiles, indexedFiles, 0).toLocaleString()}`
				: Math.max(totalFiles, indexedFiles, 0).toLocaleString()
		return `${indexedFiles.toLocaleString()} / ${totalLabel} files indexed`
	}

	private formatCodebaseChunksProgress(progress?: IndexingCodebaseProgressSnapshot): string | undefined {
		const syncedChunks = progress?.syncedChunks ?? 0
		const knownTotalChunks = progress?.knownTotalChunks ?? 0
		if (syncedChunks <= 0 && knownTotalChunks <= 0) {
			return undefined
		}
		if (progress?.chunkTotalKind === "available" || knownTotalChunks <= 0) {
			return `${syncedChunks.toLocaleString()} chunks available`
		}
		const totalLabel =
			progress?.chunkTotalKind === "estimated"
				? `~${Math.max(knownTotalChunks, syncedChunks, 0).toLocaleString()}`
				: Math.max(knownTotalChunks, syncedChunks, 0).toLocaleString()
		return `${syncedChunks.toLocaleString()} / ${totalLabel} chunks synced`
	}

	private buildRecoveredProgressLabel(snapshot: IndexingPipelineSnapshot): string | undefined {
		if (snapshot.runMode !== "resume") {
			return undefined
		}
		const baselineFiles = snapshot.baselineIndexedFiles ?? 0
		const baselineChunks = snapshot.baselineSyncedChunks ?? snapshot.baselineIndexedChunks ?? 0
		if (baselineFiles <= 0 && baselineChunks <= 0) {
			return undefined
		}
		const parts: string[] = []
		if (baselineFiles > 0) {
			parts.push(`${baselineFiles.toLocaleString()} indexed files`)
		}
		if (baselineChunks > 0) {
			parts.push(`${baselineChunks.toLocaleString()} synced chunks`)
		}
		return parts.length > 0 ? `Recovered progress: ${parts.join(" • ")} already available` : undefined
	}

	private buildElapsedSummaryLabel(snapshot: IndexingPipelineSnapshot, completed: boolean): string | undefined {
		const primaryElapsedMs =
			snapshot.runMode === "resume"
				? (snapshot.investedElapsedMs ?? snapshot.elapsedMs ?? null)
				: (snapshot.elapsedMs ?? null)
		const formatted = formatDurationCompact(primaryElapsedMs)
		if (!formatted) {
			return undefined
		}
		return completed ? `Total time ${formatted}` : `Elapsed ${formatted}`
	}

	private selectRunSummaryPrimaryService(services: IndexingServiceSnapshot[]): IndexingServiceSnapshot | undefined {
		for (const serviceId of RUN_SUMMARY_PRIMARY_SERVICE_ORDER) {
			const service = this.getPipelineServiceById(services, serviceId)
			if (!service) {
				continue
			}
			if (service.state === "running" || service.state === "warning" || service.state === "failed") {
				return service
			}
		}
		return undefined
	}

	private getPipelineServiceById(
		services: IndexingServiceSnapshot[],
		serviceId: IndexingServiceId,
	): IndexingServiceSnapshot | undefined {
		return services.find((service) => service.id === serviceId)
	}

	private getRunSummaryHeadline(serviceId: IndexingServiceId): string {
		switch (serviceId) {
			case "discovery":
				return "Discovering workspace files"
			case "file_checks":
				return "Checking for changed files"
			case "parse":
				return "Preparing changed files for indexing"
			case "plan":
				return "Preparing vector workload"
			case "embedding":
			case "vector_sync":
			case "embed":
				return "Building embeddings and syncing vectors"
			case "cleanup":
				return "Removing stale vectors"
		}
	}

	private buildRunSummaryProgressLabel(
		snapshot: IndexingPipelineSnapshot,
		service: IndexingServiceSnapshot,
	): string | undefined {
		const current = service.progressCurrent ?? 0
		const total = service.progressTotal ?? current
		const vectorSyncService =
			this.getPipelineServiceById(snapshot.services, "vector_sync") ??
			this.getPipelineServiceById(snapshot.services, "embed")
		const vectorSyncCurrent = vectorSyncService?.progressCurrent ?? current
		const vectorSyncTotal = vectorSyncService?.progressTotal ?? total

		switch (service.id) {
			case "discovery":
				return `Discovered ${Math.max(current, total, 0).toLocaleString()} files`
			case "file_checks":
				return `Checked ${current.toLocaleString()} of ${Math.max(total, current, 1).toLocaleString()} files`
			case "parse":
				return `Parsed ${current.toLocaleString()} of ${Math.max(total, current, 1).toLocaleString()} changed files`
			case "plan":
				return `Prepared ${current.toLocaleString()} of ${Math.max(total, current, 1).toLocaleString()} changed files`
			case "embedding":
			case "vector_sync":
			case "embed":
				if (vectorSyncService?.indeterminate || vectorSyncService?.progressTotal == null) {
					return `${vectorSyncCurrent.toLocaleString()} chunks synced`
				}
				return `Synced ${vectorSyncCurrent.toLocaleString()} of ${Math.max(
					vectorSyncTotal,
					vectorSyncCurrent,
					1,
				).toLocaleString()} chunks`
			case "cleanup":
				return `Removed ${current.toLocaleString()} of ${Math.max(total, current, 1).toLocaleString()} stale vectors`
		}
	}

	private getRunSummaryBlockingReason(
		snapshot: IndexingPipelineSnapshot,
		primaryService: IndexingServiceSnapshot,
	): string | undefined {
		const planService = this.getPipelineServiceById(snapshot.services, "plan")
		const candidateDetails = [primaryService.detail, planService?.detail]
		for (const detail of candidateDetails) {
			const humanized = this.humanizeRunSummaryBlockingReason(detail)
			if (humanized) {
				return humanized
			}
		}
		return undefined
	}

	private humanizeRunSummaryBlockingReason(detail?: string): string | undefined {
		if (!detail) {
			return undefined
		}
		if (this.isHumanizedBlockingReason(detail)) {
			return detail
		}

		const normalized = detail.trim()
		switch (normalized) {
			case "parse_throttled:parsed_revisions_waiting_for_planning":
				return "Parsing is temporarily throttled while the planner catches up."
			case "parsed_revisions_waiting_for_planning":
				return "Planner is catching up before more parsed files are handed off."
			case "staged_chunks_waiting_for_upsert":
				return "Waiting for queued vector sync work to drain."
			default:
				if (/^[a-z0-9_:-]+$/i.test(normalized)) {
					return `Waiting on ${normalized.replace(/^parse_throttled:/, "").replace(/[_:]+/g, " ")}.`
				}
				return undefined
		}
	}

	private isHumanizedBlockingReason(detail?: string): boolean {
		if (!detail) {
			return false
		}
		const normalized = detail.toLowerCase()
		return (
			normalized.includes("temporarily throttled") ||
			normalized.includes("planner catches up") ||
			normalized.includes("planner is catching up") ||
			normalized.includes("queued vector sync work") ||
			normalized.startsWith("waiting on ")
		)
	}

	private getRunSummaryOverlapNote(
		services: IndexingServiceSnapshot[],
		primaryService: IndexingServiceSnapshot,
	): string | undefined {
		const isActive = (serviceId: IndexingServiceId) => {
			const service = this.getPipelineServiceById(services, serviceId)
			return service?.state === "running" || service?.state === "warning" || service?.state === "failed"
		}

		if (primaryService.id === "embedding" || primaryService.id === "vector_sync" || primaryService.id === "embed") {
			if (isActive("plan")) {
				return "Also preparing queued chunks for sync."
			}
			if (isActive("parse")) {
				return "Also parsing changed files in the background."
			}
		}

		if (primaryService.id === "plan" && isActive("parse")) {
			return "Also parsing changed files in the background."
		}

		return undefined
	}

	private getRunSummaryFallbackDetail(service: IndexingServiceSnapshot): string | undefined {
		if (service.id === "discovery") {
			const estimateMetric = service.metrics.find((metric) => metric.key === "estimate")
			return estimateMetric ? `${estimateMetric.value} files estimated` : undefined
		}
		const blockingReason = this.humanizeRunSummaryBlockingReason(service.detail)
		if (blockingReason) {
			return blockingReason
		}
		if (service.detail && !/^[a-z0-9_:-]+$/i.test(service.detail.trim())) {
			return service.detail
		}
		return undefined
	}

	private getPipelineOverallHealth(services: IndexingServiceSnapshot[]): IndexingHealthState {
		if (services.some((service) => service.health === "critical" || service.state === "failed")) {
			return "critical"
		}
		if (services.some((service) => service.health === "watch" || service.state === "warning")) {
			return "watch"
		}
		if (services.some((service) => service.health === "healthy" || service.state === "running")) {
			return "healthy"
		}
		return "unknown"
	}

	private getSemanticSignature() {
		const pipeline = this.getPipelineSnapshotForStatus()
		return JSON.stringify({
			systemStatus: this._systemStatus,
			phase: this._phase,
			detailedStage: this._detailedStage,
			isBackgroundReconcile: this._isBackgroundReconcile,
			interruptionKind: this._interruptionKind,
			resumeContext: this._resumeContext,
			warnings: {
				oversized: this._oversizedFiles,
				retryingParse: this._resilienceStats.retryingParseRevisions,
				terminalFailedParse: this._resilienceStats.terminalFailedParseRevisions,
				degraded: this._resilienceStats.degradedRevisions,
				failed: this._resilienceStats.terminalFailedRevisions,
				failedChunks: this._resilienceStats.terminallyFailedChunks,
			},
			pipeline: pipeline && {
				overallState: pipeline.overallState,
				overallHealth: pipeline.overallHealth,
				runMode: pipeline.runMode,
				preservedFromPreviousRun: pipeline.preservedFromPreviousRun,
				elapsedSeconds: pipeline.elapsedMs != null ? Math.floor(Math.max(pipeline.elapsedMs, 0) / 1000) : null,
				recoveredElapsedSeconds:
					pipeline.recoveredElapsedMs != null
						? Math.floor(Math.max(pipeline.recoveredElapsedMs, 0) / 1000)
						: null,
				investedElapsedSeconds:
					pipeline.investedElapsedMs != null
						? Math.floor(Math.max(pipeline.investedElapsedMs, 0) / 1000)
						: null,
				codebaseProgress: pipeline.codebaseProgress
					? {
							indexedFiles: pipeline.codebaseProgress.indexedFiles ?? null,
							totalFiles: pipeline.codebaseProgress.totalFiles ?? null,
							fileTotalKind: pipeline.codebaseProgress.fileTotalKind ?? null,
							syncedChunks: pipeline.codebaseProgress.syncedChunks ?? null,
							knownTotalChunks: pipeline.codebaseProgress.knownTotalChunks ?? null,
							chunkTotalKind: pipeline.codebaseProgress.chunkTotalKind ?? null,
							historicalTombstonedFiles: pipeline.codebaseProgress.historicalTombstonedFiles ?? null,
						}
					: null,
				phaseTimingSeconds: pipeline.phaseTimingMs
					? {
							discovery:
								pipeline.phaseTimingMs.discoveryMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.discoveryMs, 0) / 1000)
									: null,
							fileChecks:
								pipeline.phaseTimingMs.fileChecksMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.fileChecksMs, 0) / 1000)
									: null,
							parse:
								pipeline.phaseTimingMs.parseMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.parseMs, 0) / 1000)
									: null,
							plan:
								pipeline.phaseTimingMs.planMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.planMs, 0) / 1000)
									: null,
							embedSync:
								pipeline.phaseTimingMs.embedSyncMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.embedSyncMs, 0) / 1000)
									: null,
							cleanup:
								pipeline.phaseTimingMs.cleanupMs != null
									? Math.floor(Math.max(pipeline.phaseTimingMs.cleanupMs, 0) / 1000)
									: null,
						}
					: null,
				summary: pipeline.summary && {
					primaryServiceId: pipeline.summary.primaryServiceId,
					headline: pipeline.summary.headline,
					progressLabel: pipeline.summary.progressLabel,
					secondaryLabel: pipeline.summary.secondaryLabel,
					recoveredProgressLabel: pipeline.summary.recoveredProgressLabel,
					elapsedLabel: pipeline.summary.elapsedLabel,
					etaLabel: pipeline.summary.etaLabel,
				},
				runtime: pipeline.runtime
					? {
							sidecars: pipeline.runtime.sidecars.map((sidecar) => ({
								id: sidecar.id,
								state: sidecar.state,
								health: sidecar.health,
								pendingRequestCount: sidecar.pendingRequestCount ?? 0,
								lastOperation: sidecar.lastOperation ?? null,
								lastElapsedMs:
									sidecar.lastElapsedMs != null
										? Math.floor(Math.max(sidecar.lastElapsedMs, 0) / 100)
										: null,
								lastError: sidecar.lastError ?? null,
								metrics: (sidecar.metrics ?? []).map((metric) => ({
									key: metric.key,
									value: metric.value,
									tone: metric.tone ?? null,
									visibility: metric.visibility ?? "primary",
								})),
							})),
							tasks: (pipeline.runtime.tasks ?? []).map((task) => ({
								id: task.id,
								state: task.state,
								health: task.health,
								summary: task.summary,
								detail: task.detail ?? null,
								progressCurrent: task.progressCurrent ?? null,
								progressTotal: task.progressTotal ?? null,
								progressUnit: task.progressUnit ?? null,
								progressPercent: task.progressPercent ?? null,
								indeterminate: task.indeterminate ?? false,
								rateLabel: task.rateLabel ?? null,
								etaLabel: task.etaLabel ?? null,
								phaseLabel: task.phaseLabel ?? null,
								actions: (task.actions ?? []).map((action) => ({
									id: action.id,
									enabled: action.enabled,
									reason: action.reason ?? null,
									tone: action.tone ?? null,
								})),
								metrics: (task.metrics ?? []).map((metric) => ({
									key: metric.key,
									value: metric.value,
									tone: metric.tone ?? null,
									visibility: metric.visibility ?? "primary",
								})),
							})),
						}
					: null,
				services: pipeline.services.map((service) => ({
					id: service.id,
					state: service.state,
					health: service.health,
					issueCount: service.issueCount ?? 0,
					detail: service.detail ?? null,
					progressCurrent: service.progressCurrent ?? null,
					progressTotal: service.progressTotal ?? null,
					progressPercent: service.progressPercent ?? null,
					metrics: (service.metrics ?? []).map((metric) => ({
						key: metric.key,
						value: metric.value,
						tone: metric.tone ?? null,
						visibility: metric.visibility ?? "primary",
					})),
				})),
			},
		})
	}

	private getNumericUpdateThrottleMs() {
		if (this._systemStatus === "Indexing" && !this._isBackgroundReconcile) {
			return CodeIndexStateManager.FOREGROUND_NUMERIC_UPDATE_THROTTLE_MS
		}
		return CodeIndexStateManager.BACKGROUND_NUMERIC_UPDATE_THROTTLE_MS
	}

	private flushPendingProgressEmit() {
		if (this._pendingProgressEmitTimer !== undefined) {
			clearTimeout(this._pendingProgressEmitTimer)
			this._pendingProgressEmitTimer = undefined
		}
		this._progressEmitter.fire(this.getCurrentStatus())
		this._lastProgressEmitAt = Date.now()
		this._lastSemanticSignature = this.getSemanticSignature()
	}

	private emitProgressUpdate(options?: { forceImmediate?: boolean }) {
		const semanticSignature = this.getSemanticSignature()
		const semanticChanged = semanticSignature !== this._lastSemanticSignature
		const shouldForce = options?.forceImmediate || semanticChanged || this._systemStatus !== "Indexing"

		if (shouldForce) {
			this.flushPendingProgressEmit()
			return
		}

		const throttleMs = this.getNumericUpdateThrottleMs()
		const elapsedMs = Date.now() - this._lastProgressEmitAt
		if (elapsedMs >= throttleMs) {
			this.flushPendingProgressEmit()
			return
		}
		if (this._pendingProgressEmitTimer !== undefined) {
			return
		}
		this._pendingProgressEmitTimer = setTimeout(
			() => {
				this.flushPendingProgressEmit()
			},
			Math.max(0, throttleMs - elapsedMs),
		)
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
	 * vastly underestimates actual work — causing the ETA to look nearly finished
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
				this.emitProgressUpdate()
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
				this.emitProgressUpdate()
			}
		}
	}

	private logDebug(message: string, data: Record<string, unknown>): void {
		if (this._loggerEngine === "v2") {
			IndexDebugLoggerV2.log("basic", "StateManager", message, {
				component: "StateManager",
				workspacePath: this._loggerWorkspacePath,
				...data,
			})
			return
		}

		IndexDebugLogger.log("StateManager", message, data)
	}

	public dispose(): void {
		if (this._pendingProgressEmitTimer !== undefined) {
			clearTimeout(this._pendingProgressEmitTimer)
			this._pendingProgressEmitTimer = undefined
		}
		this._progressEmitter.dispose()
	}
}
