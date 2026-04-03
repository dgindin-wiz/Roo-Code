import * as vscode from "vscode"
import { IndexDebugLogger } from "./debug-logger"
import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Per-file cache entry. Consolidates hash, mtime, and block count
 * into a single object to avoid three parallel maps with duplicate keys.
 */
export interface CacheEntry {
	hash: string
	mtimeMs?: number
	blockCount?: number
}

/**
 * Disk format version 4: compact representation with each file path
 * mapped to a [hash, mtimeMs, blockCount] tuple.  Previous formats
 * (v1 flat hash record, v2/v3 separate hashes/mtimes/blockCounts maps)
 * are still readable for backward compatibility.
 */
interface CacheDiskFormatV4 {
	v: 4
	entries: Record<string, [string, number | null, number | null]>
}

/**
 * Manages the cache for code indexing.
 *
 * Consolidates per-file data into a single `Map<string, CacheEntry>`
 * for memory efficiency and single-lookup access.  Writes use a
 * serialized flush pipeline so at most one `safeWriteJson` runs at
 * a time, eliminating the file-lock contention that previously caused
 * silent data loss.
 */
export class CacheManager implements ICacheManager {
	private cachePath: vscode.Uri
	private _entries = new Map<string, CacheEntry>()

	/**
	 * Debounced save that routes through the serialized flush() pipeline.
	 * Unlike the previous design (which called _performSave() directly
	 * and bypassed serialization), this ensures only one write happens
	 * at a time regardless of whether the trigger was a debounce fire
	 * or an explicit flush() call.
	 */
	private _debouncedSaveCache: ReturnType<typeof debounce>

	// ─── Serialized flush state ──────────────────────────────────────
	// At most one _performSave() runs at a time.
	// Concurrent flush() callers piggyback on the active promise and
	// set _dirtyAfterFlushStart=true so a follow-up save runs after
	// the current one finishes.
	private _flushPromise: Promise<void> | null = null
	private _dirtyAfterFlushStart = false

	/**
	 * Tracks whether in-memory state has diverged from disk.
	 * Set `true` on every mutation; cleared before _performSave().
	 * If _performSave() fails, _dirty is restored to `true` so the
	 * next flush() retries automatically.
	 */
	private _dirty = false

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
		// Route through flush() so the debounced path shares the same
		// serialization as explicit flush() calls — no more lock contention.
		this._debouncedSaveCache = debounce(() => {
			void this.flush()
		}, 1500)
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialization / Loading
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Initializes the cache manager by loading the cache file.
	 * Supports all disk formats: v1 (flat hash record), v2/v3
	 * (separate hashes/mtimes/blockCounts maps), and v4 (compact
	 * tuple entries).
	 */
	async initialize(): Promise<void> {
		try {
			const cacheData = await vscode.workspace.fs.readFile(this.cachePath)
			const raw = cacheData.toString()
			const parsed = JSON.parse(raw)
			this._loadFromDisk(parsed)

			// Compute cache quality stats: how many entries have mtime/blockCount
			let withMtime = 0
			let withBlockCount = 0
			let emptyHash = 0
			for (const entry of this._entries.values()) {
				if (entry.mtimeMs !== undefined) withMtime++
				if (entry.blockCount !== undefined) withBlockCount++
				if (!entry.hash) emptyHash++
			}
			const totalEntries = this._entries.size
			const fileSizeBytes = raw.length

			IndexDebugLogger.log("CacheManager", "initialize-loaded", {
				hashCount: totalEntries,
				withMtime,
				withBlockCount,
				emptyHash,
				fileSizeKB: Math.round(fileSizeBytes / 1024),
				cachePath: this.cachePath.fsPath,
				phaseTransition: true,
			})
		} catch (error) {
			this._entries.clear()
			IndexDebugLogger.log("CacheManager", "initialize-empty", {
				reason: error instanceof Error ? error.message : String(error),
				cachePath: this.cachePath.fsPath,
				phaseTransition: true,
			})
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "initialize",
			})
		}
		// After loading, the in-memory state matches disk — not dirty.
		this._dirty = false
	}

	/**
	 * Parses any supported disk format into the in-memory Map.
	 */
	private _loadFromDisk(parsed: any): void {
		this._entries.clear()

		if (!parsed || typeof parsed !== "object") {
			return
		}

		// v4: compact tuple format
		if ("v" in parsed && parsed.v === 4 && "entries" in parsed) {
			const entries = parsed.entries as Record<string, [string, number | null, number | null]>
			for (const [filePath, tuple] of Object.entries(entries)) {
				this._entries.set(filePath, {
					hash: tuple[0],
					mtimeMs: tuple[1] ?? undefined,
					blockCount: tuple[2] ?? undefined,
				})
			}
			return
		}

		// v2/v3: separate maps
		if ("hashes" in parsed) {
			const hashes: Record<string, string> = parsed.hashes ?? {}
			const mtimes: Record<string, number> = parsed.mtimes ?? {}
			const blockCounts: Record<string, number> = parsed.blockCounts ?? {}
			for (const [filePath, hash] of Object.entries(hashes)) {
				this._entries.set(filePath, {
					hash,
					mtimeMs: mtimes[filePath],
					blockCount: blockCounts[filePath],
				})
			}
			return
		}

		// v1: flat hash record
		for (const [filePath, hash] of Object.entries(parsed)) {
			if (typeof hash === "string") {
				this._entries.set(filePath, { hash })
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Save / Flush
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Saves the cache to disk in v4 compact format.
	 * Called only from _serializedFlush(), which guarantees at most
	 * one concurrent execution.
	 */
	private async _performSave(): Promise<boolean> {
		const countBeforeSave = this._entries.size
		try {
			await safeWriteJson(this.cachePath.fsPath, this._buildDiskPayload())

			// Check the file size after writing to detect truncation.
			// A truncated write would cause the save to "succeed" but produce
			// a corrupt/partial cache file on disk.
			let fileSizeBytes = -1
			try {
				const { stat } = await import("fs/promises")
				fileSizeBytes = (await stat(this.cachePath.fsPath)).size
			} catch {
				// Non-critical — stat failure doesn't block the save
			}

			// Not phaseTransition — fires per-batch (~1600x for 65K files), so
			// only write to the file log (throttled 1/sec) to avoid output channel spam.
			IndexDebugLogger.log("CacheManager", "_performSave-ok", {
				hashCount: countBeforeSave,
				fileSizeKB: fileSizeBytes >= 0 ? Math.round(fileSizeBytes / 1024) : -1,
			})
			return true
		} catch (error) {
			// Restore dirty flag so the next flush() retries the write.
			this._dirty = true
			console.error("Failed to save cache:", error)
			IndexDebugLogger.log("CacheManager", "_performSave-error", {
				error: error instanceof Error ? error.message : String(error),
				hashCount: this._entries.size,
				cachePath: this.cachePath.fsPath,
				phaseTransition: true,
			})
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_performSave",
			})
			return false
		}
	}

	/**
	 * Builds the v4 disk payload from the in-memory Map.
	 *
	 * Uses a Proxy so JsonStreamStringify can enumerate keys (via
	 * Object.keys → ownKeys + getOwnPropertyDescriptor) but each
	 * [hash, mtimeMs, blockCount] tuple is created lazily on first
	 * access rather than pre-materializing 65 K+ tuples up-front.
	 * This keeps peak memory proportional to the streaming window
	 * instead of the full cache size.
	 */
	private _buildDiskPayload(): CacheDiskFormatV4 {
		const map = this._entries
		const keys = [...map.keys()]

		const lazyEntries = new Proxy<Record<string, [string, number | null, number | null]>>(
			Object.create(null) as Record<string, [string, number | null, number | null]>,
			{
				ownKeys() {
					return keys
				},
				getOwnPropertyDescriptor(_, key) {
					if (typeof key === "string" && map.has(key)) {
						return { configurable: true, enumerable: true, writable: true }
					}
					return undefined
				},
				has(_, key) {
					return typeof key === "string" && map.has(key)
				},
				get(_, key) {
					if (typeof key === "string") {
						const entry = map.get(key)
						if (entry) {
							return [entry.hash, entry.mtimeMs ?? null, entry.blockCount ?? null]
						}
					}
					return undefined
				},
			},
		)

		return { v: 4, entries: lazyEntries }
	}

	/**
	 * Clears the cache file by writing an empty v4 object to it.
	 */
	async clearCacheFile(): Promise<void> {
		const entriesBeforeClear = this._entries.size
		// Capture caller stack trace for diagnosis
		const callerStack =
			new Error().stack
				?.split("\n")
				.slice(1, 4)
				.map((l) => l.trim())
				.join(" <- ") ?? "unknown"
		IndexDebugLogger.log("CacheManager", "clearCacheFile-called", {
			entriesBeingCleared: entriesBeforeClear,
			caller: callerStack,
			phaseTransition: true,
		})
		try {
			await safeWriteJson(this.cachePath.fsPath, { v: 4, entries: {} } satisfies CacheDiskFormatV4)
			this._entries.clear()
			this._dirty = false
		} catch (error) {
			console.error("Failed to clear cache file:", error, this.cachePath)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearCacheFile",
			})
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Hash / Mtime / BlockCount Accessors
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Gets the hash for a file path
	 * @param filePath Path to the file
	 * @returns The hash for the file or undefined if not found
	 */
	getHash(filePath: string): string | undefined {
		return this._entries.get(filePath)?.hash
	}

	/**
	 * Updates the hash for a file path
	 * @param filePath Path to the file
	 * @param hash New hash value
	 */
	updateHash(filePath: string, hash: string, mtimeMs?: number): void {
		const existing = this._entries.get(filePath)
		if (existing) {
			existing.hash = hash
			if (mtimeMs !== undefined) {
				existing.mtimeMs = mtimeMs
			}
		} else {
			this._entries.set(filePath, {
				hash,
				mtimeMs,
			})
		}
		this._dirty = true
		this._debouncedSaveCache()
	}

	/**
	 * Gets the cached mtime for a file path.
	 * Used for fast mtime-based skip before falling back to SHA-256 hash comparison.
	 */
	getMtime(filePath: string): number | undefined {
		return this._entries.get(filePath)?.mtimeMs
	}

	/**
	 * Deletes the hash, mtime, and block count for a file path
	 * @param filePath Path to the file
	 */
	deleteHash(filePath: string): void {
		this._entries.delete(filePath)
		this._dirty = true
		this._debouncedSaveCache()
	}

	// ═══════════════════════════════════════════════════════════════════
	// Flush Pipeline
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Flushes any pending debounced cache writes to disk immediately.
	 *
	 * Serialized: at most one _performSave() runs at a time. Concurrent
	 * callers piggyback on the active save, then if any data changed during
	 * the save, one follow-up save runs to capture the latest state.
	 *
	 * The debounced save also routes here, so there is only ONE code path
	 * that reaches _performSave(), eliminating file-lock contention.
	 */
	async flush(): Promise<void> {
		// Cancel any pending debounce — this flush will capture its data.
		// Without this, the debounce could fire *after* this flush completes,
		// causing a redundant (though now-serialized) write.
		this._debouncedSaveCache.cancel()

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
	 * Internal: runs _performSave() if dirty, then loops once more if data
	 * was dirtied during the save. Skips the write entirely when _dirty is
	 * false, making per-batch flush() calls near-free when a previous batch
	 * already wrote.
	 */
	private async _serializedFlush(): Promise<void> {
		do {
			this._dirtyAfterFlushStart = false
			if (!this._dirty) {
				break
			}
			this._dirty = false // optimistic — restored on failure in _performSave()
			const ok = await this._performSave()
			if (!ok) {
				// Save failed — _dirty is already restored to true.
				// Do NOT retry in this same flush cycle to avoid an
				// infinite loop. The next flush() (from the next batch
				// or debounce) will pick it up.
				break
			}
			// Loop if a concurrent caller dirtied data while we were saving,
			// OR if a mutation (updateHash/updateBlockCount) set _dirty.
		} while (this._dirtyAfterFlushStart || this._dirty)
	}

	// ═══════════════════════════════════════════════════════════════════
	// Collection Accessors
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * O(1) count of cached files. Avoids allocating Object.keys() arrays
	 * that the previous implementation required.
	 */
	get hashCount(): number {
		return this._entries.size
	}

	/**
	 * Zero-copy iterator over cached file paths.
	 * Use this instead of getAllHashes() when you only need to iterate keys.
	 */
	cachedFilePaths(): Iterable<string> {
		return this._entries.keys()
	}

	/**
	 * Gets a copy of all file hashes.
	 * @returns A copy of the file hashes record
	 * @deprecated Prefer hashCount for counts and cachedFilePaths() for iteration.
	 */
	getAllHashes(): Record<string, string> {
		const result: Record<string, string> = {}
		for (const [filePath, entry] of this._entries) {
			result[filePath] = entry.hash
		}
		return result
	}

	/**
	 * Prunes stale cache entries for files that no longer exist on disk.
	 * This prevents the cache from growing unboundedly as files are renamed/moved/deleted.
	 * Should be called periodically (e.g., on startup before scanning).
	 * @returns Number of entries pruned
	 */
	async pruneStaleEntries(): Promise<number> {
		const fs = await import("fs/promises")
		const allPaths = [...this._entries.keys()]
		let prunedCount = 0

		IndexDebugLogger.log("CacheManager", "pruneStaleEntries-start", {
			totalCachedFiles: allPaths.length,
			phaseTransition: true,
		})

		const prunedPaths: string[] = []

		for (const filePath of allPaths) {
			try {
				await fs.access(filePath)
			} catch {
				// File doesn't exist — remove stale cache entry
				this._entries.delete(filePath)
				prunedCount++
				// Log first 20 pruned paths for diagnosis
				if (prunedPaths.length < 20) {
					prunedPaths.push(filePath)
				}
			}
		}

		IndexDebugLogger.log("CacheManager", "pruneStaleEntries-done", {
			totalBefore: allPaths.length,
			totalAfter: allPaths.length - prunedCount,
			prunedCount,
			samplePrunedPaths: prunedPaths.length > 0 ? prunedPaths.join("; ") : "none",
			phaseTransition: true,
		})

		if (prunedCount > 0) {
			console.log(`[CacheManager] Pruned ${prunedCount} stale cache entries`)
			this._dirty = true
			this._debouncedSaveCache()
		}

		return prunedCount
	}

	// ═══════════════════════════════════════════════════════════════════
	// Block Count Methods
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Updates the cached block count for a file.
	 * Called after parsing a file to record how many code blocks it contains.
	 */
	updateBlockCount(filePath: string, count: number): void {
		const existing = this._entries.get(filePath)
		if (existing) {
			existing.blockCount = count
		} else {
			// Create a placeholder entry — the hash will be set by updateHash()
			// when embedding completes. Until then, getTotalCachedBlockCount()
			// excludes entries without a hash.
			this._entries.set(filePath, { hash: "", blockCount: count })
		}
		this._dirty = true
	}

	/**
	 * Gets the cached block count for a file.
	 * Returns undefined if the file has no cached block count.
	 */
	getBlockCount(filePath: string): number | undefined {
		return this._entries.get(filePath)?.blockCount
	}

	/**
	 * Gets all cached block counts.
	 * @returns A copy of the block counts record
	 */
	getAllBlockCounts(): Record<string, number> {
		const result: Record<string, number> = {}
		for (const [filePath, entry] of this._entries) {
			if (entry.blockCount !== undefined) {
				result[filePath] = entry.blockCount
			}
		}
		return result
	}

	/**
	 * Returns the sum of all cached block counts across all files.
	 * Used for estimating total blocks during incremental scans.
	 *
	 * Only counts files that also have a non-empty hash entry — this means
	 * the file was fully processed (parsed AND embedded). Files with
	 * blockCounts but no/empty hash were parsed in a previous session but
	 * never embedded (interrupted quit). Including them would inflate the
	 * total estimate.
	 */
	getTotalCachedBlockCount(): number {
		let total = 0
		for (const entry of this._entries.values()) {
			if (entry.hash && entry.blockCount !== undefined) {
				total += entry.blockCount
			}
		}
		return total
	}
}
