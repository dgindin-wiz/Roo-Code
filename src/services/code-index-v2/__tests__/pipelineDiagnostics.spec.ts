import { describe, expect, it } from "vitest"
import {
	buildPipelineBacklogSample,
	getParseThrottleReason,
	shouldPrioritizePlannerRefill,
	shouldResumeParseFromThrottle,
} from "../engine/pipelineDiagnostics"

describe("pipelineDiagnostics", () => {
	it("keeps planner refill active only while parsed revisions exist and upsert lanes are underfed", () => {
		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
				},
				stagedChunkLowWatermark: 300,
			}),
		).toBe(true)

		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 3,
					runningUpsertJobs: 0,
				},
				stagedChunkLowWatermark: 3,
			}),
		).toBe(false)

		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 200,
					runningUpsertJobs: 100,
				},
				stagedChunkLowWatermark: 300,
			}),
		).toBe(false)
	})

	it("builds backlog samples with parsed and runnable backlog fields for workspace logs", () => {
		const sample = buildPipelineBacklogSample({
			engine: "code-index-v2",
			runId: "run-1",
			workspacePath: "/workspace",
			stage: "embed",
			metrics: {
				parsedRevisions: 2,
				plannedRevisions: 1,
				stagedChunks: 5,
				queuedUpsertJobs: 4,
				runningUpsertJobs: 1,
				queuedDeleteJobs: 0,
				runningDeleteJobs: 0,
				blockingReason: "parsed_revisions_waiting_for_planning",
			},
			parseSchedulingThrottled: false,
			parseThrottleReason: null,
			plannerRefillPasses: 4,
			latestSyncTelemetry: {
				activeLaneCount: 1,
				inFlightChunkCount: 4,
				laneOccupancyPercent: 47,
				embedActivePercent: 92,
				chunksPerSecond: 42,
				pressureState: "soft",
				activationBurstLatencyMs: 215,
				readyRevisionCount: 8,
				activatedChunkCount: 188,
				supersededChunkCount: 164,
				averagePressureLatencyMs: 1_150,
				averageHostFinalizeLatencyMs: 3_200,
				lastPressureLatencyMs: 1_050,
				lastHostFinalizeLatencyMs: 3_000,
			},
		})

		expect(sample).toEqual(
			expect.objectContaining({
				component: "CodeIndexEngineV2",
				engine: "code-index-v2",
				runId: "run-1",
				workspacePath: "/workspace",
				stage: "embed",
				parsedRevisions: 2,
				plannedRevisions: 1,
				stagedChunks: 5,
				queuedUpsertJobs: 4,
				runningUpsertJobs: 1,
				blockingReason: "parsed_revisions_waiting_for_planning",
				parseSchedulingThrottled: false,
				parseThrottleReason: null,
				parsedChunkBacklog: 5,
				runnableEmbedQueueDepth: 5,
				totalVectorBacklog: 10,
				plannerRefillPasses: 4,
				activeLaneCount: 1,
				inFlightChunkCount: 4,
				laneOccupancyPercent: 47,
				embedActivePercent: 92,
				chunksPerSecond: 42,
				pressureState: "soft",
				activationBurstLatencyMs: 215,
				readyRevisionCount: 8,
				activatedChunkCount: 188,
				supersededChunkCount: 164,
				averagePressureLatencyMs: 1_150,
				averageHostFinalizeLatencyMs: 3_200,
				lastPressureLatencyMs: 1_050,
				lastHostFinalizeLatencyMs: 3_000,
			}),
		)
	})

	it("returns a planner starvation throttle reason when runnable embed work is empty but parsed backlog is ready", () => {
		expect(
			getParseThrottleReason({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 12,
					stagedChunks: 300,
					stagedChunkBytes: 0,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
				},
				parsedRevisionHighWatermark: 150,
				stagedChunkHighWatermark: 1_200,
				stagedChunkLowWatermark: 300,
				stagedBytesHighWatermark: 48 * 1024 * 1024,
			}),
		).toBe("planner_starvation_guard")
	})

	it("prefers the high watermark throttle reason over planner starvation", () => {
		expect(
			getParseThrottleReason({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 150,
					stagedChunks: 300,
					stagedChunkBytes: 0,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
				},
				parsedRevisionHighWatermark: 150,
				stagedChunkHighWatermark: 1_200,
				stagedChunkLowWatermark: 300,
				stagedBytesHighWatermark: 48 * 1024 * 1024,
			}),
		).toBe("high_watermark")
	})

	it("resumes planner starvation throttling once runnable work exists or parsed chunks fall below the low watermark", () => {
		expect(
			shouldResumeParseFromThrottle({
				metrics: {
					parsedRevisions: 12,
					stagedChunks: 300,
					stagedChunkBytes: 0,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
				},
				parseThrottleReason: "planner_starvation_guard",
				parsedRevisionLowWatermark: 40,
				stagedChunkLowWatermark: 300,
				stagedBytesLowWatermark: 16 * 1024 * 1024,
			}),
		).toBe(false)

		expect(
			shouldResumeParseFromThrottle({
				metrics: {
					parsedRevisions: 12,
					stagedChunks: 300,
					stagedChunkBytes: 0,
					queuedUpsertJobs: 1,
					runningUpsertJobs: 0,
				},
				parseThrottleReason: "planner_starvation_guard",
				parsedRevisionLowWatermark: 40,
				stagedChunkLowWatermark: 300,
				stagedBytesLowWatermark: 16 * 1024 * 1024,
			}),
		).toBe(true)

		expect(
			shouldResumeParseFromThrottle({
				metrics: {
					parsedRevisions: 12,
					stagedChunks: 299,
					stagedChunkBytes: 0,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
				},
				parseThrottleReason: "planner_starvation_guard",
				parsedRevisionLowWatermark: 40,
				stagedChunkLowWatermark: 300,
				stagedBytesLowWatermark: 16 * 1024 * 1024,
			}),
		).toBe(true)
	})
})
