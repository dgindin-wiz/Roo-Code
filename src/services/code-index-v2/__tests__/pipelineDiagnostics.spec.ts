import { describe, expect, it } from "vitest"
import { buildPipelineBacklogSample, shouldPrioritizePlannerRefill } from "../engine/pipelineDiagnostics"

describe("pipelineDiagnostics", () => {
	it("keeps planner refill active only while parsed revisions exist and upsert lanes are underfed", () => {
		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
					stagedChunks: 12,
				},
				stagedChunkHighWatermark: 1200,
			}),
		).toBe(true)

		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 3,
					runningUpsertJobs: 0,
					stagedChunks: 12,
				},
				stagedChunkHighWatermark: 1200,
			}),
		).toBe(false)

		expect(
			shouldPrioritizePlannerRefill({
				embedPhaseStarted: true,
				metrics: {
					parsedRevisions: 2,
					queuedUpsertJobs: 0,
					runningUpsertJobs: 0,
					stagedChunks: 1_200,
				},
				stagedChunkHighWatermark: 1200,
			}),
		).toBe(false)
	})

	it("builds backlog samples with backlog and embed-correlation fields for workspace logs", () => {
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
			embedQueueDepth: 10,
			latestSyncTelemetry: {
				activeLaneCount: 1,
				inFlightChunkCount: 4,
				laneOccupancyPercent: 47,
				embedActivePercent: 92,
				chunksPerSecond: 42,
				pressureState: "soft",
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
				embedQueueDepth: 10,
				activeLaneCount: 1,
				inFlightChunkCount: 4,
				laneOccupancyPercent: 47,
				embedActivePercent: 92,
				chunksPerSecond: 42,
				pressureState: "soft",
				averagePressureLatencyMs: 1_150,
				averageHostFinalizeLatencyMs: 3_200,
				lastPressureLatencyMs: 1_050,
				lastHostFinalizeLatencyMs: 3_000,
			}),
		)
	})
})
