import * as vscode from "vscode"
import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Manages the cache for code indexing
 */
export class CacheManager implements ICacheManager {
	private cachePath: vscode.Uri
	private fileHashes: Record<string, string> = {}
	private fileMtimes: Record<string, number> = {} // mtime in milliseconds for fast skip
	private fileBlockCounts: Record<string, number> = {} // block count per file for progress estimation
	private _debouncedSaveCache: () => void

	// Serialized flush: at most one _performSave() runs at a time.
	// If more flush() calls arrive while a save is in progress, they set
	// _dirtyAfterFlushStart=true and piggyback on the active promise.
	// When the current save finishes, the loop does one more save to
	// capture all accumulated updates, then resolves for all waiters.
	private _flushPromise: Promise<void> | null = null
	private _dirtyAfterFlushStart = false

	/**
	 * Creates a new cache manager
	 * @param context VS Code extension context
	 * @param workspacePath Path to the workspace
	 */
	constructor(
		private context: vscode.ExtensionContext,
		private workspacePath: string,
	) {
		this.cachePath = vscode.Uri.joinPath(
			context.globalStorageUri,
			`roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
		)
		this._debouncedSaveCache = debounce(async () => {
			await this._performSave()
		}, 1500)
	}

	/**
	 * Initializes the cache manager by loading the cache file
	 */
	async initialize(): Promise<void> {
		try {
			const cacheData = await vscode.workspace.fs.readFile(this.cachePath)
			const parsed = JSON.parse(cacheData.toString())
			// Support old format (Record<string, string>), v2 ({hashes, mtimes}), and v3 ({hashes, mtimes, blockCounts})
			if (parsed && typeof parsed === "object" && "hashes" in parsed) {
				this.fileHashes = parsed.hashes ?? {}
				this.fileMtimes = parsed.mtimes ?? {}
				this.fileBlockCounts = parsed.blockCounts ?? {}
			} else {
				// Backward compatibility: old format is just a hash record
				this.fileHashes = parsed ?? {}
				this.fileMtimes = {}
				this.fileBlockCounts = {}
			}
		} catch (error) {
			this.fileHashes = {}
			this.fileBlockCounts = {}
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "initialize",
			})
		}
	}

	/**
	 * Saves the cache to disk
	 */
	private async _performSave(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, {
				hashes: this.fileHashes,
				mtimes: this.fileMtimes,
				blockCounts: this.fileBlockCounts,
			})
		} catch (error) {
			console.error("Failed to save cache:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_performSave",
			})
		}
	}

	/**
	 * Clears the cache file by writing an empty object to it
	 */
	async clearCacheFile(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, { hashes: {}, mtimes: {}, blockCounts: {} })
			this.fileHashes = {}
			this.fileMtimes = {}
			this.fileBlockCounts = {}
		} catch (error) {
			console.error("Failed to clear cache file:", error, this.cachePath)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearCacheFile",
			})
		}
	}

	/**
	 * Gets the hash for a file path
	 * @param filePath Path to the file
	 * @returns The hash for the file or undefined if not found
	 */
	getHash(filePath: string): string | undefined {
		return this.fileHashes[filePath]
	}

	/**
	 * Updates the hash for a file path
	 * @param filePath Path to the file
	 * @param hash New hash value
	 */
	updateHash(filePath: string, hash: string, mtimeMs?: number): void {
		this.fileHashes[filePath] = hash
		if (mtimeMs !== undefined) {
			this.fileMtimes[filePath] = mtimeMs
		}
		this._debouncedSaveCache()
	}

	/**
	 * Gets the cached mtime for a file path.
	 * Used for fast mtime-based skip before falling back to SHA-256 hash comparison.
	 */
	getMtime(filePath: string): number | undefined {
		return this.fileMtimes[filePath]
	}

	/**
	 * Deletes the hash and mtime for a file path
	 * @param filePath Path to the file
	 */
	deleteHash(filePath: string): void {
		delete this.fileHashes[filePath]
		delete this.fileMtimes[filePath]
		delete this.fileBlockCounts[filePath]
		this._debouncedSaveCache()
	}

	/**
	 * Flushes any pending debounced cache writes to disk immediately.
	 *
	 * Serialized: at most one _performSave() runs at a time. Concurrent
	 * callers piggyback on the active save, then if any data changed during
	 * the save, one follow-up save runs to capture the latest state.
	 * This prevents 10 concurrent batches from causing file-lock contention
	 * (which previously caused most writes to fail silently, losing cache data).
	 */
	async flush(): Promise<void> {
		if (this._flushPromise) {
			// A save is already in progress — mark dirty so it does a follow-up
			this._dirtyAfterFlushStart = true
			return this._flushPromise
		}

		this._flushPromise = this._serializedFlush()
		try {
			await this._flushPromise
		} finally {
			this._flushPromise = null
		}
	}

	/**
	 * Internal: runs _performSave(), then loops once more if data was dirtied
	 * during the save. This guarantees all accumulated updates are persisted
	 * with at most 2 sequential writes, regardless of how many concurrent
	 * flush() calls were made.
	 */
	private async _serializedFlush(): Promise<void> {
		do {
			this._dirtyAfterFlushStart = false
			await this._performSave()
		} while (this._dirtyAfterFlushStart)
	}

	/**
	 * Gets a copy of all file hashes
	 * @returns A copy of the file hashes record
	 */
	getAllHashes(): Record<string, string> {
		return { ...this.fileHashes }
	}

	/**
	 * Prunes stale cache entries for files that no longer exist on disk.
	 * This prevents the cache from growing unboundedly as files are renamed/moved/deleted.
	 * Should be called periodically (e.g., on startup before scanning).
	 * @returns Number of entries pruned
	 */
	async pruneStaleEntries(): Promise<number> {
		const fs = await import("fs/promises")
		const entries = Object.keys(this.fileHashes)
		let prunedCount = 0

		for (const filePath of entries) {
			try {
				await fs.access(filePath)
			} catch {
				// File doesn't exist — remove stale cache entry (hash, mtime, and block count)
				delete this.fileHashes[filePath]
				delete this.fileMtimes[filePath]
				delete this.fileBlockCounts[filePath]
				prunedCount++
			}
		}

		if (prunedCount > 0) {
			console.log(`[CacheManager] Pruned ${prunedCount} stale cache entries`)
			this._debouncedSaveCache()
		}

		return prunedCount
	}

	// --- Block Count Methods ---

	/**
	 * Updates the cached block count for a file.
	 * Called after parsing a file to record how many code blocks it contains.
	 */
	updateBlockCount(filePath: string, count: number): void {
		this.fileBlockCounts[filePath] = count
	}

	/**
	 * Gets the cached block count for a file.
	 * Returns undefined if the file has no cached block count.
	 */
	getBlockCount(filePath: string): number | undefined {
		return this.fileBlockCounts[filePath]
	}

	/**
	 * Gets all cached block counts.
	 * @returns A copy of the block counts record
	 */
	getAllBlockCounts(): Record<string, number> {
		return { ...this.fileBlockCounts }
	}

	/**
	 * Returns the sum of all cached block counts across all files.
	 * Used for estimating total blocks during incremental scans.
	 *
	 * Only counts files that also have a hash entry — this means the file
	 * was fully processed (parsed AND embedded). Files with blockCounts
	 * but no hash were parsed in a previous session but never embedded
	 * (interrupted quit). Including them would inflate the total estimate.
	 */
	getTotalCachedBlockCount(): number {
		let total = 0
		for (const [filePath, count] of Object.entries(this.fileBlockCounts)) {
			if (this.fileHashes[filePath] !== undefined) {
				total += count
			}
		}
		return total
	}
}
