import type { DiffPlannerSummary } from "../pipeline/DiffPlanner"
import { DiffPlanner } from "../pipeline/DiffPlanner"
import { SqliteMetadataRepository } from "./SqliteMetadataRepository"

type MetadataGatewayMethods = Pick<
	SqliteMetadataRepository,
	| "adoptRetryableJobsFromStaleRuns"
	| "adoptRevisionToRun"
	| "beginRun"
	| "claimJobs"
	| "claimJobsWithLease"
	| "countChunksForRevisions"
	| "cleanupStaleRuns"
	| "clearStorage"
	| "completeJobs"
	| "countActiveChunksForWorkspace"
	| "countActiveIndexedFilesForWorkspace"
	| "countOutstandingResumedJobs"
	| "countTrackedFilesForWorkspace"
	| "createFileRevision"
	| "dispose"
	| "enqueueJobs"
	| "ensureWorkspaceRecord"
	| "excludeFilesFromIndexing"
	| "failJob"
	| "finalizeReadyRevisionsBatch"
	| "findReusableRevision"
	| "getActiveChunksByFingerprints"
	| "getActiveChunksByRelativePaths"
	| "getActiveRevisionForFile"
	| "getBootstrapPath"
	| "getChunkVariantsByChunkIds"
	| "getChunksByIds"
	| "getChunksForRevision"
	| "getDatabasePath"
	| "getDiagnosticsDirectoryPath"
	| "getDiffBaselineRevision"
	| "getDiscoveredFilesByRelativePaths"
	| "getDiscoveredFilesForWorkspace"
	| "getFileRecordByWorkspacePathOptional"
	| "getNextRetryAt"
	| "getRunProgressRecord"
	| "getRevisionJobResolution"
	| "getRevisionsByState"
	| "getRunBacklogMetrics"
	| "getTelemetryDatabasePath"
	| "getTrackedFilesForWorkspace"
	| "getWorkspaceId"
	| "heartbeatJobs"
	| "heartbeatRun"
	| "initialize"
	| "listRevisionWarnings"
	| "listTrackedOversizedFiles"
	| "listTrackedOversizedRelativePaths"
	| "listPlannedRevisionResolutions"
	| "listWarningRelativePaths"
	| "markChunkState"
	| "markChunkStates"
	| "markChunkVariantStates"
	| "markFileTombstoned"
	| "markJobTerminalFailed"
	| "markRevisionCommitted"
	| "markRevisionDegraded"
	| "markRevisionState"
	| "markRevisionSuperseded"
	| "markRevisionTerminalFailure"
	| "markRunComplete"
	| "markRunDiscoveryComplete"
	| "markRunFailed"
	| "markRunStopped"
	| "persistParsedRevision"
	| "recordWatchEvent"
	| "releaseJobs"
	| "replaceTrackedOversizedFiles"
	| "searchActiveChunksLexically"
	| "searchActiveChunksLexicallyWithStatus"
	| "upsertFileRecords"
	| "appendRunSample"
	| "checkpointWal"
	| "performMaintenance"
	| "writeRunSummary"
>

export type MetadataGateway = MetadataGatewayMethods & {
	runPlannerSlice(
		runId: string,
		options?: { revisionIds?: string[]; limit?: number; maxJobs?: number },
		signal?: AbortSignal,
	): Promise<DiffPlannerSummary>
}

export class DirectMetadataGateway extends SqliteMetadataRepository implements MetadataGateway {
	async runPlannerSlice(
		runId: string,
		options?: { revisionIds?: string[]; limit?: number; maxJobs?: number },
		signal?: AbortSignal,
	): Promise<DiffPlannerSummary> {
		const planner = new DiffPlanner(this as any)
		return planner.run(runId, signal, options)
	}
}
