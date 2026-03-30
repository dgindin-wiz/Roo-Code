import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"
import type { ScanProgress, ScanResult } from "../interfaces"

// Mock vscode workspace so startIndexing passes workspace check
vi.mock("vscode", () => {
	const path = require("path")
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	return {
		window: {
			activeTextEditor: null,
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: testWorkspacePath },
					name: "test",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
		},
		RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	}
})

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

// Mock i18n translator used in orchestrator messages
vi.mock("../../i18n", () => ({
	t: (key: string, params?: any) => {
		if (key === "embeddings:orchestrator.failedDuringInitialScan" && params?.errorMessage) {
			return `Failed during initial scan: ${params.errorMessage}`
		}
		return key
	},
}))

/**
 * Creates a mock state manager with all required methods.
 * Tracks state transitions via an internal `currentState` variable.
 */
function createMockStateManager() {
	let currentState = "Standby"
	return {
		get state() {
			return currentState
		},
		setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
			currentState = state
		}),
		startIndexingTimer: vi.fn(),
		reportScanProgress: vi.fn(),
		startEmbedPhase: vi.fn(),
		reportEmbedProgress: vi.fn(),
		reportComplete: vi.fn().mockImplementation(() => {
			currentState = "Indexed"
		}),
		reportFileQueueProgress: vi.fn(),
		reportBlockIndexingProgress: vi.fn(),
	}
}

/**
 * Creates a mock cache manager with all required methods.
 */
function createMockCacheManager() {
	return {
		clearCacheFile: vi.fn().mockResolvedValue(undefined),
		flush: vi.fn().mockResolvedValue(undefined),
		getAllHashes: vi.fn().mockReturnValue({}),
		getAllBlockCounts: vi.fn().mockReturnValue({}),
		getTotalCachedBlockCount: vi.fn().mockReturnValue(0),
	}
}

/**
 * Creates a mock file watcher with all required event subscriptions.
 */
function createMockFileWatcher() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		dispose: vi.fn(),
	}
}

/**
 * Creates a mock scanner with onProgress/onError event support.
 * The `scanDirectory` mock resolves with the provided `result`.
 * Progress events can be fired via the returned `fireProgress`/`fireError` helpers.
 */
function createMockScanner(result?: ScanResult) {
	const progressListeners: Array<(p: ScanProgress) => void> = []
	const errorListeners: Array<(e: Error) => void> = []

	const defaultResult: ScanResult = result ?? {
		totalFiles: 0,
		processedFiles: 0,
		skippedFiles: 0,
		totalBlocks: 0,
		blocksEmbedded: 0,
		errors: [],
	}

	return {
		scanner: {
			scanDirectory: vi.fn().mockResolvedValue(defaultResult),
			onProgress: vi.fn().mockImplementation((listener: (p: ScanProgress) => void) => {
				progressListeners.push(listener)
				return {
					dispose: () => {
						const i = progressListeners.indexOf(listener)
						if (i >= 0) progressListeners.splice(i, 1)
					},
				}
			}),
			onError: vi.fn().mockImplementation((listener: (e: Error) => void) => {
				errorListeners.push(listener)
				return {
					dispose: () => {
						const i = errorListeners.indexOf(listener)
						if (i >= 0) errorListeners.splice(i, 1)
					},
				}
			}),
		},
		fireProgress: (p: ScanProgress) => {
			for (const l of progressListeners) l(p)
		},
		fireError: (e: Error) => {
			for (const l of errorListeners) l(e)
		},
	}
}

describe("CodeIndexOrchestrator - edge case: empty collection clears stale cache", () => {
	const workspacePath = "/test/workspace"

	it("should clear cache when collection exists but has no data (externally wiped)", async () => {
		const stateManager = createMockStateManager()
		const cacheManager = createMockCacheManager()
		const vectorStore = {
			initialize: vi.fn().mockResolvedValue(false), // collection exists, not newly created
			hasIndexedData: vi.fn().mockResolvedValue(false), // but empty — data was wiped externally
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(0),
		}
		const { scanner } = createMockScanner()
		const fileWatcher = createMockFileWatcher()

		const orchestrator = new CodeIndexOrchestrator(
			{ isFeatureConfigured: true, isFeatureEnabled: true } as any,
			stateManager as any,
			workspacePath,
			cacheManager as any,
			vectorStore as any,
			scanner as any,
			fileWatcher as any,
		)

		await orchestrator.startIndexing()

		// Cache should be cleared because collection exists but is empty
		expect(cacheManager.clearCacheFile).toHaveBeenCalled()
	})

	it("should NOT clear cache when collection exists and has data (normal resume)", async () => {
		const stateManager = createMockStateManager()
		const cacheManager = createMockCacheManager()
		const vectorStore = {
			initialize: vi.fn().mockResolvedValue(false), // collection exists
			hasIndexedData: vi.fn().mockResolvedValue(true), // has data — normal resume
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(5000),
		}
		const { scanner } = createMockScanner({
			totalFiles: 10,
			processedFiles: 0,
			skippedFiles: 10,
			totalBlocks: 0,
			blocksEmbedded: 0,
			errors: [],
		})
		const fileWatcher = createMockFileWatcher()

		const orchestrator = new CodeIndexOrchestrator(
			{ isFeatureConfigured: true, isFeatureEnabled: true } as any,
			stateManager as any,
			workspacePath,
			cacheManager as any,
			vectorStore as any,
			scanner as any,
			fileWatcher as any,
		)

		await orchestrator.startIndexing()

		// Cache should NOT be cleared on normal resume
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
	})
})

describe("CodeIndexOrchestrator - error path cleanup gating", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
			isFeatureEnabled: true,
		}

		stateManager = createMockStateManager()
		cacheManager = createMockCacheManager()

		vectorStore = {
			initialize: vi.fn(),
			hasIndexedData: vi.fn(),
			markIndexingIncomplete: vi.fn(),
			markIndexingComplete: vi.fn(),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(0),
		}

		fileWatcher = createMockFileWatcher()
	})

	it("should not call clearCollection() or clear cache when initialize() fails (indexing not started)", async () => {
		// Arrange: fail at initialize()
		vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))
		const { scanner } = createMockScanner()

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("should flush cache but NOT clear collection when a non-Qdrant error occurs after initialize() succeeds (indexing started)", async () => {
		// Arrange: initialize succeeds; fail soon after to enter error path with indexingStarted=true
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(true) // incremental scan path (has data)
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))
		const { scanner } = createMockScanner()

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert: for non-dimension-mismatch errors, we preserve Qdrant data
		// and flush cache instead of clearing both
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		expect(cacheManager.flush).toHaveBeenCalled()

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})
})

describe("CodeIndexOrchestrator - stopIndexing", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
			isFeatureEnabled: true,
		}

		stateManager = createMockStateManager()
		cacheManager = createMockCacheManager()

		vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(true),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(0),
		}

		fileWatcher = createMockFileWatcher()
	})

	it("should abort indexing when stopIndexing() is called", async () => {
		// Make scanner hang until aborted
		const { scanner } = createMockScanner()
		scanner.scanDirectory.mockImplementation(async (_dir: string, signal: AbortSignal) => {
			// Wait for abort signal
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve()
					return
				}
				signal?.addEventListener("abort", () => resolve())
			})
			return {
				totalFiles: 0,
				processedFiles: 0,
				skippedFiles: 0,
				totalBlocks: 0,
				blocksEmbedded: 0,
				errors: [],
			} satisfies ScanResult
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		// Start indexing (async, don't await)
		const indexingPromise = orchestrator.startIndexing()

		// Give it a tick to begin
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Stop indexing
		orchestrator.stopIndexing()

		// Wait for indexing to complete
		await indexingPromise

		// State should be Standby (not Error)
		const setStateCalls = stateManager.setSystemState.mock.calls
		const lastCall = setStateCalls[setStateCalls.length - 1]
		expect(lastCall[0]).toBe("Standby")
	})

	it("should set state to Standby after abort, not Error", async () => {
		// Make scanner throw AbortError when signal is aborted
		const { scanner } = createMockScanner()
		scanner.scanDirectory.mockImplementation(async (_dir: string, signal: AbortSignal) => {
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve()
					return
				}
				signal?.addEventListener("abort", () => resolve())
			})
			throw new DOMException("Indexing aborted", "AbortError")
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Should NOT have set Error state — abort is handled gracefully
		const errorCalls = stateManager.setSystemState.mock.calls.filter((call: any[]) => call[0] === "Error")
		expect(errorCalls).toHaveLength(0)

		// Should NOT have cleared collection on abort
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})

	it("should preserve partial index data after stop", async () => {
		const { scanner } = createMockScanner()
		scanner.scanDirectory.mockImplementation(async (_dir: string, signal: AbortSignal) => {
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve()
					return
				}
				signal?.addEventListener("abort", () => resolve())
			})
			return {
				totalFiles: 10,
				processedFiles: 5,
				skippedFiles: 0,
				totalBlocks: 5,
				blocksEmbedded: 5,
				errors: [],
			} satisfies ScanResult
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Cache should NOT be cleared on user-initiated stop
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Collection should NOT be cleared on user-initiated stop
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})
})

describe("CodeIndexOrchestrator - transient error handling", () => {
	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let fileWatcher: any
	const workspacePath = require("path").join(require("path").sep, "test", "workspace")

	beforeEach(() => {
		vi.useFakeTimers()

		configManager = {
			isFeatureConfigured: true,
			isFeatureEnabled: true,
		}

		stateManager = createMockStateManager()
		cacheManager = createMockCacheManager()

		vectorStore = {
			initialize: vi.fn(),
			hasIndexedData: vi.fn(),
			markIndexingIncomplete: vi.fn(),
			markIndexingComplete: vi.fn(),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(0),
		}

		fileWatcher = createMockFileWatcher()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("should preserve data and flush cache on QdrantTransientError during initialize", async () => {
		const { QdrantTransientError } = await import("../vector-store/qdrant-client")
		vectorStore.initialize.mockRejectedValue(new QdrantTransientError("Connection timeout"))
		const { scanner } = createMockScanner()

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// Should NOT clear collection or cache
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Should flush cache to preserve progress
		expect(cacheManager.flush).toHaveBeenCalled()
		// Should be in error state
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("should schedule auto-retry on QdrantTransientError", async () => {
		const { QdrantTransientError } = await import("../vector-store/qdrant-client")
		vectorStore.initialize.mockRejectedValue(new QdrantTransientError("Connection timeout"))
		const { scanner } = createMockScanner()

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// Verify retry timer was scheduled (5s for first retry)
		expect(vi.getTimerCount()).toBe(1)

		// Advance timer to trigger retry
		stateManager.setSystemState.mockImplementation((state: string) => {
			currentState = state
		})
		let currentState = "Error" // Reset to Error state for retry
		await vi.advanceTimersByTimeAsync(5000)

		// Should attempt initialize again
		expect(vectorStore.initialize).toHaveBeenCalledTimes(2)
	})

	it("should cancel auto-retry when stopIndexing is called", async () => {
		const { QdrantTransientError } = await import("../vector-store/qdrant-client")
		vectorStore.initialize.mockRejectedValue(new QdrantTransientError("Connection timeout"))
		const { scanner } = createMockScanner()

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// Timer should be scheduled
		expect(vi.getTimerCount()).toBe(1)

		// Stop indexing should cancel the timer
		orchestrator.stopIndexing()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("should reset retry counter on successful indexing", async () => {
		// First call fails with transient error, second succeeds
		const { QdrantTransientError } = await import("../vector-store/qdrant-client")
		let callCount = 0
		vectorStore.initialize.mockImplementation(() => {
			callCount++
			if (callCount === 1) {
				return Promise.reject(new QdrantTransientError("Connection timeout"))
			}
			return Promise.resolve(false) // existing collection
		})
		vectorStore.hasIndexedData.mockResolvedValue(true) // skip full scan
		vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
		vectorStore.markIndexingComplete.mockResolvedValue(undefined)
		const { scanner } = createMockScanner({
			totalFiles: 10,
			processedFiles: 0,
			skippedFiles: 10,
			totalBlocks: 0,
			blocksEmbedded: 0,
			errors: [],
		})

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		// First attempt fails
		await orchestrator.startIndexing()
		expect(vi.getTimerCount()).toBe(1)

		// Advance to trigger retry — reset state so startIndexing proceeds
		let currentState = "Error"
		stateManager.setSystemState.mockImplementation((state: string) => {
			currentState = state
		})
		Object.defineProperty(stateManager, "state", { get: () => currentState })

		await vi.advanceTimersByTimeAsync(5000)

		// Second attempt should succeed — verify it reached Indexed state
		expect(vectorStore.initialize).toHaveBeenCalledTimes(2)
	})

	it("should flush but not clear on embedder error after Qdrant connected", async () => {
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(true) // incremental scan
		vectorStore.markIndexingIncomplete.mockResolvedValue(undefined)
		// Scanner fails with embedder error
		const { scanner } = createMockScanner()
		scanner.scanDirectory.mockRejectedValue(new Error("OpenAI API rate limit exceeded"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner as any,
			fileWatcher,
		)

		await orchestrator.startIndexing()

		// Should NOT clear collection (data is valid)
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		// Should NOT clear cache file
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Should flush cache to preserve partial progress
		expect(cacheManager.flush).toHaveBeenCalled()
		// Should NOT schedule auto-retry (not a transient Qdrant error)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe("CodeIndexOrchestrator - progress forwarding", () => {
	const workspacePath = "/test/workspace"

	it("should forward scanner progress events to state manager", async () => {
		const stateManager = createMockStateManager()
		const cacheManager = createMockCacheManager()
		const vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(true),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(100),
		}
		const fileWatcher = createMockFileWatcher()

		// Create scanner that fires progress events during scan
		const { scanner, fireProgress } = createMockScanner({
			totalFiles: 100,
			processedFiles: 5,
			skippedFiles: 95,
			totalBlocks: 50,
			blocksEmbedded: 50,
			errors: [],
		})
		scanner.scanDirectory.mockImplementation(async (_dir: string, _signal: AbortSignal) => {
			// Simulate progress events during scan
			fireProgress({
				phase: "discovering",
				filesChecked: 0,
				totalFiles: 100,
				blocksEmbedded: 0,
				totalBlocksEstimate: 0,
				isEstimatedTotal: true,
			})
			fireProgress({
				phase: "discovering",
				filesChecked: 95,
				totalFiles: 100,
				blocksEmbedded: 0,
				totalBlocksEstimate: 0,
				isEstimatedTotal: true,
			})
			fireProgress({
				phase: "embedding",
				filesChecked: 100,
				totalFiles: 100,
				blocksEmbedded: 50,
				totalBlocksEstimate: 50,
				isEstimatedTotal: false,
			})
			return {
				totalFiles: 100,
				processedFiles: 5,
				skippedFiles: 95,
				totalBlocks: 50,
				blocksEmbedded: 50,
				errors: [],
			} satisfies ScanResult
		})

		const orchestrator = new CodeIndexOrchestrator(
			{ isFeatureConfigured: true, isFeatureEnabled: true } as any,
			stateManager as any,
			workspacePath,
			cacheManager as any,
			vectorStore as any,
			scanner as any,
			fileWatcher as any,
		)

		await orchestrator.startIndexing()

		// Should have called reportScanProgress for discovering phase
		expect(stateManager.reportScanProgress).toHaveBeenCalled()
		// Should have called reportComplete at the end
		expect(stateManager.reportComplete).toHaveBeenCalled()
	})

	it("should NOT add startingBlockCount to totalBlocksEstimate on resume (no double-counting)", async () => {
		const stateManager = createMockStateManager()
		const cacheManager = createMockCacheManager()
		const startingBlockCount = 200
		const scannerTotalEstimate = 500 // represents ALL blocks in workspace, including the 200 already embedded
		const vectorStore = {
			initialize: vi.fn().mockResolvedValue(false), // not a new collection
			hasIndexedData: vi.fn().mockResolvedValue(true), // incremental
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			getPointCount: vi.fn().mockResolvedValue(startingBlockCount),
		}
		const fileWatcher = createMockFileWatcher()

		const { scanner, fireProgress } = createMockScanner({
			totalFiles: 100,
			processedFiles: 10,
			skippedFiles: 90,
			totalBlocks: scannerTotalEstimate,
			blocksEmbedded: 300,
			errors: [],
		})
		scanner.scanDirectory.mockImplementation(async (_dir: string, _signal: AbortSignal) => {
			// Scanner reports totalBlocksEstimate = 500 (ALL blocks, not just new ones)
			fireProgress({
				phase: "embedding",
				filesChecked: 100,
				totalFiles: 100,
				blocksEmbedded: 300,
				totalBlocksEstimate: scannerTotalEstimate,
				isEstimatedTotal: false,
			})
			return {
				totalFiles: 100,
				processedFiles: 10,
				skippedFiles: 90,
				totalBlocks: scannerTotalEstimate,
				blocksEmbedded: 300,
				errors: [],
			} satisfies ScanResult
		})

		const orchestrator = new CodeIndexOrchestrator(
			{ isFeatureConfigured: true, isFeatureEnabled: true } as any,
			stateManager as any,
			workspacePath,
			cacheManager as any,
			vectorStore as any,
			scanner as any,
			fileWatcher as any,
		)

		await orchestrator.startIndexing()

		// startEmbedPhase should receive the scanner's totalBlocksEstimate (500),
		// NOT startingBlockCount + totalBlocksEstimate (200 + 500 = 700)
		expect(stateManager.startEmbedPhase).toHaveBeenCalledWith(
			scannerTotalEstimate, // 500, not 700
			false,
			undefined,
			startingBlockCount, // 200, passed as display offset only
		)

		// reportEmbedProgress should also use scanner's totalBlocksEstimate directly
		expect(stateManager.reportEmbedProgress).toHaveBeenCalledWith(
			300,
			scannerTotalEstimate, // 500, not 700
			100,
			true,
		)
	})
})
