import { IndexingBenchmarkReport } from "./types"

export function formatIndexingBenchmarkReport(report: IndexingBenchmarkReport): string {
	const { scenario, aggregate, snapshots } = report
	const lastSnapshot = snapshots[snapshots.length - 1]

	return [
		"Code Index V2 Synthetic Indexing Benchmark",
		"",
		`Scenario: ${scenario.id}`,
		`Files: ${scenario.totalFiles.toLocaleString()} total / ${scenario.changedFiles.toLocaleString()} changed`,
		`Ticks: ${aggregate.totalTicks.toLocaleString()}`,
		`Completed: ${aggregate.completed ? "yes" : "no"}`,
		`Committed files: ${aggregate.filesCommitted.toLocaleString()}`,
		`Peak staged chunks: ${aggregate.peakStagedChunks.toLocaleString()}`,
		`Peak staged bytes: ${aggregate.peakStagedChunkBytes.toLocaleString()}`,
		`Peak queued jobs: ${aggregate.peakQueuedJobs.toLocaleString()}`,
		`Parse throttled ticks: ${aggregate.parseThrottleTicks.toLocaleString()}`,
		`Retrying parse revisions: ${aggregate.retryingParseRevisions.toLocaleString()}`,
		`Retrying chunks: ${aggregate.retryingChunks.toLocaleString()}`,
		`Terminal failed revisions: ${aggregate.terminalFailedRevisions.toLocaleString()}`,
		`Terminal failed chunks: ${aggregate.terminalFailedChunks.toLocaleString()}`,
		`Final blocking reason: ${aggregate.finalBlockingReason}`,
		"",
		"Final snapshot:",
		`  Parsed ${lastSnapshot?.filesParsed.toLocaleString() ?? 0} / Planned ${lastSnapshot?.filesPlanned.toLocaleString() ?? 0} / Committed ${lastSnapshot?.filesCommitted.toLocaleString() ?? 0}`,
		`  Staged chunks ${lastSnapshot?.stagedChunks.toLocaleString() ?? 0} / queued upserts ${lastSnapshot?.queuedUpsertJobs.toLocaleString() ?? 0}`,
	].join("\n")
}
