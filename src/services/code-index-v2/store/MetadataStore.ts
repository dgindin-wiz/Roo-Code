import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { createHash } from "crypto"
import { v4 as uuidv4 } from "uuid"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { CODE_INDEX_V2_DB_BASENAME } from "../shared/constants"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { CODE_INDEX_V2_SCHEMA, getCodeIndexV2SchemaVersion } from "./schema"
import {
	ChunkInput,
	ChunkRecord,
	ChunkWithRevisionRecord,
	FileRecord,
	FileRecordInput,
	FileRecordWithRevision,
	FileRevisionInput,
	FileRevisionRecord,
	FileRevisionWithFileRecord,
	JobInput,
	JobRecord,
	PaginatedRevisionWarningDetails,
	RevisionQueryOptions,
	RevisionJobResolution,
	RevisionWarningDetail,
	RunJobStateCounts,
	StaleRunCleanupSummary,
	WarningDetailsFilter,
	WarningDetailsSort,
	WatchEventRecord,
	WorkspaceRecord,
} from "./types"

interface SqliteStatement<TBind extends unknown[] = unknown[], TResult = unknown> {
	run(...params: TBind): TResult
	get(...params: TBind): TResult
	all(...params: TBind): TResult[]
}

interface SqliteDatabaseSync {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
	close(): void
}

const { DatabaseSync } = require("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabaseSync
}

const PRESERVED_PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface MetadataBootstrapFile {
	schemaVersion: number
	workspacePath: string
	dbPath: string
	schemaSql: string
	initializedAt: string
}

/**
 * Starter bootstrap for the future SQLite-backed metadata store.
 *
 * This class intentionally avoids introducing a SQLite dependency in the
 * scaffolding PR. It creates the durable filesystem location and writes a
 * schema manifest so the next slice can add a real DB implementation
 * without changing where state lives on disk.
 */
export class MetadataStore {
	private readonly workspaceHash: string
	private readonly rootDir: vscode.Uri
	private readonly dbPath: string
	private readonly bootstrapPath: string
	private _db: SqliteDatabaseSync | undefined

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly workspacePath: string,
	) {
		this.workspaceHash = createHash("sha256").update(workspacePath).digest("hex")
		this.rootDir = vscode.Uri.joinPath(context.globalStorageUri, "code-index-v2", this.workspaceHash)
		this.dbPath = path.join(this.rootDir.fsPath, CODE_INDEX_V2_DB_BASENAME)
		this.bootstrapPath = path.join(this.rootDir.fsPath, "bootstrap.json")
	}

	async initialize(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.rootDir)
		this._openDatabase()
		this._initializeSchema()
		await this.writeBootstrapFile()
		await this.ensureWorkspaceRecord()

		IndexDebugLoggerV2.log("basic", "MetadataStore", "bootstrap-initialized", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
		})
	}

	getDatabasePath(): string {
		return this.dbPath
	}

	getWorkspaceId(): string {
		return this.workspaceHash
	}

	getBootstrapPath(): string {
		return this.bootstrapPath
	}

	async readBootstrapFile(): Promise<MetadataBootstrapFile | undefined> {
		try {
			const raw = await fs.readFile(this.bootstrapPath, "utf-8")
			return JSON.parse(raw) as MetadataBootstrapFile
		} catch {
			return undefined
		}
	}

	async dispose(): Promise<void> {
		this._db?.close()
		this._db = undefined
	}

	async clearStorage(): Promise<void> {
		await this.dispose()
		await fs.rm(this.rootDir.fsPath, { recursive: true, force: true })

		IndexDebugLoggerV2.log("basic", "MetadataStore", "storage-cleared", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
		})
	}

	async ensureWorkspaceRecord(): Promise<WorkspaceRecord> {
		const now = Date.now()
		const workspaceId = this.workspaceHash
		this.db()
			.prepare(
				`INSERT INTO workspaces (workspace_id, workspace_path, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(workspace_id)
				 DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`,
			)
			.run(workspaceId, this.workspacePath, now, now)

		return {
			workspaceId,
			workspacePath: this.workspacePath,
		}
	}

	async beginRun(triggerType: string): Promise<string> {
		const runId = uuidv4()
		const now = Date.now()
		this.db()
			.prepare(
				`INSERT INTO index_runs (
					run_id, workspace_id, trigger_type, state, started_at, discovery_complete, reconciliation_complete
				) VALUES (?, ?, ?, ?, ?, 0, 0)`,
			)
			.run(runId, this.workspaceHash, triggerType, "started", now)

		return runId
	}

	async markRunDiscoveryComplete(runId: string): Promise<void> {
		this.db()
			.prepare(`UPDATE index_runs SET state = ?, discovery_complete = 1 WHERE run_id = ?`)
			.run("discovery_complete", runId)
	}

	async markRunComplete(runId: string): Promise<void> {
		this.db()
			.prepare(`UPDATE index_runs SET state = ?, completed_at = ? WHERE run_id = ?`)
			.run("complete", Date.now(), runId)
	}

	async markRunFailed(runId: string, errorMessage: string): Promise<void> {
		this.db()
			.prepare(`UPDATE index_runs SET state = ?, completed_at = ?, error_message = ? WHERE run_id = ?`)
			.run("failed", Date.now(), errorMessage, runId)
	}

	async markRunStopped(runId: string, errorMessage = "Stopped by user."): Promise<void> {
		const now = Date.now()
		this.db()
			.prepare(`UPDATE index_runs SET state = ?, completed_at = ?, error_message = ? WHERE run_id = ?`)
			.run("stopped", now, errorMessage, runId)

		this.db()
			.prepare(
				`UPDATE jobs
				 SET state = 'abandoned', last_error = ?, updated_at = ?
				 WHERE workspace_id = ?
					AND run_id = ?
					AND state IN ('queued', 'running')`,
			)
			.run(errorMessage, now, this.workspaceHash, runId)

		this.db()
			.prepare(
				`UPDATE file_revisions
				 SET state = 'failed', failure_reason = ?
				 WHERE run_id = ?
					AND state NOT IN ('hashed', 'parsed', 'planned', 'committed', 'superseded', 'failed')`,
			)
			.run(errorMessage, runId)

		this.db()
			.prepare(
				`UPDATE chunks
				 SET state = 'abandoned', updated_at = ?
				 WHERE revision_id IN (
					SELECT revision_id
					FROM file_revisions
					WHERE run_id = ?
				)
					AND revision_id NOT IN (
						SELECT revision_id
						FROM file_revisions
						WHERE run_id = ?
							AND state IN ('hashed', 'parsed', 'planned')
					)
					AND state NOT IN ('upserted', 'deleted', 'abandoned')`,
			)
			.run(now, runId, runId)
	}

	async cleanupStaleRuns(): Promise<StaleRunCleanupSummary> {
		const staleRuns = this.db()
			.prepare(
				`SELECT run_id AS runId
				FROM index_runs
				WHERE workspace_id = ?
					AND state NOT IN ('complete', 'failed', 'stopped')`,
			)
			.all(this.workspaceHash) as Array<{ runId: string }>

		if (staleRuns.length === 0) {
			const garbageCollection = this.garbageCollectExpiredPendingRuns()
			return {
				staleRunIds: [],
				staleRunsMarkedFailed: 0,
				staleJobsAbandoned: 0,
				staleJobsPreservedForResume: 0,
				staleRevisionsFailed: 0,
				staleChunksAbandoned: 0,
				expiredRunsDeleted: garbageCollection.expiredRunsDeleted,
				expiredJobsGarbageCollected: garbageCollection.expiredJobsGarbageCollected,
				expiredRevisionsGarbageCollected: garbageCollection.expiredRevisionsGarbageCollected,
				expiredChunksGarbageCollected: garbageCollection.expiredChunksGarbageCollected,
			}
		}

		const staleRunIds = staleRuns.map(({ runId }) => runId)
		const placeholders = staleRunIds.map(() => "?").join(", ")
		const now = Date.now()
		const errorMessage = "Marked stale after restart before the V2 run completed."
		const resumableJobs = this.db()
			.prepare(
				`SELECT job_id AS jobId
				FROM jobs
				WHERE workspace_id = ?
					AND run_id IN (${placeholders})
					AND state IN ('queued', 'running')`,
			)
			.all(this.workspaceHash, ...staleRunIds) as Array<{ jobId: string }>
		const resumableJobIds = new Set(resumableJobs.map(({ jobId }) => jobId))

		const updateRuns = this.db().prepare(
			`UPDATE index_runs
			 SET state = 'failed', completed_at = ?, error_message = ?
			 WHERE workspace_id = ?
				AND state NOT IN ('complete', 'failed', 'stopped')`,
		)
		updateRuns.run(now, errorMessage, this.workspaceHash)

		const updateJobs = this.db().prepare(
			`UPDATE jobs
			 SET state = 'abandoned', last_error = ?, updated_at = ?
			 WHERE workspace_id = ?
				AND run_id IN (${placeholders})
				AND state IN ('queued', 'running')
				AND job_id NOT IN (${resumableJobs.map(() => "?").join(", ") || "''"})`,
		)
		const jobsResult = updateJobs.run(
			errorMessage,
			now,
			this.workspaceHash,
			...staleRunIds,
			...resumableJobIds,
		) as { changes?: number }

		const requeueRunningJobs = this.db().prepare(
			`UPDATE jobs
			 SET state = 'queued', updated_at = ?
			 WHERE workspace_id = ?
				AND run_id IN (${placeholders})
				AND state = 'running'`,
		)
		requeueRunningJobs.run(now, this.workspaceHash, ...staleRunIds)

		const updateRevisions = this.db().prepare(
			`UPDATE file_revisions
			 SET state = 'failed', failure_reason = ?
			 WHERE run_id IN (${placeholders})
				AND state NOT IN ('hashed', 'parsed', 'planned')
				AND revision_id NOT IN (
					SELECT DISTINCT c.revision_id
					FROM chunks c
					INNER JOIN jobs j ON j.entity_id = c.chunk_id
					WHERE j.run_id IN (${placeholders})
						AND j.state IN ('queued', 'running')
				)
				AND state NOT IN ('committed', 'superseded', 'failed')`,
		)
		const revisionsResult = updateRevisions.run(errorMessage, ...staleRunIds, ...staleRunIds) as {
			changes?: number
		}

		const updateChunks = this.db().prepare(
			`UPDATE chunks
			 SET state = 'abandoned', updated_at = ?
			 WHERE revision_id IN (
				SELECT revision_id
				FROM file_revisions
				WHERE run_id IN (${placeholders})
			)
				AND revision_id NOT IN (
					SELECT revision_id
					FROM file_revisions
					WHERE run_id IN (${placeholders})
						AND state IN ('hashed', 'parsed', 'planned')
				)
				AND chunk_id NOT IN (
					SELECT entity_id
					FROM jobs
					WHERE run_id IN (${placeholders})
						AND state IN ('queued', 'running')
				)
				AND state NOT IN ('upserted', 'deleted', 'abandoned')`,
		)
		const chunksResult = updateChunks.run(now, ...staleRunIds, ...staleRunIds, ...staleRunIds) as {
			changes?: number
		}

		IndexDebugLoggerV2.log("basic", "MetadataStore", "stale-runs-cleaned", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
			runId: staleRunIds.join(","),
			jobId: `${jobsResult.changes ?? 0}:${revisionsResult.changes ?? 0}:${chunksResult.changes ?? 0}`,
		})
		const garbageCollection = this.garbageCollectExpiredPendingRuns()

		return {
			staleRunIds,
			staleRunsMarkedFailed: staleRunIds.length,
			staleJobsAbandoned: jobsResult.changes ?? 0,
			staleJobsPreservedForResume: resumableJobIds.size,
			staleRevisionsFailed: revisionsResult.changes ?? 0,
			staleChunksAbandoned: chunksResult.changes ?? 0,
			expiredRunsDeleted: garbageCollection.expiredRunsDeleted,
			expiredJobsGarbageCollected: garbageCollection.expiredJobsGarbageCollected,
			expiredRevisionsGarbageCollected: garbageCollection.expiredRevisionsGarbageCollected,
			expiredChunksGarbageCollected: garbageCollection.expiredChunksGarbageCollected,
		}
	}

	async adoptRetryableJobsFromStaleRuns(targetRunId: string, staleRunIds: string[]): Promise<number> {
		const resumableRuns = this.db()
			.prepare(
				`SELECT DISTINCT run_id AS runId
				FROM jobs
				WHERE workspace_id = ?
					AND run_id != ?
					AND state = 'queued'`,
			)
			.all(this.workspaceHash, targetRunId) as Array<{ runId: string }>
		const candidateRunIds = Array.from(new Set([...staleRunIds, ...resumableRuns.map(({ runId }) => runId)]))

		if (candidateRunIds.length === 0) {
			return 0
		}

		const placeholders = candidateRunIds.map(() => "?").join(", ")
		const now = Date.now()

		const adoptJobs = this.db().prepare(
			`UPDATE jobs
			 SET run_id = ?, state = 'queued', next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
			 WHERE workspace_id = ?
				AND run_id IN (${placeholders})
				AND state = 'queued'`,
		)
		const adoptedJobsResult = adoptJobs.run(targetRunId, now, now, this.workspaceHash, ...candidateRunIds) as {
			changes?: number
		}

		const adoptPlannedRevisions = this.db().prepare(
			`UPDATE file_revisions
			 SET run_id = ?
			 WHERE run_id IN (${placeholders})
				AND state = 'planned'
				AND revision_id IN (
					SELECT DISTINCT c.revision_id
					FROM chunks c
					INNER JOIN jobs j ON j.entity_id = c.chunk_id
					WHERE j.run_id = ?
						AND j.state = 'queued'
				)`,
		)
		adoptPlannedRevisions.run(targetRunId, ...candidateRunIds, targetRunId)

		return adoptedJobsResult.changes ?? 0
	}

	private garbageCollectExpiredPendingRuns(): {
		expiredRunsDeleted: number
		expiredJobsGarbageCollected: number
		expiredRevisionsGarbageCollected: number
		expiredChunksGarbageCollected: number
	} {
		const cutoff = Date.now() - PRESERVED_PENDING_RETENTION_MS
		const expiredRuns = this.db()
			.prepare(
				`SELECT run_id AS runId
				FROM index_runs
				WHERE workspace_id = ?
					AND state IN ('failed', 'stopped')
					AND completed_at IS NOT NULL
					AND completed_at < ?`,
			)
			.all(this.workspaceHash, cutoff) as Array<{ runId: string }>

		if (expiredRuns.length === 0) {
			return {
				expiredRunsDeleted: 0,
				expiredJobsGarbageCollected: 0,
				expiredRevisionsGarbageCollected: 0,
				expiredChunksGarbageCollected: 0,
			}
		}

		const expiredRunIds = expiredRuns.map(({ runId }) => runId)
		const placeholders = expiredRunIds.map(() => "?").join(", ")

		const deleteJobs = this.db().prepare(
			`DELETE FROM jobs
			 WHERE workspace_id = ?
				AND run_id IN (${placeholders})
				AND state = 'queued'`,
		)
		const deletedJobsResult = deleteJobs.run(this.workspaceHash, ...expiredRunIds) as { changes?: number }

		const deleteChunks = this.db().prepare(
			`DELETE FROM chunks
			 WHERE revision_id IN (
				SELECT revision_id
				FROM file_revisions
				WHERE run_id IN (${placeholders})
					AND state IN ('hashed', 'parsed', 'planned')
			)`,
		)
		const deletedChunksResult = deleteChunks.run(...expiredRunIds) as { changes?: number }

		const deleteRevisions = this.db().prepare(
			`DELETE FROM file_revisions
			 WHERE run_id IN (${placeholders})
				AND state IN ('hashed', 'parsed', 'planned')`,
		)
		const deletedRevisionsResult = deleteRevisions.run(...expiredRunIds) as { changes?: number }

		const deleteRuns = this.db().prepare(
			`DELETE FROM index_runs
			 WHERE workspace_id = ?
				AND run_id IN (${placeholders})
				AND run_id NOT IN (SELECT DISTINCT run_id FROM jobs)
				AND run_id NOT IN (SELECT DISTINCT run_id FROM file_revisions)`,
		)
		const deletedRunsResult = deleteRuns.run(this.workspaceHash, ...expiredRunIds) as { changes?: number }

		IndexDebugLoggerV2.log("basic", "MetadataStore", "expired-pending-runs-garbage-collected", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
			runId: expiredRunIds.join(","),
			jobId: `${deletedRunsResult.changes ?? 0}:${deletedJobsResult.changes ?? 0}:${deletedRevisionsResult.changes ?? 0}:${deletedChunksResult.changes ?? 0}`,
		})

		return {
			expiredRunsDeleted: deletedRunsResult.changes ?? 0,
			expiredJobsGarbageCollected: deletedJobsResult.changes ?? 0,
			expiredRevisionsGarbageCollected: deletedRevisionsResult.changes ?? 0,
			expiredChunksGarbageCollected: deletedChunksResult.changes ?? 0,
		}
	}

	async upsertFileRecord(input: FileRecordInput): Promise<FileRecord> {
		const now = Date.now()
		const existing = this.db()
			.prepare(`SELECT file_id AS fileId FROM files WHERE workspace_id = ? AND relative_path = ?`)
			.get(input.workspaceId, input.relativePath) as { fileId?: string } | undefined

		const fileId = existing?.fileId ?? uuidv4()

		this.db()
			.prepare(
				`INSERT INTO files (
					file_id, workspace_id, relative_path, normalized_path, last_seen_mtime_ms,
					last_seen_size, ignore_state, active_revision_id, tombstoned, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
				ON CONFLICT(workspace_id, relative_path)
				DO UPDATE SET
					normalized_path = excluded.normalized_path,
					last_seen_mtime_ms = excluded.last_seen_mtime_ms,
					last_seen_size = excluded.last_seen_size,
					ignore_state = excluded.ignore_state,
					tombstoned = excluded.tombstoned,
					updated_at = excluded.updated_at`,
			)
			.run(
				fileId,
				input.workspaceId,
				input.relativePath,
				input.normalizedPath,
				input.lastSeenMtimeMs ?? null,
				input.lastSeenSize ?? null,
				input.ignoreState,
				input.tombstoned ? 1 : 0,
				now,
				now,
			)

		return this.getFileRecordByWorkspacePath(input.workspaceId, input.relativePath)
	}

	async getFileRecordByWorkspacePath(workspaceId: string, relativePath: string): Promise<FileRecord> {
		const row = this.db()
			.prepare(
				`SELECT
					file_id AS fileId,
					workspace_id AS workspaceId,
					relative_path AS relativePath,
					normalized_path AS normalizedPath,
					last_seen_mtime_ms AS lastSeenMtimeMs,
					last_seen_size AS lastSeenSize,
					ignore_state AS ignoreState,
					active_revision_id AS activeRevisionId,
					tombstoned
				FROM files
				WHERE workspace_id = ? AND relative_path = ?`,
			)
			.get(workspaceId, relativePath) as (Omit<FileRecord, "tombstoned"> & { tombstoned: number }) | undefined

		if (!row) {
			throw new Error(`File record not found for ${workspaceId}:${relativePath}`)
		}

		return {
			...row,
			tombstoned: Boolean(row.tombstoned),
		}
	}

	async getFileRecordByWorkspacePathOptional(
		workspaceId: string,
		relativePath: string,
	): Promise<FileRecord | undefined> {
		const row = this.db()
			.prepare(
				`SELECT
					file_id AS fileId,
					workspace_id AS workspaceId,
					relative_path AS relativePath,
					normalized_path AS normalizedPath,
					last_seen_mtime_ms AS lastSeenMtimeMs,
					last_seen_size AS lastSeenSize,
					ignore_state AS ignoreState,
					active_revision_id AS activeRevisionId,
					tombstoned
				FROM files
				WHERE workspace_id = ? AND relative_path = ?`,
			)
			.get(workspaceId, relativePath) as (Omit<FileRecord, "tombstoned"> & { tombstoned: number }) | undefined

		if (!row) {
			return undefined
		}

		return {
			...row,
			tombstoned: Boolean(row.tombstoned),
		}
	}

	async getDiscoveredFilesForWorkspace(workspaceId: string): Promise<FileRecordWithRevision[]> {
		const rows = this.db()
			.prepare(
				`SELECT
					f.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					f.last_seen_mtime_ms AS lastSeenMtimeMs,
					f.last_seen_size AS lastSeenSize,
					f.ignore_state AS ignoreState,
					f.active_revision_id AS activeRevisionId,
					f.tombstoned,
					active_fr.revision_id AS latestRevisionId,
					active_fr.content_hash AS latestRevisionContentHash,
					active_fr.fast_fingerprint AS latestRevisionFastFingerprint,
					active_fr.state AS latestRevisionState
				FROM files f
				LEFT JOIN file_revisions active_fr ON active_fr.revision_id = f.active_revision_id
				WHERE f.workspace_id = ? AND f.ignore_state = 'included' AND f.tombstoned = 0
				ORDER BY f.relative_path ASC`,
			)
			.all(workspaceId) as Array<Omit<FileRecordWithRevision, "tombstoned"> & { tombstoned: number }>

		return rows.map((row) => ({
			...row,
			tombstoned: Boolean(row.tombstoned),
		}))
	}

	async getDiscoveredFilesByRelativePaths(
		workspaceId: string,
		relativePaths: string[],
	): Promise<FileRecordWithRevision[]> {
		if (relativePaths.length === 0) {
			return []
		}

		const placeholders = relativePaths.map(() => "?").join(", ")
		const rows = this.db()
			.prepare(
				`SELECT
					f.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					f.last_seen_mtime_ms AS lastSeenMtimeMs,
					f.last_seen_size AS lastSeenSize,
					f.ignore_state AS ignoreState,
					f.active_revision_id AS activeRevisionId,
					f.tombstoned,
					active_fr.revision_id AS latestRevisionId,
					active_fr.content_hash AS latestRevisionContentHash,
					active_fr.fast_fingerprint AS latestRevisionFastFingerprint,
					active_fr.state AS latestRevisionState
				FROM files f
				LEFT JOIN file_revisions active_fr ON active_fr.revision_id = f.active_revision_id
				WHERE f.workspace_id = ? AND f.ignore_state = 'included' AND f.tombstoned = 0 AND f.relative_path IN (${placeholders})
				ORDER BY f.relative_path ASC`,
			)
			.all(workspaceId, ...relativePaths) as Array<
			Omit<FileRecordWithRevision, "tombstoned"> & { tombstoned: number }
		>

		return rows.map((row) => ({
			...row,
			tombstoned: Boolean(row.tombstoned),
		}))
	}

	async getTrackedFilesForWorkspace(workspaceId: string): Promise<FileRecord[]> {
		const rows = this.db()
			.prepare(
				`SELECT
					file_id AS fileId,
					workspace_id AS workspaceId,
					relative_path AS relativePath,
					normalized_path AS normalizedPath,
					last_seen_mtime_ms AS lastSeenMtimeMs,
					last_seen_size AS lastSeenSize,
					ignore_state AS ignoreState,
					active_revision_id AS activeRevisionId,
					tombstoned
				FROM files
				WHERE workspace_id = ? AND ignore_state = 'included'
				ORDER BY relative_path ASC`,
			)
			.all(workspaceId) as Array<Omit<FileRecord, "tombstoned"> & { tombstoned: number }>

		return rows.map((row) => ({
			...row,
			tombstoned: Boolean(row.tombstoned),
		}))
	}

	async countTrackedFilesForWorkspace(workspaceId: string): Promise<number> {
		const row = this.db()
			.prepare(`SELECT COUNT(*) AS count FROM files WHERE workspace_id = ? AND ignore_state = 'included'`)
			.get(workspaceId) as { count?: number } | undefined
		return row?.count ?? 0
	}

	async countActiveIndexedFilesForWorkspace(workspaceId: string): Promise<number> {
		const row = this.db()
			.prepare(
				`SELECT COUNT(*) AS count
				FROM files
				WHERE workspace_id = ?
					AND ignore_state = 'included'
					AND tombstoned = 0
					AND active_revision_id IS NOT NULL`,
			)
			.get(workspaceId) as { count?: number } | undefined
		return row?.count ?? 0
	}

	async countActiveChunksForWorkspace(workspaceId: string): Promise<number> {
		const row = this.db()
			.prepare(
				`SELECT COUNT(*) AS count
				FROM chunks c
				INNER JOIN files f ON f.active_revision_id = c.revision_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0`,
			)
			.get(workspaceId) as { count?: number } | undefined
		return row?.count ?? 0
	}

	async createFileRevision(input: FileRevisionInput): Promise<FileRevisionRecord> {
		const revisionId = uuidv4()
		const discoveredAt = input.discoveredAt ?? Date.now()

		this.db()
			.prepare(
				`INSERT INTO file_revisions (
					revision_id, file_id, run_id, content_hash, fast_fingerprint,
					parser_version, chunker_version, state, discovered_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				revisionId,
				input.fileId,
				input.runId,
				input.contentHash,
				input.fastFingerprint ?? null,
				input.parserVersion,
				input.chunkerVersion,
				input.state ?? "pending",
				discoveredAt,
			)

		return this.getFileRevision(revisionId)
	}

	async getFileRevision(revisionId: string): Promise<FileRevisionRecord> {
		const row = this.db()
			.prepare(
				`SELECT
					revision_id AS revisionId,
					file_id AS fileId,
					run_id AS runId,
					content_hash AS contentHash,
					fast_fingerprint AS fastFingerprint,
					parser_version AS parserVersion,
					chunker_version AS chunkerVersion,
					state,
					discovered_at AS discoveredAt,
					committed_at AS committedAt,
					superseded_at AS supersededAt,
					failure_reason AS failureReason
				FROM file_revisions
				WHERE revision_id = ?`,
			)
			.get(revisionId) as FileRevisionRecord | undefined

		if (!row) {
			throw new Error(`Revision not found: ${revisionId}`)
		}

		return row
	}

	async markRevisionCommitted(revisionId: string): Promise<void> {
		this.db()
			.prepare(`UPDATE file_revisions SET state = ?, committed_at = ? WHERE revision_id = ?`)
			.run("committed", Date.now(), revisionId)

		this.db()
			.prepare(
				`UPDATE files
				 SET active_revision_id = ?, tombstoned = 0, updated_at = ?
				 WHERE file_id = (SELECT file_id FROM file_revisions WHERE revision_id = ?)`,
			)
			.run(revisionId, Date.now(), revisionId)
	}

	async markRevisionDegraded(revisionId: string, reason: string): Promise<void> {
		this.db()
			.prepare(`UPDATE file_revisions SET state = ?, committed_at = ?, failure_reason = ? WHERE revision_id = ?`)
			.run("degraded", Date.now(), reason, revisionId)

		this.db()
			.prepare(
				`UPDATE files
				 SET active_revision_id = ?, tombstoned = 0, updated_at = ?
				 WHERE file_id = (SELECT file_id FROM file_revisions WHERE revision_id = ?)`,
			)
			.run(revisionId, Date.now(), revisionId)
	}

	async markRevisionFailed(revisionId: string, reason: string): Promise<void> {
		this.db()
			.prepare(`UPDATE file_revisions SET state = ?, failure_reason = ? WHERE revision_id = ?`)
			.run("failed", reason, revisionId)
	}

	async markRevisionTerminalFailure(revisionId: string, reason: string): Promise<void> {
		this.db()
			.prepare(`UPDATE file_revisions SET state = ?, failure_reason = ? WHERE revision_id = ?`)
			.run("terminal_failed", reason, revisionId)
	}

	async markRevisionSuperseded(revisionId: string): Promise<void> {
		this.db()
			.prepare(`UPDATE file_revisions SET state = ?, superseded_at = ? WHERE revision_id = ?`)
			.run("superseded", Date.now(), revisionId)
	}

	async markRevisionState(revisionId: string, state: FileRevisionRecord["state"]): Promise<void> {
		this.db().prepare(`UPDATE file_revisions SET state = ? WHERE revision_id = ?`).run(state, revisionId)
	}

	async getRevisionsByState(
		workspaceId: string,
		state: string,
		options?: RevisionQueryOptions,
	): Promise<FileRevisionWithFileRecord[]> {
		const clauses = [`f.workspace_id = ?`, `fr.state = ?`]
		const params: Array<string | number> = [workspaceId, state]

		if (options?.runId) {
			clauses.push(`fr.run_id = ?`)
			params.push(options.runId)
		}

		const limitClause = options?.limit ? ` LIMIT ${Math.max(1, options.limit)}` : ""

		return this.db()
			.prepare(
				`SELECT
					fr.revision_id AS revisionId,
					fr.file_id AS fileId,
					fr.run_id AS runId,
					fr.content_hash AS contentHash,
					fr.fast_fingerprint AS fastFingerprint,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion,
					fr.state,
					fr.discovered_at AS discoveredAt,
					fr.committed_at AS committedAt,
					fr.superseded_at AS supersededAt,
					fr.failure_reason AS failureReason,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					f.ignore_state AS fileIgnoreState
				FROM file_revisions fr
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE ${clauses.join(" AND ")}
				ORDER BY fr.discovered_at ASC${limitClause}`,
			)
			.all(...params) as FileRevisionWithFileRecord[]
	}

	async countOutstandingResumedJobs(runId: string): Promise<number> {
		const result = this.db()
			.prepare(
				`SELECT COUNT(*) AS count
				FROM jobs
				WHERE workspace_id = ?
					AND run_id = ?
					AND created_at < (
						SELECT started_at
						FROM index_runs
						WHERE run_id = ?
					)
					AND state IN ('queued', 'running')`,
			)
			.get(this.workspaceHash, runId, runId) as { count?: number } | undefined

		return result?.count ?? 0
	}

	async listRevisionWarnings(
		workspaceId: string,
		limit = 10,
		offset = 0,
		filter: WarningDetailsFilter = "all",
		sort: WarningDetailsSort = "severity",
	): Promise<PaginatedRevisionWarningDetails> {
		let filterClause = ""
		if (filter === "degraded") {
			filterClause = `AND fr.state = 'degraded'`
		} else if (filter === "parser_failed") {
			filterClause = `AND fr.state = 'terminal_failed'
				AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id)`
		} else if (filter === "failed") {
			filterClause = `AND (
				fr.state = 'failed'
				OR (fr.state = 'terminal_failed' AND EXISTS (SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id))
			)`
		}
		const orderClause =
			sort === "path"
				? `f.relative_path COLLATE NOCASE ASC, fr.discovered_at DESC`
				: sort === "recent"
					? `fr.discovered_at DESC, f.relative_path COLLATE NOCASE ASC`
					: `CASE
						WHEN fr.state = 'terminal_failed' AND NOT EXISTS (
							SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id
						) THEN 0
						WHEN fr.state IN ('terminal_failed', 'failed') THEN 1
						WHEN fr.state = 'degraded' THEN 2
						ELSE 3
					END,
					fr.discovered_at DESC,
					f.relative_path COLLATE NOCASE ASC`
		const totalRow = this.db()
			.prepare(
				`SELECT COUNT(*) AS count
				FROM file_revisions fr
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND fr.state IN ('degraded', 'terminal_failed', 'failed')
					${filterClause}`,
			)
			.get(workspaceId) as { count?: number } | undefined
		const items = this.db()
			.prepare(
				`SELECT
					fr.revision_id AS revisionId,
					fr.file_id AS fileId,
					f.relative_path AS relativePath,
					fr.state,
					CASE
						WHEN fr.state = 'degraded' THEN 'degraded'
						WHEN fr.state = 'terminal_failed' AND NOT EXISTS (
							SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id
						) THEN 'parser_failed'
						ELSE 'failed'
					END AS category,
					fr.failure_reason AS failureReason,
					fr.discovered_at AS discoveredAt
				FROM file_revisions fr
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND fr.state IN ('degraded', 'terminal_failed', 'failed')
					${filterClause}
				ORDER BY ${orderClause}
				LIMIT ? OFFSET ?`,
			)
			.all(workspaceId, Math.max(1, limit), Math.max(0, offset)) as RevisionWarningDetail[]

		return {
			total: totalRow?.count ?? 0,
			items,
		}
	}

	async listWarningRelativePaths(workspaceId: string, filter: WarningDetailsFilter = "all"): Promise<string[]> {
		let filterClause = ""
		if (filter === "degraded") {
			filterClause = `AND fr.state = 'degraded'`
		} else if (filter === "parser_failed") {
			filterClause = `AND fr.state = 'terminal_failed'
				AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id)`
		} else if (filter === "failed") {
			filterClause = `AND (
				fr.state = 'failed'
				OR (fr.state = 'terminal_failed' AND EXISTS (SELECT 1 FROM chunks c WHERE c.revision_id = fr.revision_id))
			)`
		}

		const rows = this.db()
			.prepare(
				`SELECT DISTINCT f.relative_path AS relativePath
				FROM file_revisions fr
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND fr.state IN ('degraded', 'terminal_failed', 'failed')
					${filterClause}
				ORDER BY f.relative_path COLLATE NOCASE ASC`,
			)
			.all(workspaceId) as Array<{ relativePath: string }>

		return rows.map((row) => row.relativePath)
	}

	async getPreviousCommittedRevision(
		fileId: string,
		excludingRevisionId: string,
	): Promise<FileRevisionRecord | undefined> {
		return this.db()
			.prepare(
				`SELECT
					revision_id AS revisionId,
					file_id AS fileId,
					run_id AS runId,
					content_hash AS contentHash,
					fast_fingerprint AS fastFingerprint,
					parser_version AS parserVersion,
					chunker_version AS chunkerVersion,
					state,
					discovered_at AS discoveredAt,
					committed_at AS committedAt,
					superseded_at AS supersededAt,
					failure_reason AS failureReason
				FROM file_revisions
				WHERE file_id = ? AND revision_id != ? AND state = 'committed'
				ORDER BY discovered_at DESC
				LIMIT 1`,
			)
			.get(fileId, excludingRevisionId) as FileRevisionRecord | undefined
	}

	async getDiffBaselineRevision(
		fileId: string,
		excludingRevisionId: string,
	): Promise<FileRevisionRecord | undefined> {
		const activeRevision = await this.getActiveRevisionForFile(fileId)
		if (activeRevision && activeRevision.revisionId !== excludingRevisionId) {
			return activeRevision
		}

		return this.getPreviousCommittedRevision(fileId, excludingRevisionId)
	}

	async getActiveRevisionForFile(fileId: string): Promise<FileRevisionRecord | undefined> {
		return this.db()
			.prepare(
				`SELECT
					fr.revision_id AS revisionId,
					fr.file_id AS fileId,
					fr.run_id AS runId,
					fr.content_hash AS contentHash,
					fr.fast_fingerprint AS fastFingerprint,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion,
					fr.state,
					fr.discovered_at AS discoveredAt,
					fr.committed_at AS committedAt,
					fr.superseded_at AS supersededAt,
					fr.failure_reason AS failureReason
				FROM file_revisions fr
				INNER JOIN files f ON f.active_revision_id = fr.revision_id
				WHERE f.file_id = ?`,
			)
			.get(fileId) as FileRevisionRecord | undefined
	}

	async findReusableRevision(
		fileId: string,
		contentHash: string,
		fastFingerprint?: string | null,
	): Promise<FileRevisionRecord | undefined> {
		return this.db()
			.prepare(
				`SELECT
					revision_id AS revisionId,
					file_id AS fileId,
					run_id AS runId,
					content_hash AS contentHash,
					fast_fingerprint AS fastFingerprint,
					parser_version AS parserVersion,
					chunker_version AS chunkerVersion,
					state,
					discovered_at AS discoveredAt,
					committed_at AS committedAt,
					superseded_at AS supersededAt,
					failure_reason AS failureReason
				FROM file_revisions
				WHERE file_id = ?
					AND content_hash = ?
					AND COALESCE(fast_fingerprint, '') = COALESCE(?, '')
					AND state IN ('hashed', 'parsed')
				ORDER BY discovered_at DESC
				LIMIT 1`,
			)
			.get(fileId, contentHash, fastFingerprint ?? null) as FileRevisionRecord | undefined
	}

	async adoptRevisionToRun(revisionId: string, runId: string): Promise<void> {
		this.db().prepare(`UPDATE file_revisions SET run_id = ? WHERE revision_id = ?`).run(runId, revisionId)
	}

	async upsertChunks(chunks: ChunkInput[]): Promise<void> {
		const now = Date.now()
		const statement = this.db().prepare(
			`INSERT INTO chunks (
				chunk_id, revision_id, chunk_fingerprint, start_line, end_line,
				content, content_hash, token_estimate, embedding_model, vector_point_id,
				state, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)

		for (const chunk of chunks) {
			statement.run(
				uuidv4(),
				chunk.revisionId,
				chunk.chunkFingerprint,
				chunk.startLine,
				chunk.endLine,
				chunk.content,
				chunk.contentHash,
				chunk.tokenEstimate ?? null,
				chunk.embeddingModel ?? null,
				chunk.vectorPointId ?? null,
				chunk.state ?? "pending",
				now,
				now,
			)
		}
	}

	async getChunksForRevision(revisionId: string): Promise<ChunkRecord[]> {
		return this.db()
			.prepare(
				`SELECT
					chunk_id AS chunkId,
					revision_id AS revisionId,
					chunk_fingerprint AS chunkFingerprint,
					start_line AS startLine,
					end_line AS endLine,
					content,
					content_hash AS contentHash,
					token_estimate AS tokenEstimate,
					embedding_model AS embeddingModel,
					vector_point_id AS vectorPointId,
					state,
					created_at AS createdAt,
					updated_at AS updatedAt
				FROM chunks
				WHERE revision_id = ?`,
			)
			.all(revisionId) as ChunkRecord[]
	}

	async getChunksByIds(chunkIds: string[]): Promise<ChunkWithRevisionRecord[]> {
		if (chunkIds.length === 0) {
			return []
		}

		const placeholders = chunkIds.map(() => "?").join(", ")
		return this.db()
			.prepare(
				`SELECT
					c.chunk_id AS chunkId,
					c.revision_id AS revisionId,
					c.chunk_fingerprint AS chunkFingerprint,
					c.start_line AS startLine,
					c.end_line AS endLine,
					c.content,
					c.content_hash AS contentHash,
					c.token_estimate AS tokenEstimate,
					c.embedding_model AS embeddingModel,
					c.vector_point_id AS vectorPointId,
					c.state,
					c.created_at AS createdAt,
					c.updated_at AS updatedAt,
					fr.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion
				FROM chunks c
				INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE c.chunk_id IN (${placeholders})`,
			)
			.all(...chunkIds) as ChunkWithRevisionRecord[]
	}

	async markChunkState(
		chunkId: string,
		state: ChunkRecord["state"],
		options?: {
			embeddingModel?: string | null
			vectorPointId?: string | null
			clearContent?: boolean
		},
	): Promise<void> {
		this.db()
			.prepare(
				`UPDATE chunks
				 SET state = ?,
					 embedding_model = COALESCE(?, embedding_model),
					 vector_point_id = COALESCE(?, vector_point_id),
					 content = CASE WHEN ? THEN '' ELSE content END,
					 updated_at = ?
				 WHERE chunk_id = ?`,
			)
			.run(
				state,
				options?.embeddingModel ?? null,
				options?.vectorPointId ?? null,
				options?.clearContent ? 1 : 0,
				Date.now(),
				chunkId,
			)
	}

	async markChunkStates(
		updates: Array<{
			chunkId: string
			state: ChunkRecord["state"]
			embeddingModel?: string | null
			vectorPointId?: string | null
			clearContent?: boolean
		}>,
	): Promise<void> {
		if (updates.length === 0) {
			return
		}

		const now = Date.now()
		const statement = this.db().prepare(
			`UPDATE chunks
			 SET state = ?,
				 embedding_model = COALESCE(?, embedding_model),
				 vector_point_id = COALESCE(?, vector_point_id),
				 content = CASE WHEN ? THEN '' ELSE content END,
				 updated_at = ?
			 WHERE chunk_id = ?`,
		)

		this.db().exec("BEGIN")
		try {
			for (const update of updates) {
				statement.run(
					update.state,
					update.embeddingModel ?? null,
					update.vectorPointId ?? null,
					update.clearContent ? 1 : 0,
					now,
					update.chunkId,
				)
			}
			this.db().exec("COMMIT")
		} catch (error) {
			this.db().exec("ROLLBACK")
			throw error
		}
	}

	async enqueueJobs(jobs: JobInput[]): Promise<void> {
		const now = Date.now()
		const statement = this.db().prepare(
			`INSERT INTO jobs (
				job_id, workspace_id, run_id, job_type, entity_id, state, priority,
				attempt_count, next_attempt_at, last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
		)

		for (const job of jobs) {
			statement.run(
				uuidv4(),
				job.workspaceId,
				job.runId,
				job.jobType,
				job.entityId,
				job.state ?? "queued",
				job.priority ?? 100,
				job.nextAttemptAt ?? now,
				now,
				now,
			)
		}
	}

	async claimJobs(jobType: string, limit: number, runId?: string): Promise<JobRecord[]> {
		const clauses = [`job_type = ?`, `state = 'queued'`, `next_attempt_at <= ?`]
		const params: Array<string | number> = [jobType, Date.now()]

		if (runId) {
			clauses.push(`run_id = ?`)
			params.push(runId)
		}

		const rows = this.db()
			.prepare(
				`SELECT
					job_id AS jobId,
					workspace_id AS workspaceId,
					run_id AS runId,
					job_type AS jobType,
					entity_id AS entityId,
					state,
					priority,
					attempt_count AS attemptCount,
					next_attempt_at AS nextAttemptAt,
					last_error AS lastError,
					created_at AS createdAt,
					updated_at AS updatedAt
				FROM jobs
				WHERE ${clauses.join(" AND ")}
				ORDER BY priority ASC, created_at ASC
				LIMIT ?`,
			)
			.all(...params, limit) as JobRecord[]

		const update = this.db().prepare(
			`UPDATE jobs
			 SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
			 WHERE job_id = ?`,
		)

		for (const row of rows) {
			update.run(Date.now(), row.jobId)
		}

		return rows.map((row) => ({ ...row, state: "running", attemptCount: row.attemptCount + 1 }))
	}

	async completeJob(jobId: string): Promise<void> {
		this.db().prepare(`UPDATE jobs SET state = 'done', updated_at = ? WHERE job_id = ?`).run(Date.now(), jobId)
	}

	async completeJobs(jobIds: string[]): Promise<void> {
		if (jobIds.length === 0) {
			return
		}

		const now = Date.now()
		const statement = this.db().prepare(`UPDATE jobs SET state = 'done', updated_at = ? WHERE job_id = ?`)
		this.db().exec("BEGIN")
		try {
			for (const jobId of jobIds) {
				statement.run(now, jobId)
			}
			this.db().exec("COMMIT")
		} catch (error) {
			this.db().exec("ROLLBACK")
			throw error
		}
	}

	async markJobTerminalFailed(jobId: string, errorMessage: string): Promise<void> {
		this.db()
			.prepare(
				`UPDATE jobs
				 SET state = 'terminal_failed', last_error = ?, updated_at = ?
				 WHERE job_id = ?`,
			)
			.run(errorMessage, Date.now(), jobId)
	}

	async failJob(jobId: string, errorMessage: string, nextAttemptAt: number): Promise<void> {
		this.db()
			.prepare(
				`UPDATE jobs
				 SET state = 'queued', last_error = ?, next_attempt_at = ?, updated_at = ?
				 WHERE job_id = ?`,
			)
			.run(errorMessage, nextAttemptAt, Date.now(), jobId)
	}

	async getNextRetryAt(jobType: string, runId: string): Promise<number | undefined> {
		const row = this.db()
			.prepare(
				`SELECT MIN(next_attempt_at) AS nextAttemptAt
				FROM jobs
				WHERE job_type = ?
					AND run_id = ?
					AND state = 'queued'`,
			)
			.get(jobType, runId) as { nextAttemptAt?: number | null } | undefined

		return row?.nextAttemptAt ?? undefined
	}

	async getRunJobStateCounts(runId: string, jobType?: string): Promise<RunJobStateCounts> {
		const clauses = [`run_id = ?`]
		const params: Array<string | number> = [runId]

		if (jobType) {
			clauses.push(`job_type = ?`)
			params.push(jobType)
		}

		const rows = this.db()
			.prepare(
				`SELECT state, COUNT(*) AS count
				FROM jobs
				WHERE ${clauses.join(" AND ")}
				GROUP BY state`,
			)
			.all(...params) as Array<{ state: string; count: number }>

		const counts: RunJobStateCounts = {
			queued: 0,
			running: 0,
			done: 0,
			abandoned: 0,
			terminalFailed: 0,
		}

		for (const row of rows) {
			if (row.state === "queued") {
				counts.queued = row.count
			} else if (row.state === "running") {
				counts.running = row.count
			} else if (row.state === "done") {
				counts.done = row.count
			} else if (row.state === "abandoned") {
				counts.abandoned = row.count
			} else if (row.state === "terminal_failed") {
				counts.terminalFailed = row.count
			}
		}

		return counts
	}

	async getRevisionJobResolution(revisionId: string, runId: string, jobType: string): Promise<RevisionJobResolution> {
		const rows = this.db()
			.prepare(
				`SELECT j.state AS state, COUNT(*) AS count
				FROM jobs j
				INNER JOIN chunks c ON c.chunk_id = j.entity_id
				WHERE c.revision_id = ?
					AND j.run_id = ?
					AND j.job_type = ?
				GROUP BY j.state`,
			)
			.all(revisionId, runId, jobType) as Array<{ state: string; count: number }>

		const resolution: RevisionJobResolution = {
			doneJobs: 0,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 0,
		}

		for (const row of rows) {
			resolution.totalJobs += row.count
			if (row.state === "done") {
				resolution.doneJobs = row.count
			} else if (row.state === "queued") {
				resolution.queuedJobs = row.count
			} else if (row.state === "running") {
				resolution.runningJobs = row.count
			} else if (row.state === "terminal_failed") {
				resolution.terminalFailedJobs = row.count
			}
		}

		return resolution
	}

	async recordWatchEvent(relativePath: string, eventType: string): Promise<WatchEventRecord> {
		const eventId = uuidv4()
		const observedAt = Date.now()
		this.db()
			.prepare(
				`INSERT INTO watch_events (
					event_id, workspace_id, relative_path, event_type, observed_at, coalesced
				) VALUES (?, ?, ?, ?, ?, 0)`,
			)
			.run(eventId, this.workspaceHash, relativePath, eventType, observedAt)

		return {
			eventId,
			workspaceId: this.workspaceHash,
			relativePath,
			eventType,
			observedAt,
			coalesced: false,
		}
	}

	async markFileTombstoned(fileId: string, tombstoned = true): Promise<void> {
		this.db()
			.prepare(`UPDATE files SET tombstoned = ?, updated_at = ? WHERE file_id = ?`)
			.run(tombstoned ? 1 : 0, Date.now(), fileId)
	}

	private async writeBootstrapFile(): Promise<void> {
		const payload: MetadataBootstrapFile = {
			schemaVersion: getCodeIndexV2SchemaVersion(),
			workspacePath: this.workspacePath,
			dbPath: this.dbPath,
			schemaSql: CODE_INDEX_V2_SCHEMA,
			initializedAt: new Date().toISOString(),
		}

		await safeWriteJson(this.bootstrapPath, payload, { prettyPrint: true })
	}

	private _openDatabase(): void {
		if (!this._db) {
			this._db = new DatabaseSync(this.dbPath)
		}
	}

	private _initializeSchema(): void {
		this.db().exec(CODE_INDEX_V2_SCHEMA)
		try {
			this.db().exec(`ALTER TABLE chunks ADD COLUMN content TEXT NOT NULL DEFAULT ''`)
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
			if (!message.includes("duplicate column")) {
				throw error
			}
		}
		this.db()
			.prepare(
				`INSERT INTO schema_meta (key, value)
				 VALUES ('schemaVersion', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.run(String(getCodeIndexV2SchemaVersion()))
	}

	private db(): SqliteDatabaseSync {
		if (!this._db) {
			throw new Error("MetadataStore not initialized")
		}
		return this._db
	}
}
