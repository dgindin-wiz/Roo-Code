import { beforeEach, describe, expect, it, vi } from "vitest"
import { DiffPlanner } from "../pipeline/DiffPlanner"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		log: vi.fn(),
	},
}))

describe("DiffPlanner", () => {
	const createDeps = () => {
		const metadataStore = {
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
			getRevisionsByState: vi.fn(),
			getChunksForRevision: vi.fn(),
			getDiffBaselineRevision: vi.fn(),
			enqueueJobs: vi.fn().mockResolvedValue(undefined),
			markRevisionState: vi.fn().mockResolvedValue(undefined),
		}

		return { metadataStore }
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the active degraded revision as the diff baseline and only compares vector-owning chunks", async () => {
		const { metadataStore } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-new",
				fileId: "file-1",
				runId: "run-1",
			},
		])
		metadataStore.getDiffBaselineRevision.mockResolvedValue({
			revisionId: "revision-degraded",
			fileId: "file-1",
			state: "degraded",
		})
		metadataStore.getChunksForRevision.mockImplementation(async (revisionId: string) => {
			if (revisionId === "revision-new") {
				return [
					{
						chunkId: "chunk-still-failed",
						chunkFingerprint: "fp-failed",
						state: "parsed",
						vectorPointId: null,
					},
					{
						chunkId: "chunk-new",
						chunkFingerprint: "fp-new",
						state: "parsed",
						vectorPointId: null,
					},
				]
			}

			return [
				{
					chunkId: "old-upserted",
					chunkFingerprint: "fp-healthy",
					state: "upserted",
					vectorPointId: "point-healthy",
				},
				{
					chunkId: "old-failed",
					chunkFingerprint: "fp-failed",
					state: "terminal_failed",
					vectorPointId: null,
				},
			]
		})

		const planner = new DiffPlanner(metadataStore as any)
		const summary = await planner.run("run-1")

		expect(metadataStore.enqueueJobs).toHaveBeenCalledTimes(2)
		expect(metadataStore.enqueueJobs).toHaveBeenNthCalledWith(1, [
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-still-failed",
			},
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-new",
			},
		])
		expect(metadataStore.enqueueJobs).toHaveBeenNthCalledWith(2, [
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "delete",
				entityId: "old-upserted",
			},
		])
		expect(metadataStore.markRevisionState).toHaveBeenCalledWith("revision-new", "planned")
		expect(summary.plannedRevisions).toBe(1)
		expect(summary.upsertJobs).toBe(2)
		expect(summary.deleteJobs).toBe(1)
	})

	it("re-enqueues unchanged chunk fingerprints for a new revision", async () => {
		const { metadataStore } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-new",
				fileId: "file-1",
				runId: "run-1",
			},
		])
		metadataStore.getDiffBaselineRevision.mockResolvedValue({
			revisionId: "revision-old",
			fileId: "file-1",
			state: "committed",
		})
		metadataStore.getChunksForRevision.mockImplementation(async (revisionId: string) => {
			if (revisionId === "revision-new") {
				return [
					{
						chunkId: "chunk-same",
						chunkFingerprint: "fp-same",
						state: "parsed",
						vectorPointId: null,
					},
					{
						chunkId: "chunk-new",
						chunkFingerprint: "fp-new",
						state: "parsed",
						vectorPointId: null,
					},
				]
			}

			return [
				{
					chunkId: "old-same",
					chunkFingerprint: "fp-same",
					state: "upserted",
					vectorPointId: "point-same",
				},
				{
					chunkId: "old-removed",
					chunkFingerprint: "fp-removed",
					state: "upserted",
					vectorPointId: "point-removed",
				},
			]
		})

		const planner = new DiffPlanner(metadataStore as any)
		const summary = await planner.run("run-1")

		expect(metadataStore.enqueueJobs).toHaveBeenCalledTimes(2)
		expect(metadataStore.enqueueJobs).toHaveBeenNthCalledWith(1, [
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-same",
			},
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-new",
			},
		])
		expect(metadataStore.enqueueJobs).toHaveBeenNthCalledWith(2, [
			{
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "delete",
				entityId: "old-removed",
			},
		])
		expect(metadataStore.markRevisionState).toHaveBeenCalledWith("revision-new", "planned")
		expect(summary.plannedRevisions).toBe(1)
		expect(summary.upsertJobs).toBe(2)
		expect(summary.deleteJobs).toBe(1)
	})

	it("logs planner slice latency and queued jobs for each diff-planning slice", async () => {
		const { metadataStore } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-new",
				fileId: "file-1",
				runId: "run-1",
			},
		])
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		metadataStore.getChunksForRevision.mockResolvedValue([
			{
				chunkId: "chunk-new",
				chunkFingerprint: "fp-new",
				state: "parsed",
				vectorPointId: null,
			},
		])
		const logSpy = vi.spyOn(IndexDebugLoggerV2, "log").mockImplementation(() => {})

		const planner = new DiffPlanner(metadataStore as any)
		const summary = await planner.run("run-1")

		const completeCall = logSpy.mock.calls.find(([, , message]) => message === "diff-plan-complete")
		expect(completeCall?.[3]).toEqual(
			expect.objectContaining({
				runId: "run-1",
				plannedRevisions: 1,
				upsertJobs: 1,
				deleteJobs: 0,
				plannerSliceLatencyMs: expect.any(Number),
			}),
		)
		expect(summary.plannerSliceLatencyMs).toEqual(expect.any(Number))
	})
})
