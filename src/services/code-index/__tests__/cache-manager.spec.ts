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

// Mock debounce to execute immediately
vitest.mock("lodash.debounce", () => ({ default: vitest.fn((fn) => fn) }))

// Mock TelemetryService
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

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

	describe("initialize", () => {
		it("should load existing cache file successfully", async () => {
			const mockCache = { "file1.ts": "hash1", "file2.ts": "hash2" }
			const mockBuffer = Buffer.from(JSON.stringify(mockCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(mockCachePath)
			expect(cacheManager.getAllHashes()).toEqual(mockCache)
		})

		it("should handle missing cache file by creating empty cache", async () => {
			;(vscode.workspace.fs.readFile as Mock).mockRejectedValue(new Error("File not found"))

			await cacheManager.initialize()

			expect(cacheManager.getAllHashes()).toEqual({})
		})
	})

	describe("hash management", () => {
		it("should update hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(cacheManager.getHash(filePath)).toBe(hash)
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should delete hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			cacheManager.deleteHash(filePath)

			expect(cacheManager.getHash(filePath)).toBeUndefined()
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should return shallow copy of hashes", () => {
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

	describe("saving", () => {
		it("should save cache to disk with correct data", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, expect.any(Object))

			// Verify the saved data
			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData).toEqual({ hashes: { [filePath]: hash }, mtimes: {}, blockCounts: {} })
		})

		it("should handle save errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			cacheManager.updateHash("test.ts", "hash")

			// Wait for any pending promises
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to save cache:", expect.any(Error))

			consoleErrorSpy.mockRestore()
		})
	})

	describe("clearCacheFile", () => {
		it("should clear cache file and reset state", async () => {
			cacheManager.updateHash("test.ts", "hash")

			// Reset the mock to ensure safeWriteJson succeeds for clearCacheFile
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			await cacheManager.clearCacheFile()

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, {
				hashes: {},
				mtimes: {},
				blockCounts: {},
			})
			expect(cacheManager.getAllHashes()).toEqual({})
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

		it("should persist block counts alongside hashes and mtimes", async () => {
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)
			cacheManager.updateHash("file.ts", "hash1", 1000)
			cacheManager.updateBlockCount("file.ts", 12)
			// Trigger save by updating hash again (debounced save)
			cacheManager.updateHash("file2.ts", "hash2")

			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData.blockCounts).toEqual({ "file.ts": 12 })
			expect(savedData.hashes).toHaveProperty("file.ts", "hash1")
			expect(savedData.mtimes).toHaveProperty("file.ts", 1000)
		})
	})
})
