import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"

export interface DiffPlannerSummary {
	runId: string
	plannedRevisions: number
	upsertJobs: number
	deleteJobs: number
	reusedFingerprintUpserts: number
	deletedMissingFingerprintChunks: number
	safetyFallbackRevisions: number
	plannerSliceLatencyMs: number
}

export class DiffPlanner {
	constructor(private readonly metadataStore: MetadataStore) {}

	async run(
		runId: string,
		signal?: AbortSignal,
		options?: { revisionIds?: string[]; limit?: number; maxJobs?: number },
	): Promise<DiffPlannerSummary> {
		const plannerSliceStartedAt = Date.now()
		const workspaceId = this.metadataStore.getWorkspaceId()
		const revisionIdSet = options?.revisionIds ? new Set(options.revisionIds) : undefined
		const revisions = await this.metadataStore.getRevisionsByState(workspaceId, "parsed", {
			runId,
			limit: options?.limit,
		})

		let plannedRevisions = 0
		let upsertJobs = 0
		let deleteJobs = 0
		let reusedFingerprintUpserts = 0
		let deletedMissingFingerprintChunks = 0
		let safetyFallbackRevisions = 0
		const maxJobs = Math.max(1, options?.maxJobs ?? Number.MAX_SAFE_INTEGER)

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

			// Point IDs and payloads are revision-scoped, so even unchanged chunk fingerprints on a
			// newly parsed revision still need an upsert for the active revision to remain searchable.
			const chunksToUpsert = currentChunks
			const chunksToDelete = previousChunks.filter((chunk) => !currentFingerprints.has(chunk.chunkFingerprint))
			const reusedFingerprintCount = currentChunks.filter((chunk) =>
				previousFingerprints.has(chunk.chunkFingerprint),
			).length
			const projectedJobs = upsertJobs + deleteJobs + chunksToUpsert.length + chunksToDelete.length
			if (plannedRevisions > 0 && projectedJobs > maxJobs) {
				break
			}

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
			reusedFingerprintUpserts += reusedFingerprintCount
			deletedMissingFingerprintChunks += chunksToDelete.length
			if (previousChunks.length > 0 && reusedFingerprintCount > 0) {
				safetyFallbackRevisions++
			}

			IndexDebugLoggerV2.log("basic", "DiffPlanner", "diff-plan-revision", {
				component: "DiffPlanner",
				runId,
				revisionId: revision.revisionId,
				fileId: revision.fileId,
				currentChunkCount: currentChunks.length,
				previousChunkCount: previousChunks.length,
				upsertJobCount: chunksToUpsert.length,
				deleteJobCount: chunksToDelete.length,
				reusedFingerprintUpserts: reusedFingerprintCount,
				deleteReason: "missing_chunk_in_current_revision",
				upsertReason: "revision_scoped_payload_refresh",
				safetyFallbackApplied: previousChunks.length > 0 && reusedFingerprintCount > 0,
			})
		}

		IndexDebugLoggerV2.log("basic", "DiffPlanner", "diff-plan-complete", {
			component: "DiffPlanner",
			runId,
			plannerSliceLatencyMs: Date.now() - plannerSliceStartedAt,
			plannedRevisions,
			upsertJobs,
			deleteJobs,
			jobId: `${plannedRevisions}:${upsertJobs}:${deleteJobs}`,
			reusedFingerprintUpserts,
			deletedMissingFingerprintChunks,
			safetyFallbackRevisions,
			deleteChurnRatio:
				plannedRevisions > 0 ? Number((deleteJobs / Math.max(plannedRevisions, 1)).toFixed(3)) : undefined,
			upsertChurnRatio:
				upsertJobs > 0 ? Number((reusedFingerprintUpserts / Math.max(upsertJobs, 1)).toFixed(3)) : undefined,
		})

		return {
			runId,
			plannedRevisions,
			upsertJobs,
			deleteJobs,
			reusedFingerprintUpserts,
			deletedMissingFingerprintChunks,
			safetyFallbackRevisions,
			plannerSliceLatencyMs: Date.now() - plannerSliceStartedAt,
		}
	}
}
