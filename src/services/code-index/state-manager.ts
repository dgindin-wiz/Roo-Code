import * as vscode from "vscode"
import { IndexDebugLogger } from "./debug-logger"

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"

export type IndexingPhase = "scanning" | "embedding" | "complete"

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

	// Two-phase progress fields
	private _phase: IndexingPhase | undefined
	private _totalFiles: number = 0
	private _processedFiles: number = 0
	private _filesParsed: number = 0 // files actually parsed (not skipped), for ETA during estimated totals
	private _totalBlocks: number = 0
	private _blocksEmbedded: number = 0
	private _startingBlockCount: number = 0 // pre-existing blocks in Qdrant from a previous session
	private _isEstimatedTotal: boolean = false
	private _embedStartedAt: number = 0
	private _estimatedTimeRemainingMs: number | null = null
	private _lastFilesParsedChangeTime: number = 0 // when _filesParsed last changed (for backpressure detection)
	private static readonly MIN_PROGRESS_FOR_ETA = 0.01 // 1% — show ETA early; block-level progress is stable
	private static readonly BACKPRESSURE_DISPLAY_THRESHOLD_MS = 2_000 // show "waiting" hint after 2s of no file progress

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
			totalFiles: this._totalFiles,
			processedFiles: this._processedFiles,
			totalBlocks: this._getExtrapolatedTotal(),
			blocksEmbedded: effectiveBlocksEmbedded,
			estimatedTimeRemainingMs: this._estimatedTimeRemainingMs,
			isEstimatedTotal: this._isEstimatedTotal,
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
				// Optionally clear the message or set a default for non-indexing states
				if (newState === "Standby" && message === undefined) this._statusMessage = "Ready."
				if (newState === "Indexed" && message === undefined) this._statusMessage = "Index up-to-date."
				if (newState === "Error" && message === undefined) this._statusMessage = "An error occurred."
				// Reset two-phase fields
				if (newState !== "Stopping") {
					this._phase = newState === "Indexed" ? "complete" : undefined
					this._estimatedTimeRemainingMs = null
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

	// --- Two-Phase Progress ---

	/**
	 * Called when indexing begins to initialize timing.
	 */
	public startIndexingTimer(): void {
		this._estimatedTimeRemainingMs = null
	}

	/**
	 * Reports progress during the scan phase (checking files for changes).
	 */
	public reportScanProgress(scannedFiles: number, totalFiles: number): void {
		if (this._systemStatus === "Stopping") return

		this._phase = "scanning"
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
	): void {
		if (this._systemStatus === "Stopping") return

		this._phase = "embedding"
		this._totalBlocks = totalBlocks
		this._blocksEmbedded = 0
		this._startingBlockCount = startingBlockCount ?? 0
		this._isEstimatedTotal = isEstimate
		this._embedStartedAt = Date.now()
		this._estimatedTimeRemainingMs = null
		this._lastFilesParsedChangeTime = Date.now()

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

		// Use block-level progress for bar + ETA (uniform cost per block)
		this._processedItems = effectiveEmbedded
		this._totalItems = displayTotal
		this._processedFiles = this._filesParsed
		this._currentItemUnit = "blocks"
		this._phase = "embedding"
		this._systemStatus = "Indexing"

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
		const parseStalled =
			this._filesParsed < this._totalFiles &&
			this._filesParsed > 0 &&
			Date.now() - this._lastFilesParsedChangeTime >= CodeIndexStateManager.BACKPRESSURE_DISPLAY_THRESHOLD_MS
		const backpressureHint = parseStalled ? " (waiting for embeddings)" : ""
		const fileLine =
			this._totalFiles > 0
				? `\n${this._filesParsed.toLocaleString()} of ${this._totalFiles.toLocaleString()} files checked${backpressureHint}`
				: ""
		this._statusMessage = `${blockLine}${fileLine}`

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
		this._totalBlocks = totalBlocks
		this._blocksEmbedded = totalBlocks
		this._startingBlockCount = 0 // Reset — total already includes everything
		this._totalFiles = totalFiles
		this._isEstimatedTotal = false
		this._estimatedTimeRemainingMs = null
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
			const blocksPerFile = this._totalBlocks / this._filesParsed
			return Math.round(blocksPerFile * this._totalFiles)
		}
		return this._totalBlocks
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
		const blocksPerMs = this._blocksEmbedded / elapsed
		// Remaining blocks to embed this session (using extrapolated total)
		const remainingBlocks = Math.max(0, extrapolatedTotal - effectiveEmbedded)
		this._estimatedTimeRemainingMs = blocksPerMs > 0 ? Math.max(0, Math.round(remainingBlocks / blocksPerMs)) : null
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
