import type { Mock } from "vitest"
import * as vscode from "vscode"
import { createHash } from "crypto"
import debounce from "lodash.debounce"
import { CacheManager } from "../cache-manager"

// Mock safeWriteJson utility
vitest.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vitest.fn().mockResolvedValue(undefined),
}))

// Import the mocked version
import { safeWriteJson } from "../../../utils/safeWriteJson"

// Mock fs/promises for pruneStaleEntries tests
const mockFsAccess = vitest.fn()
vitest.mock("fs/promises", () => ({
	access: (...args: any[]) => mockFsAccess(...args),
}))

// Mock vscode
vitest.mock("vscode", () => ({
	Uri: {
		joinPath: vitest.fn(),
	},
	workspace: {
		fs: {
			readFile: vitest.fn(),
			writeFile: vitest.fn(),
			delete: vitest.fn(),
		},
	},
}))

// Mock debounce to execute immediately, with cancel/flush stubs
vitest.mock("lodash.debounce", () => ({
	default: vitest.fn((fn: (...args: unknown[]) => unknown) => {
		const wrapped = (...args: any[]) => fn(...args)
		wrapped.cancel = vitest.fn()
		wrapped.flush = vitest.fn()
		return wrapped
	}),
}))

// Mock TelemetryService
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

// Mock IndexDebugLogger
vitest.mock("../debug-logger", () => ({
	IndexDebugLogger: {
		log: vitest.fn(),
		logSuppressed: vitest.fn(),
		close: vitest.fn(),
		setContext: vitest.fn(),
	},
}))

/**
 * Helper to drain microtask queue so fire-and-forget `void this.flush()` from
 * the debounced save path completes before assertions.
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("CacheManager", () => {
	let mockContext: vscode.ExtensionContext
	let mockWorkspacePath: string
	let mockCachePath: vscode.Uri
	let cacheManager: CacheManager

	beforeEach(() => {
		// Reset all mocks
		vitest.clearAllMocks()

		// Mock context
		mockWorkspacePath = "/mock/workspace"
		mockCachePath = { fsPath: "/mock/storage/cache.json" } as vscode.Uri
		mockContext = {
			globalStorageUri: { fsPath: "/mock/storage" } as vscode.Uri,
		} as vscode.ExtensionContext

		// Mock Uri.joinPath
		;(vscode.Uri.joinPath as Mock).mockReturnValue(mockCachePath)

		// Create cache manager instance
		cacheManager = new CacheManager(mockContext, mockWorkspacePath)
	})

	describe("constructor", () => {
		it("should correctly set up cachePath using Uri.joinPath and crypto.createHash", () => {
			const expectedHash = createHash("sha256").update(mockWorkspacePath).digest("hex")

			expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
				mockContext.globalStorageUri,
				`roo-index-cache-${expectedHash}.json`,
			)
		})

		it("should set up debounced save function", () => {
			expect(debounce).toHaveBeenCalledWith(expect.any(Function), 1500)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// Initialization / Backward-compatible loading
	// ═══════════════════════════════════════════════════════════════════
	describe("initialize", () => {
		it("should load existing v4 cache file successfully", async () => {
			const mockCache = {
				v: 4,
				entries: {
					"file1.ts": ["hash1", null, null],
					"file2.ts": ["hash2", 1000, 5],
				},
			}
			const mockBuffer = Buffer.from(JSON.stringify(mockCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(mockCachePath)
			expect(cacheManager.getHash("file1.ts")).toBe("hash1")
			expect(cacheManager.getHash("file2.ts")).toBe("hash2")
			expect(cacheManager.getMtime("file2.ts")).toBe(1000)
			expect(cacheManager.getBlockCount("file2.ts")).toBe(5)
		})

		it("should load v2/v3 cache file (backward compat)", async () => {
			const mockCache = {
				hashes: { "file1.ts": "hash1", "file2.ts": "hash2" },
				mtimes: { "file1.ts": 1234567890 },
				blockCounts: { "file2.ts": 10 },
			}
			const mockBuffer = Buffer.from(JSON.stringify(mockCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(cacheManager.getHash("file1.ts")).toBe("hash1")
			expect(cacheManager.getHash("file2.ts")).toBe("hash2")
			expect(cacheManager.getMtime("file1.ts")).toBe(1234567890)
			expect(cacheManager.getBlockCount("file2.ts")).toBe(10)
			expect(cacheManager.hashCount).toBe(2)
		})

		it("should load v1 flat hash record (backward compat)", async () => {
			const mockCache = { "file1.ts": "hash1", "file2.ts": "hash2" }
			const mockBuffer = Buffer.from(JSON.stringify(mockCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(cacheManager.getHash("file1.ts")).toBe("hash1")
			expect(cacheManager.getHash("file2.ts")).toBe("hash2")
			expect(cacheManager.getMtime("file1.ts")).toBeUndefined()
			expect(cacheManager.hashCount).toBe(2)
		})

		it("should handle missing cache file by creating empty cache", async () => {
			;(vscode.workspace.fs.readFile as Mock).mockRejectedValue(new Error("File not found"))

			await cacheManager.initialize()

			expect(cacheManager.getAllHashes()).toEqual({})
			expect(cacheManager.hashCount).toBe(0)
		})

		it("should not be dirty after loading", async () => {
			const mockCache = { v: 4, entries: { "a.ts": ["h", null, null] } }
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(Buffer.from(JSON.stringify(mockCache)))
			;(safeWriteJson as Mock).mockClear()

			await cacheManager.initialize()

			// flush() after initialize should be a no-op (not dirty)
			await cacheManager.flush()
			expect(safeWriteJson).not.toHaveBeenCalled()
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// Hash / Mtime Management
	// ═══════════════════════════════════════════════════════════════════
	describe("hash management", () => {
		it("should update hash and trigger save", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			await tick()

			expect(cacheManager.getHash(filePath)).toBe(hash)
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should delete hash and trigger save", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			await tick()
			cacheManager.deleteHash(filePath)
			await tick()

			expect(cacheManager.getHash(filePath)).toBeUndefined()
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should return shallow copy of hashes via getAllHashes()", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			const hashes = cacheManager.getAllHashes()

			// Modify the returned object
			hashes[filePath] = "modified"

			// Original should remain unchanged
			expect(cacheManager.getHash(filePath)).toBe(hash)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// hashCount and cachedFilePaths
	// ═══════════════════════════════════════════════════════════════════
	describe("hashCount and cachedFilePaths", () => {
		it("should return 0 for empty cache", () => {
			expect(cacheManager.hashCount).toBe(0)
			expect([...cacheManager.cachedFilePaths()]).toEqual([])
		})

		it("should return correct count after mutations", () => {
			cacheManager.updateHash("a.ts", "h1")
			cacheManager.updateHash("b.ts", "h2")
			cacheManager.updateHash("c.ts", "h3")
			expect(cacheManager.hashCount).toBe(3)

			cacheManager.deleteHash("b.ts")
			expect(cacheManager.hashCount).toBe(2)
		})

		it("should iterate all cached paths", () => {
			cacheManager.updateHash("x.ts", "hx")
			cacheManager.updateHash("y.ts", "hy")
			const paths = [...cacheManager.cachedFilePaths()]
			expect(paths).toContain("x.ts")
			expect(paths).toContain("y.ts")
			expect(paths).toHaveLength(2)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// Saving (v4 format)
	// ═══════════════════════════════════════════════════════════════════
	describe("saving", () => {
		it("should save cache to disk in v4 format", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash, 1234)
			await tick()

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, expect.any(Object))

			// Verify the saved data is v4 format
			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData).toEqual({
				v: 4,
				entries: { [filePath]: [hash, 1234, null] },
			})
		})

		it("should handle save errors gracefully and restore dirty flag", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			cacheManager.updateHash("test.ts", "hash")

			// Wait for the fire-and-forget flush to complete
			await tick()

			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to save cache:", expect.any(Error))

			// After a failed save, a subsequent flush should retry (dirty was restored)
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			await cacheManager.flush()
			expect(safeWriteJson).toHaveBeenCalled()

			consoleErrorSpy.mockRestore()
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// clearCacheFile
	// ═══════════════════════════════════════════════════════════════════
	describe("clearCacheFile", () => {
		it("should clear cache file and reset state with v4 format", async () => {
			cacheManager.updateHash("test.ts", "hash")
			await tick()

			// Reset the mock to ensure safeWriteJson succeeds for clearCacheFile
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			await cacheManager.clearCacheFile()

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, {
				v: 4,
				entries: {},
			})
			expect(cacheManager.getAllHashes()).toEqual({})
			expect(cacheManager.hashCount).toBe(0)
		})

		it("should handle clear errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			await cacheManager.clearCacheFile()

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to clear cache file:",
				expect.any(Error),
				mockCachePath,
			)

			consoleErrorSpy.mockRestore()
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// mtime support
	// ═══════════════════════════════════════════════════════════════════
	describe("mtime support", () => {
		it("should store and retrieve mtime alongside hash", () => {
			cacheManager.updateHash("file.ts", "hash1", 1234567890)
			expect(cacheManager.getHash("file.ts")).toBe("hash1")
			expect(cacheManager.getMtime("file.ts")).toBe(1234567890)
		})

		it("should return undefined for mtime when not set", () => {
			cacheManager.updateHash("file.ts", "hash1")
			expect(cacheManager.getMtime("file.ts")).toBeUndefined()
		})

		it("should delete mtime when deleting hash", () => {
			cacheManager.updateHash("file.ts", "hash1", 1234567890)
			cacheManager.deleteHash("file.ts")
			expect(cacheManager.getHash("file.ts")).toBeUndefined()
			expect(cacheManager.getMtime("file.ts")).toBeUndefined()
		})

		it("should clear mtimes when clearing cache file", async () => {
			// Reset safeWriteJson mock to succeed (it may be mocked to throw from prior tests)
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateHash("file.ts", "hash1", 1234567890)
			await cacheManager.clearCacheFile()
			expect(cacheManager.getMtime("file.ts")).toBeUndefined()
			expect(cacheManager.getAllHashes()).toEqual({})
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// Block count support
	// ═══════════════════════════════════════════════════════════════════
	describe("block count support", () => {
		it("should store and retrieve block count", () => {
			cacheManager.updateBlockCount("file.ts", 15)
			expect(cacheManager.getBlockCount("file.ts")).toBe(15)
		})

		it("should return undefined for block count when not set", () => {
			expect(cacheManager.getBlockCount("nonexistent.ts")).toBeUndefined()
		})

		it("should delete block count when deleting hash", () => {
			cacheManager.updateHash("file.ts", "hash1")
			cacheManager.updateBlockCount("file.ts", 10)
			cacheManager.deleteHash("file.ts")
			expect(cacheManager.getBlockCount("file.ts")).toBeUndefined()
		})

		it("should clear block counts when clearing cache file", async () => {
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateBlockCount("file.ts", 20)
			await cacheManager.clearCacheFile()
			expect(cacheManager.getBlockCount("file.ts")).toBeUndefined()
		})

		it("should return all block counts", () => {
			cacheManager.updateBlockCount("a.ts", 5)
			cacheManager.updateBlockCount("b.ts", 10)
			const counts = cacheManager.getAllBlockCounts()
			expect(counts).toEqual({ "a.ts": 5, "b.ts": 10 })
			// Should be a copy, not the same reference
			counts["a.ts"] = 999
			expect(cacheManager.getBlockCount("a.ts")).toBe(5)
		})

		it("should compute total cached block count only for files with a hash", () => {
			// Files with both hash and blockCount (fully processed)
			cacheManager.updateHash("a.ts", "hashA")
			cacheManager.updateBlockCount("a.ts", 5)
			cacheManager.updateHash("b.ts", "hashB")
			cacheManager.updateBlockCount("b.ts", 10)
			cacheManager.updateHash("c.ts", "hashC")
			cacheManager.updateBlockCount("c.ts", 3)
			expect(cacheManager.getTotalCachedBlockCount()).toBe(18)
		})

		it("should exclude orphaned blockCounts (no hash) from total", () => {
			// Fully processed file — has hash + blockCount
			cacheManager.updateHash("done.ts", "hashDone")
			cacheManager.updateBlockCount("done.ts", 10)

			// Orphaned entries — blockCount written during parse, but hash never written
			// (simulates interrupted quit before embedding completed)
			cacheManager.updateBlockCount("orphan1.ts", 20)
			cacheManager.updateBlockCount("orphan2.ts", 30)

			// Only done.ts should be counted
			expect(cacheManager.getTotalCachedBlockCount()).toBe(10)
		})

		it("should return 0 for total cached block count when empty", () => {
			expect(cacheManager.getTotalCachedBlockCount()).toBe(0)
		})

		it("should return 0 when all blockCounts are orphaned (no hashes)", () => {
			cacheManager.updateBlockCount("orphan1.ts", 5)
			cacheManager.updateBlockCount("orphan2.ts", 10)
			expect(cacheManager.getTotalCachedBlockCount()).toBe(0)
		})

		it("should persist block counts in v4 format", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateHash("file.ts", "hash1", 1000)
			cacheManager.updateBlockCount("file.ts", 12)

			await cacheManager.flush()

			const lastCall = (safeWriteJson as Mock).mock.calls[(safeWriteJson as Mock).mock.calls.length - 1]
			const savedData = lastCall[1]
			expect(savedData.v).toBe(4)
			expect(savedData.entries["file.ts"]).toEqual(["hash1", 1000, 12])
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// pruneStaleEntries
	// ═══════════════════════════════════════════════════════════════════
	describe("pruneStaleEntries", () => {
		beforeEach(() => {
			mockFsAccess.mockReset()
		})

		it("should remove entries where fs.access throws (file does not exist)", async () => {
			cacheManager.updateHash("/mock/existing.ts", "hash1")
			cacheManager.updateHash("/mock/deleted.ts", "hash2")
			cacheManager.updateHash("/mock/also-deleted.ts", "hash3")

			mockFsAccess.mockImplementation(async (filePath: string) => {
				if (filePath === "/mock/existing.ts") return undefined // exists
				throw new Error("ENOENT")
			})

			const pruned = await cacheManager.pruneStaleEntries()

			expect(pruned).toBe(2)
			expect(cacheManager.getHash("/mock/existing.ts")).toBe("hash1")
			expect(cacheManager.getHash("/mock/deleted.ts")).toBeUndefined()
			expect(cacheManager.getHash("/mock/also-deleted.ts")).toBeUndefined()
		})

		it("should preserve all entries when every file exists", async () => {
			cacheManager.updateHash("a.ts", "hashA")
			cacheManager.updateHash("b.ts", "hashB")
			cacheManager.updateHash("c.ts", "hashC")

			mockFsAccess.mockResolvedValue(undefined) // all files exist

			const pruned = await cacheManager.pruneStaleEntries()

			expect(pruned).toBe(0)
			expect(cacheManager.hashCount).toBe(3)
		})

		it("should delete mtime and blockCount alongside hash when pruning", async () => {
			cacheManager.updateHash("/mock/gone.ts", "hash1", 9999)
			cacheManager.updateBlockCount("/mock/gone.ts", 42)

			mockFsAccess.mockRejectedValue(new Error("ENOENT"))

			await cacheManager.pruneStaleEntries()

			expect(cacheManager.getHash("/mock/gone.ts")).toBeUndefined()
			expect(cacheManager.getMtime("/mock/gone.ts")).toBeUndefined()
			expect(cacheManager.getBlockCount("/mock/gone.ts")).toBeUndefined()
		})

		it("should trigger debounced save when entries are pruned", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateHash("gone.ts", "hash1")
			await tick()

			// Clear the write from updateHash
			;(safeWriteJson as Mock).mockClear()

			mockFsAccess.mockRejectedValue(new Error("ENOENT"))

			await cacheManager.pruneStaleEntries()
			await tick()

			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should not trigger save when nothing is pruned", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateHash("exists.ts", "hash1")
			await tick()

			// Clear the write from updateHash
			;(safeWriteJson as Mock).mockClear()

			mockFsAccess.mockResolvedValue(undefined) // file exists

			await cacheManager.pruneStaleEntries()
			await tick()

			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it("should handle empty cache gracefully", async () => {
			mockFsAccess.mockResolvedValue(undefined)

			const pruned = await cacheManager.pruneStaleEntries()

			expect(pruned).toBe(0)
		})

		it("should handle ALL entries failing fs.access (simulates startup race)", async () => {
			// Simulates the exact bug: during VS Code startup, all files briefly
			// appear inaccessible. If pruneStaleEntries runs during this window,
			// it would delete the entire cache.
			for (let i = 0; i < 100; i++) {
				cacheManager.updateHash(`/workspace/src/file${i}.ts`, `hash${i}`, 1000 + i)
				cacheManager.updateBlockCount(`/workspace/src/file${i}.ts`, 5)
			}

			// All files transiently inaccessible
			mockFsAccess.mockRejectedValue(new Error("ENOENT: no such file or directory"))

			const pruned = await cacheManager.pruneStaleEntries()

			// This test documents the behavior: pruneStaleEntries WILL delete everything
			// if all files are inaccessible. This is why we removed it from the startup path.
			expect(pruned).toBe(100)
			expect(cacheManager.hashCount).toBe(0)
		})

		it("should handle mixed accessible/inaccessible files correctly", async () => {
			cacheManager.updateHash("/ws/keep1.ts", "h1", 100)
			cacheManager.updateBlockCount("/ws/keep1.ts", 3)
			cacheManager.updateHash("/ws/keep2.ts", "h2", 200)
			cacheManager.updateBlockCount("/ws/keep2.ts", 7)
			cacheManager.updateHash("/ws/gone1.ts", "h3", 300)
			cacheManager.updateBlockCount("/ws/gone1.ts", 5)

			mockFsAccess.mockImplementation(async (filePath: string) => {
				if (filePath.includes("keep")) return undefined
				throw new Error("ENOENT")
			})

			const pruned = await cacheManager.pruneStaleEntries()

			expect(pruned).toBe(1)
			// Kept entries are intact (consolidated in CacheEntry)
			expect(cacheManager.getHash("/ws/keep1.ts")).toBe("h1")
			expect(cacheManager.getMtime("/ws/keep1.ts")).toBe(100)
			expect(cacheManager.getBlockCount("/ws/keep1.ts")).toBe(3)
			expect(cacheManager.getHash("/ws/keep2.ts")).toBe("h2")
			// Gone entry is fully removed
			expect(cacheManager.getHash("/ws/gone1.ts")).toBeUndefined()
			expect(cacheManager.getMtime("/ws/gone1.ts")).toBeUndefined()
			expect(cacheManager.getBlockCount("/ws/gone1.ts")).toBeUndefined()
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	// Flush / save reliability
	// ═══════════════════════════════════════════════════════════════════
	describe("flush reliability", () => {
		it("should persist latest data when flush() is called", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			cacheManager.updateHash("a.ts", "hashA", 100)
			cacheManager.updateBlockCount("a.ts", 5)
			cacheManager.updateHash("b.ts", "hashB", 200)

			await cacheManager.flush()

			// flush should call _performSave which writes all current data in v4 format
			const lastCall = (safeWriteJson as Mock).mock.calls[(safeWriteJson as Mock).mock.calls.length - 1]
			expect(lastCall[1].v).toBe(4)
			expect(lastCall[1].entries["a.ts"]).toEqual(["hashA", 100, 5])
			expect(lastCall[1].entries["b.ts"]).toEqual(["hashB", 200, null])
		})

		it("should serialize concurrent flush calls (no file-lock contention)", async () => {
			// Set up data first, then reset mock so only flush() writes are tracked
			cacheManager.updateHash("a.ts", "hashA")
			await tick()
			;(safeWriteJson as Mock).mockClear()

			let concurrentSaves = 0
			let maxConcurrentSaves = 0
			let saveCount = 0

			;(safeWriteJson as Mock).mockImplementation(async () => {
				concurrentSaves++
				maxConcurrentSaves = Math.max(maxConcurrentSaves, concurrentSaves)
				// Simulate slow write
				await new Promise((resolve) => setTimeout(resolve, 10))
				saveCount++
				concurrentSaves--
			})

			// Mark dirty again so flush actually writes
			cacheManager.updateHash("a.ts", "hashA-updated")

			// Fire multiple concurrent flushes
			const flushPromises = [
				cacheManager.flush(),
				cacheManager.flush(),
				cacheManager.flush(),
				cacheManager.flush(),
			]

			await Promise.all(flushPromises)

			// At most 1 save should run at a time (serialized via _flushPromise)
			expect(maxConcurrentSaves).toBe(1)
			// At least 1 save, at most 2 (one active + one follow-up for dirty data)
			expect(saveCount).toBeGreaterThanOrEqual(1)
			expect(saveCount).toBeLessThanOrEqual(2)
		})

		it("should capture data written after flush starts (dirty follow-up)", async () => {
			let saveCallCount = 0
			const savedSnapshots: any[] = []

			;(safeWriteJson as Mock).mockImplementation(async (_path: string, data: any) => {
				savedSnapshots.push(JSON.parse(JSON.stringify(data)))
				saveCallCount++
				if (saveCallCount === 1) {
					// During first save, add more data (simulates embedding completing mid-flush)
					cacheManager.updateHash("late.ts", "hashLate", 999)
				}
			})

			cacheManager.updateHash("early.ts", "hashEarly", 100)

			await cacheManager.flush()

			// Should have done at least 2 saves: one for early.ts, one follow-up for late.ts
			expect(saveCallCount).toBeGreaterThanOrEqual(2)

			// The last snapshot should contain both entries in v4 format
			const lastSnapshot = savedSnapshots[savedSnapshots.length - 1]
			expect(lastSnapshot.v).toBe(4)
			expect(lastSnapshot.entries["early.ts"][0]).toBe("hashEarly")
			expect(lastSnapshot.entries["late.ts"][0]).toBe("hashLate")
		})

		it("should handle flush errors without losing in-memory state", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Disk full"))

			cacheManager.updateHash("important.ts", "hash123", 500)

			await cacheManager.flush()

			// Even though flush failed, in-memory state should be intact
			expect(cacheManager.getHash("important.ts")).toBe("hash123")
			expect(cacheManager.getMtime("important.ts")).toBe(500)

			consoleErrorSpy.mockRestore()
		})

		it("should skip write when not dirty (empty cache, never mutated)", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			// No mutations — cache is not dirty
			await cacheManager.flush()

			// Flush should skip the write because _dirty is false
			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it("should cancel pending debounce when flush() is called", async () => {
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			cacheManager.updateHash("test.ts", "hash1")

			// Get the cancel mock from the debounced function
			const debouncedFn = (cacheManager as any)._debouncedSaveCache
			const cancelMock = debouncedFn.cancel as Mock

			// Reset cancel call count (updateHash triggers debounce which may flush)
			cancelMock.mockClear()

			await cacheManager.flush()

			// flush() should have called cancel() to prevent redundant debounced write
			expect(cancelMock).toHaveBeenCalled()
		})

		it("should retry on next flush after a save failure (dirty restored)", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})

			// First flush: fail
			;(safeWriteJson as Mock).mockRejectedValueOnce(new Error("Disk full"))
			cacheManager.updateHash("retry.ts", "hash1")
			await cacheManager.flush()

			// _dirty should be restored to true by _performSave error handler
			// Second flush: succeed
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			await cacheManager.flush()

			// The retry flush should have written (because dirty was restored)
			expect(safeWriteJson).toHaveBeenCalled()
			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData.v).toBe(4)
			expect(savedData.entries["retry.ts"]).toBeDefined()

			consoleErrorSpy.mockRestore()
		})
	})
})
