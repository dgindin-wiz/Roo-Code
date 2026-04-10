import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { analyzeIndexingRunFromDebugLog, formatIndexingRunDiagnosis } from "../eval/IndexingRunDiagnosis"

describe("IndexingRunDiagnosis", () => {
	let tempDir = ""

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true })
			tempDir = ""
		}
	})

	it("diagnoses the latest workspace run from debug log lines", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-index-diagnosis-"))
		const logPath = path.join(tempDir, "roo-code-index-v2.log")
		await fs.writeFile(
			logPath,
			[
				JSON.stringify({
					timestamp: "2026-04-09T10:00:00.000Z",
					component: "ParseChunkService",
					message: "parse-chunk-progress",
					workspacePath: "/tmp/wiz",
					runId: "run-1",
				}),
				JSON.stringify({
					timestamp: "2026-04-09T10:00:02.000Z",
					component: "CodeIndexEngineV2",
					message: "index-performance-summary",
					workspacePath: "/tmp/wiz",
					runId: "run-1",
					discoveredFiles: 100,
					filesChanged: 50,
					chunksParsed: 250,
					vectorsCreated: 250,
					totalRunMs: 5_000,
				}),
			].join("\n"),
		)

		const diagnosis = await analyzeIndexingRunFromDebugLog({
			logPath,
			workspacePath: "/tmp/wiz",
		})

		expect(diagnosis.completed).toBe(true)
		expect(diagnosis.runId).toBe("run-1")
		expect(diagnosis.performanceSummary?.chunksParsed).toBe(250)
		expect(formatIndexingRunDiagnosis(diagnosis)).toContain("Completed: yes")
	})
})
