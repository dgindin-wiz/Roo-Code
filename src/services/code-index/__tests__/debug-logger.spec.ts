import * as fs from "fs"
import * as zlib from "zlib"
import * as vscode from "vscode"

// Track the mock return value for getConfiguration
let mockDebugLoggingSetting = false

// Mock vscode before importing the module under test
vi.mock("vscode", () => {
	const _mockAppendLine = vi.fn()
	const _mockCreateOutputChannel = vi.fn().mockReturnValue({ appendLine: _mockAppendLine })
	return {
		workspace: {
			getConfiguration: vi.fn().mockImplementation(() => ({
				get: vi.fn().mockImplementation((key: string, defaultValue: any) => {
					if (key === "codeIndex.debugLogging") {
						return mockDebugLoggingSetting
					}
					return defaultValue
				}),
			})),
			workspaceFolders: [{ uri: { fsPath: "/workspace/my-project" } }, { uri: { fsPath: "/workspace/other" } }],
		},
		window: {
			createOutputChannel: _mockCreateOutputChannel,
		},
	}
})

// Mock fs to prevent actual file writes
vi.mock("fs", () => {
	const mockWrite = vi.fn().mockReturnValue(true)
	const mockEnd = vi.fn()
	return {
		createWriteStream: vi.fn().mockReturnValue({
			write: mockWrite,
			end: mockEnd,
		}),
		statSync: vi.fn().mockReturnValue({ size: 0 }),
		unlinkSync: vi.fn(),
		renameSync: vi.fn(),
		readFileSync: vi.fn().mockReturnValue(Buffer.from("log data")),
		writeFileSync: vi.fn(),
	}
})

// Mock zlib for compression tests
vi.mock("zlib", () => ({
	gzipSync: vi.fn().mockReturnValue(Buffer.from("compressed")),
}))

// Must import after mocks
import { IndexDebugLogger, LOG_MAX_BYTES } from "../debug-logger"

// Helper to get the mock appendLine function from the mocked vscode module
function getMockAppendLine(): ReturnType<typeof vi.fn> {
	const channel = (vscode.window.createOutputChannel as any).mock.results[0]?.value
	return channel?.appendLine ?? vi.fn()
}

function getMockCreateOutputChannel(): ReturnType<typeof vi.fn> {
	return vscode.window.createOutputChannel as any
}

describe("IndexDebugLogger", () => {
	beforeEach(() => {
		// Reset internal state between tests
		IndexDebugLogger.close()
		;(IndexDebugLogger as any)._stream = null
		;(IndexDebugLogger as any)._outputChannel = null
		;(IndexDebugLogger as any)._updateCount = 0
		;(IndexDebugLogger as any)._lastLogTime = 0
		;(IndexDebugLogger as any)._sessionStartTime = 0
		;(IndexDebugLogger as any)._workspaceName = "unknown"
		;(IndexDebugLogger as any)._workspacePath = ""
		;(IndexDebugLogger as any)._peakHeapMB = 0
		mockDebugLoggingSetting = false
		vi.clearAllMocks()
	})

	describe("setting-driven enable/disable", () => {
		it("should not write to log when codeIndex.debugLogging is false (default)", () => {
			mockDebugLoggingSetting = false

			IndexDebugLogger.log("Test", "method", { key: "value" })

			expect(fs.createWriteStream).not.toHaveBeenCalled()
		})

		it("should write to log when codeIndex.debugLogging is true", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method", { phaseTransition: true, key: "value" })

			expect(fs.createWriteStream).toHaveBeenCalled()
		})

		it("should not write suppressed logs when disabled", () => {
			mockDebugLoggingSetting = false

			IndexDebugLogger.logSuppressed("Test", "method", { key: "value" })

			expect(fs.createWriteStream).not.toHaveBeenCalled()
		})

		it("should write suppressed logs when enabled", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.logSuppressed("Test", "method", { key: "value" })

			expect(fs.createWriteStream).toHaveBeenCalled()
		})

		it("should respond to runtime setting changes", () => {
			// Start disabled
			mockDebugLoggingSetting = false
			IndexDebugLogger.log("Test", "method1", { phaseTransition: true })
			expect(fs.createWriteStream).not.toHaveBeenCalled()

			// Enable at runtime
			mockDebugLoggingSetting = true
			IndexDebugLogger.log("Test", "method2", { phaseTransition: true })
			expect(fs.createWriteStream).toHaveBeenCalled()
		})
	})

	describe("logPath", () => {
		it("should return a path ending with roo-index-debug.log", () => {
			expect(IndexDebugLogger.logPath).toMatch(/roo-index-debug\.log$/)
		})
	})

	describe("setContext", () => {
		it("should set workspace name from path basename", () => {
			IndexDebugLogger.setContext({
				workspacePath: "/Users/daniel/GitHub/wiz",
				embedderProvider: "openai",
				modelId: "text-embedding-3-small",
				qdrantUrl: "http://localhost:6333",
			})

			expect(IndexDebugLogger.workspaceName).toBe("wiz")
		})

		it("should reset session start time", () => {
			const before = Date.now()
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })
			const after = Date.now()

			expect(IndexDebugLogger.sessionStartTime).toBeGreaterThanOrEqual(before)
			expect(IndexDebugLogger.sessionStartTime).toBeLessThanOrEqual(after)
		})

		it("should reset update count", () => {
			;(IndexDebugLogger as any)._updateCount = 42
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })
			expect((IndexDebugLogger as any)._updateCount).toBe(0)
		})

		it("should write session header to OutputChannel", () => {
			IndexDebugLogger.setContext({
				workspacePath: "/Users/daniel/GitHub/wiz",
				embedderProvider: "openai",
				modelId: "text-embedding-3-small",
				qdrantUrl: "http://localhost:6333",
			})

			expect(getMockCreateOutputChannel()).toHaveBeenCalledWith("Roo Code: Index")
			const appendLine = getMockAppendLine()
			expect(appendLine).toHaveBeenCalled()
			const header = appendLine.mock.calls[0][0] as string
			expect(header).toContain("Code Index Session Started")
			expect(header).toContain("wiz")
			expect(header).toContain("openai")
			expect(header).toContain("text-embedding-3-small")
			expect(header).toContain("localhost:6333")
		})

		it("should write session header to file when debug logging is enabled", () => {
			mockDebugLoggingSetting = true
			IndexDebugLogger.setContext({
				workspacePath: "/test/project",
				embedderProvider: "ollama",
			})

			expect(fs.createWriteStream).toHaveBeenCalled()
			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const firstWriteCall = mockStream.write.mock.calls[0][0] as string
			expect(firstWriteCall).toContain("Code Index Session Started")
			expect(firstWriteCall).toContain("project")
			expect(firstWriteCall).toContain("ollama")
		})

		it("should NOT write session header to file when debug logging is disabled", () => {
			mockDebugLoggingSetting = false
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			expect(fs.createWriteStream).not.toHaveBeenCalled()
		})

		it("should include platform information in session header", () => {
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			const appendLine = getMockAppendLine()
			const header = appendLine.mock.calls[0][0] as string
			expect(header).toContain(process.platform)
			expect(header).toContain(process.arch)
		})

		it("should include open folder count in session header", () => {
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			const appendLine = getMockAppendLine()
			const header = appendLine.mock.calls[0][0] as string
			expect(header).toContain("openFolders")
			expect(header).toContain("2") // From our mock
		})

		it("should default to 'unknown' when workspace path is empty", () => {
			IndexDebugLogger.setContext({ workspacePath: "" })
			expect(IndexDebugLogger.workspaceName).toBe("unknown")
		})
	})

	describe("workspace tag in log lines", () => {
		it("should include workspace name tag in log lines", () => {
			mockDebugLoggingSetting = true
			IndexDebugLogger.setContext({ workspacePath: "/test/my-project" })
			vi.clearAllMocks()

			// Re-create stream mock after clearAllMocks
			;(IndexDebugLogger as any)._stream = null
			;(fs.createWriteStream as any).mockReturnValue({
				write: vi.fn().mockReturnValue(true),
				end: vi.fn(),
			})

			IndexDebugLogger.log("Test", "method", { phaseTransition: true, key: "value" })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toContain("[my-project]")
		})

		it("should show [unknown] when setContext was never called", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method", { phaseTransition: true })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toContain("[unknown]")
		})
	})

	describe("elapsed time", () => {
		it("should include elapsed time in log lines", () => {
			mockDebugLoggingSetting = true
			;(IndexDebugLogger as any)._sessionStartTime = Date.now() - 65000 // 1 min 5 sec ago
			;(IndexDebugLogger as any)._stream = null
			;(fs.createWriteStream as any).mockReturnValue({
				write: vi.fn().mockReturnValue(true),
				end: vi.fn(),
			})

			IndexDebugLogger.log("Test", "method", { phaseTransition: true })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toMatch(/\+0:01:0[45]/)
		})

		it("should show +0:00:00 when session not started", () => {
			mockDebugLoggingSetting = true
			;(IndexDebugLogger as any)._sessionStartTime = 0

			IndexDebugLogger.log("Test", "method", { phaseTransition: true })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toContain("+0:00:00")
		})
	})

	describe("OutputChannel integration", () => {
		it("should write phase transitions to OutputChannel", () => {
			mockDebugLoggingSetting = true
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			// Get the mock appendLine AFTER setContext created the channel
			const appendLine = getMockAppendLine()
			const callCountAfterSetContext = appendLine.mock.calls.length

			// Re-create file stream only
			;(IndexDebugLogger as any)._stream = null
			;(fs.createWriteStream as any).mockReturnValue({
				write: vi.fn().mockReturnValue(true),
				end: vi.fn(),
			})

			IndexDebugLogger.log("Orchestrator", "post-initialize", { phaseTransition: true, collectionCreated: false })

			expect(appendLine.mock.calls.length).toBeGreaterThan(callCountAfterSetContext)
			const channelLine = appendLine.mock.calls[appendLine.mock.calls.length - 1][0] as string
			expect(channelLine).toContain("Orchestrator.post-initialize")
			expect(channelLine).toContain("collectionCreated=false")
		})

		it("should NOT write non-transition logs to OutputChannel", () => {
			mockDebugLoggingSetting = true
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			// Get appendLine mock before clearing
			const appendLine = getMockAppendLine()
			const callCountAfterSetContext = appendLine.mock.calls.length

			;(IndexDebugLogger as any)._stream = null
			;(fs.createWriteStream as any).mockReturnValue({
				write: vi.fn().mockReturnValue(true),
				end: vi.fn(),
			})

			IndexDebugLogger.log("Scanner", "blocks-embedded", { batchSize: 10 })

			// OutputChannel should NOT have new writes after the log call
			expect(appendLine.mock.calls.length).toBe(callCountAfterSetContext)
		})

		it("should NOT write suppressed logs to OutputChannel", () => {
			mockDebugLoggingSetting = true
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			const appendLine = getMockAppendLine()
			const callCountAfterSetContext = appendLine.mock.calls.length

			;(IndexDebugLogger as any)._stream = null
			;(fs.createWriteStream as any).mockReturnValue({
				write: vi.fn().mockReturnValue(true),
				end: vi.fn(),
			})

			IndexDebugLogger.logSuppressed("StateManager", "reportEmbedProgress", { blocksEmbedded: 100 })

			expect(appendLine.mock.calls.length).toBe(callCountAfterSetContext)
		})
	})

	describe("logToChannel", () => {
		it("should write to OutputChannel even when debug logging is disabled", () => {
			mockDebugLoggingSetting = false
			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			// Get appendLine mock
			const appendLine = getMockAppendLine()
			const callCountAfterSetContext = appendLine.mock.calls.length

			IndexDebugLogger.logToChannel("Scan completed: 1000 blocks indexed")

			expect(appendLine.mock.calls.length).toBeGreaterThan(callCountAfterSetContext)
			const line = appendLine.mock.calls[appendLine.mock.calls.length - 1][0] as string
			expect(line).toContain("Scan completed: 1000 blocks indexed")
			expect(line).toContain("[project]")
		})

		it("should include elapsed time in channel messages", () => {
			IndexDebugLogger.setContext({ workspacePath: "/test/wiz" })

			// Override session start time after setContext
			;(IndexDebugLogger as any)._sessionStartTime = Date.now() - 5000

			const appendLine = getMockAppendLine()

			IndexDebugLogger.logToChannel("Some event")

			const line = appendLine.mock.calls[appendLine.mock.calls.length - 1][0] as string
			expect(line).toMatch(/\+0:00:0[45]/)
		})
	})

	describe("memory stats", () => {
		it("should include heapMB in phase transition logs", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method", { phaseTransition: true })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toMatch(/heapMB=\d+/)
		})

		it("should include heapMB in non-transition logs", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method", { key: "value" })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const logLine = mockStream.write.mock.calls[0][0] as string
			expect(logLine).toMatch(/heapMB=\d+/)
			expect(logLine).toMatch(/rssMB=\d+/)
		})

		it("should track peak heap memory", () => {
			const fakeMemory = 500
			vi.spyOn(IndexDebugLogger, "_getMemoryMB").mockReturnValue(fakeMemory)
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method1", { phaseTransition: true })

			expect((IndexDebugLogger as any)._peakHeapMB).toBe(fakeMemory)

			vi.mocked(IndexDebugLogger._getMemoryMB).mockRestore()
		})
	})

	describe("close session summary", () => {
		it("should include duration and event count in closing message", () => {
			mockDebugLoggingSetting = true
			;(IndexDebugLogger as any)._sessionStartTime = Date.now() - 120000 // 2 min
			;(IndexDebugLogger as any)._updateCount = 500
			;(IndexDebugLogger as any)._peakHeapMB = 800

			// Create the stream first
			IndexDebugLogger.log("Test", "method", { phaseTransition: true })

			// Get appendLine before close
			const appendLine = getMockAppendLine()
			const callCountBeforeClose = appendLine.mock.calls.length

			IndexDebugLogger.close()

			expect(appendLine.mock.calls.length).toBeGreaterThan(callCountBeforeClose)
			const channelLine = appendLine.mock.calls[appendLine.mock.calls.length - 1][0] as string
			expect(channelLine).toContain("Session ended")
			expect(channelLine).toContain("peakHeapMB=800")
		})

		it("should write summary to file log", () => {
			mockDebugLoggingSetting = true
			;(IndexDebugLogger as any)._updateCount = 42

			// Create stream by logging
			IndexDebugLogger.log("Test", "method", { phaseTransition: true })
			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			const writeCountBeforeClose = mockStream.write.mock.calls.length

			IndexDebugLogger.close()

			expect(mockStream.write.mock.calls.length).toBeGreaterThan(writeCountBeforeClose)
			const summaryLine = mockStream.write.mock.calls[mockStream.write.mock.calls.length - 1][0] as string
			expect(summaryLine).toContain("Session ended")
			expect(summaryLine).toContain("totalEvents=")
		})
	})

	describe("throttling", () => {
		it("should throttle non-transition logs to 1 per second", () => {
			mockDebugLoggingSetting = true

			// First call goes through
			IndexDebugLogger.log("Test", "method", { key: "a" })
			// Second call within 1 sec should be throttled
			IndexDebugLogger.log("Test", "method", { key: "b" })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			expect(mockStream.write.mock.calls.length).toBe(1)
		})

		it("should always log phase transitions even within throttle window", () => {
			mockDebugLoggingSetting = true

			IndexDebugLogger.log("Test", "method1", { phaseTransition: true })
			IndexDebugLogger.log("Test", "method2", { phaseTransition: true })

			const mockStream = (fs.createWriteStream as any).mock.results[0].value
			expect(mockStream.write.mock.calls.length).toBe(2)
		})
	})

	describe("log rotation", () => {
		it("should not rotate when file is below LOG_MAX_BYTES", () => {
			;(fs.statSync as any).mockReturnValue({ size: LOG_MAX_BYTES - 1 })

			IndexDebugLogger._rotateIfNeeded()

			expect(fs.readFileSync).not.toHaveBeenCalled()
			expect(zlib.gzipSync).not.toHaveBeenCalled()
		})

		it("should not rotate when log file does not exist", () => {
			;(fs.statSync as any).mockImplementation(() => {
				throw new Error("ENOENT")
			})

			IndexDebugLogger._rotateIfNeeded()

			expect(fs.readFileSync).not.toHaveBeenCalled()
			expect(zlib.gzipSync).not.toHaveBeenCalled()
		})

		it("should rotate when file exceeds LOG_MAX_BYTES", () => {
			;(fs.statSync as any).mockReturnValue({ size: LOG_MAX_BYTES + 1 })

			IndexDebugLogger._rotateIfNeeded()

			// Should read current log, compress, and write .1.gz
			expect(fs.readFileSync).toHaveBeenCalledWith(IndexDebugLogger.logPath)
			expect(zlib.gzipSync).toHaveBeenCalled()
			expect(fs.writeFileSync).toHaveBeenCalledWith(`${IndexDebugLogger.logPath}.1.gz`, expect.any(Buffer))
			// Should truncate current log
			expect(fs.writeFileSync).toHaveBeenCalledWith(IndexDebugLogger.logPath, "")
		})

		it("should shift existing rotated files (delete .2.gz, rename .1.gz → .2.gz)", () => {
			;(fs.statSync as any).mockReturnValue({ size: LOG_MAX_BYTES + 1 })

			IndexDebugLogger._rotateIfNeeded()

			// Should try to delete .2.gz (the oldest)
			expect(fs.unlinkSync).toHaveBeenCalledWith(`${IndexDebugLogger.logPath}.2.gz`)
			// Should try to rename .1.gz → .2.gz
			expect(fs.renameSync).toHaveBeenCalledWith(
				`${IndexDebugLogger.logPath}.1.gz`,
				`${IndexDebugLogger.logPath}.2.gz`,
			)
		})

		it("should close existing stream before rotating", () => {
			;(fs.statSync as any).mockReturnValue({ size: LOG_MAX_BYTES + 1 })
			// Set up a fake stream to verify it gets closed
			const mockEnd = vi.fn()
			;(IndexDebugLogger as any)._stream = { write: vi.fn(), end: mockEnd }

			IndexDebugLogger._rotateIfNeeded()

			expect(mockEnd).toHaveBeenCalled()
			expect((IndexDebugLogger as any)._stream).toBeNull()
		})

		it("should not throw when rotation encounters errors", () => {
			;(fs.statSync as any).mockReturnValue({ size: LOG_MAX_BYTES + 1 })
			;(fs.readFileSync as any).mockImplementation(() => {
				throw new Error("disk full")
			})

			// Should not throw
			expect(() => IndexDebugLogger._rotateIfNeeded()).not.toThrow()
		})

		it("should be called during setContext when debug logging is enabled", () => {
			mockDebugLoggingSetting = true
			const rotateSpy = vi.spyOn(IndexDebugLogger, "_rotateIfNeeded")

			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			expect(rotateSpy).toHaveBeenCalled()
			rotateSpy.mockRestore()
		})

		it("should NOT be called during setContext when debug logging is disabled", () => {
			mockDebugLoggingSetting = false
			const rotateSpy = vi.spyOn(IndexDebugLogger, "_rotateIfNeeded")

			IndexDebugLogger.setContext({ workspacePath: "/test/project" })

			expect(rotateSpy).not.toHaveBeenCalled()
			rotateSpy.mockRestore()
		})
	})
})
