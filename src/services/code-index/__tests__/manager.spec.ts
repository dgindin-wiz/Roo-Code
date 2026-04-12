import { CodeIndexManager } from "../manager"
import { CodeIndexServiceFactory } from "../service-factory"
import { afterEach, beforeEach, describe, expect, it, vi, type MockedClass } from "vitest"
import * as path from "path"

const {
	testWorkspacePath: mockedTestWorkspacePath,
	mockedPathSep,
	workspaceFolderState,
} = vi.hoisted(() => {
	const testPath = require("path")
	const testWorkspacePath = testPath.join(testPath.sep, "test", "workspace")
	const createWorkspaceFolder = (fsPath: string, name = testPath.basename(fsPath), index = 0) => ({
		uri: {
			fsPath,
			scheme: "file",
			authority: "",
			path: fsPath,
			toString: (_skipEncoding?: boolean) => `file://${fsPath}`,
		},
		name,
		index,
	})

	return {
		testWorkspacePath,
		mockedPathSep: testPath.sep,
		workspaceFolderState: {
			workspaceFolders: [createWorkspaceFolder(testWorkspacePath, "test", 0)],
			createWorkspaceFolder,
		},
	}
})

const { mockCodeIndexEngineV2, MockedCodeIndexEngineV2Class } = vi.hoisted(() => {
	const engine = {
		start: vi.fn().mockResolvedValue(undefined),
		refreshAll: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		clear: vi.fn().mockResolvedValue(undefined),
		clearDatabase: vi.fn().mockResolvedValue(undefined),
		search: vi.fn().mockResolvedValue([]),
		enqueuePathsChanged: vi.fn().mockResolvedValue(undefined),
		getStatus: vi.fn().mockResolvedValue({
			engine: "v2",
			state: "idle",
			message: "Code Index V2 ready",
		}),
	}

	return {
		mockCodeIndexEngineV2: engine,
		MockedCodeIndexEngineV2Class: vi.fn(() => engine),
	}
})

// Helper: create a mock vscode.Uri from an fsPath
function mockUri(fsPath: string, scheme = "file") {
	return {
		fsPath,
		scheme,
		authority: "",
		path: fsPath,
		toString: (skipEncoding?: boolean) => `${scheme}://${fsPath}`,
	}
}

// Mock vscode module
vi.mock("vscode", () => {
	return {
		Uri: {
			file: (p: string) => ({
				fsPath: p,
				scheme: "file",
				authority: "",
				path: p,
				toString: (_skipEncoding?: boolean) => `file://${p}`,
			}),
			joinPath: vi.fn((...args: any[]) => ({ fsPath: args.join("/") })),
		},
		window: {
			activeTextEditor: null,
		},
		workspace: {
			get workspaceFolders() {
				return workspaceFolderState.workspaceFolders
			},
			set workspaceFolders(value) {
				workspaceFolderState.workspaceFolders = value
			},
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
			getConfiguration: vi.fn().mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "codeIndex.respectGitIgnore") {
						return true
					}
					if (key === "codeIndex.includeDefaultIgnoredGeneratedPaths") {
						return false
					}
					if (key === "codeIndex.embeddingLaneConcurrency") {
						return 2
					}
					if (key === "codeIndex.embeddingBatchSize") {
						return 60
					}
					if (key === "codeIndex.maxFiles") {
						return 100000
					}
					if (key === "codeIndex.debugLogging") {
						return false
					}
					return defaultValue
				}),
			}),
			getWorkspaceFolder: vi.fn((uri: { fsPath: string }) =>
				workspaceFolderState.workspaceFolders.find(
					(folder: any) =>
						uri.fsPath === folder.uri.fsPath ||
						uri.fsPath.startsWith(`${folder.uri.fsPath}${mockedPathSep}`),
				),
			),
		},
		RelativePattern: vi.fn().mockImplementation((base: any, pattern: any) => ({ base, pattern })),
	}
})

// Mock only the essential dependencies
vi.mock("../../../utils/path", () => {
	return {
		getWorkspacePath: vi.fn(() => mockedTestWorkspacePath),
		getWorkspaceFolderForPath: vi.fn((contextPath?: string) => {
			if (!contextPath) {
				return undefined
			}
			return workspaceFolderState.workspaceFolders.find(
				(folder: any) =>
					contextPath === folder.uri.fsPath || contextPath.startsWith(`${folder.uri.fsPath}${mockedPathSep}`),
			)
		}),
		getCurrentWorkspaceFolder: vi.fn(() => workspaceFolderState.workspaceFolders[0]),
	}
})

// Mock fs/promises for RooIgnoreController
vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockRejectedValue(new Error("File not found")), // Simulate no .gitignore/.rooignore
	},
}))

// Mock file utils for RooIgnoreController
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false), // Simulate no .rooignore file
}))

// Mock ignore module
vi.mock("ignore", () => ({
	default: vi.fn().mockReturnValue({
		add: vi.fn(),
		ignores: vi.fn().mockReturnValue(false),
	}),
}))

vi.mock("../state-manager", () => ({
	CodeIndexStateManager: vi.fn().mockImplementation(() => ({
		startIndexingTimer: vi.fn(),
		reportCustomProgress: vi.fn(),
		reportScanProgress: vi.fn(),
		startEmbedPhase: vi.fn(),
		reportEmbedProgress: vi.fn(),
		reportComplete: vi.fn(),
		onProgressUpdate: vi.fn(),
		getCurrentStatus: vi.fn(),
		dispose: vi.fn(),
		setSystemState: vi.fn(),
		setLoggerContext: vi.fn(),
		setResilienceStats: vi.fn(),
	})),
}))

vi.mock("../../code-index-v2", () => ({
	CodeIndexEngineV2: MockedCodeIndexEngineV2Class,
	IndexDebugLoggerV2: {
		log: vi.fn(),
	},
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("../service-factory")
const MockedCodeIndexServiceFactory = CodeIndexServiceFactory as MockedClass<typeof CodeIndexServiceFactory>

describe("CodeIndexManager - handleSettingsChange regression", () => {
	let mockContext: any
	let manager: CodeIndexManager

	// Define test paths for use in tests
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	const testExtensionPath = path.join(path.sep, "test", "extension")
	const testStoragePath = path.join(path.sep, "test", "storage")
	const testGlobalStoragePath = path.join(path.sep, "test", "global-storage")
	const testLogPath = path.join(path.sep, "test", "log")

	beforeEach(() => {
		// Clear all instances before each test
		CodeIndexManager.disposeAll()
		vi.clearAllMocks()
		mockCodeIndexEngineV2.start.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.refreshAll.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.stop.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.clear.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.clearDatabase.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.search.mockResolvedValue([])
		mockCodeIndexEngineV2.enqueuePathsChanged.mockResolvedValue(undefined)
		mockCodeIndexEngineV2.getStatus.mockResolvedValue({
			engine: "v2",
			state: "idle",
			message: "Code Index V2 ready",
		})

		const workspaceStateStore: Record<string, any> = {}
		const globalStateStore: Record<string, any> = {}
		mockContext = {
			subscriptions: [],
			workspaceState: {
				get: vi.fn((key: string, defaultValue?: any) => workspaceStateStore[key] ?? defaultValue),
				update: vi.fn(async (key: string, value: any) => {
					workspaceStateStore[key] = value
				}),
			} as any,
			globalState: {
				get: vi.fn((key: string, defaultValue?: any) => globalStateStore[key] ?? defaultValue),
				update: vi.fn(async (key: string, value: any) => {
					globalStateStore[key] = value
				}),
			} as any,
			extensionUri: {} as any,
			extensionPath: testExtensionPath,
			asAbsolutePath: vi.fn(),
			storageUri: {} as any,
			storagePath: testStoragePath,
			globalStorageUri: {} as any,
			globalStoragePath: testGlobalStoragePath,
			logUri: {} as any,
			logPath: testLogPath,
			extensionMode: 3, // vscode.ExtensionMode.Test
			secrets: {} as any,
			environmentVariableCollection: {} as any,
			extension: {} as any,
			languageModelAccessInformation: {} as any,
		}

		manager = CodeIndexManager.getInstance(mockContext)!
	})

	afterEach(() => {
		vi.useRealTimers()
		CodeIndexManager.disposeAll()
	})

	describe("handleSettingsChange", () => {
		it("should not throw when called on uninitialized manager (regression test)", async () => {
			// This is the core regression test: handleSettingsChange() should not throw
			// when called before the manager is initialized (during first-time configuration)

			// Ensure manager is not initialized
			expect(manager.isInitialized).toBe(false)

			// Mock a minimal config manager that simulates first-time configuration
			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			const mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Mock the feature state to simulate valid configuration that would normally trigger restart
			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

			// Mock service factory to handle _recreateServices call
			const mockServiceFactoryInstance = {
				configManager: mockConfigManager,
				workspacePath: testWorkspacePath,
				cacheManager: mockCacheManager,
				createEmbedder: vi.fn().mockReturnValue({ embedderInfo: { name: "openai" } }),
				createVectorStore: vi.fn().mockReturnValue({}),
				createDirectoryScanner: vi.fn().mockReturnValue({}),
				createFileWatcher: vi.fn().mockReturnValue({
					onDidStartBatchProcessing: vi.fn(),
					onBatchProgressUpdate: vi.fn(),
					watch: vi.fn(),
					stopWatcher: vi.fn(),
					dispose: vi.fn(),
				}),
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// The key test: this should NOT throw "CodeIndexManager not initialized" error
			await expect(manager.handleSettingsChange()).resolves.not.toThrow()

			// Verify that loadConfiguration was called (the method should still work)
			expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
		})

		it("should work normally when manager is initialized", async () => {
			// Mock a complete config manager with all required properties
			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			const mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Simulate an initialized manager by setting the required properties
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
			;(manager as any)._searchService = {}

			// Verify manager is considered initialized
			expect(manager.isInitialized).toBe(true)

			// Mock the feature state
			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

			// Mock service factory to handle _recreateServices call
			const mockServiceFactoryInstance = {
				configManager: mockConfigManager,
				workspacePath: testWorkspacePath,
				cacheManager: mockCacheManager,
				createEmbedder: vi.fn().mockReturnValue({ embedderInfo: { name: "openai" } }),
				createVectorStore: vi.fn().mockReturnValue({}),
				createDirectoryScanner: vi.fn().mockReturnValue({}),
				createFileWatcher: vi.fn().mockReturnValue({
					onDidStartBatchProcessing: vi.fn(),
					onBatchProgressUpdate: vi.fn(),
					watch: vi.fn(),
					stopWatcher: vi.fn(),
					dispose: vi.fn(),
				}),
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// Mock the methods that would be called during restart
			const recreateServicesSpy = vi.spyOn(manager as any, "_recreateServices")

			await manager.handleSettingsChange()

			// Verify that the restart sequence was called
			expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
			// _recreateServices should be called when requiresRestart is true
			expect(recreateServicesSpy).toHaveBeenCalled()
			// Note: startIndexing is NOT called by handleSettingsChange - it's only called by initialize()
		})

		it("should handle case when config manager is not set", async () => {
			// Ensure config manager is not set (edge case)
			;(manager as any)._configManager = undefined

			// This should not throw an error
			await expect(manager.handleSettingsChange()).resolves.not.toThrow()
		})
	})

	describe("v2 engine delegation", () => {
		let mockConfigManager: any
		let mockStateManager: any

		beforeEach(() => {
			mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				currentSearchMaxResults: 50,
			}
			;(manager as any)._configManager = mockConfigManager
			mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			vi.spyOn(manager, "selectedEngine", "get").mockReturnValue("v2" as any)
		})

		it("leaves v2 engine idle until indexing is started explicitly", async () => {
			const mockContextProxy = { refreshSecrets: vi.fn() } as any

			const result = await manager.initialize(mockContextProxy)

			expect(result).toEqual({ requiresRestart: false })
			expect(MockedCodeIndexEngineV2Class).toHaveBeenCalledWith(
				mockContext,
				testWorkspacePath,
				mockConfigManager,
				expect.any(Object),
			)
			expect(mockCodeIndexEngineV2.start).not.toHaveBeenCalled()
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "Code Index V2 is ready to start.")
		})

		it("delegates start, search, and clear to the v2 engine", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			mockCodeIndexEngineV2.getStatus.mockResolvedValue({
				engine: "v2",
				state: "idle",
				message: "V2 updated",
			})
			mockCodeIndexEngineV2.search.mockResolvedValue([
				{
					id: "point-1",
					score: 0.88,
					payload: {
						filePath: "src/example.ts",
						codeChunk: "const value = 1",
						startLine: 1,
						endLine: 1,
					},
				},
			])

			await manager.startIndexing()
			const results = await manager.searchIndex("find value")
			await manager.clearIndexData()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "V2 updated")
			expect(mockCodeIndexEngineV2.search).toHaveBeenCalledWith("find value", 50, {
				directoryPrefix: undefined,
			})
			expect(results).toHaveLength(1)
			expect(mockCodeIndexEngineV2.clear).toHaveBeenCalledTimes(1)
		})

		it("delegates stopIndexing to the v2 engine", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2

			await expect(manager.stopIndexing()).resolves.toBeUndefined()
			expect(mockCodeIndexEngineV2.stop).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "Indexing stopped.")
		})

		it("manual start bypasses an already scheduled deferred startup timer", async () => {
			vi.useFakeTimers()
			const mockContextProxy = { refreshSecrets: vi.fn() } as any

			await manager.initialize(mockContextProxy)
			;(manager as any).scheduleDeferredV2Start()
			await manager.startIndexing()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(6_000)
			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
		})

		it("startup watchdog stops runaway startup runs and avoids immediate restart thrash", async () => {
			vi.useFakeTimers()
			const mockContextProxy = { refreshSecrets: vi.fn() } as any
			let rejectStart: ((reason?: unknown) => void) | undefined
			mockCodeIndexEngineV2.start.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectStart = reject
					}),
			)
			mockCodeIndexEngineV2.stop.mockImplementationOnce(async () => {
				rejectStart?.(new Error("Stopped by user."))
			})
			const memoryUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
				rss: 950 * 1024 * 1024,
				heapTotal: 0,
				heapUsed: 0,
				external: 0,
				arrayBuffers: 0,
			})

			await manager.initialize(mockContextProxy)
			;(manager as any).scheduleDeferredV2Start()
			await vi.advanceTimersByTimeAsync(8_000)
			await Promise.resolve()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.stop).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Standby",
				"Startup indexing paused after extension host memory reached 950 MB.",
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)

			memoryUsageSpy.mockRestore()
		})

		it("manual start bypasses startup watchdog cooldown after a paused startup run", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			;(manager as any)._v2StartupCooldownUntil = Date.now() + 60_000
			;(manager as any)._startupV2AbortMessage =
				"Startup indexing paused after extension host memory reached 950 MB."
			mockCodeIndexEngineV2.start.mockReset().mockResolvedValueOnce(undefined)
			mockCodeIndexEngineV2.getStatus.mockReset().mockResolvedValueOnce({
				engine: "v2",
				state: "idle",
				message: "V2 updated",
			})

			await manager.startIndexing()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Code Index V2 is running...")
		})

		it("waits for an in-flight v2 stop before manual restart", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			;(manager as any)._v2EngineStarted = true

			let resolveStop: (() => void) | undefined
			mockCodeIndexEngineV2.stop.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveStop = resolve
					}),
			)
			mockCodeIndexEngineV2.start.mockReset().mockResolvedValueOnce(undefined)
			mockCodeIndexEngineV2.getStatus.mockReset().mockResolvedValueOnce({
				engine: "v2",
				state: "idle",
				message: "V2 restarted after stop",
			})

			const stopPromise = (manager as any).stopV2Engine()
			const restartPromise = manager.startIndexing()

			await Promise.resolve()
			expect(mockCodeIndexEngineV2.start).not.toHaveBeenCalled()

			resolveStop?.()
			await stopPromise
			await restartPromise

			expect(mockCodeIndexEngineV2.stop).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Code Index V2 is running...")
		})

		it("preserves structured warning and resume counts in manager status", async () => {
			await manager.setWorkspaceEnabled(true)

			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Indexed",
				message: "V2 mapped 66,017 files with warnings",
				processedItems: 210709,
				totalItems: 210709,
				currentItemUnit: "blocks",
				phase: "complete",
				totalFiles: 66017,
				totalBlocks: 210709,
				resumedRetryJobs: 4,
				resumedPendingJobs: 0,
				retryingParseRevisions: 2,
				terminalFailedParseRevisions: 3,
				degradedRevisions: 5,
				terminalFailedRevisions: 1,
				terminallyFailedChunks: 7,
				retryingChunks: 2,
			})

			const status = manager.getCurrentStatus()

			expect(status.workspaceEnabled).toBe(true)
			expect(status.totalFiles).toBe(66017)
			expect(status.totalBlocks).toBe(210709)
			expect(status.resumedRetryJobs).toBe(4)
			expect(status.resumedPendingJobs).toBe(0)
			expect(status.retryingParseRevisions).toBe(2)
			expect(status.terminalFailedParseRevisions).toBe(3)
			expect(status.degradedRevisions).toBe(5)
			expect(status.terminalFailedRevisions).toBe(1)
			expect(status.terminallyFailedChunks).toBe(7)
			expect(status.retryingChunks).toBe(2)
		})

		it("surfaces indexed-with-warnings status from a restarted v2 engine", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			mockCodeIndexEngineV2.getStatus.mockReset().mockResolvedValueOnce({
				engine: "v2",
				state: "idle",
				message:
					"V2 mapped 66,017 files, refreshed 57,625 changed files, and synced 210,709 chunks with warnings (3 parser-failed files, 5 degraded files, 1 failed file)",
			})

			await manager.startIndexing()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.getStatus).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenLastCalledWith(
				"Standby",
				"V2 mapped 66,017 files, refreshed 57,625 changed files, and synced 210,709 chunks with warnings (3 parser-failed files, 5 degraded files, 1 failed file)",
			)
		})

		it("moves a restarted v2 engine into error state when startup fails", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			mockCodeIndexEngineV2.start.mockRejectedValueOnce(new Error("resume adoption failed"))

			await expect(manager.startIndexing()).rejects.toThrow("resume adoption failed")

			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Code Index V2 is running...")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Error", "resume adoption failed")
		})

		it("rearms a manual v2 start when the engine reports a stale stopped status", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			mockCodeIndexEngineV2.start.mockReset().mockResolvedValue(undefined)
			mockCodeIndexEngineV2.stop.mockReset().mockResolvedValue(undefined)
			mockCodeIndexEngineV2.getStatus
				.mockReset()
				.mockResolvedValueOnce({
					engine: "v2",
					state: "idle",
					message: "Indexing stopped.",
				})
				.mockResolvedValueOnce({
					engine: "v2",
					state: "idle",
					message: "V2 restarted after stale stop",
				})

			await manager.startIndexing()

			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(2)
			expect(mockCodeIndexEngineV2.stop).toHaveBeenCalledTimes(1)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "V2 restarted after stale stop")
		})

		it("recovers v2 error state before manual restart", async () => {
			const mockContextProxy = { refreshSecrets: vi.fn() } as any
			;(manager as any)._contextProxy = mockContextProxy
			const recoverSpy = vi.spyOn(manager, "recoverFromError").mockResolvedValueOnce(undefined)
			const initializeSpy = vi.spyOn(manager, "initialize").mockResolvedValueOnce({ requiresRestart: false })
			mockStateManager.getCurrentStatus.mockReturnValueOnce({
				systemStatus: "Error",
				message: "Failed to fetch Qdrant collection info: 408 Request Timeout",
			})
			;(manager as any)._engineV2 = mockCodeIndexEngineV2

			await manager.startIndexing()

			expect(recoverSpy).toHaveBeenCalledTimes(1)
			expect(initializeSpy).toHaveBeenCalledWith(mockContextProxy)
			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
		})

		it("treats a user stop abort as standby instead of error", async () => {
			;(manager as any)._engineV2 = mockCodeIndexEngineV2
			mockCodeIndexEngineV2.start.mockRejectedValueOnce(new Error("Stopped by user."))

			await expect(manager.startIndexing()).resolves.toBeUndefined()

			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Code Index V2 is running...")
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "Indexing stopped.")
			expect(mockStateManager.setSystemState).not.toHaveBeenCalledWith("Error", expect.any(String))
		})

		it("awaits v2 shutdown during error recovery before clearing the engine reference", async () => {
			let releaseStop: (() => void) | undefined
			mockCodeIndexEngineV2.stop.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseStop = resolve
					}),
			)
			;(manager as any)._engineV2 = mockCodeIndexEngineV2

			const recoveryPromise = manager.recoverFromError()

			expect(mockCodeIndexEngineV2.stop).toHaveBeenCalledTimes(1)
			expect((manager as any)._engineV2).toBe(mockCodeIndexEngineV2)

			releaseStop?.()
			await recoveryPromise

			expect((manager as any)._engineV2).toBeUndefined()
		})
	})

	describe("embedder validation integration", () => {
		let mockServiceFactoryInstance: any
		let mockStateManager: any
		let mockEmbedder: any
		let mockVectorStore: any
		let mockScanner: any
		let mockFileWatcher: any

		beforeEach(() => {
			// Mock service factory objects
			mockEmbedder = { embedderInfo: { name: "openai" } }
			mockVectorStore = {}
			mockScanner = {}
			mockFileWatcher = {
				onDidStartBatchProcessing: vi.fn(),
				onBatchProgressUpdate: vi.fn(),
				watch: vi.fn(),
				stopWatcher: vi.fn(),
				dispose: vi.fn(),
			}

			// Mock service factory instance
			mockServiceFactoryInstance = {
				createServices: vi.fn().mockReturnValue({
					embedder: mockEmbedder,
					vectorStore: mockVectorStore,
					scanner: mockScanner,
					fileWatcher: mockFileWatcher,
				}),
				validateEmbedder: vi.fn(),
			}

			// Mock the ServiceFactory constructor
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance)

			// Mock state manager methods directly on the existing instance
			mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()

			// Mock config manager
			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager
		})

		it("should validate embedder during _recreateServices when validation succeeds", async () => {
			// Arrange
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({ valid: true })

			// Act - directly call the private method for testing
			await (manager as any)._recreateServices()

			// Assert
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).not.toHaveBeenCalledWith("Error", expect.any(String))
		})

		it("should set error state when embedder validation fails", async () => {
			// Arrange
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({
				valid: false,
				error: "embeddings:validation.authenticationFailed",
			})

			// Act & Assert
			await expect((manager as any)._recreateServices()).rejects.toThrow(
				"embeddings:validation.authenticationFailed",
			)

			// Assert other expectations
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				"embeddings:validation.authenticationFailed",
			)
		})

		it("should set generic error state when embedder validation throws", async () => {
			// Arrange
			// Since the real service factory catches exceptions, we should mock it to resolve with an error
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({
				valid: false,
				error: "embeddings:validation.configurationError",
			})

			// Act & Assert
			await expect((manager as any)._recreateServices()).rejects.toThrow(
				"embeddings:validation.configurationError",
			)

			// Assert other expectations
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				"embeddings:validation.configurationError",
			)
		})

		it("should handle embedder creation failure", async () => {
			// Arrange
			mockServiceFactoryInstance.createServices.mockImplementation(() => {
				throw new Error("Invalid configuration")
			})

			// Act & Assert - should throw the error
			await expect((manager as any)._recreateServices()).rejects.toThrow("Invalid configuration")

			// Should not attempt validation if embedder creation fails
			expect(mockServiceFactoryInstance.validateEmbedder).not.toHaveBeenCalled()
		})
	})

	describe("recoverFromError", () => {
		let mockConfigManager: any
		let mockCacheManager: any
		let mockStateManager: any

		beforeEach(() => {
			// Mock config manager
			mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Mock state manager
			mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Error",
				message: "Failed during initial scan: fetch failed",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			// Mock orchestrator and search service to simulate initialized state
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn(), state: "Error" }
			;(manager as any)._searchService = {}
			;(manager as any)._serviceFactory = {}
		})

		it("should clear error state when recoverFromError is called", async () => {
			// Act
			await manager.recoverFromError()

			// Assert
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "")
		})

		it("should reset internal service instances but preserve configManager", async () => {
			// Verify initial state
			expect((manager as any)._configManager).toBeDefined()
			expect((manager as any)._serviceFactory).toBeDefined()
			expect((manager as any)._orchestrator).toBeDefined()
			expect((manager as any)._searchService).toBeDefined()

			// Act
			await manager.recoverFromError()

			// Assert - runtime service instances should be undefined
			// but _configManager is intentionally preserved to avoid false restart detection
			expect((manager as any)._configManager).toBeDefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()
		})

		it("should make manager report as not initialized after recovery", async () => {
			// Verify initial state
			expect(manager.isInitialized).toBe(true)

			// Act
			await manager.recoverFromError()

			// Assert
			expect(manager.isInitialized).toBe(false)
		})

		it("should allow re-initialization after recovery", async () => {
			// Setup mock for re-initialization
			const mockServiceFactoryInstance = {
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// Act - recover from error
			await manager.recoverFromError()

			// Verify manager is not initialized
			expect(manager.isInitialized).toBe(false)

			// Mock context proxy for initialization
			const mockContextProxy = {
				getValue: vi.fn(),
				setValue: vi.fn(),
				storeSecret: vi.fn(),
				getSecret: vi.fn(),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				getGlobalState: vi.fn().mockReturnValue({
					codebaseIndexEnabled: true,
					codebaseIndexQdrantUrl: "http://localhost:6333",
					codebaseIndexEmbedderProvider: "openai",
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderModelDimension: 1536,
					codebaseIndexSearchMaxResults: 10,
					codebaseIndexSearchMinScore: 0.4,
				}),
			}

			// Enable workspace indexing before re-initialization
			await manager.setWorkspaceEnabled(true)

			// Re-initialize
			await manager.initialize(mockContextProxy as any)

			// Assert - manager should be initialized again
			expect(manager.isInitialized).toBe(true)
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalled()
		})

		it("should be safe to call when not in error state (idempotent)", async () => {
			// Setup manager in non-error state
			mockStateManager.getCurrentStatus.mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			// Verify initial state is not error
			const initialStatus = manager.getCurrentStatus()
			expect(initialStatus.systemStatus).not.toBe("Error")

			// Act - call recoverFromError when not in error state
			await expect(manager.recoverFromError()).resolves.not.toThrow()

			// Assert - should still clear state and runtime service instances
			// _configManager is intentionally preserved to avoid false restart detection
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "")
			expect((manager as any)._configManager).toBeDefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()
		})

		it("should continue recovery even if setSystemState throws", async () => {
			// Setup state manager to throw on setSystemState
			mockStateManager.setSystemState.mockImplementation(() => {
				throw new Error("State update failed")
			})

			// Setup manager with service instances
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._serviceFactory = {}
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
			;(manager as any)._searchService = {}

			// Spy on console.error
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// Act - should not throw despite setSystemState error
			await expect(manager.recoverFromError()).resolves.not.toThrow()

			// Assert - error should be logged
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to clear error state during recovery:",
				expect.any(Error),
			)

			// Assert - runtime service instances should still be cleared
			// _configManager is intentionally preserved to avoid false restart detection
			expect((manager as any)._configManager).toBeDefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()

			// Cleanup
			consoleErrorSpy.mockRestore()
		})
	})

	describe("workspace-enabled gating", () => {
		it("should not start indexing when workspace is not enabled", async () => {
			await manager.setAutoEnableDefault(false)

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			expect(manager.isWorkspaceEnabled).toBe(false)

			await manager.startIndexing()

			expect(mockStateManager.setSystemState).not.toHaveBeenCalledWith("Indexing", expect.any(String))
		})

		it("should include workspaceEnabled in getCurrentStatus", async () => {
			await manager.setAutoEnableDefault(false)

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			const status = manager.getCurrentStatus()
			expect(status.workspaceEnabled).toBe(false)
		})

		it("should persist workspace enabled state", async () => {
			await manager.setAutoEnableDefault(false)
			expect(manager.isWorkspaceEnabled).toBe(false)

			await manager.setWorkspaceEnabled(true)
			expect(manager.isWorkspaceEnabled).toBe(true)

			await manager.setWorkspaceEnabled(false)
			expect(manager.isWorkspaceEnabled).toBe(false)
		})

		it("should store enablement per folder URI, not per window", async () => {
			CodeIndexManager.disposeAll()

			const vscode = await import("vscode")

			const folderAPath = path.join(path.sep, "test", "folderA")
			const folderBPath = path.join(path.sep, "test", "folderB")
			const folderAUri = mockUri(folderAPath)
			const folderBUri = mockUri(folderBPath)

			// Both folders share the same workspaceState (same window)
			const sharedStore: Record<string, any> = {}
			const sharedContext = {
				...mockContext,
				workspaceState: {
					get: vi.fn((key: string, defaultValue?: any) => sharedStore[key] ?? defaultValue),
					update: vi.fn(async (key: string, value: any) => {
						sharedStore[key] = value
					}),
				} as any,
				globalState: {
					get: vi.fn((_key: string, _defaultValue?: any) => false),
					update: vi.fn(),
				} as any,
			}

			// Patch workspaceFolders to include both folders
			;(vscode.workspace as any).workspaceFolders = [
				{ uri: folderAUri, name: "folderA", index: 0 },
				{ uri: folderBUri, name: "folderB", index: 1 },
			]

			const managerA = CodeIndexManager.getInstance(sharedContext as any, folderAPath)!
			const managerB = CodeIndexManager.getInstance(sharedContext as any, folderBPath)!

			// Both start disabled (autoEnableDefault is false via globalState mock)
			expect(managerA.isWorkspaceEnabled).toBe(false)
			expect(managerB.isWorkspaceEnabled).toBe(false)

			// Enable A only
			await managerA.setWorkspaceEnabled(true)

			expect(managerA.isWorkspaceEnabled).toBe(true)
			expect(managerB.isWorkspaceEnabled).toBe(false)

			// Enable B, disable A
			await managerB.setWorkspaceEnabled(true)
			await managerA.setWorkspaceEnabled(false)

			expect(managerA.isWorkspaceEnabled).toBe(false)
			expect(managerB.isWorkspaceEnabled).toBe(true)

			CodeIndexManager.disposeAll()
		})

		it("should normalize nested paths to the containing workspace root", () => {
			CodeIndexManager.disposeAll()

			const nestedWorkspacePath = path.join(testWorkspacePath, "packages", "wiz")
			workspaceFolderState.workspaceFolders = [
				{
					uri: mockUri(testWorkspacePath),
					name: "workspace",
					index: 0,
				},
			]

			const rootManager = CodeIndexManager.getInstance(mockContext as any, testWorkspacePath)
			const nestedManager = CodeIndexManager.getInstance(mockContext as any, nestedWorkspacePath)

			expect(nestedManager).toBe(rootManager)
		})
	})

	describe("stopIndexing", () => {
		it("should delegate to orchestrator.stopIndexing()", async () => {
			const mockOrchestrator = {
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				state: "Indexing",
			}
			;(manager as any)._orchestrator = mockOrchestrator

			await manager.stopIndexing()

			expect(mockOrchestrator.stopIndexing).toHaveBeenCalled()
		})

		it("should be safe to call when orchestrator is not set", async () => {
			;(manager as any)._orchestrator = undefined

			await expect(manager.stopIndexing()).resolves.toBeUndefined()
		})
	})

	describe("handleSettingsChange - disable toggle bug fix", () => {
		it("should abort active indexing when feature is disabled", async () => {
			const mockOrchestrator = {
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				state: "Indexing",
			}
			;(manager as any)._orchestrator = mockOrchestrator

			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: false,
			}
			;(manager as any)._configManager = mockConfigManager

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()

			await manager.handleSettingsChange()

			expect(mockOrchestrator.stopIndexing).toHaveBeenCalled()
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "Code indexing is disabled")
		})
	})

	describe("clearIndexData — stops active scan before clearing", () => {
		it("should call stopIndexing before clearing index data", async () => {
			const callOrder: string[] = []

			const mockOrchestrator = {
				stopIndexing: vi.fn(() => callOrder.push("stopIndexing")),
				stopWatcher: vi.fn(),
				clearIndexData: vi.fn(async () => callOrder.push("clearIndexData")),
				state: "Indexing",
			}
			const mockCacheManager = {
				clearCacheFile: vi.fn(async () => callOrder.push("clearCacheFile")),
			}

			const mockConfigManager = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
			}
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._orchestrator = mockOrchestrator
			;(manager as any)._searchService = {}
			;(manager as any)._cacheManager = mockCacheManager

			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)

			await manager.clearIndexData()

			// stopIndexing must be called BEFORE clearIndexData
			expect(callOrder).toEqual(["stopIndexing", "clearIndexData", "clearCacheFile"])
		})

		it("should still clear data when not currently indexing", async () => {
			const mockOrchestrator = {
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				clearIndexData: vi.fn(),
				state: "Indexed",
			}
			const mockCacheManager = {
				clearCacheFile: vi.fn(),
			}

			const mockConfigManager = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
			}
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._orchestrator = mockOrchestrator
			;(manager as any)._searchService = {}
			;(manager as any)._cacheManager = mockCacheManager

			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)

			await manager.clearIndexData()

			expect(mockOrchestrator.stopIndexing).toHaveBeenCalled()
			expect(mockOrchestrator.clearIndexData).toHaveBeenCalled()
			expect(mockCacheManager.clearCacheFile).toHaveBeenCalled()
		})

		it("resets V2 startup state so manual start works after clear", async () => {
			vi.spyOn(manager, "selectedEngine", "get").mockReturnValue("v2" as any)

			const mockContextProxy = {
				getGlobalState: vi.fn((key: string) =>
					key === "codebaseIndexConfig"
						? {
								codebaseIndexEnabled: true,
								codebaseIndexQdrantUrl: "http://localhost:6333",
								codebaseIndexEmbedderProvider: "openai",
								codebaseIndexEmbedderModelId: "text-embedding-3-small",
							}
						: undefined,
				),
				getSecret: vi.fn((key: string) => (key === "codeIndexOpenAiKey" ? "test-openai-key" : undefined)),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				setValue: vi.fn(),
			} as any

			await manager.initialize(mockContextProxy)
			;(manager as any)._v2EngineStarted = true
			;(manager as any)._v2EngineStartPromise = Promise.resolve()
			;(manager as any)._startupV2StartPromise = Promise.resolve()
			;(manager as any)._v2StartupCooldownUntil = Date.now() + 60_000
			;(manager as any)._startupV2AbortMessage =
				"Startup indexing paused after extension host memory reached 974 MB."

			await manager.clearIndexData()
			await manager.startIndexing()
			await Promise.resolve()

			expect(mockCodeIndexEngineV2.clear).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.start).toHaveBeenCalledTimes(1)
			expect((manager as any)._v2EngineStarted).toBe(true)
			expect((manager as any)._v2StartupCooldownUntil).toBe(0)
			expect((manager as any)._startupV2AbortMessage).toBeUndefined()
		})

		it("delegates full database clears to the V2 engine database path", async () => {
			vi.spyOn(manager, "selectedEngine", "get").mockReturnValue("v2" as any)

			const mockContextProxy = {
				getGlobalState: vi.fn((key: string) =>
					key === "codebaseIndexConfig"
						? {
								codebaseIndexEnabled: true,
								codebaseIndexQdrantUrl: "http://localhost:6333",
								codebaseIndexEmbedderProvider: "openai",
								codebaseIndexEmbedderModelId: "text-embedding-3-small",
							}
						: undefined,
				),
				getSecret: vi.fn((key: string) => (key === "codeIndexOpenAiKey" ? "test-openai-key" : undefined)),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				setValue: vi.fn(),
			} as any

			await manager.initialize(mockContextProxy)
			await manager.clearIndexDatabase()

			expect(mockCodeIndexEngineV2.clearDatabase).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.clear).not.toHaveBeenCalled()
		})
	})

	describe("refreshAllIndexData", () => {
		it("delegates to the V2 engine refresh path", async () => {
			const manager = CodeIndexManager.getInstance(mockContext as any, testWorkspacePath)!
			vi.spyOn(manager, "selectedEngine", "get").mockReturnValue("v2" as any)
			const mockContextProxy = {
				getGlobalState: vi.fn((key: string) =>
					key === "codebaseIndexConfig"
						? {
								codebaseIndexEnabled: true,
								codebaseIndexQdrantUrl: "http://localhost:6333",
								codebaseIndexEmbedderProvider: "openai",
								codebaseIndexEmbedderModelId: "text-embedding-3-small",
							}
						: undefined,
				),
				getSecret: vi.fn((key: string) => (key === "codeIndexOpenAiKey" ? "test-openai-key" : undefined)),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				setValue: vi.fn(),
			} as any

			await manager.initialize(mockContextProxy)
			await manager.refreshAllIndexData()

			expect(mockCodeIndexEngineV2.refreshAll).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.clear).not.toHaveBeenCalled()
		})

		it("initializes before refreshing when V2 is not yet initialized", async () => {
			const manager = CodeIndexManager.getInstance(mockContext as any, testWorkspacePath)!
			vi.spyOn(manager, "selectedEngine", "get").mockReturnValue("v2" as any)
			;(manager as any)._contextProxy = {} as any
			const initializeSpy = vi.spyOn(manager, "initialize").mockImplementation(async () => {
				;(manager as any)._configManager = {
					isFeatureEnabled: true,
					isFeatureConfigured: true,
				}
				;(manager as any)._engineV2 = mockCodeIndexEngineV2
				return { requiresRestart: false }
			})

			await manager.refreshAllIndexData()

			expect(initializeSpy).toHaveBeenCalledTimes(1)
			expect(mockCodeIndexEngineV2.refreshAll).toHaveBeenCalledTimes(1)
		})
	})

	describe("startIndexing — auto-recovery from Error state", () => {
		it("should re-initialize and start indexing after recovering from Error", async () => {
			const mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Error",
				message: "Failed during initial scan",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn(), state: "Error" }
			;(manager as any)._searchService = {}
			;(manager as any)._serviceFactory = {}
			;(manager as any)._cacheManager = { initialize: vi.fn(), clearCacheFile: vi.fn() }

			// Store a contextProxy so startIndexing can re-initialize
			const mockContextProxy = {
				getValue: vi.fn(),
				setValue: vi.fn(),
				storeSecret: vi.fn(),
				getSecret: vi.fn(),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				getGlobalState: vi.fn().mockReturnValue({
					codebaseIndexEnabled: true,
					codebaseIndexQdrantUrl: "http://localhost:6333",
					codebaseIndexEmbedderProvider: "openai",
				}),
			}
			;(manager as any)._contextProxy = mockContextProxy

			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isWorkspaceEnabled", "get").mockReturnValue(true)

			// Mock initialize to set up services after recovery
			const initializeSpy = vi.spyOn(manager, "initialize").mockResolvedValue({ requiresRestart: false })
			const recoverSpy = vi.spyOn(manager, "recoverFromError")

			// After initialize, orchestrator should be set back up
			initializeSpy.mockImplementation(async () => {
				;(manager as any)._orchestrator = {
					startIndexing: vi.fn(),
					stopIndexing: vi.fn(),
					stopWatcher: vi.fn(),
					state: "Standby",
				}
				;(manager as any)._searchService = {}
				;(manager as any)._cacheManager = { initialize: vi.fn(), clearCacheFile: vi.fn() }
				return { requiresRestart: false }
			})

			await manager.startIndexing()

			// Should have called recoverFromError then initialize
			expect(recoverSpy).toHaveBeenCalled()
			expect(initializeSpy).toHaveBeenCalledWith(mockContextProxy)
		})

		it("should not re-initialize when not in Error state", async () => {
			const mockStateManager = (manager as any)._stateManager
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Indexed",
				message: "",
			})

			const mockOrchestrator = {
				startIndexing: vi.fn(),
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				state: "Indexed",
			}
			const mockConfigManager = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
			}
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._orchestrator = mockOrchestrator
			;(manager as any)._searchService = {}
			;(manager as any)._cacheManager = {}

			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isWorkspaceEnabled", "get").mockReturnValue(true)

			const recoverSpy = vi.spyOn(manager, "recoverFromError")

			await manager.startIndexing()

			expect(recoverSpy).not.toHaveBeenCalled()
			expect(mockOrchestrator.startIndexing).toHaveBeenCalled()
		})
	})
})
