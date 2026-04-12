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
	const workspaceA = "/mock/workspace-a"
	const workspaceB = "/mock/workspace-b"
	const trackedKeys = ["shared:1", `${workspaceA}:parse:1`, `${workspaceB}:parse:1`]

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-logs-"))
		IndexDebugLoggerV2.configureDiagnosticsDirectory(tempDir)
	})

	afterEach(async () => {
		for (const key of trackedKeys) {
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(key)
		}
		IndexDebugLoggerV2.configureDiagnosticsDirectory(undefined, workspaceA)
		IndexDebugLoggerV2.configureDiagnosticsDirectory(undefined, workspaceB)
		IndexDebugLoggerV2.configureDiagnosticsDirectory(undefined)
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

	it("routes workspace-tagged logs to workspace-specific files", async () => {
		const workspaceDirA = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-logs-a-"))
		const workspaceDirB = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-logs-b-"))
		IndexDebugLoggerV2.configureDiagnosticsDirectory(workspaceDirA, workspaceA)
		IndexDebugLoggerV2.configureDiagnosticsDirectory(workspaceDirB, workspaceB)

		IndexDebugLoggerV2.updateTrackedProcessSnapshot("shared:1", "shared", "shared-host", undefined, 10, {
			rssMB: 5,
			heapUsedMB: 1,
			heapTotalMB: 1,
			externalMB: 0,
			arrayBuffersMB: 0,
		})
		IndexDebugLoggerV2.updateTrackedProcessSnapshot(
			`${workspaceA}:parse:1`,
			"parseSidecars",
			"parse-lane-1",
			workspaceA,
			11,
			{
				rssMB: 7,
				heapUsedMB: 1,
				heapTotalMB: 1,
				externalMB: 0,
				arrayBuffersMB: 0,
			},
		)
		IndexDebugLoggerV2.updateTrackedProcessSnapshot(
			`${workspaceB}:parse:1`,
			"parseSidecars",
			"parse-lane-1",
			workspaceB,
			12,
			{
				rssMB: 9,
				heapUsedMB: 1,
				heapTotalMB: 1,
				externalMB: 0,
				arrayBuffersMB: 0,
			},
		)

		IndexDebugLoggerV2.log("basic", "Test", "workspace-a-event", { workspacePath: workspaceA })
		IndexDebugLoggerV2.log("basic", "Test", "workspace-b-event", { workspacePath: workspaceB })
		IndexDebugLoggerV2.log("basic", "Test", "shared-event", {})

		const workspaceALogPath = IndexDebugLoggerV2.getLogPath(workspaceA)
		const workspaceBLogPath = IndexDebugLoggerV2.getLogPath(workspaceB)
		const sharedLogPath = IndexDebugLoggerV2.getLogPath()

		const workspaceALines = (await fs.readFile(workspaceALogPath, "utf-8")).trim().split("\n")
		const workspaceBLines = (await fs.readFile(workspaceBLogPath, "utf-8")).trim().split("\n")
		const sharedLines = (await fs.readFile(sharedLogPath, "utf-8")).trim().split("\n")

		const workspaceAEvent = JSON.parse(workspaceALines.at(-1)!)
		const workspaceBEvent = JSON.parse(workspaceBLines.at(-1)!)
		const sharedEvent = JSON.parse(sharedLines.at(-1)!)

		expect(workspaceALogPath.startsWith(workspaceDirA)).toBe(true)
		expect(workspaceBLogPath.startsWith(workspaceDirB)).toBe(true)
		expect(sharedLogPath.startsWith(tempDir)).toBe(true)
		expect(workspaceAEvent.message).toBe("workspace-a-event")
		expect(workspaceBEvent.message).toBe("workspace-b-event")
		expect(sharedEvent.message).toBe("shared-event")
		expect(workspaceAEvent.trackedProcesses.totalTrackedProcesses).toBe(2)
		expect(workspaceBEvent.trackedProcesses.totalTrackedProcesses).toBe(2)
		expect(sharedEvent.trackedProcesses.totalTrackedProcesses).toBe(1)

		await fs.rm(workspaceDirA, { recursive: true, force: true })
		await fs.rm(workspaceDirB, { recursive: true, force: true })
	})
})
