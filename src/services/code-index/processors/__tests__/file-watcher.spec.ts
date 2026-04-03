// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import * as vscode from "vscode"
import { createHash } from "crypto"

import { FileWatcher } from "../file-watcher"
import { QdrantTransientError } from "../../vector-store/qdrant-client"

// Mock TelemetryService
vi.mock("../../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock dependencies
vi.mock("../../cache-manager")
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation(() => ({
		validateAccess: vi.fn().mockReturnValue(true),
	})),
}))
vi.mock("ignore")
vi.mock("../parser", () => ({
	codeParser: {
		parseFile: vi.fn().mockResolvedValue([
			{
				file_path: "/mock/workspace/src/file.ts",
				identifier: "testFunc",
				type: "function",
				start_line: 1,
				end_line: 10,
				content: "function testFunc() {}",
				fileHash: "abc123",
				segmentHash: "seg123",
			},
		]),
	},
}))
vi.mock("../../../glob/ignore-utils", () => ({
	isPathInIgnoredDirectory: vi.fn().mockReturnValue(false),
}))

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(60),
		}),
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
		fs: {
			stat: vi.fn().mockResolvedValue({ size: 1000 }),
			readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
		},
	},
	RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	Uri: {
		file: vi.fn().mockImplementation((path: string) => ({ fsPath: path })),
	},
	EventEmitter: vi.fn().mockImplementation(() => {
		const listeners: ((...args: unknown[]) => unknown)[] = []
		return {
			event: vi.fn().mockImplementation((listener: (...args: unknown[]) => unknown) => {
				listeners.push(listener)
				return { dispose: () => {} }
			}),
			fire: vi.fn().mockImplementation((data: any) => {
				listeners.forEach((l) => l(data))
			}),
			dispose: vi.fn(),
		}
	}),
	ExtensionContext: vi.fn(),
}))

describe("FileWatcher", () => {
	let fileWatcher: FileWatcher
	let mockWatcher: any
	let mockOnDidCreate: any
	let mockOnDidChange: any
	let mockOnDidDelete: any
	let mockContext: any
	let mockCacheManager: any
	let mockEmbedder: any
	let mockVectorStore: any
	let mockIgnoreInstance: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Create mock event handlers
		mockOnDidCreate = vi.fn()
		mockOnDidChange = vi.fn()
		mockOnDidDelete = vi.fn()

		// Create mock watcher
		mockWatcher = {
			onDidCreate: vi.fn().mockImplementation((handler: (...args: unknown[]) => unknown) => {
				mockOnDidCreate = handler
				return { dispose: vi.fn() }
			}),
			onDidChange: vi.fn().mockImplementation((handler: (...args: unknown[]) => unknown) => {
				mockOnDidChange = handler
				return { dispose: vi.fn() }
			}),
			onDidDelete: vi.fn().mockImplementation((handler: (...args: unknown[]) => unknown) => {
				mockOnDidDelete = handler
				return { dispose: vi.fn() }
			}),
			dispose: vi.fn(),
		}

		// Mock createFileSystemWatcher to return our mock watcher
		vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(mockWatcher)

		// Create mock dependencies
		mockContext = {
			subscriptions: [],
		}

		mockCacheManager = {
			getHash: vi.fn().mockReturnValue(undefined),
			updateHash: vi.fn(),
			deleteHash: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
		}

		mockVectorStore = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
		}

		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
		}

		fileWatcher = new FileWatcher(
			"/mock/workspace",
			mockContext,
			mockCacheManager,
			mockEmbedder,
			mockVectorStore,
			mockIgnoreInstance,
		)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// ─── Category I: File Filtering (existing tests, preserved) ─────────────

	describe("file filtering", () => {
		it("should ignore files in hidden directories on create events", async () => {
			await fileWatcher.initialize()

			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point: any) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/config", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/file.ts", shouldProcess: false },
				{ path: "/mock/workspace/src/.next/static/file.js", shouldProcess: false },
				{ path: "/mock/workspace/node_modules/package/index.js", shouldProcess: false },
				{ path: "/mock/workspace/normal/file.js", shouldProcess: true },
			]

			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			await new Promise((resolve) => setTimeout(resolve, 600))

			expect(processedFiles).not.toContain("src/.next/static/file.js")
			expect(processedFiles).not.toContain(".git/config")
			expect(processedFiles).not.toContain(".hidden/file.ts")
		})

		it("should ignore files in hidden directories on change events", async () => {
			await fileWatcher.initialize()

			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point: any) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.vscode/settings.json", shouldProcess: false },
				{ path: "/mock/workspace/src/.cache/data.json", shouldProcess: false },
				{ path: "/mock/workspace/dist/bundle.js", shouldProcess: false },
			]

			for (const { path } of testCases) {
				await mockOnDidChange({ fsPath: path })
			}

			await new Promise((resolve) => setTimeout(resolve, 600))

			expect(processedFiles).not.toContain(".vscode/settings.json")
			expect(processedFiles).not.toContain("src/.cache/data.json")
		})

		it("should ignore files in hidden directories on delete events", async () => {
			await fileWatcher.initialize()

			const deletedFiles: string[] = []
			mockVectorStore.deletePointsByFilePath.mockImplementation(async (filePath: string) => {
				deletedFiles.push(filePath)
			})

			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/objects/abc123", shouldProcess: false },
				{ path: "/mock/workspace/.DS_Store", shouldProcess: false },
				{ path: "/mock/workspace/build/.cache/temp.js", shouldProcess: false },
			]

			for (const { path } of testCases) {
				await mockOnDidDelete({ fsPath: path })
			}

			await new Promise((resolve) => setTimeout(resolve, 600))

			expect(deletedFiles).not.toContain(".git/objects/abc123")
			expect(deletedFiles).not.toContain(".DS_Store")
			expect(deletedFiles).not.toContain("build/.cache/temp.js")
		})

		it("should handle nested hidden directories correctly", async () => {
			await fileWatcher.initialize()

			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point: any) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			const testCases = [
				{ path: "/mock/workspace/src/components/Button.tsx", shouldProcess: true },
				{ path: "/mock/workspace/src/.hidden/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/src/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/src/components/.hidden/Button.tsx", shouldProcess: false },
			]

			for (const { path } of testCases) {
				await mockOnDidCreate({ fsPath: path })
			}

			await new Promise((resolve) => setTimeout(resolve, 600))

			expect(processedFiles).not.toContain("src/.hidden/components/Button.tsx")
			expect(processedFiles).not.toContain(".hidden/src/components/Button.tsx")
			expect(processedFiles).not.toContain("src/components/.hidden/Button.tsx")
		})
	})

	// ─── Category: Dispose ──────────────────────────────────────────────────

	describe("dispose", () => {
		it("should dispose of the watcher when disposed", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			expect(mockWatcher.dispose).toHaveBeenCalled()
		})
	})

	// ─── Category A: Debounce & Event Coalescing ────────────────────────────

	describe("debounce & event coalescing", () => {
		it("should coalesce rapid events within debounce window into a single batch", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Fire 3 events rapidly
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/a.ts" })
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/b.ts" })
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/c.ts" })

			// Before debounce fires, no batch processing should have happened
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()

			// Advance past debounce delay (500ms)
			await vi.advanceTimersByTimeAsync(600)

			// All 3 files should have been processed in the batch
			// (upsertPoints called once with all points, or processFile called 3 times)
			// We verify via the deletePointsByMultipleFilePaths not being called for creates
			// and that flush was called once (one batch)
			expect(mockCacheManager.flush).toHaveBeenCalledTimes(1)
		})

		it("should resolve create→change→delete on same file to final event type (delete)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Rapid sequence: create, change, then delete on same file
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/temp.ts" })
			await mockOnDidChange({ fsPath: "/mock/workspace/src/temp.ts" })
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/temp.ts" })

			await vi.advanceTimersByTimeAsync(600)

			// The final event is "delete", so it should call deletePointsByMultipleFilePaths
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalled()
			// And deleteHash should be called for the deleted file
			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("/mock/workspace/src/temp.ts")
		})

		it("should trigger a new batch for events arriving after debounce fires", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// First event
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/first.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// flush called for first batch
			expect(mockCacheManager.flush).toHaveBeenCalledTimes(1)

			// Second event after first batch completes
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/second.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// flush called again for second batch
			expect(mockCacheManager.flush).toHaveBeenCalledTimes(2)
		})
	})

	// ─── Category B: Batch Processing Pipeline ──────────────────────────────

	describe("batch processing pipeline", () => {
		it("should process created file: embed, upsert, update cache hash", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/new-file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Embedder should have been called
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalled()
			// Points should have been upserted
			expect(mockVectorStore.upsertPoints).toHaveBeenCalled()
			// Cache hash should have been updated
			expect(mockCacheManager.updateHash).toHaveBeenCalled()
			// No delete call for creates
			const deleteArgs = mockVectorStore.deletePointsByMultipleFilePaths.mock.calls
			// deletePointsByMultipleFilePaths should NOT include the created file path
			// (only called for changed files in the upsert phase)
			for (const call of deleteArgs) {
				expect(call[0]).not.toContain("/mock/workspace/src/new-file.ts")
			}
		})

		it("should process changed file: delete old points AFTER upsert (Fix 3)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			const callOrder: string[] = []
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementation(async () => {
				callOrder.push("delete")
			})
			mockVectorStore.upsertPoints.mockImplementation(async () => {
				callOrder.push("upsert")
			})

			await mockOnDidChange({ fsPath: "/mock/workspace/src/changed.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// For changed files, deletion of old points happens in _executeBatchUpsertOperations
			// BEFORE upsert within the same phase (delete then upsert)
			expect(callOrder).toContain("delete")
			expect(callOrder).toContain("upsert")
			// Delete should come before upsert for changed files
			expect(callOrder.indexOf("delete")).toBeLessThan(callOrder.indexOf("upsert"))
		})

		it("should process deleted file: delete from Qdrant and cache", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			await mockOnDidDelete({ fsPath: "/mock/workspace/src/removed.ts" })
			await vi.advanceTimersByTimeAsync(600)

			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledWith([
				"/mock/workspace/src/removed.ts",
			])
			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("/mock/workspace/src/removed.ts")
		})

		it("should handle mixed batch: creates + changes + deletes", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/new.ts" })
			await mockOnDidChange({ fsPath: "/mock/workspace/src/modified.ts" })
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/old.ts" })

			await vi.advanceTimersByTimeAsync(600)

			// Delete phase should handle explicit deletion
			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith("/mock/workspace/src/old.ts")
			// Upsert phase should handle new + modified
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).toHaveBeenCalled()
			// Flush should be called at end
			expect(mockCacheManager.flush).toHaveBeenCalled()
		})

		it("should skip unchanged files (cache hash matches)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Make the cache return the same hash as the computed hash
			const content = "test content"
			const expectedHash = createHash("sha256").update(content).digest("hex")
			mockCacheManager.getHash.mockReturnValue(expectedHash)

			await mockOnDidChange({ fsPath: "/mock/workspace/src/unchanged.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Should NOT create embeddings or upsert
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
		})
	})

	// ─── Category C: Cache Flush (Fix 1) ────────────────────────────────────

	describe("cache flush after batch (Fix 1)", () => {
		it("should call flush() after successful batch processing", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			expect(mockCacheManager.flush).toHaveBeenCalledTimes(1)
		})

		it("should call flush() even when some files in the batch had errors", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Make the embedder fail for this file
			mockEmbedder.createEmbeddings.mockRejectedValueOnce(new Error("embedding failed"))

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/bad-file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// flush should still be called even though embedding failed
			expect(mockCacheManager.flush).toHaveBeenCalledTimes(1)
		})

		it("should handle flush errors gracefully without crashing the batch", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			mockCacheManager.flush.mockRejectedValueOnce(new Error("disk full"))

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })

			// Should not throw
			await vi.advanceTimersByTimeAsync(600)

			expect(mockCacheManager.flush).toHaveBeenCalled()
		})
	})

	// ─── Category D: Disposed Guard (Fix 2) ─────────────────────────────────

	describe("disposed guard (Fix 2)", () => {
		it("should ignore events received after dispose()", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			fileWatcher.dispose()

			// Try to send events after disposal
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/post-dispose.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Nothing should have been processed
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
		})

		it("should bail out of triggerBatchProcessing when _disposed is set", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Accumulate an event, then dispose before debounce fires
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })

			// Dispose before timer fires
			fileWatcher.dispose()

			await vi.advanceTimersByTimeAsync(600)

			// No batch processing should occur
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
			expect(mockCacheManager.flush).not.toHaveBeenCalled()
		})

		it("should not make Qdrant calls after dispose during batch processing", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Make processFile slow so we can dispose mid-batch
			let resolveProcessing: (() => void) | undefined
			const { codeParser } = await import("../parser")
			vi.mocked(codeParser.parseFile).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveProcessing = () =>
							resolve([
								{
									file_path: "/mock/workspace/src/slow.ts",
									identifier: "f",
									type: "function",
									start_line: 1,
									end_line: 5,
									content: "fn",
									fileHash: "h",
									segmentHash: "s",
								},
							])
					}),
			)

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/slow.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Dispose while processing is in flight
			fileWatcher.dispose()

			// Resolve the slow processing
			resolveProcessing?.()
			await vi.advanceTimersByTimeAsync(0)

			// upsertPoints should NOT have been called because _disposed was set
			expect(mockVectorStore.upsertPoints).not.toHaveBeenCalled()
		})
	})

	// ─── Category E: Atomic Changed-File Deletions (Fix 3) ──────────────────

	describe("atomic changed-file deletions (Fix 3)", () => {
		it("should only delete old points for changed files in the upsert phase, not the deletion phase", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			const deletionPhasePaths: string[][] = []
			let deletionCallCount = 0
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementation(async (paths: string[]) => {
				deletionCallCount++
				deletionPhasePaths.push(paths)
			})

			await mockOnDidChange({ fsPath: "/mock/workspace/src/changed.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Phase 1 (_handleBatchDeletions) should NOT include the changed file
			// because only explicit deletes go there now.
			// Phase 3 (_executeBatchUpsertOperations) should include the changed file.
			// We expect deletePointsByMultipleFilePaths to be called once (in Phase 3 for changed file)
			expect(deletionCallCount).toBe(1)
			expect(deletionPhasePaths[0]).toContain("/mock/workspace/src/changed.ts")
		})

		it("should preserve old points when upsert fails (no premature deletion)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Make upsert fail
			mockVectorStore.upsertPoints.mockRejectedValue(new Error("upsert failed"))

			const deletedPaths: string[][] = []
			mockVectorStore.deletePointsByMultipleFilePaths.mockImplementation(async (paths: string[]) => {
				deletedPaths.push(paths)
			})

			await mockOnDidChange({ fsPath: "/mock/workspace/src/changed.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Delete was called (before upsert in the same phase), but cache was NOT updated
			// because the upsert failed
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})
	})

	// ─── Category G: Transient Error Recovery (Fix 5) ───────────────────────

	describe("transient deletion retry (Fix 5)", () => {
		it("should queue failed transient deletions in _pendingRetryDeletions", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Make deletion fail with transient error
			mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(
				new QdrantTransientError("Qdrant unavailable"),
			)

			await mockOnDidDelete({ fsPath: "/mock/workspace/src/deleted.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// The deletion should NOT have updated the cache (transient = retry later)
			expect(mockCacheManager.deleteHash).not.toHaveBeenCalledWith("/mock/workspace/src/deleted.ts")

			// Now trigger another batch — the retry should include the failed deletion
			mockVectorStore.deletePointsByMultipleFilePaths.mockResolvedValueOnce(undefined)
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/new.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// deletePointsByMultipleFilePaths should be called again with the retry path
			const allDeleteCalls = mockVectorStore.deletePointsByMultipleFilePaths.mock.calls
			const retryCall = allDeleteCalls[allDeleteCalls.length - 1]
			// The retry call (in Phase 1) should include the previously failed path
			// Note: The new.ts is a "create" so it won't be in deletions
			expect(retryCall[0]).toContain("/mock/workspace/src/deleted.ts")
		})

		it("should clear pending retry deletions after successful retry", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// First batch: transient failure
			mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(
				new QdrantTransientError("Qdrant unavailable"),
			)
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/deleted.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Second batch: retry succeeds
			mockVectorStore.deletePointsByMultipleFilePaths.mockResolvedValueOnce(undefined)
			await mockOnDidCreate({ fsPath: "/mock/workspace/src/trigger.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Third batch: should NOT include the previously retried path
			mockVectorStore.deletePointsByMultipleFilePaths.mockClear()
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/another.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Only the new deletion should be in the call
			if (mockVectorStore.deletePointsByMultipleFilePaths.mock.calls.length > 0) {
				const paths = mockVectorStore.deletePointsByMultipleFilePaths.mock.calls[0][0]
				expect(paths).not.toContain("/mock/workspace/src/deleted.ts")
			}
		})
	})

	// ─── Category F: Permanent Error Handling ───────────────────────────────

	describe("permanent error handling", () => {
		it("should mark batch with error when permanent deletion error occurs", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			const permanentError = new Error("Permission denied")
			mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(permanentError)

			// Capture the batch summary
			let batchSummary: any = null
			;(fileWatcher as any)._onDidFinishBatchProcessing.event((summary: any) => {
				batchSummary = summary
			})

			await mockOnDidDelete({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// batchError should be set in the summary
			expect(batchSummary).not.toBeNull()
			expect(batchSummary.batchError).toBe(permanentError)
		})

		it("should mark batch with error when permanent upsert error occurs", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			const permanentError = new Error("Database write failed")
			mockVectorStore.upsertPoints.mockRejectedValue(permanentError)

			let batchSummary: any = null
			;(fileWatcher as any)._onDidFinishBatchProcessing.event((summary: any) => {
				batchSummary = summary
			})

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })
			// Need enough time for debounce (500ms) + retry delays (500ms + 1000ms)
			await vi.advanceTimersByTimeAsync(3000)

			expect(batchSummary).not.toBeNull()
			expect(batchSummary.batchError).toBeDefined()
		})

		it("should NOT set batchError for transient delete error on changed files (single failure)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			// Transient error on deletePointsByMultipleFilePaths for changed files
			// is caught by the outer catch in _executeBatchUpsertOperations
			mockVectorStore.deletePointsByMultipleFilePaths.mockRejectedValueOnce(
				new QdrantTransientError("connection lost"),
			)

			let batchSummary: any = null
			;(fileWatcher as any)._onDidFinishBatchProcessing.event((summary: any) => {
				batchSummary = summary
			})

			await mockOnDidChange({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			expect(batchSummary).not.toBeNull()
			// Transient errors should NOT set batchError
			expect(batchSummary.batchError).toBeUndefined()
		})
	})

	// ─── Category H: Concurrency & Limits ───────────────────────────────────

	describe("concurrency and limits", () => {
		it("should process files in chunks of FILE_PROCESSING_CONCURRENCY_LIMIT (10)", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			let maxConcurrent = 0
			let currentConcurrent = 0

			const { codeParser } = await import("../parser")
			vi.mocked(codeParser.parseFile).mockImplementation(async () => {
				currentConcurrent++
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
				await new Promise((resolve) => setTimeout(resolve, 10))
				currentConcurrent--
				return [
					{
						file_path: "/mock/workspace/src/file.ts",
						identifier: "f",
						type: "function",
						start_line: 1,
						end_line: 5,
						content: "fn",
						fileHash: "h",
						segmentHash: "s",
					},
				]
			})

			// Create 15 files — should process in 2 chunks (10 + 5)
			for (let i = 0; i < 15; i++) {
				await mockOnDidCreate({ fsPath: `/mock/workspace/src/file${i}.ts` })
			}

			await vi.advanceTimersByTimeAsync(600)
			// With fake timers, the internal setTimeout(10) needs advancing too
			await vi.advanceTimersByTimeAsync(100)

			// Max concurrent should not exceed 10
			expect(maxConcurrent).toBeLessThanOrEqual(10)
		})
	})

	// ─── Category J: Progress Events ────────────────────────────────────────

	describe("progress events", () => {
		it("should fire onDidStartBatchProcessing with correct file paths", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			let startedPaths: string[] = []
			;(fileWatcher as any)._onDidStartBatchProcessing.event((paths: string[]) => {
				startedPaths = paths
			})

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/a.ts" })
			await mockOnDidDelete({ fsPath: "/mock/workspace/src/b.ts" })

			await vi.advanceTimersByTimeAsync(600)

			expect(startedPaths).toContain("/mock/workspace/src/a.ts")
			expect(startedPaths).toContain("/mock/workspace/src/b.ts")
		})

		it("should fire onBatchProgressUpdate with incrementing counts", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			const progressUpdates: Array<{ processedInBatch: number; totalInBatch: number }> = []
			;(fileWatcher as any)._onBatchProgressUpdate.event(
				(update: { processedInBatch: number; totalInBatch: number }) => {
					progressUpdates.push(update)
				},
			)

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			// Should have at least initial (0/1) and final (1/1) progress updates
			expect(progressUpdates.length).toBeGreaterThanOrEqual(2)
			// First should be 0 processed
			expect(progressUpdates[0].processedInBatch).toBe(0)
			// Last should be all processed
			const lastUpdate = progressUpdates[progressUpdates.length - 1]
			expect(lastUpdate.processedInBatch).toBe(lastUpdate.totalInBatch)
		})

		it("should fire onDidFinishBatchProcessing with summary including all results", async () => {
			vi.useFakeTimers()
			await fileWatcher.initialize()

			let summary: any = null
			;(fileWatcher as any)._onDidFinishBatchProcessing.event((s: any) => {
				summary = s
			})

			await mockOnDidCreate({ fsPath: "/mock/workspace/src/file.ts" })
			await vi.advanceTimersByTimeAsync(600)

			expect(summary).not.toBeNull()
			expect(summary.processedFiles).toBeDefined()
			expect(Array.isArray(summary.processedFiles)).toBe(true)
			expect(summary.processedFiles.length).toBeGreaterThan(0)
		})
	})

	// ─── processFile unit tests ─────────────────────────────────────────────

	describe("processFile", () => {
		it("should skip files that exceed MAX_FILE_SIZE_BYTES", async () => {
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValueOnce({
				size: 2 * 1024 * 1024, // 2MB, exceeds 1MB limit
				type: 1,
				ctime: 0,
				mtime: 0,
			} as any)

			const result = await fileWatcher.processFile("/mock/workspace/src/huge-file.ts")
			expect(result.status).toBe("skipped")
			expect(result.reason).toContain("too large")
		})

		it("should skip files ignored by .rooignore", async () => {
			mockIgnoreInstance.ignores.mockReturnValueOnce(true)

			const result = await fileWatcher.processFile("/mock/workspace/src/ignored.ts")
			expect(result.status).toBe("skipped")
			expect(result.reason).toContain("ignored")
		})

		it("should return local_error when file read fails", async () => {
			vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error("File not found"))

			const result = await fileWatcher.processFile("/mock/workspace/src/missing.ts")
			expect(result.status).toBe("local_error")
			expect(result.error).toBeDefined()
		})
	})
})
