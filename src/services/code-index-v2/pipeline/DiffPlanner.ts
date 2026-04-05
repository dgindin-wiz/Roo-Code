import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"

export interface DiffPlannerSummary {
	runId: string
	plannedRevisions: number
	upsertJobs: number
	deleteJobs: number
}

export class DiffPlanner {
	constructor(private readonly metadataStore: MetadataStore) {}

	async run(runId: string, signal?: AbortSignal, options?: { revisionIds?: string[] }): Promise<DiffPlannerSummary> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const revisionIdSet = options?.revisionIds ? new Set(options.revisionIds) : undefined
		const revisions = await this.metadataStore.getRevisionsByState(workspaceId, "parsed", { runId })

		let plannedRevisions = 0
		let upsertJobs = 0
		let deleteJobs = 0

		for (const revision of revisions) {
			if (revision.runId !== runId || (revisionIdSet && !revisionIdSet.has(revision.revisionId))) {
				continue
			}

			if (signal?.aborted) {
				throw new Error("Diff planner aborted")
			}

			const currentChunks = await this.metadataStore.getChunksForRevision(revision.revisionId)
			const previousRevision = await this.metadataStore.getDiffBaselineRevision(
				revision.fileId,
				revision.revisionId,
			)
			const previousChunks = previousRevision
				? (await this.metadataStore.getChunksForRevision(previousRevision.revisionId)).filter(
						(chunk) => chunk.state === "upserted" && Boolean(chunk.vectorPointId),
					)
				: []

			const currentFingerprints = new Set(currentChunks.map((chunk) => chunk.chunkFingerprint))
			const previousFingerprints = new Set(previousChunks.map((chunk) => chunk.chunkFingerprint))

			const chunksToUpsert = currentChunks.filter((chunk) => !previousFingerprints.has(chunk.chunkFingerprint))
			const chunksToDelete = previousChunks.filter((chunk) => !currentFingerprints.has(chunk.chunkFingerprint))

			if (chunksToUpsert.length > 0) {
				await this.metadataStore.enqueueJobs(
					chunksToUpsert.map((chunk) => ({
						workspaceId,
						runId,
						jobType: "upsert",
						entityId: chunk.chunkId,
					})),
				)
			}

			if (chunksToDelete.length > 0) {
				await this.metadataStore.enqueueJobs(
					chunksToDelete.map((chunk) => ({
						workspaceId,
						runId,
						jobType: "delete",
						entityId: chunk.chunkId,
					})),
				)
			}

			await this.metadataStore.markRevisionState(revision.revisionId, "planned")

			plannedRevisions++
			upsertJobs += chunksToUpsert.length
			deleteJobs += chunksToDelete.length
		}

		IndexDebugLoggerV2.log("basic", "DiffPlanner", "diff-plan-complete", {
			component: "DiffPlanner",
			runId,
			jobId: `${plannedRevisions}:${upsertJobs}:${deleteJobs}`,
		})

		return {
			runId,
			plannedRevisions,
			upsertJobs,
			deleteJobs,
		}
	}
}
