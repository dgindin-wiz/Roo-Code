import { IndexingBenchmarkHarness } from "./IndexingBenchmarkHarness"
import { formatIndexingBenchmarkReport } from "./format-indexing-report"

async function main() {
	const harness = new IndexingBenchmarkHarness()
	const report = harness.run({
		id: "wiz-like-default",
		totalFiles: 65_000,
		changedFiles: 65_000,
		averageChunksPerFile: 6,
		parseFilesPerTick: 10,
		plannerFilesPerTick: 25,
		embedChunksPerTick: 300,
		chunkRetryRate: 0.01,
		parseRetryRate: 0.005,
		terminalChunkFailureRate: 0.001,
		slowEmbedEveryTicks: 20,
		slowEmbedMultiplier: 4,
	})

	console.log(formatIndexingBenchmarkReport(report))
}

void main()
