export interface PipelineBacklogMetricsLike {
	parsedRevisions: number
	plannedRevisions: number
	stagedChunks: number
	stagedChunkBytes?: number
	queuedUpsertJobs: number
	runningUpsertJobs: number
	queuedDeleteJobs: number
	runningDeleteJobs: number
	blockingReason?: string | null
}

export type ParseThrottleReason = "high_watermark" | "planner_starvation_guard"

export interface PipelineEmbedTelemetryLike {
	activeLaneCount?: number
	inFlightChunkCount?: number
	laneOccupancyPercent?: number
	embedActivePercent?: number
	chunksPerSecond?: number
	pressureState?: string
	averagePressureLatencyMs?: number
	averageHostFinalizeLatencyMs?: number
	lastPressureLatencyMs?: number
	lastHostFinalizeLatencyMs?: number
}

export function shouldPrioritizePlannerRefill(input: {
	embedPhaseStarted: boolean
	metrics: Pick<PipelineBacklogMetricsLike, "parsedRevisions" | "queuedUpsertJobs" | "runningUpsertJobs">
	stagedChunkLowWatermark: number
}): boolean {
	const runnableEmbedQueueDepth = input.metrics.queuedUpsertJobs + input.metrics.runningUpsertJobs
	return (
		input.embedPhaseStarted &&
		input.metrics.parsedRevisions > 0 &&
		runnableEmbedQueueDepth < input.stagedChunkLowWatermark
	)
}

export function getParseThrottleReason(input: {
	embedPhaseStarted: boolean
	metrics: Pick<
		PipelineBacklogMetricsLike,
		"parsedRevisions" | "stagedChunks" | "stagedChunkBytes" | "queuedUpsertJobs" | "runningUpsertJobs"
	>
	parsedRevisionHighWatermark: number
	stagedChunkHighWatermark: number
	stagedChunkLowWatermark: number
	stagedBytesHighWatermark: number
}): ParseThrottleReason | null {
	const runnableEmbedQueueDepth = input.metrics.queuedUpsertJobs + input.metrics.runningUpsertJobs
	if (
		input.metrics.parsedRevisions >= input.parsedRevisionHighWatermark ||
		input.metrics.stagedChunks >= input.stagedChunkHighWatermark ||
		(input.metrics.stagedChunkBytes ?? 0) >= input.stagedBytesHighWatermark
	) {
		return "high_watermark"
	}

	if (
		input.embedPhaseStarted &&
		input.metrics.parsedRevisions > 0 &&
		runnableEmbedQueueDepth === 0 &&
		input.metrics.stagedChunks >= input.stagedChunkLowWatermark
	) {
		return "planner_starvation_guard"
	}

	return null
}

export function shouldResumeParseFromThrottle(input: {
	metrics: Pick<
		PipelineBacklogMetricsLike,
		"parsedRevisions" | "stagedChunks" | "stagedChunkBytes" | "queuedUpsertJobs" | "runningUpsertJobs"
	>
	parseThrottleReason: ParseThrottleReason | null
	parsedRevisionLowWatermark: number
	stagedChunkLowWatermark: number
	stagedBytesLowWatermark: number
}): boolean {
	if (input.parseThrottleReason === "planner_starvation_guard") {
		const runnableEmbedQueueDepth = input.metrics.queuedUpsertJobs + input.metrics.runningUpsertJobs
		return runnableEmbedQueueDepth > 0 || input.metrics.stagedChunks < input.stagedChunkLowWatermark
	}

	return (
		input.metrics.parsedRevisions <= input.parsedRevisionLowWatermark &&
		input.metrics.stagedChunks <= input.stagedChunkLowWatermark &&
		(input.metrics.stagedChunkBytes ?? 0) <= input.stagedBytesLowWatermark
	)
}

export function buildPipelineBacklogSample(input: {
	engine: string
	runId: string
	workspacePath: string
	stage: string
	metrics: PipelineBacklogMetricsLike
	parseSchedulingThrottled: boolean
	parseThrottleReason?: "high_watermark" | "planner_starvation_guard" | null
	plannerRefillPasses?: number
	latestSyncTelemetry?: PipelineEmbedTelemetryLike
}) {
	const parsedChunkBacklog = input.metrics.stagedChunks
	const runnableEmbedQueueDepth = input.metrics.queuedUpsertJobs + input.metrics.runningUpsertJobs
	const totalVectorBacklog = parsedChunkBacklog + runnableEmbedQueueDepth
	return {
		component: "CodeIndexEngineV2" as const,
		engine: input.engine,
		runId: input.runId,
		workspacePath: input.workspacePath,
		stage: input.stage,
		parsedRevisions: input.metrics.parsedRevisions,
		plannedRevisions: input.metrics.plannedRevisions,
		stagedChunks: input.metrics.stagedChunks,
		queuedUpsertJobs: input.metrics.queuedUpsertJobs,
		runningUpsertJobs: input.metrics.runningUpsertJobs,
		queuedDeleteJobs: input.metrics.queuedDeleteJobs,
		runningDeleteJobs: input.metrics.runningDeleteJobs,
		blockingReason: input.metrics.blockingReason,
		parseSchedulingThrottled: input.parseSchedulingThrottled,
		parseThrottleReason: input.parseThrottleReason ?? null,
		parsedChunkBacklog,
		runnableEmbedQueueDepth,
		totalVectorBacklog,
		plannerRefillPasses: input.plannerRefillPasses,
		activeLaneCount: input.latestSyncTelemetry?.activeLaneCount,
		inFlightChunkCount: input.latestSyncTelemetry?.inFlightChunkCount,
		laneOccupancyPercent: input.latestSyncTelemetry?.laneOccupancyPercent,
		embedActivePercent: input.latestSyncTelemetry?.embedActivePercent,
		chunksPerSecond: input.latestSyncTelemetry?.chunksPerSecond,
		pressureState: input.latestSyncTelemetry?.pressureState,
		averagePressureLatencyMs: input.latestSyncTelemetry?.averagePressureLatencyMs,
		averageHostFinalizeLatencyMs: input.latestSyncTelemetry?.averageHostFinalizeLatencyMs,
		lastPressureLatencyMs: input.latestSyncTelemetry?.lastPressureLatencyMs,
		lastHostFinalizeLatencyMs: input.latestSyncTelemetry?.lastHostFinalizeLatencyMs,
	}
}
