import { beforeEach, describe, expect, it, vi } from "vitest"
import { DiffPlanner } from "../pipeline/DiffPlanner"

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
})
