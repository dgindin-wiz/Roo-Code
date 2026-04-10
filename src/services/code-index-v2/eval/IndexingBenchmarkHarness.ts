import {
	IndexingBenchmarkAggregate,
	IndexingBenchmarkReport,
	IndexingBenchmarkScenario,
	IndexingBenchmarkTickSnapshot,
} from "./types"

export class IndexingBenchmarkHarness {
	private static readonly DEFAULT_STAGED_CHUNK_HIGH_WATERMARK = 1_200
	private static readonly DEFAULT_STAGED_CHUNK_LOW_WATERMARK = 300
	private static readonly DEFAULT_STAGED_BYTES_HIGH_WATERMARK = 48 * 1024 * 1024
	private static readonly DEFAULT_STAGED_BYTES_LOW_WATERMARK = 16 * 1024 * 1024
	private static readonly DEFAULT_PARSED_REVISION_HIGH_WATERMARK = 150
	private static readonly DEFAULT_PARSED_REVISION_LOW_WATERMARK = 40
	private static readonly APPROX_BYTES_PER_CHUNK = 1_536

	run(input: IndexingBenchmarkScenario): IndexingBenchmarkReport {
		const scenario: IndexingBenchmarkScenario = {
			deleteChunksPerTick: 0,
			parseRetryRate: 0,
			chunkRetryRate: 0,
			terminalChunkFailureRate: 0,
			ticks: 10_000,
			slowEmbedEveryTicks: 0,
			slowEmbedMultiplier: 1,
			...input,
		}

		let filesParsed = 0
		let filesPlanned = 0
		let filesCommitted = 0
		let stagedChunks = 0
		let stagedChunkBytes = 0
		let parsedWaitingForPlanning = 0
		let plannedWaitingForCommit = 0
		let queuedUpsertJobs = 0
		let runningUpsertJobs = 0
		let queuedDeleteJobs = 0
		let runningDeleteJobs = 0
		let retryingParseRevisions = 0
		let retryingChunks = 0
		let terminalFailedRevisions = 0
		let terminalFailedChunks = 0
		let parseThrottleTicks = 0
		let peakStagedChunks = 0
		let peakStagedChunkBytes = 0
		let peakQueuedJobs = 0

		const snapshots: IndexingBenchmarkTickSnapshot[] = []
		const totalFilesDiscovered = scenario.totalFiles
		const totalFilesHashed = scenario.changedFiles
		const chunksPerFile = Math.max(1, Math.round(scenario.averageChunksPerFile))
		const parseRetryChunkPenalty = Math.round(chunksPerFile * (scenario.parseRetryRate ?? 0))

		for (let tick = 1; tick <= (scenario.ticks ?? 10_000); tick++) {
			const parseThrottled =
				parsedWaitingForPlanning >= IndexingBenchmarkHarness.DEFAULT_PARSED_REVISION_HIGH_WATERMARK ||
				stagedChunks >= IndexingBenchmarkHarness.DEFAULT_STAGED_CHUNK_HIGH_WATERMARK ||
				stagedChunkBytes >= IndexingBenchmarkHarness.DEFAULT_STAGED_BYTES_HIGH_WATERMARK ||
				queuedUpsertJobs + runningUpsertJobs >= IndexingBenchmarkHarness.DEFAULT_STAGED_CHUNK_HIGH_WATERMARK

			if (parseThrottled) {
				parseThrottleTicks++
			}

			if (!parseThrottled && filesParsed + terminalFailedRevisions < scenario.changedFiles) {
				const parseCount = Math.min(
					scenario.parseFilesPerTick,
					scenario.changedFiles - filesParsed - terminalFailedRevisions,
				)
				filesParsed += parseCount
				parsedWaitingForPlanning += parseCount
				const parsedChunkCount = parseCount * chunksPerFile
				stagedChunks += parsedChunkCount
				stagedChunkBytes += parsedChunkCount * IndexingBenchmarkHarness.APPROX_BYTES_PER_CHUNK
				retryingParseRevisions += Math.round(parseCount * (scenario.parseRetryRate ?? 0))
				terminalFailedRevisions += Math.round(parseCount * ((scenario.parseRetryRate ?? 0) * 0.05))
				terminalFailedChunks += Math.round(parseCount * parseRetryChunkPenalty * 0.05)
			}

			const planCount = Math.min(scenario.plannerFilesPerTick, parsedWaitingForPlanning)
			if (planCount > 0) {
				parsedWaitingForPlanning -= planCount
				filesPlanned += planCount
				plannedWaitingForCommit += planCount
				queuedUpsertJobs += planCount * chunksPerFile
			}

			const embedMultiplier =
				scenario.slowEmbedEveryTicks &&
				scenario.slowEmbedEveryTicks > 0 &&
				tick % scenario.slowEmbedEveryTicks === 0
					? 1 / Math.max(1, scenario.slowEmbedMultiplier ?? 1)
					: 1
			const embedBudget = Math.max(1, Math.floor(scenario.embedChunksPerTick * embedMultiplier))
			const runnableUpsertJobs = Math.min(queuedUpsertJobs, embedBudget)
			queuedUpsertJobs -= runnableUpsertJobs
			runningUpsertJobs = runnableUpsertJobs

			const retriedChunkCount = Math.round(runnableUpsertJobs * (scenario.chunkRetryRate ?? 0))
			const terminalChunkCount = Math.round(runnableUpsertJobs * (scenario.terminalChunkFailureRate ?? 0))
			const successfulChunkCount = Math.max(0, runnableUpsertJobs - retriedChunkCount - terminalChunkCount)

			retryingChunks += retriedChunkCount
			terminalFailedChunks += terminalChunkCount
			stagedChunks = Math.max(0, stagedChunks - successfulChunkCount - terminalChunkCount)
			stagedChunkBytes = Math.max(
				0,
				stagedChunkBytes -
					(successfulChunkCount + terminalChunkCount) * IndexingBenchmarkHarness.APPROX_BYTES_PER_CHUNK,
			)
			queuedUpsertJobs += retriedChunkCount
			runningUpsertJobs = 0

			const committedFilesThisTick = Math.min(
				plannedWaitingForCommit,
				Math.floor(successfulChunkCount / chunksPerFile),
			)
			plannedWaitingForCommit -= committedFilesThisTick
			filesCommitted += committedFilesThisTick

			const deleteBudget = Math.min(queuedDeleteJobs, scenario.deleteChunksPerTick ?? 0)
			queuedDeleteJobs -= deleteBudget
			runningDeleteJobs = deleteBudget
			runningDeleteJobs = 0

			peakStagedChunks = Math.max(peakStagedChunks, stagedChunks)
			peakStagedChunkBytes = Math.max(peakStagedChunkBytes, stagedChunkBytes)
			peakQueuedJobs = Math.max(peakQueuedJobs, queuedUpsertJobs + queuedDeleteJobs)

			const blockingReason = this.getBlockingReason({
				parsedWaitingForPlanning,
				stagedChunks,
				queuedUpsertJobs,
				queuedDeleteJobs,
				retryingChunks,
				plannedWaitingForCommit,
			})

			snapshots.push({
				tick,
				filesDiscovered: totalFilesDiscovered,
				filesHashed: totalFilesHashed,
				filesParsed,
				filesPlanned,
				filesCommitted,
				stagedChunks,
				stagedChunkBytes,
				queuedUpsertJobs,
				runningUpsertJobs,
				queuedDeleteJobs,
				runningDeleteJobs,
				retryingParseRevisions,
				retryingChunks,
				terminalFailedRevisions,
				terminalFailedChunks,
				blockingReason,
				parseThrottled,
			})

			if (
				filesCommitted + terminalFailedRevisions >= scenario.changedFiles &&
				stagedChunks === 0 &&
				queuedUpsertJobs === 0 &&
				plannedWaitingForCommit === 0 &&
				parsedWaitingForPlanning === 0
			) {
				break
			}

			const canResumeParse =
				parsedWaitingForPlanning <= IndexingBenchmarkHarness.DEFAULT_PARSED_REVISION_LOW_WATERMARK &&
				stagedChunks <= IndexingBenchmarkHarness.DEFAULT_STAGED_CHUNK_LOW_WATERMARK &&
				stagedChunkBytes <= IndexingBenchmarkHarness.DEFAULT_STAGED_BYTES_LOW_WATERMARK &&
				queuedUpsertJobs <= IndexingBenchmarkHarness.DEFAULT_STAGED_CHUNK_LOW_WATERMARK
			if (parseThrottled && canResumeParse) {
				// Intentional no-op. The next tick can resume parse naturally.
			}
		}

		const finalSnapshot = snapshots[snapshots.length - 1]
		const aggregate: IndexingBenchmarkAggregate = {
			totalTicks: snapshots.length,
			completed:
				filesCommitted + terminalFailedRevisions >= scenario.changedFiles &&
				stagedChunks === 0 &&
				queuedUpsertJobs === 0 &&
				plannedWaitingForCommit === 0 &&
				parsedWaitingForPlanning === 0,
			filesCommitted,
			peakStagedChunks,
			peakStagedChunkBytes,
			peakQueuedJobs,
			parseThrottleTicks,
			retryingParseRevisions,
			retryingChunks,
			terminalFailedRevisions,
			terminalFailedChunks,
			finalBlockingReason: finalSnapshot?.blockingReason ?? "idle",
		}

		return {
			scenario,
			aggregate,
			snapshots,
		}
	}

	private getBlockingReason(input: {
		parsedWaitingForPlanning: number
		stagedChunks: number
		queuedUpsertJobs: number
		queuedDeleteJobs: number
		retryingChunks: number
		plannedWaitingForCommit: number
	}): string {
		if (input.parsedWaitingForPlanning > 0) {
			return "parsed_revisions_waiting_for_planning"
		}
		if (input.stagedChunks > 0) {
			return "staged_chunks_waiting_for_upsert"
		}
		if (input.queuedUpsertJobs > 0) {
			return "queued_upsert_jobs"
		}
		if (input.queuedDeleteJobs > 0) {
			return "queued_delete_jobs"
		}
		if (input.plannedWaitingForCommit > 0) {
			return "planned_revisions_waiting_for_commit"
		}
		if (input.retryingChunks > 0) {
			return "retry_backoff_jobs"
		}
		return "idle"
	}
}
