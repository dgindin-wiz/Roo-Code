// npx vitest services/code-index/processors/__tests__/scanner.spec.ts

import { DirectoryScanner } from "../scanner"
import { stat } from "fs/promises"
import type { ScanProgress, ScanResult } from "../../interfaces"

// Mock TelemetryService
vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		access: vi.fn(),
		rename: vi.fn(),
		constants: {},
	},
	stat: vi.fn(),
}))

// Create a simple mock for vscode since we can't access the real one
// NOTE: EventEmitter must be defined inline because vi.mock factories are hoisted
vi.mock("vscode", () => {
	class InlineEventEmitter {
		private _listeners: Array<(e: any) => void> = []
		event = (listener: (e: any) => void) => {
			this._listeners.push(listener)
			return {
				dispose: () => {
					this._listeners = this._listeners.filter((l: any) => l !== listener)
				},
			}
		}
		fire = (data: any) => {
			for (const l of this._listeners) l(data)
		}
		dispose = () => {
			this._listeners = []
		}
	}

	return {
		workspace: {
			workspaceFolders: [
				{
					uri: {
						fsPath: "/mock/workspace",
					},
				},
			],
			getWorkspaceFolder: vi.fn().mockReturnValue({
				uri: {
					fsPath: "/mock/workspace",
				},
			}),
			fs: {
				readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
			},
		},
		Uri: {
			file: vi.fn().mockImplementation((path: string) => path),
		},
		window: {
			activeTextEditor: {
				document: {
					uri: {
						fsPath: "/mock/workspace",
					},
				},
			},
		},
		EventEmitter: InlineEventEmitter,
	}
})

vi.mock("../../../../core/ignore/RooIgnoreController")
vi.mock("ignore")

// Override the Jest-based mock with a vitest-compatible version
vi.mock("../../../glob/list-files", () => ({
	listFiles: vi.fn(),
}))

describe("DirectoryScanner", () => {
	let scanner: DirectoryScanner
	let mockEmbedder: any
	let mockVectorStore: any
	let mockCodeParser: any
	let mockCacheManager: any
	let mockIgnoreInstance: any
	let mockStats: any

	// Default AbortSignal (not aborted) for tests that don't test cancellation
	let signal: AbortSignal

	beforeEach(async () => {
		const controller = new AbortController()
		signal = controller.signal

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
			embedderInfo: { name: "mock-embedder", dimensions: 384 },
		}
		mockVectorStore = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(true),
			search: vi.fn().mockResolvedValue([]),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			deleteCollection: vi.fn().mockResolvedValue(undefined),
			collectionExists: vi.fn().mockResolvedValue(true),
		}
		mockCodeParser = {
			parseFile: vi.fn().mockResolvedValue([]),
		}
		mockCacheManager = {
			getHash: vi.fn().mockReturnValue(undefined),
			getMtime: vi.fn().mockReturnValue(undefined),
			getBlockCount: vi.fn().mockReturnValue(undefined),
			getAllHashes: vi.fn().mockReturnValue({}),
			updateHash: vi.fn().mockResolvedValue(undefined),
			updateBlockCount: vi.fn(),
			deleteHash: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(undefined),
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
			getTotalCachedBlockCount: vi.fn().mockReturnValue(0),
		}
		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
		}

		scanner = new DirectoryScanner(
			mockEmbedder,
			mockVectorStore,
			mockCodeParser,
			mockCacheManager,
			mockIgnoreInstance,
		)

		// Mock default implementations - create proper Stats object
		mockStats = {
			size: 1024,
			isFile: () => true,
			isDirectory: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isSymbolicLink: () => false,
			isFIFO: () => false,
			isSocket: () => false,
			dev: 0,
			ino: 0,
			mode: 0,
			nlink: 0,
			uid: 0,
			gid: 0,
			rdev: 0,
			blksize: 0,
			blocks: 0,
			atimeMs: 0,
			mtimeMs: 0,
			ctimeMs: 0,
			birthtimeMs: 0,
			atime: new Date(),
			mtime: new Date(),
			ctime: new Date(),
			birthtime: new Date(),
			atimeNs: BigInt(0),
			mtimeNs: BigInt(0),
			ctimeNs: BigInt(0),
			birthtimeNs: BigInt(0),
		}
		vi.mocked(stat).mockResolvedValue(mockStats)

		// Get and mock the listFiles function
		const { listFiles } = await import("../../../glob/list-files")
		vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js"], false])
	})

	/** Collect all progress events from a scan. */
	function collectProgress(s: DirectoryScanner): ScanProgress[] {
		const events: ScanProgress[] = []
		s.onProgress((p) => events.push({ ...p }))
		return events
	}

	describe("scanDirectory", () => {
		it("should skip files larger than MAX_FILE_SIZE_BYTES", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])

			// Create large file mock stats
			const largeFileStats = {
				...mockStats,
				size: 2 * 1024 * 1024, // 2MB > 1MB limit
			}
			vi.mocked(stat).mockResolvedValueOnce(largeFileStats)

			const result = await scanner.scanDirectory("/test", signal)
			// Large files are classified as unchanged in discovery (counted as skipped)
			expect(result.skippedFiles).toBe(1)
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
		})

		it("should parse changed files and return result with processedFiles", async () => {
			// Create scanner without embedder to test the non-embedding path
			const scannerNoEmbeddings = new DirectoryScanner(
				null as any, // No embedder
				null as any, // No vector store
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
			)

			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])
			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "segment-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			const result = await scannerNoEmbeddings.scanDirectory("/test", signal)
			expect(result.processedFiles).toBe(1)
		})

		it("should process embeddings for new/changed files", async () => {
			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "segment-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			await scanner.scanDirectory("/test", signal)
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).toHaveBeenCalled()
		})

		it("should delete points for removed files", async () => {
			;(mockCacheManager.getAllHashes as any).mockReturnValue({ "old/file.js": "old-hash" })

			await scanner.scanDirectory("/test", signal)
			expect(mockVectorStore.deletePointsByFilePath).toHaveBeenCalledWith("old/file.js")
			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("old/file.js")
		})

		it("should filter out files in hidden directories", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			// Mock listFiles to return files including some in hidden directories
			vi.mocked(listFiles).mockResolvedValue([
				[
					"test/file1.js",
					"test/.hidden/file2.js",
					".git/config",
					"src/.next/static/file3.js",
					"normal/file4.js",
				],
				false,
			])

			// Mock parseFile to track which files are actually processed
			const processedFiles: string[] = []
			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => {
				processedFiles.push(filePath)
				return []
			})

			await scanner.scanDirectory("/test", signal)

			// Verify that only non-hidden files were processed
			expect(processedFiles).toEqual(["test/file1.js", "normal/file4.js"])
			expect(processedFiles).not.toContain("test/.hidden/file2.js")
			expect(processedFiles).not.toContain(".git/config")
			expect(processedFiles).not.toContain("src/.next/static/file3.js")

			// Verify the stats
			expect(mockCodeParser.parseFile).toHaveBeenCalledTimes(2)
		})

		it("should process markdown files alongside code files", async () => {
			// Create scanner without embedder to test the non-embedding path
			const scannerNoEmbeddings = new DirectoryScanner(
				null as any, // No embedder
				null as any, // No vector store
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
			)

			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/README.md", "test/app.js", "docs/guide.markdown"], false])

			const mockMarkdownBlocks: any[] = [
				{
					file_path: "test/README.md",
					content: "# Introduction\nThis is a comprehensive guide...",
					start_line: 1,
					end_line: 10,
					identifier: "Introduction",
					type: "markdown_header_h1",
					fileHash: "md-hash",
					segmentHash: "md-segment-hash",
				},
			]

			const mockJsBlocks: any[] = [
				{
					file_path: "test/app.js",
					content: "function main() { return 'hello'; }",
					start_line: 1,
					end_line: 3,
					identifier: "main",
					type: "function",
					fileHash: "js-hash",
					segmentHash: "js-segment-hash",
				},
			]

			const mockMarkdownBlocks2: any[] = [
				{
					file_path: "docs/guide.markdown",
					content: "## Getting Started\nFollow these steps...",
					start_line: 1,
					end_line: 8,
					identifier: "Getting Started",
					type: "markdown_header_h2",
					fileHash: "markdown-hash",
					segmentHash: "markdown-segment-hash",
				},
			]

			// Mock parseFile to return different blocks based on file extension
			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => {
				if (filePath.endsWith(".md")) {
					return mockMarkdownBlocks
				} else if (filePath.endsWith(".markdown")) {
					return mockMarkdownBlocks2
				} else if (filePath.endsWith(".js")) {
					return mockJsBlocks
				}
				return []
			})

			const result = await scannerNoEmbeddings.scanDirectory("/test", signal)

			// Verify all files were processed
			expect(mockCodeParser.parseFile).toHaveBeenCalledTimes(3)
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("test/README.md", expect.any(Object))
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("test/app.js", expect.any(Object))
			expect(mockCodeParser.parseFile).toHaveBeenCalledWith("docs/guide.markdown", expect.any(Object))

			// Verify processing still works
			expect(result.processedFiles).toBe(3)
		})

		it("should generate unique point IDs for each block from the same file", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/large-doc.md"], false])

			// Mock multiple blocks from the same file with different segmentHash values
			const mockBlocks: any[] = [
				{
					file_path: "test/large-doc.md",
					content: "# Introduction\nThis is the intro section...",
					start_line: 1,
					end_line: 10,
					identifier: "Introduction",
					type: "markdown_header_h1",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-1",
				},
				{
					file_path: "test/large-doc.md",
					content: "## Getting Started\nHere's how to begin...",
					start_line: 11,
					end_line: 20,
					identifier: "Getting Started",
					type: "markdown_header_h2",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-2",
				},
				{
					file_path: "test/large-doc.md",
					content: "## Advanced Topics\nFor advanced users...",
					start_line: 21,
					end_line: 30,
					identifier: "Advanced Topics",
					type: "markdown_header_h2",
					fileHash: "same-file-hash",
					segmentHash: "unique-segment-hash-3",
				},
			]

			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			await scanner.scanDirectory("/test", signal)

			// Verify that upsertPoints was called with unique IDs for each block
			expect(mockVectorStore.upsertPoints).toHaveBeenCalledTimes(1)
			const upsertCall = mockVectorStore.upsertPoints.mock.calls[0]
			const points = upsertCall[0]

			// Extract the IDs from the points
			const pointIds = points.map((point: any) => point.id)

			// Verify all IDs are unique
			expect(pointIds).toHaveLength(3)
			expect(new Set(pointIds).size).toBe(3) // All IDs should be unique

			// Verify that each point has the correct payload
			expect(points[0].payload.segmentHash).toBe("unique-segment-hash-1")
			expect(points[1].payload.segmentHash).toBe("unique-segment-hash-2")
			expect(points[2].payload.segmentHash).toBe("unique-segment-hash-3")
		})

		it("should stop processing files when signal is aborted", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js", "test/file3.js"], false])

			// Create an already-aborted signal
			const controller = new AbortController()
			controller.abort()

			const result = await scanner.scanDirectory("/test", controller.signal)

			// No files should have been processed since signal was already aborted
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
			expect(result.processedFiles).toBe(0)
		})

		it("should stop processing batches when signal is aborted mid-scan", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js", "test/file2.js"], false])

			const controller = new AbortController()

			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "function hello() {}",
					start_line: 1,
					end_line: 3,
					identifier: "hello",
					type: "function",
					fileHash: "hash1",
					segmentHash: "seg-hash-1",
				},
			]

			// Abort after first file is parsed
			;(mockCodeParser.parseFile as any).mockImplementation(async () => {
				controller.abort()
				return mockBlocks
			})

			const result = await scanner.scanDirectory("/test", controller.signal)

			// No batches should have been submitted to the embedder
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})

		it("should not process deleted files when signal is aborted", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([[], false])

			// Set up cached files that would normally be detected as deleted
			;(mockCacheManager.getAllHashes as any).mockReturnValue({ "old/file.js": "old-hash" })

			// Create an already-aborted signal
			const controller = new AbortController()
			controller.abort()

			await scanner.scanDirectory("/test", controller.signal)

			// Deleted file cleanup should not have run
			expect(mockVectorStore.deletePointsByFilePath).not.toHaveBeenCalled()
		})

		it("should count large files as unchanged (skipped) in discovery", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/large.js"], false])

			// Make file exceed MAX_FILE_SIZE_BYTES (1MB)
			vi.mocked(stat).mockResolvedValueOnce({ ...mockStats, size: 2 * 1024 * 1024 })

			const result = await scanner.scanDirectory("/test", signal)

			expect(result.skippedFiles).toBe(1)
			expect(result.processedFiles).toBe(0)
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
		})

		it("should skip mtime-cached files during discovery and count as unchanged", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/cached.js"], false])

			// Set mtime match so the file is skipped in discovery
			const mtimeMs = 1234567890
			vi.mocked(stat).mockResolvedValueOnce({ ...mockStats, mtimeMs })
			mockCacheManager.getMtime.mockReturnValue(mtimeMs)

			const result = await scanner.scanDirectory("/test", signal)

			// Mtime-matched files are classified as unchanged in discovery
			expect(result.skippedFiles).toBe(1)
			expect(result.processedFiles).toBe(0)
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
		})

		it("should throw systemic error after MAX_CONSECUTIVE_BATCH_FAILURES consecutive batch failures", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			// Need enough files to trigger at least MAX_CONSECUTIVE_BATCH_FAILURES batches.
			// With batchSegmentThreshold=1, each block becomes its own batch.
			const fileNames = Array.from({ length: 8 }, (_, i) => `test/file${i}.js`)
			vi.mocked(listFiles).mockResolvedValue([fileNames, false])

			// Create scanner with batchSegmentThreshold=1 so every block triggers a batch
			const failScanner = new DirectoryScanner(
				mockEmbedder,
				mockVectorStore,
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				1, // batchSegmentThreshold = 1
			)

			// Each file produces 1 block
			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => [
				{
					file_path: filePath,
					content: "function test() {}",
					start_line: 1,
					end_line: 3,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: `seg-${filePath}`,
				},
			])

			// Make upsertPoints always fail — simulates Qdrant collection deleted mid-indexing
			mockVectorStore.upsertPoints.mockRejectedValue(new Error("Collection not found"))

			// scanDirectory should throw the systemic error
			await expect(failScanner.scanDirectory("/test", signal)).rejects.toThrow(/consecutive batch failures/)
		})

		it("should not throw when consecutive failures stay below threshold", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			// 4 files = 4 batches (threshold=1). MAX_CONSECUTIVE_BATCH_FAILURES=5.
			// 4 < 5, so no systemic error — just individual batch errors reported via onError.
			const fileNames = Array.from({ length: 4 }, (_, i) => `test/file${i}.js`)
			vi.mocked(listFiles).mockResolvedValue([fileNames, false])

			const fewFailScanner = new DirectoryScanner(
				mockEmbedder,
				mockVectorStore,
				mockCodeParser,
				mockCacheManager,
				mockIgnoreInstance,
				1,
			)

			;(mockCodeParser.parseFile as any).mockImplementation((filePath: string) => [
				{
					file_path: filePath,
					content: "function test() {}",
					start_line: 1,
					end_line: 3,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: `seg-${filePath}`,
				},
			])

			// All upserts fail, but only 4 consecutive failures < 5 threshold
			mockVectorStore.upsertPoints.mockRejectedValue(new Error("Collection not found"))

			// Collect errors via onError event
			const errorEvents: Error[] = []
			fewFailScanner.onError((err) => errorEvents.push(err))

			// Should NOT throw — 4 failures is below the threshold
			const result = await fewFailScanner.scanDirectory("/test", signal)
			expect(result).toBeDefined()
			expect(result.processedFiles).toBe(4)
			// Individual batch errors should have been reported via onError event
			expect(errorEvents.length).toBeGreaterThan(0)
		})

		it("should skip hash-matched files during parse phase", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/unchanged.js"], false])

			// No mtime match (forces hash check path in parse phase)
			mockCacheManager.getMtime.mockReturnValue(undefined)
			// Hash matches — file content unchanged (SHA-256 of "test content" from vscode.workspace.fs.readFile mock)
			mockCacheManager.getHash.mockReturnValue("6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72")

			const result = await scanner.scanDirectory("/test", signal)

			// Hash-matched files are counted as skipped
			expect(result.skippedFiles).toBe(1)
			expect(result.processedFiles).toBe(0)
		})

		it("should emit progress events through all phases", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])

			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "function hello() {}",
					start_line: 1,
					end_line: 3,
					identifier: "hello",
					type: "function",
					fileHash: "hash",
					segmentHash: "seg-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			const progress = collectProgress(scanner)
			await scanner.scanDirectory("/test", signal)

			// Should have received progress events
			expect(progress.length).toBeGreaterThanOrEqual(2)

			// First event should be discovering
			expect(progress[0].phase).toBe("discovering")

			// Last event should be complete
			const lastProgress = progress[progress.length - 1]
			expect(lastProgress.phase).toBe("complete")
			expect(lastProgress.isEstimatedTotal).toBe(false)
		})

		it("should emit error events for non-fatal file processing errors", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/bad-file.js", "test/good-file.js"], false])

			let callCount = 0
			;(mockCodeParser.parseFile as any).mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					throw new Error("Parse failed")
				}
				return [
					{
						file_path: "test/good-file.js",
						content: "function ok() {}",
						start_line: 1,
						end_line: 1,
						identifier: "ok",
						type: "function",
						fileHash: "hash",
						segmentHash: "seg",
					},
				]
			})

			const errorEvents: Error[] = []
			scanner.onError((err) => errorEvents.push(err))

			const result = await scanner.scanDirectory("/test", signal)

			// Non-fatal error should have been emitted
			expect(errorEvents.length).toBeGreaterThanOrEqual(1)
			expect(errorEvents[0].message).toContain("Parse failed")
			// Also collected in result.errors
			expect(result.errors.length).toBeGreaterThanOrEqual(1)
		})

		it("should return ScanResult with correct structure", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/file1.js"], false])

			const mockBlocks: any[] = [
				{
					file_path: "test/file1.js",
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "hash",
					segmentHash: "segment-hash",
				},
			]
			;(mockCodeParser.parseFile as any).mockResolvedValue(mockBlocks)

			const result: ScanResult = await scanner.scanDirectory("/test", signal)

			expect(result).toHaveProperty("totalFiles")
			expect(result).toHaveProperty("processedFiles")
			expect(result).toHaveProperty("skippedFiles")
			expect(result).toHaveProperty("totalBlocks")
			expect(result).toHaveProperty("blocksEmbedded")
			expect(result).toHaveProperty("errors")
			expect(typeof result.totalFiles).toBe("number")
			expect(typeof result.processedFiles).toBe("number")
			expect(Array.isArray(result.errors)).toBe(true)
		})

		it("should skip candidates entirely when no changed files found", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([["test/cached.js", "test/cached2.js"], false])

			// All files have mtime match → no candidates
			const mtimeMs = 1234567890
			vi.mocked(stat).mockResolvedValue({ ...mockStats, mtimeMs })
			mockCacheManager.getMtime.mockReturnValue(mtimeMs)

			const result = await scanner.scanDirectory("/test", signal)

			expect(result.skippedFiles).toBe(2)
			expect(result.processedFiles).toBe(0)
			expect(result.totalBlocks).toBe(0)
			expect(mockCodeParser.parseFile).not.toHaveBeenCalled()
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})
	})
})
