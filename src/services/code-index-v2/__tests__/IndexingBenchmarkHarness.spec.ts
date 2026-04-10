import { describe, expect, it } from "vitest"
import { formatIndexingBenchmarkReport } from "../eval/format-indexing-report"
import { IndexingBenchmarkHarness } from "../eval/IndexingBenchmarkHarness"

describe("IndexingBenchmarkHarness", () => {
	it("simulates a Wiz-like indexing run and reports throttle/backlog metrics", () => {
		const harness = new IndexingBenchmarkHarness()
		const report = harness.run({
			id: "wiz-like",
			totalFiles: 65_000,
			changedFiles: 65_000,
			averageChunksPerFile: 6,
			parseFilesPerTick: 60,
			plannerFilesPerTick: 40,
			embedChunksPerTick: 120,
			chunkRetryRate: 0.01,
			parseRetryRate: 0.005,
			slowEmbedEveryTicks: 10,
			slowEmbedMultiplier: 8,
			ticks: 400,
		})

		expect(report.aggregate.totalTicks).toBeGreaterThan(0)
		expect(report.aggregate.peakStagedChunks).toBeGreaterThan(0)
		expect(report.aggregate.peakQueuedJobs).toBeGreaterThan(0)
		expect(report.aggregate.finalBlockingReason).toBeTruthy()
		expect(report.snapshots.some((snapshot) => snapshot.parseThrottled)).toBe(true)
		expect(formatIndexingBenchmarkReport(report)).toContain("Code Index V2 Synthetic Indexing Benchmark")
	})
})
