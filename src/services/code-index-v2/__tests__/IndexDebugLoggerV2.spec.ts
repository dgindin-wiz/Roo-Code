import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
		}),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
	},
}))

import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"

describe("IndexDebugLoggerV2", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-logs-"))
		IndexDebugLoggerV2.configureDiagnosticsDirectory(tempDir)
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("writes logs into the configured diagnostics directory", async () => {
		IndexDebugLoggerV2.log("basic", "Test", "hello-world", { runId: "run-1" })

		const logPath = IndexDebugLoggerV2.getLogPath()
		const contents = await fs.readFile(logPath, "utf-8")

		expect(logPath.startsWith(tempDir)).toBe(true)
		expect(contents).toContain("hello-world")
		expect(IndexDebugLoggerV2.listLogFiles()).toContain(logPath)
	})
})
