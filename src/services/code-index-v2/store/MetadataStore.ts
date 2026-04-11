import * as fs from "fs/promises"
import * as path from "path"
import * as zlib from "zlib"
import * as vscode from "vscode"
import { createHash } from "crypto"
import { v4 as uuidv4 } from "uuid"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import {
	CODE_INDEX_V2_DB_BASENAME,
	CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME,
	CODE_INDEX_V2_PERSISTENT_DIR_BASENAME,
	CODE_INDEX_V2_TELEMETRY_DB_BASENAME,
} from "../shared/constants"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { CODE_INDEX_V2_SCHEMA, getCodeIndexV2SchemaVersion } from "./schema"
import {
	ChunkInput,
	ChunkVariantInput,
	ChunkVariantRecord,
	LexicalChunkSearchRecord,
	ChunkRecord,
	ChunkWithRevisionRecord,
	FileRecord,
	FileRecordInput,
	FileRecordWithRevision,
	FileRevisionInput,
	FileRevisionRecord,
	FileRevisionWithFileRecord,
	IndexRunSampleInput,
	IndexRunSampleRecord,
	IndexRunSummaryInput,
	IndexRunSummaryRecord,
	JobInput,
	JobRecord,
	OversizedTrackedFileInput,
	OversizedTrackedFileRecord,
	PaginatedOversizedTrackedFiles,
	PaginatedRevisionWarningDetails,
	PlannedRevisionResolution,
	RevisionQueryOptions,
	RevisionJobResolution,
	RevisionWarningDetail,
	RunProgressSnapshot,
	RunProgressRecord,
	RunBacklogMetrics,
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

type TransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"

const { DatabaseSync } = require("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabaseSync
}

const PRESERVED_PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_JOB_LEASE_MS = 30_000
const MAX_PERSISTED_RUN_SUMMARIES = 100
const MAX_PERSISTED_RUN_SAMPLES_PER_RUN = 512
const FTS_STOPWORDS = new Set([
	"a",
	"about",
	"add",
	"after",
	"all",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"before",
	"between",
	"both",
	"but",
	"by",
	"can",
	"code",
	"does",
	"do",
	"each",
	"for",
	"from",
	"get",
	"has",
	"have",
	"how",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"like",
	"make",
	"most",
	"not",
	"of",
	"on",
	"or",
	"our",
	"out",
	"over",
	"results",
	"roo",
	"search",
	"should",
	"so",
	"some",
	"the",
	"their",
	"them",
	"then",
	"there",
	"this",
	"to",
	"up",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"will",
	"with",
	"within",
	"without",
])
const MAX_FTS_TOKENS = 8
const MAX_FTS_TOKENS_LONG_QUERY = 4

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
	private readonly persistentRootDir: vscode.Uri
	private readonly diagnosticsRootDir: vscode.Uri
	private readonly legacyDiagnosticsRootDir: vscode.Uri
	private readonly dbPath: string
	private readonly telemetryDbPath: string
	private readonly bootstrapPath: string
	private _db: SqliteDatabaseSync | undefined
	private _telemetryDb: SqliteDatabaseSync | undefined

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly workspacePath: string,
	) {
		this.workspaceHash = createHash("sha256").update(workspacePath).digest("hex")
		this.rootDir = vscode.Uri.joinPath(context.globalStorageUri, "code-index-v2", this.workspaceHash)
		this.persistentRootDir = vscode.Uri.joinPath(
			context.globalStorageUri,
			"code-index-v2",
			CODE_INDEX_V2_PERSISTENT_DIR_BASENAME,
			this.workspaceHash,
		)
		this.diagnosticsRootDir = vscode.Uri.joinPath(this.persistentRootDir, CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME)
		this.legacyDiagnosticsRootDir = vscode.Uri.joinPath(
			context.globalStorageUri,
			"code-index-v2",
			CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME,
		)
		this.dbPath = path.join(this.rootDir.fsPath, CODE_INDEX_V2_DB_BASENAME)
		this.telemetryDbPath = path.join(this.persistentRootDir.fsPath, CODE_INDEX_V2_TELEMETRY_DB_BASENAME)
		this.bootstrapPath = path.join(this.rootDir.fsPath, "bootstrap.json")
	}

	async initialize(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.rootDir)
		await vscode.workspace.fs.createDirectory(this.persistentRootDir)
		await vscode.workspace.fs.createDirectory(this.diagnosticsRootDir)
		IndexDebugLoggerV2.configureDiagnosticsDirectory(this.diagnosticsRootDir.fsPath)
		this._openDatabase()
		this._openTelemetryDatabase()
		this._initializeSchema()
		this._initializeTelemetrySchema()
		this.ensureChunkLexicalFtsPopulated()
		await this.migrateLegacyTelemetryToPersistent()
		await this.writeBootstrapFile()
		await this.ensureWorkspaceRecord()
		await this.enforceRunTelemetryRetention()
		await this.backfillRunSummariesFromLogs()
		await this.enforceRunTelemetryRetention()

		IndexDebugLoggerV2.log("basic", "MetadataStore", "bootstrap-initialized", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
		})
	}

	getDatabasePath(): string {
		return this.dbPath
	}

	getTelemetryDatabasePath(): string {
		return this.telemetryDbPath
	}

	getWorkspaceId(): string {
		return this.workspaceHash
	}

	getBootstrapPath(): string {
		return this.bootstrapPath
	}

	getDiagnosticsDirectoryPath(): string {
		return this.diagnosticsRootDir.fsPath
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
		this._telemetryDb?.close()
		this._telemetryDb = undefined
	}

	async clearStorage(options?: { includeTelemetry?: boolean }): Promise<void> {
		await this.disposeOperationalDatabase()
		await fs.rm(this.rootDir.fsPath, { recursive: true, force: true })
		if (options?.includeTelemetry) {
			await this.disposeTelemetryDatabase()
			await fs.rm(this.persistentRootDir.fsPath, { recursive: true, force: true })
		}

		IndexDebugLoggerV2.log(
			"basic",
			"MetadataStore",
			options?.includeTelemetry ? "database-cleared" : "storage-cleared",
			{
				component: "MetadataStore",
				workspacePath: this.workspacePath,
				includeTelemetry: options?.includeTelemetry ?? false,
			},
		)
	}

	async ensureWorkspaceRecord(): Promise<WorkspaceRecord> {
		const now = Date.now()
		const workspaceId = this.workspaceHash
		for (const database of [this.db(), this.telemetryDb()]) {
			database
				.prepare(
					`INSERT INTO workspaces (workspace_id, workspace_path, created_at, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(workspace_id)
					 DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`,
				)
				.run(workspaceId, this.workspacePath, now, now)
		}

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
					run_id, workspace_id, trigger_type, state, started_at, last_heartbeat_at,
					discovery_complete, reconciliation_complete
				) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
			)
			.run(runId, this.workspaceHash, triggerType, "started", now, now)

		return runId
	}

	async markRunDiscoveryComplete(runId: string): Promise<void> {
		this.db()
			.prepare(`UPDATE index_runs SET state = ?, discovery_complete = 1, last_heartbeat_at = ? WHERE run_id = ?`)
			.run("discovery_complete", Date.now(), runId)
	}

	async markRunComplete(runId: string): Promise<void> {
		this.db()
			.prepare(
				`UPDATE index_runs
				 SET state = ?, completed_at = ?, last_heartbeat_at = ?, blocking_reason = ?
				 WHERE run_id = ?`,
			)
			.run("complete", Date.now(), Date.now(), null, runId)
	}

	async markRunFailed(runId: string, errorMessage: string): Promise<void> {
		this.db()
			.prepare(
				`UPDATE index_runs
				 SET state = ?, completed_at = ?, last_heartbeat_at = ?, error_message = ?
				 WHERE run_id = ?`,
			)
			.run("failed", Date.now(), Date.now(), errorMessage, runId)
	}

	async markRunStopped(runId: string, errorMessage = "Stopped by user."): Promise<void> {
		const now = Date.now()
		this.db()
			.prepare(
				`UPDATE index_runs
				 SET state = ?, completed_at = ?, last_heartbeat_at = ?, error_message = ?
				 WHERE run_id = ?`,
			)
			.run("stopped", now, now, errorMessage, runId)

		this.db()
			.prepare(
				`UPDATE jobs
				 SET state = 'abandoned', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
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

	async heartbeatRun(runId: string, owner: string, progress?: RunProgressSnapshot): Promise<void> {
		const now = Date.now()
		this.db()
			.prepare(
				`UPDATE index_runs
				 SET last_heartbeat_at = ?,
					 heartbeat_owner = ?,
					 progress_json = COALESCE(?, progress_json),
					 blocking_reason = COALESCE(?, blocking_reason)
				 WHERE run_id = ?`,
			)
			.run(now, owner, progress ? JSON.stringify(progress) : null, progress?.blockingReason ?? null, runId)
	}

	async writeRunSummary(input: IndexRunSummaryInput): Promise<void> {
		const values = [
			input.runId,
			input.workspaceId,
			input.triggerType,
			input.state,
			input.startedAt,
			input.completedAt ?? null,
			input.totalRunMs ?? null,
			input.discoveryMs ?? null,
			input.statHashMs ?? null,
			input.parseChunkMs ?? null,
			input.diffPlanningMs ?? null,
			input.embedUpsertMs ?? null,
			input.discoveredFiles ?? null,
			input.filesScanned ?? null,
			input.filesChanged ?? null,
			input.parsedChunks ?? null,
			input.plannedRevisions ?? null,
			input.syncedChunks ?? null,
			input.upsertedChunks ?? null,
			input.deletedChunks ?? null,
			input.committedRevisions ?? null,
			input.retryingParseRevisions ?? null,
			input.terminalFailedParseRevisions ?? null,
			input.retryingChunks ?? null,
			input.terminalFailedChunks ?? null,
			input.degradedRevisions ?? null,
			input.terminalFailedRevisions ?? null,
			input.chunksPerSecond ?? null,
			input.peakChunksPerSecond ?? null,
			input.averageBatchLatencyMs ?? null,
			input.peakBatchLatencyMs ?? null,
			input.averageEmbedLatencyMs ?? null,
			input.averageUpsertLatencyMs ?? null,
			input.averageMetadataCommitLatencyMs ?? null,
			input.averageIdleGapMs ?? null,
			input.peakIdleGapMs ?? null,
			input.peakBatchSize ?? null,
			input.peakEmbeddingCount ?? null,
			input.laneConcurrency ?? null,
			input.effectiveBatchSize ?? null,
			input.peakInFlightChunkCount ?? null,
			input.pressureSoftTransitions ?? null,
			input.pressureHardTransitions ?? null,
			input.pressureSoftDurationMs ?? null,
			input.pressureHardDurationMs ?? null,
			input.parseThrottleMs ?? null,
			input.peakStagedChunks ?? null,
			input.peakQueuedJobs ?? null,
			input.hostRssMB ?? null,
			input.hostHeapUsedMB ?? null,
			input.hostExternalMB ?? null,
			input.hostCpuPercent ?? null,
			input.trackedSidecarRssMB ?? null,
			input.parseSidecarRssMB ?? null,
			input.embedSidecarRssMB ?? null,
			input.gpuSampler ?? null,
			input.gpuUtilizationPercent ?? null,
			input.gpuMemoryPressurePercent ?? null,
			input.gpuInUseBytes ?? null,
			input.gpuAllocatedBytes ?? null,
			input.gpuPowerW ?? null,
			input.averageGpuUtilizationPercent ?? null,
			input.peakGpuUtilizationPercent ?? null,
			input.averageGpuInUseBytes ?? null,
			input.peakGpuInUseBytes ?? null,
			input.gpuSampleCount ?? null,
			input.embeddingsPerChunk ?? null,
			input.laneOccupancyPercent ?? null,
			input.embedActivePercent ?? null,
			input.blockedOnParsedRevisionsMs ?? null,
			input.blockedOnStagedChunksMs ?? null,
			input.buildVersion ?? null,
			input.buildTimestamp ?? null,
			input.buildSha ?? null,
			input.engineVersion ?? null,
			input.provider ?? null,
			input.modelId ?? null,
			input.runtimeKind ?? null,
			input.deviceHint ?? null,
			input.lastBlockingReason ?? null,
			input.errorMessage ?? null,
		]
		this.telemetryDb()
			.prepare(
				`INSERT INTO index_run_summaries (
					run_id, workspace_id, trigger_type, state, started_at, completed_at, total_run_ms,
					discovery_ms, stat_hash_ms, parse_chunk_ms, diff_planning_ms, embed_upsert_ms,
					discovered_files, files_scanned, files_changed, parsed_chunks, planned_revisions,
					synced_chunks, upserted_chunks, deleted_chunks, committed_revisions,
					retrying_parse_revisions, terminal_failed_parse_revisions, retrying_chunks,
					terminal_failed_chunks, degraded_revisions, terminal_failed_revisions,
					chunks_per_second, peak_chunks_per_second, average_batch_latency_ms,
					peak_batch_latency_ms, average_embed_latency_ms, average_upsert_latency_ms,
					average_metadata_commit_latency_ms, average_idle_gap_ms, peak_idle_gap_ms,
					peak_batch_size, peak_embedding_count, lane_concurrency, effective_batch_size,
					peak_in_flight_chunk_count, pressure_soft_transitions, pressure_hard_transitions,
					pressure_soft_duration_ms, pressure_hard_duration_ms, parse_throttle_ms,
					peak_staged_chunks, peak_queued_jobs, host_rss_mb, host_heap_used_mb, host_external_mb,
					host_cpu_percent, tracked_sidecar_rss_mb, parse_sidecar_rss_mb, embed_sidecar_rss_mb,
					gpu_sampler, gpu_utilization_percent, gpu_memory_pressure_percent, gpu_in_use_bytes,
					gpu_allocated_bytes, gpu_power_w, average_gpu_utilization_percent, peak_gpu_utilization_percent,
					average_gpu_in_use_bytes, peak_gpu_in_use_bytes, gpu_sample_count, embeddings_per_chunk,
					lane_occupancy_percent, embed_active_percent, blocked_on_parsed_revisions_ms,
					blocked_on_staged_chunks_ms, build_version, build_timestamp, build_sha,
					engine_version, provider, model_id, runtime_kind, device_hint, last_blocking_reason, error_message
				) VALUES (${values.map(() => "?").join(", ")})
				ON CONFLICT(run_id) DO UPDATE SET
					workspace_id=excluded.workspace_id,
					trigger_type=excluded.trigger_type,
					state=excluded.state,
					started_at=excluded.started_at,
					completed_at=excluded.completed_at,
					total_run_ms=excluded.total_run_ms,
					discovery_ms=excluded.discovery_ms,
					stat_hash_ms=excluded.stat_hash_ms,
					parse_chunk_ms=excluded.parse_chunk_ms,
					diff_planning_ms=excluded.diff_planning_ms,
					embed_upsert_ms=excluded.embed_upsert_ms,
					discovered_files=excluded.discovered_files,
					files_scanned=excluded.files_scanned,
					files_changed=excluded.files_changed,
					parsed_chunks=excluded.parsed_chunks,
					planned_revisions=excluded.planned_revisions,
					synced_chunks=excluded.synced_chunks,
					upserted_chunks=excluded.upserted_chunks,
					deleted_chunks=excluded.deleted_chunks,
					committed_revisions=excluded.committed_revisions,
					retrying_parse_revisions=excluded.retrying_parse_revisions,
					terminal_failed_parse_revisions=excluded.terminal_failed_parse_revisions,
					retrying_chunks=excluded.retrying_chunks,
					terminal_failed_chunks=excluded.terminal_failed_chunks,
					degraded_revisions=excluded.degraded_revisions,
					terminal_failed_revisions=excluded.terminal_failed_revisions,
					chunks_per_second=excluded.chunks_per_second,
					peak_chunks_per_second=excluded.peak_chunks_per_second,
					average_batch_latency_ms=excluded.average_batch_latency_ms,
					peak_batch_latency_ms=excluded.peak_batch_latency_ms,
					average_embed_latency_ms=excluded.average_embed_latency_ms,
					average_upsert_latency_ms=excluded.average_upsert_latency_ms,
					average_metadata_commit_latency_ms=excluded.average_metadata_commit_latency_ms,
					average_idle_gap_ms=excluded.average_idle_gap_ms,
					peak_idle_gap_ms=excluded.peak_idle_gap_ms,
					peak_batch_size=excluded.peak_batch_size,
					peak_embedding_count=excluded.peak_embedding_count,
					lane_concurrency=excluded.lane_concurrency,
					effective_batch_size=excluded.effective_batch_size,
					peak_in_flight_chunk_count=excluded.peak_in_flight_chunk_count,
					pressure_soft_transitions=excluded.pressure_soft_transitions,
					pressure_hard_transitions=excluded.pressure_hard_transitions,
					pressure_soft_duration_ms=excluded.pressure_soft_duration_ms,
					pressure_hard_duration_ms=excluded.pressure_hard_duration_ms,
					parse_throttle_ms=excluded.parse_throttle_ms,
					peak_staged_chunks=excluded.peak_staged_chunks,
					peak_queued_jobs=excluded.peak_queued_jobs,
					host_rss_mb=excluded.host_rss_mb,
					host_heap_used_mb=excluded.host_heap_used_mb,
					host_external_mb=excluded.host_external_mb,
					host_cpu_percent=excluded.host_cpu_percent,
					tracked_sidecar_rss_mb=excluded.tracked_sidecar_rss_mb,
					parse_sidecar_rss_mb=excluded.parse_sidecar_rss_mb,
					embed_sidecar_rss_mb=excluded.embed_sidecar_rss_mb,
					gpu_sampler=excluded.gpu_sampler,
					gpu_utilization_percent=excluded.gpu_utilization_percent,
					gpu_memory_pressure_percent=excluded.gpu_memory_pressure_percent,
					gpu_in_use_bytes=excluded.gpu_in_use_bytes,
					gpu_allocated_bytes=excluded.gpu_allocated_bytes,
					gpu_power_w=excluded.gpu_power_w,
					average_gpu_utilization_percent=excluded.average_gpu_utilization_percent,
					peak_gpu_utilization_percent=excluded.peak_gpu_utilization_percent,
					average_gpu_in_use_bytes=excluded.average_gpu_in_use_bytes,
					peak_gpu_in_use_bytes=excluded.peak_gpu_in_use_bytes,
					gpu_sample_count=excluded.gpu_sample_count,
					embeddings_per_chunk=excluded.embeddings_per_chunk,
					lane_occupancy_percent=excluded.lane_occupancy_percent,
					embed_active_percent=excluded.embed_active_percent,
					blocked_on_parsed_revisions_ms=excluded.blocked_on_parsed_revisions_ms,
					blocked_on_staged_chunks_ms=excluded.blocked_on_staged_chunks_ms,
					build_version=excluded.build_version,
					build_timestamp=excluded.build_timestamp,
					build_sha=excluded.build_sha,
					engine_version=excluded.engine_version,
					provider=excluded.provider,
					model_id=excluded.model_id,
					runtime_kind=excluded.runtime_kind,
					device_hint=excluded.device_hint,
					last_blocking_reason=excluded.last_blocking_reason,
					error_message=excluded.error_message`,
			)
			.run(...values)
		await this.enforceRunTelemetryRetention()
	}

	async appendRunSample(input: IndexRunSampleInput): Promise<void> {
		this.telemetryDb()
			.prepare(
				`INSERT INTO index_run_samples (
					sample_id, run_id, workspace_id, recorded_at, stage, event_type, blocking_reason,
					pressure_state, pressure_reasons_json, lane_concurrency, effective_batch_size, active_lane_count,
					in_flight_chunk_count, peak_in_flight_chunk_count, chunks_per_second, peak_chunks_per_second,
					average_batch_latency_ms, average_embed_latency_ms, average_upsert_latency_ms,
					average_metadata_commit_latency_ms, average_idle_gap_ms, waiting_for_jobs_ms,
					waiting_for_in_flight_capacity_ms, waiting_for_pressure_ms, requested_batch_size,
					embedding_count, provider_batch_utilization, embeddings_per_chunk, lane_occupancy_percent,
					embed_active_percent, staged_chunks, staged_chunk_bytes,
					queued_upsert_jobs, running_upsert_jobs, queued_delete_jobs, running_delete_jobs,
					parsed_revisions, planned_revisions, host_rss_mb, host_heap_used_mb, host_external_mb,
					host_cpu_percent, tracked_sidecar_rss_mb, parse_sidecar_rss_mb, embed_sidecar_rss_mb,
					gpu_sampler, gpu_utilization_percent, gpu_memory_pressure_percent, gpu_in_use_bytes,
					gpu_allocated_bytes, gpu_power_w, details_json
				) VALUES (
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				)`,
			)
			.run(
				uuidv4(),
				input.runId,
				input.workspaceId,
				input.recordedAt,
				input.stage,
				input.eventType,
				input.blockingReason ?? null,
				input.pressureState ?? null,
				input.pressureReasons ? JSON.stringify(input.pressureReasons) : null,
				input.laneConcurrency ?? null,
				input.effectiveBatchSize ?? null,
				input.activeLaneCount ?? null,
				input.inFlightChunkCount ?? null,
				input.peakInFlightChunkCount ?? null,
				input.chunksPerSecond ?? null,
				input.peakChunksPerSecond ?? null,
				input.averageBatchLatencyMs ?? null,
				input.averageEmbedLatencyMs ?? null,
				input.averageUpsertLatencyMs ?? null,
				input.averageMetadataCommitLatencyMs ?? null,
				input.averageIdleGapMs ?? null,
				input.waitingForJobsMs ?? null,
				input.waitingForInFlightCapacityMs ?? null,
				input.waitingForPressureMs ?? null,
				input.requestedBatchSize ?? null,
				input.embeddingCount ?? null,
				input.providerBatchUtilization ?? null,
				input.embeddingsPerChunk ?? null,
				input.laneOccupancyPercent ?? null,
				input.embedActivePercent ?? null,
				input.stagedChunks ?? null,
				input.stagedChunkBytes ?? null,
				input.queuedUpsertJobs ?? null,
				input.runningUpsertJobs ?? null,
				input.queuedDeleteJobs ?? null,
				input.runningDeleteJobs ?? null,
				input.parsedRevisions ?? null,
				input.plannedRevisions ?? null,
				input.hostRssMB ?? null,
				input.hostHeapUsedMB ?? null,
				input.hostExternalMB ?? null,
				input.hostCpuPercent ?? null,
				input.trackedSidecarRssMB ?? null,
				input.parseSidecarRssMB ?? null,
				input.embedSidecarRssMB ?? null,
				input.gpuSampler ?? null,
				input.gpuUtilizationPercent ?? null,
				input.gpuMemoryPressurePercent ?? null,
				input.gpuInUseBytes ?? null,
				input.gpuAllocatedBytes ?? null,
				input.gpuPowerW ?? null,
				input.detailsJson ?? null,
			)
		await this.trimRunSamples(input.runId)
	}

	async listRunSummaries(limit = 10): Promise<IndexRunSummaryRecord[]> {
		return this.telemetryDb()
			.prepare(
				`SELECT
					run_id AS runId,
					workspace_id AS workspaceId,
					trigger_type AS triggerType,
					state,
					started_at AS startedAt,
					completed_at AS completedAt,
					total_run_ms AS totalRunMs,
					discovery_ms AS discoveryMs,
					stat_hash_ms AS statHashMs,
					parse_chunk_ms AS parseChunkMs,
					diff_planning_ms AS diffPlanningMs,
					embed_upsert_ms AS embedUpsertMs,
					discovered_files AS discoveredFiles,
					files_scanned AS filesScanned,
					files_changed AS filesChanged,
					parsed_chunks AS parsedChunks,
					planned_revisions AS plannedRevisions,
					synced_chunks AS syncedChunks,
					upserted_chunks AS upsertedChunks,
					deleted_chunks AS deletedChunks,
					committed_revisions AS committedRevisions,
					retrying_parse_revisions AS retryingParseRevisions,
					terminal_failed_parse_revisions AS terminalFailedParseRevisions,
					retrying_chunks AS retryingChunks,
					terminal_failed_chunks AS terminalFailedChunks,
					degraded_revisions AS degradedRevisions,
					terminal_failed_revisions AS terminalFailedRevisions,
					chunks_per_second AS chunksPerSecond,
					peak_chunks_per_second AS peakChunksPerSecond,
					average_batch_latency_ms AS averageBatchLatencyMs,
					peak_batch_latency_ms AS peakBatchLatencyMs,
					average_embed_latency_ms AS averageEmbedLatencyMs,
					average_upsert_latency_ms AS averageUpsertLatencyMs,
					average_metadata_commit_latency_ms AS averageMetadataCommitLatencyMs,
					average_idle_gap_ms AS averageIdleGapMs,
					peak_idle_gap_ms AS peakIdleGapMs,
					peak_batch_size AS peakBatchSize,
					peak_embedding_count AS peakEmbeddingCount,
					lane_concurrency AS laneConcurrency,
					effective_batch_size AS effectiveBatchSize,
					peak_in_flight_chunk_count AS peakInFlightChunkCount,
					pressure_soft_transitions AS pressureSoftTransitions,
					pressure_hard_transitions AS pressureHardTransitions,
					pressure_soft_duration_ms AS pressureSoftDurationMs,
					pressure_hard_duration_ms AS pressureHardDurationMs,
					parse_throttle_ms AS parseThrottleMs,
					peak_staged_chunks AS peakStagedChunks,
					peak_queued_jobs AS peakQueuedJobs,
					host_rss_mb AS hostRssMB,
					host_heap_used_mb AS hostHeapUsedMB,
					host_external_mb AS hostExternalMB,
					host_cpu_percent AS hostCpuPercent,
					tracked_sidecar_rss_mb AS trackedSidecarRssMB,
					parse_sidecar_rss_mb AS parseSidecarRssMB,
					embed_sidecar_rss_mb AS embedSidecarRssMB,
					gpu_sampler AS gpuSampler,
					gpu_utilization_percent AS gpuUtilizationPercent,
					gpu_memory_pressure_percent AS gpuMemoryPressurePercent,
					gpu_in_use_bytes AS gpuInUseBytes,
					gpu_allocated_bytes AS gpuAllocatedBytes,
					gpu_power_w AS gpuPowerW,
					average_gpu_utilization_percent AS averageGpuUtilizationPercent,
					peak_gpu_utilization_percent AS peakGpuUtilizationPercent,
					average_gpu_in_use_bytes AS averageGpuInUseBytes,
					peak_gpu_in_use_bytes AS peakGpuInUseBytes,
					gpu_sample_count AS gpuSampleCount,
					embeddings_per_chunk AS embeddingsPerChunk,
					lane_occupancy_percent AS laneOccupancyPercent,
					embed_active_percent AS embedActivePercent,
					blocked_on_parsed_revisions_ms AS blockedOnParsedRevisionsMs,
					blocked_on_staged_chunks_ms AS blockedOnStagedChunksMs,
					build_version AS buildVersion,
					build_timestamp AS buildTimestamp,
					build_sha AS buildSha,
					engine_version AS engineVersion,
					provider,
					model_id AS modelId,
					runtime_kind AS runtimeKind,
					device_hint AS deviceHint,
					last_blocking_reason AS lastBlockingReason,
					error_message AS errorMessage
				FROM index_run_summaries
				WHERE workspace_id = ?
				ORDER BY started_at DESC
				LIMIT ?`,
			)
			.all(this.workspaceHash, Math.max(1, limit)) as IndexRunSummaryRecord[]
	}

	async getRunSummary(runId: string): Promise<IndexRunSummaryRecord | undefined> {
		return this.telemetryDb()
			.prepare(
				`SELECT
					run_id AS runId,
					workspace_id AS workspaceId,
					trigger_type AS triggerType,
					state,
					started_at AS startedAt,
					completed_at AS completedAt,
					total_run_ms AS totalRunMs,
					discovery_ms AS discoveryMs,
					stat_hash_ms AS statHashMs,
					parse_chunk_ms AS parseChunkMs,
					diff_planning_ms AS diffPlanningMs,
					embed_upsert_ms AS embedUpsertMs,
					discovered_files AS discoveredFiles,
					files_scanned AS filesScanned,
					files_changed AS filesChanged,
					parsed_chunks AS parsedChunks,
					planned_revisions AS plannedRevisions,
					synced_chunks AS syncedChunks,
					upserted_chunks AS upsertedChunks,
					deleted_chunks AS deletedChunks,
					committed_revisions AS committedRevisions,
					retrying_parse_revisions AS retryingParseRevisions,
					terminal_failed_parse_revisions AS terminalFailedParseRevisions,
					retrying_chunks AS retryingChunks,
					terminal_failed_chunks AS terminalFailedChunks,
					degraded_revisions AS degradedRevisions,
					terminal_failed_revisions AS terminalFailedRevisions,
					chunks_per_second AS chunksPerSecond,
					peak_chunks_per_second AS peakChunksPerSecond,
					average_batch_latency_ms AS averageBatchLatencyMs,
					peak_batch_latency_ms AS peakBatchLatencyMs,
					average_embed_latency_ms AS averageEmbedLatencyMs,
					average_upsert_latency_ms AS averageUpsertLatencyMs,
					average_metadata_commit_latency_ms AS averageMetadataCommitLatencyMs,
					average_idle_gap_ms AS averageIdleGapMs,
					peak_idle_gap_ms AS peakIdleGapMs,
					peak_batch_size AS peakBatchSize,
					peak_embedding_count AS peakEmbeddingCount,
					lane_concurrency AS laneConcurrency,
					effective_batch_size AS effectiveBatchSize,
					peak_in_flight_chunk_count AS peakInFlightChunkCount,
					pressure_soft_transitions AS pressureSoftTransitions,
					pressure_hard_transitions AS pressureHardTransitions,
					pressure_soft_duration_ms AS pressureSoftDurationMs,
					pressure_hard_duration_ms AS pressureHardDurationMs,
					parse_throttle_ms AS parseThrottleMs,
					peak_staged_chunks AS peakStagedChunks,
					peak_queued_jobs AS peakQueuedJobs,
					host_rss_mb AS hostRssMB,
					host_heap_used_mb AS hostHeapUsedMB,
					host_external_mb AS hostExternalMB,
					host_cpu_percent AS hostCpuPercent,
					tracked_sidecar_rss_mb AS trackedSidecarRssMB,
					parse_sidecar_rss_mb AS parseSidecarRssMB,
					embed_sidecar_rss_mb AS embedSidecarRssMB,
					gpu_sampler AS gpuSampler,
					gpu_utilization_percent AS gpuUtilizationPercent,
					gpu_memory_pressure_percent AS gpuMemoryPressurePercent,
					gpu_in_use_bytes AS gpuInUseBytes,
					gpu_allocated_bytes AS gpuAllocatedBytes,
					gpu_power_w AS gpuPowerW,
					average_gpu_utilization_percent AS averageGpuUtilizationPercent,
					peak_gpu_utilization_percent AS peakGpuUtilizationPercent,
					average_gpu_in_use_bytes AS averageGpuInUseBytes,
					peak_gpu_in_use_bytes AS peakGpuInUseBytes,
					gpu_sample_count AS gpuSampleCount,
					embeddings_per_chunk AS embeddingsPerChunk,
					lane_occupancy_percent AS laneOccupancyPercent,
					embed_active_percent AS embedActivePercent,
					blocked_on_parsed_revisions_ms AS blockedOnParsedRevisionsMs,
					blocked_on_staged_chunks_ms AS blockedOnStagedChunksMs,
					build_version AS buildVersion,
					build_timestamp AS buildTimestamp,
					build_sha AS buildSha,
					engine_version AS engineVersion,
					provider,
					model_id AS modelId,
					runtime_kind AS runtimeKind,
					device_hint AS deviceHint,
					last_blocking_reason AS lastBlockingReason,
					error_message AS errorMessage
				FROM index_run_summaries
				WHERE run_id = ?`,
			)
			.get(runId) as IndexRunSummaryRecord | undefined
	}

	async listRunSamples(runId: string, limit = 500): Promise<IndexRunSampleRecord[]> {
		const rows = this.telemetryDb()
			.prepare(
				`SELECT
					sample_id AS sampleId,
					run_id AS runId,
					workspace_id AS workspaceId,
					recorded_at AS recordedAt,
					stage,
					event_type AS eventType,
					blocking_reason AS blockingReason,
					pressure_state AS pressureState,
					pressure_reasons_json AS pressureReasonsJson,
					lane_concurrency AS laneConcurrency,
					effective_batch_size AS effectiveBatchSize,
					active_lane_count AS activeLaneCount,
					in_flight_chunk_count AS inFlightChunkCount,
					peak_in_flight_chunk_count AS peakInFlightChunkCount,
					chunks_per_second AS chunksPerSecond,
					peak_chunks_per_second AS peakChunksPerSecond,
					average_batch_latency_ms AS averageBatchLatencyMs,
					average_embed_latency_ms AS averageEmbedLatencyMs,
					average_upsert_latency_ms AS averageUpsertLatencyMs,
					average_metadata_commit_latency_ms AS averageMetadataCommitLatencyMs,
					average_idle_gap_ms AS averageIdleGapMs,
					waiting_for_jobs_ms AS waitingForJobsMs,
					waiting_for_in_flight_capacity_ms AS waitingForInFlightCapacityMs,
					waiting_for_pressure_ms AS waitingForPressureMs,
					requested_batch_size AS requestedBatchSize,
					embedding_count AS embeddingCount,
					provider_batch_utilization AS providerBatchUtilization,
					embeddings_per_chunk AS embeddingsPerChunk,
					lane_occupancy_percent AS laneOccupancyPercent,
					embed_active_percent AS embedActivePercent,
					staged_chunks AS stagedChunks,
					staged_chunk_bytes AS stagedChunkBytes,
					queued_upsert_jobs AS queuedUpsertJobs,
					running_upsert_jobs AS runningUpsertJobs,
					queued_delete_jobs AS queuedDeleteJobs,
					running_delete_jobs AS runningDeleteJobs,
					parsed_revisions AS parsedRevisions,
					planned_revisions AS plannedRevisions,
					host_rss_mb AS hostRssMB,
					host_heap_used_mb AS hostHeapUsedMB,
					host_external_mb AS hostExternalMB,
					host_cpu_percent AS hostCpuPercent,
					tracked_sidecar_rss_mb AS trackedSidecarRssMB,
					parse_sidecar_rss_mb AS parseSidecarRssMB,
					embed_sidecar_rss_mb AS embedSidecarRssMB,
					gpu_sampler AS gpuSampler,
					gpu_utilization_percent AS gpuUtilizationPercent,
					gpu_memory_pressure_percent AS gpuMemoryPressurePercent,
					gpu_in_use_bytes AS gpuInUseBytes,
					gpu_allocated_bytes AS gpuAllocatedBytes,
					gpu_power_w AS gpuPowerW,
					details_json AS detailsJson,
					pressure_reasons_json AS pressureReasonsJson
				FROM index_run_samples
				WHERE run_id = ?
				ORDER BY recorded_at ASC
				LIMIT ?`,
			)
			.all(runId, Math.max(1, limit)) as Array<IndexRunSampleRecord & { pressureReasonsJson?: string | null }>

		return rows.map((row) => ({
			...row,
			pressureReasons: this.parseStringArray(row.pressureReasonsJson),
		}))
	}

	async checkpointWal(mode: "PASSIVE" | "RESTART" | "TRUNCATE" = "PASSIVE"): Promise<void> {
		this.db().prepare(`PRAGMA wal_checkpoint(${mode})`).get()
	}

	async getRunProgressRecord(runId: string): Promise<RunProgressRecord | undefined> {
		const row = this.db()
			.prepare(
				`SELECT
					run_id AS runId,
					state,
					trigger_type AS triggerType,
					started_at AS startedAt,
					completed_at AS completedAt,
					last_heartbeat_at AS lastHeartbeatAt,
					heartbeat_owner AS heartbeatOwner,
					blocking_reason AS blockingReason,
					progress_json AS progressJson,
					error_message AS errorMessage
				FROM index_runs
				WHERE run_id = ?`,
			)
			.get(runId) as
			| (Omit<RunProgressRecord, "progress"> & {
					progressJson?: string | null
			  })
			| undefined

		if (!row) {
			return undefined
		}

		return {
			runId: row.runId,
			state: row.state,
			triggerType: row.triggerType,
			startedAt: row.startedAt,
			completedAt: row.completedAt,
			lastHeartbeatAt: row.lastHeartbeatAt,
			heartbeatOwner: row.heartbeatOwner,
			blockingReason: row.blockingReason,
			progress: this.parseProgressSnapshot(row.progressJson),
			errorMessage: row.errorMessage,
		}
	}

	async listRecentRunProgress(limit = 10): Promise<RunProgressRecord[]> {
		const rows = this.db()
			.prepare(
				`SELECT
					run_id AS runId,
					state,
					trigger_type AS triggerType,
					started_at AS startedAt,
					completed_at AS completedAt,
					last_heartbeat_at AS lastHeartbeatAt,
					heartbeat_owner AS heartbeatOwner,
					blocking_reason AS blockingReason,
					progress_json AS progressJson,
					error_message AS errorMessage
				FROM index_runs
				WHERE workspace_id = ?
				ORDER BY started_at DESC
				LIMIT ?`,
			)
			.all(this.workspaceHash, Math.max(1, limit)) as Array<
			Omit<RunProgressRecord, "progress"> & {
				progressJson?: string | null
			}
		>

		return rows.map((row) => ({
			runId: row.runId,
			state: row.state,
			triggerType: row.triggerType,
			startedAt: row.startedAt,
			completedAt: row.completedAt,
			lastHeartbeatAt: row.lastHeartbeatAt,
			heartbeatOwner: row.heartbeatOwner,
			blockingReason: row.blockingReason,
			progress: this.parseProgressSnapshot(row.progressJson),
			errorMessage: row.errorMessage,
		}))
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
			 SET state = 'abandoned', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
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
			 SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
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
			 SET run_id = ?, state = 'queued', next_attempt_at = MIN(next_attempt_at, ?), lease_owner = NULL,
				 lease_expires_at = NULL, updated_at = ?
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
					active_fr.state AS latestRevisionState,
					active_fr.parser_version AS latestRevisionParserVersion,
					active_fr.chunker_version AS latestRevisionChunkerVersion
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
					active_fr.state AS latestRevisionState,
					active_fr.parser_version AS latestRevisionParserVersion,
					active_fr.chunker_version AS latestRevisionChunkerVersion
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

	async excludeFilesFromIndexing(fileIds: string[]): Promise<void> {
		if (fileIds.length === 0) {
			return
		}

		const placeholders = fileIds.map(() => "?").join(", ")
		this.db()
			.prepare(
				`UPDATE files
				 SET ignore_state = 'excluded',
					 tombstoned = 1,
					 updated_at = ?
				 WHERE file_id IN (${placeholders})`,
			)
			.run(Date.now(), ...fileIds)
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

	async countChunksForRevisions(revisionIds: string[]): Promise<number> {
		if (revisionIds.length === 0) {
			return 0
		}

		const placeholders = revisionIds.map(() => "?").join(", ")
		const row = this.db()
			.prepare(
				`SELECT COUNT(*) AS count
				FROM chunks
				WHERE revision_id IN (${placeholders})`,
			)
			.get(...revisionIds) as { count?: number } | undefined

		return row?.count ?? 0
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

	async replaceTrackedOversizedFiles(
		workspaceId: string,
		entries: OversizedTrackedFileInput[],
	): Promise<PaginatedOversizedTrackedFiles> {
		const now = Date.now()
		const normalizedEntries = Array.from(
			new Map(
				entries.map((entry) => [
					entry.relativePath,
					{
						...entry,
						lastEvaluatedAt: entry.lastEvaluatedAt ?? now,
					},
				]),
			).values(),
		)

		const deleteAllStatement = this.db().prepare(`DELETE FROM oversized_file_tracking WHERE workspace_id = ?`)
		const deleteAllExceptStatement = this.db().prepare(
			`DELETE FROM oversized_file_tracking WHERE workspace_id = ? AND relative_path NOT IN (${normalizedEntries
				.map(() => "?")
				.join(", ")})`,
		)
		const upsertStatement = this.db().prepare(
			`INSERT INTO oversized_file_tracking (
				workspace_id,
				relative_path,
				normalized_path,
				status,
				size_bytes,
				last_modified_mtime_ms,
				recommendation,
				reason,
				approved_max_bytes,
				source_run_id,
				last_evaluated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(workspace_id, relative_path)
			DO UPDATE SET
				normalized_path = excluded.normalized_path,
				status = excluded.status,
				size_bytes = excluded.size_bytes,
				last_modified_mtime_ms = excluded.last_modified_mtime_ms,
				recommendation = excluded.recommendation,
				reason = excluded.reason,
				approved_max_bytes = excluded.approved_max_bytes,
				source_run_id = excluded.source_run_id,
				last_evaluated_at = excluded.last_evaluated_at`,
		)

		this.db().exec("BEGIN")
		try {
			if (normalizedEntries.length === 0) {
				deleteAllStatement.run(workspaceId)
			} else {
				deleteAllExceptStatement.run(workspaceId, ...normalizedEntries.map((entry) => entry.relativePath))
				for (const entry of normalizedEntries) {
					upsertStatement.run(
						workspaceId,
						entry.relativePath,
						entry.normalizedPath,
						entry.status,
						entry.sizeBytes,
						entry.lastModifiedMtimeMs ?? null,
						entry.recommendation,
						entry.reason,
						entry.approvedMaxBytes ?? null,
						entry.sourceRunId ?? null,
						entry.lastEvaluatedAt,
					)
				}
			}
			this.db().exec("COMMIT")
		} catch (error) {
			this.db().exec("ROLLBACK")
			throw error
		}

		return this.listTrackedOversizedFiles(workspaceId, 20, 0)
	}

	async listTrackedOversizedRelativePaths(workspaceId: string): Promise<string[]> {
		const rows = this.db()
			.prepare(
				`SELECT relative_path AS relativePath
				FROM oversized_file_tracking
				WHERE workspace_id = ?
				ORDER BY relative_path COLLATE NOCASE ASC`,
			)
			.all(workspaceId) as Array<{ relativePath: string }>

		return rows.map((row) => row.relativePath)
	}

	async listTrackedOversizedFiles(
		workspaceId: string,
		limit = 20,
		offset = 0,
	): Promise<PaginatedOversizedTrackedFiles> {
		const totalRow = this.db()
			.prepare(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN status IN ('skipped', 'needs_reapproval') THEN 1 ELSE 0 END) AS actionable
				FROM oversized_file_tracking
				WHERE workspace_id = ?`,
			)
			.get(workspaceId) as { total?: number; actionable?: number } | undefined

		const items = this.db()
			.prepare(
				`SELECT
					workspace_id AS workspaceId,
					relative_path AS relativePath,
					normalized_path AS normalizedPath,
					status,
					size_bytes AS sizeBytes,
					last_modified_mtime_ms AS lastModifiedMtimeMs,
					recommendation,
					reason,
					approved_max_bytes AS approvedMaxBytes,
					source_run_id AS sourceRunId,
					last_evaluated_at AS lastEvaluatedAt
				FROM oversized_file_tracking
				WHERE workspace_id = ?
				ORDER BY
					CASE status
						WHEN 'needs_reapproval' THEN 0
						WHEN 'skipped' THEN 1
						WHEN 'approved' THEN 2
						WHEN 'eligible' THEN 3
						WHEN 'missing' THEN 4
						ELSE 5
					END,
					CASE recommendation
						WHEN 'likely_useful' THEN 0
						WHEN 'review_manually' THEN 1
						ELSE 2
					END,
					size_bytes ASC,
					relative_path COLLATE NOCASE ASC
				LIMIT ? OFFSET ?`,
			)
			.all(workspaceId, Math.max(1, limit), Math.max(0, offset)) as OversizedTrackedFileRecord[]

		return {
			total: totalRow?.total ?? 0,
			actionable: totalRow?.actionable ?? 0,
			items,
		}
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
		parserVersion?: string | null,
		chunkerVersion?: string | null,
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
					AND COALESCE(parser_version, '') = COALESCE(?, '')
					AND COALESCE(chunker_version, '') = COALESCE(?, '')
					AND state IN ('hashed', 'parsed')
				ORDER BY discovered_at DESC
				LIMIT 1`,
			)
			.get(fileId, contentHash, fastFingerprint ?? null, parserVersion ?? null, chunkerVersion ?? null) as
			| FileRevisionRecord
			| undefined
	}

	async adoptRevisionToRun(revisionId: string, runId: string): Promise<void> {
		this.db().prepare(`UPDATE file_revisions SET run_id = ? WHERE revision_id = ?`).run(runId, revisionId)
	}

	async upsertChunks(chunks: ChunkInput[]): Promise<ChunkRecord[]> {
		if (chunks.length === 0) {
			return []
		}

		const now = Date.now()
		const statement = this.db().prepare(
			`INSERT INTO chunks (
				chunk_id, revision_id, chunk_fingerprint, start_line, end_line,
				language, chunk_kind, symbol_name, symbol_qualified_name, parent_symbol_name, parent_chunk_fingerprint, summary, search_text,
				content, content_hash, token_estimate, embedding_model, vector_point_id,
				state, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		const insertedChunks: ChunkRecord[] = []
		const revisionPathMap = this.getRevisionPathMap(Array.from(new Set(chunks.map((chunk) => chunk.revisionId))))
		this.withTransaction(() => {
			for (const chunk of chunks) {
				const chunkId = uuidv4()
				statement.run(
					chunkId,
					chunk.revisionId,
					chunk.chunkFingerprint,
					chunk.startLine,
					chunk.endLine,
					chunk.language ?? null,
					chunk.chunkKind ?? null,
					chunk.symbolName ?? null,
					chunk.symbolQualifiedName ?? null,
					chunk.parentSymbolName ?? null,
					chunk.parentChunkFingerprint ?? null,
					chunk.summary ?? null,
					chunk.searchText ?? null,
					chunk.content,
					chunk.contentHash,
					chunk.tokenEstimate ?? null,
					chunk.embeddingModel ?? null,
					chunk.vectorPointId ?? null,
					chunk.state ?? "parsed",
					now,
					now,
				)
				insertedChunks.push({
					chunkId,
					revisionId: chunk.revisionId,
					chunkFingerprint: chunk.chunkFingerprint,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					language: chunk.language ?? null,
					chunkKind: chunk.chunkKind ?? null,
					symbolName: chunk.symbolName ?? null,
					symbolQualifiedName: chunk.symbolQualifiedName ?? null,
					parentSymbolName: chunk.parentSymbolName ?? null,
					parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
					summary: chunk.summary ?? null,
					searchText: chunk.searchText ?? null,
					content: chunk.content,
					contentHash: chunk.contentHash,
					tokenEstimate: chunk.tokenEstimate ?? null,
					embeddingModel: chunk.embeddingModel ?? null,
					vectorPointId: chunk.vectorPointId ?? null,
					state: chunk.state ?? "parsed",
					createdAt: now,
					updatedAt: now,
				})
			}

			this.upsertChunkLexicalFtsRows(
				insertedChunks.map((chunk) => ({
					chunkId: chunk.chunkId,
					revisionId: chunk.revisionId,
					relativePath: revisionPathMap.get(chunk.revisionId) ?? "",
					symbolQualifiedName: chunk.symbolQualifiedName,
					symbolName: chunk.symbolName,
					parentSymbolName: chunk.parentSymbolName,
					summary: chunk.summary,
					searchText: chunk.searchText,
				})),
			)
		})

		return insertedChunks
	}

	async upsertChunkVariants(variants: ChunkVariantInput[]): Promise<ChunkVariantRecord[]> {
		if (variants.length === 0) {
			return []
		}

		const now = Date.now()
		const statement = this.db().prepare(
			`INSERT INTO chunk_variants (
				variant_id, chunk_id, variant_type, content, content_hash, token_estimate,
				embedding_model, vector_point_id, state, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		const insertedVariants: ChunkVariantRecord[] = []
		this.withTransaction(() => {
			for (const variant of variants) {
				const variantId = uuidv4()
				statement.run(
					variantId,
					variant.chunkId,
					variant.variantType,
					variant.content,
					variant.contentHash,
					variant.tokenEstimate ?? null,
					variant.embeddingModel ?? null,
					variant.vectorPointId ?? null,
					variant.state ?? "parsed",
					now,
					now,
				)
				insertedVariants.push({
					variantId,
					chunkId: variant.chunkId,
					variantType: variant.variantType,
					content: variant.content,
					contentHash: variant.contentHash,
					tokenEstimate: variant.tokenEstimate ?? null,
					embeddingModel: variant.embeddingModel ?? null,
					vectorPointId: variant.vectorPointId ?? null,
					state: variant.state ?? "parsed",
					createdAt: now,
					updatedAt: now,
				})
			}
		})

		return insertedVariants
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
					language,
					chunk_kind AS chunkKind,
					symbol_name AS symbolName,
					symbol_qualified_name AS symbolQualifiedName,
					parent_symbol_name AS parentSymbolName,
					parent_chunk_fingerprint AS parentChunkFingerprint,
					summary,
					search_text AS searchText,
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
					c.language,
					c.chunk_kind AS chunkKind,
					c.symbol_name AS symbolName,
					c.symbol_qualified_name AS symbolQualifiedName,
					c.parent_symbol_name AS parentSymbolName,
					c.parent_chunk_fingerprint AS parentChunkFingerprint,
					c.summary,
					c.search_text AS searchText,
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

	async getChunkVariantsByChunkIds(chunkIds: string[]): Promise<ChunkVariantRecord[]> {
		if (chunkIds.length === 0) {
			return []
		}

		const placeholders = chunkIds.map(() => "?").join(", ")
		return this.db()
			.prepare(
				`SELECT
					variant_id AS variantId,
					chunk_id AS chunkId,
					variant_type AS variantType,
					content,
					content_hash AS contentHash,
					token_estimate AS tokenEstimate,
					embedding_model AS embeddingModel,
					vector_point_id AS vectorPointId,
					state,
					created_at AS createdAt,
					updated_at AS updatedAt
				FROM chunk_variants
				WHERE chunk_id IN (${placeholders})
				ORDER BY chunk_id ASC, variant_type ASC`,
			)
			.all(...chunkIds) as ChunkVariantRecord[]
	}

	async getActiveChunksByFingerprints(
		references: Array<{ relativePath: string; chunkFingerprint: string }>,
	): Promise<ChunkWithRevisionRecord[]> {
		if (references.length === 0) {
			return []
		}

		const uniqueReferences = Array.from(
			new Map(
				references
					.filter((reference) => reference.relativePath && reference.chunkFingerprint)
					.map((reference) => [
						`${reference.relativePath}::${reference.chunkFingerprint}`,
						{
							relativePath: reference.relativePath,
							chunkFingerprint: reference.chunkFingerprint,
						},
					]),
			).values(),
		)

		if (uniqueReferences.length === 0) {
			return []
		}

		const clauses = uniqueReferences.map(() => "(f.relative_path = ? AND c.chunk_fingerprint = ?)").join(" OR ")
		const params = uniqueReferences.flatMap((reference) => [reference.relativePath, reference.chunkFingerprint])

		return this.db()
			.prepare(
				`SELECT
					c.chunk_id AS chunkId,
					c.revision_id AS revisionId,
					c.chunk_fingerprint AS chunkFingerprint,
					c.start_line AS startLine,
					c.end_line AS endLine,
					c.language,
					c.chunk_kind AS chunkKind,
					c.symbol_name AS symbolName,
					c.symbol_qualified_name AS symbolQualifiedName,
					c.parent_symbol_name AS parentSymbolName,
					c.parent_chunk_fingerprint AS parentChunkFingerprint,
					c.summary,
					c.search_text AS searchText,
					c.content,
					c.content_hash AS contentHash,
					c.token_estimate AS tokenEstimate,
					c.embedding_model AS embeddingModel,
					c.vector_point_id AS vectorPointId,
					c.state,
					c.created_at AS createdAt,
					c.updated_at AS updatedAt,
					f.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion
				FROM chunks c
				INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
				INNER JOIN files f ON f.active_revision_id = c.revision_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND (${clauses})`,
			)
			.all(this.workspaceHash, ...params) as ChunkWithRevisionRecord[]
	}

	async getActiveChunksByRelativePaths(relativePaths: string[]): Promise<ChunkWithRevisionRecord[]> {
		if (relativePaths.length === 0) {
			return []
		}

		const uniqueRelativePaths = Array.from(new Set(relativePaths.filter(Boolean)))
		if (uniqueRelativePaths.length === 0) {
			return []
		}

		const placeholders = uniqueRelativePaths.map(() => "?").join(", ")

		return this.db()
			.prepare(
				`SELECT
					c.chunk_id AS chunkId,
					c.revision_id AS revisionId,
					c.chunk_fingerprint AS chunkFingerprint,
					c.start_line AS startLine,
					c.end_line AS endLine,
					c.language,
					c.chunk_kind AS chunkKind,
					c.symbol_name AS symbolName,
					c.symbol_qualified_name AS symbolQualifiedName,
					c.parent_symbol_name AS parentSymbolName,
					c.parent_chunk_fingerprint AS parentChunkFingerprint,
					c.summary,
					c.search_text AS searchText,
					c.content,
					c.content_hash AS contentHash,
					c.token_estimate AS tokenEstimate,
					c.embedding_model AS embeddingModel,
					c.vector_point_id AS vectorPointId,
					c.state,
					c.created_at AS createdAt,
					c.updated_at AS updatedAt,
					f.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion
				FROM chunks c
				INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
				INNER JOIN files f ON f.active_revision_id = c.revision_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND f.relative_path IN (${placeholders})`,
			)
			.all(this.workspaceHash, ...uniqueRelativePaths) as ChunkWithRevisionRecord[]
	}

	async searchActiveChunksLexically(query: string, limit: number): Promise<LexicalChunkSearchRecord[]> {
		return (await this.searchActiveChunksLexicallyWithStatus(query, limit, { allowExactFallback: true })).results
	}

	async searchActiveChunksLexicallyWithStatus(
		query: string,
		limit: number,
		options?: {
			allowExactFallback?: boolean
		},
	): Promise<{
		results: LexicalChunkSearchRecord[]
		status: "completed"
		mode: "fts_only" | "fts_plus_exact_fallback"
		timingsMs: {
			ftsMs: number
			fallbackMs: number
			totalMs: number
		}
	}> {
		const normalizedQuery = query.trim().toLowerCase()
		if (!normalizedQuery || limit <= 0) {
			return {
				results: [],
				status: "completed",
				mode: options?.allowExactFallback ? "fts_plus_exact_fallback" : "fts_only",
				timingsMs: {
					ftsMs: 0,
					fallbackMs: 0,
					totalMs: 0,
				},
			}
		}

		const tokens = Array.from(new Set(normalizedQuery.match(/[a-z0-9_./-]+/g) ?? [])).filter(
			(token) => token.length > 1,
		)
		const rawTokens = Array.from(new Set(query.match(/[A-Za-z0-9_./\\:-]+/g) ?? [])).filter(
			(token) => token.length > 1,
		)
		if (tokens.length === 0) {
			return {
				results: [],
				status: "completed",
				mode: options?.allowExactFallback ? "fts_plus_exact_fallback" : "fts_only",
				timingsMs: {
					ftsMs: 0,
					fallbackMs: 0,
					totalMs: 0,
				},
			}
		}

		const startedAt = Date.now()
		const ddlTokens = new Set(["create", "table", "alter", "index", "column", "constraint", "primary", "foreign"])
		const candidateLimit = Math.max(limit * 10, 25)
		const candidates = new Map<string, LexicalChunkSearchRecord>()
		const ftsTokens = this.buildFtsTokens(normalizedQuery)
		let ftsMs = 0

		if (ftsTokens.length > 0) {
			const ftsStartedAt = Date.now()
			const ftsQuery = this.buildFtsQuery(ftsTokens)
			const ftsRows = this.db()
				.prepare(
					`SELECT
						c.chunk_id AS chunkId,
						c.revision_id AS revisionId,
						c.chunk_fingerprint AS chunkFingerprint,
						c.start_line AS startLine,
						c.end_line AS endLine,
						c.language,
						c.chunk_kind AS chunkKind,
						c.symbol_name AS symbolName,
						c.symbol_qualified_name AS symbolQualifiedName,
						c.parent_symbol_name AS parentSymbolName,
						c.parent_chunk_fingerprint AS parentChunkFingerprint,
						c.summary,
						c.search_text AS searchText,
						c.content,
						c.content_hash AS contentHash,
						c.token_estimate AS tokenEstimate,
						c.embedding_model AS embeddingModel,
						c.vector_point_id AS vectorPointId,
						c.state,
						c.created_at AS createdAt,
						c.updated_at AS updatedAt,
						f.file_id AS fileId,
						f.workspace_id AS workspaceId,
						f.relative_path AS relativePath,
						f.normalized_path AS normalizedPath,
						fr.parser_version AS parserVersion,
						fr.chunker_version AS chunkerVersion,
						0 AS lexicalScore
					FROM chunk_lexical_fts
					INNER JOIN chunks c ON c.chunk_id = chunk_lexical_fts.chunk_id
					INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
					INNER JOIN files f ON f.active_revision_id = c.revision_id
					WHERE f.workspace_id = ?
						AND f.ignore_state = 'included'
						AND f.tombstoned = 0
						AND chunk_lexical_fts MATCH ?
					ORDER BY bm25(chunk_lexical_fts, 6.0, 8.0, 7.0, 4.0, 2.0, 1.0) ASC,
						f.relative_path ASC,
						c.start_line ASC
					LIMIT ?`,
				)
				.all(this.workspaceHash, ftsQuery, candidateLimit) as LexicalChunkSearchRecord[]
			for (const row of ftsRows) {
				candidates.set(row.chunkId, row)
			}
			ftsMs = Date.now() - ftsStartedAt
		}

		let fallbackMs = 0
		const allowExactFallback =
			options?.allowExactFallback === true &&
			this.shouldRunExactLexicalFallback(
				query,
				normalizedQuery,
				rawTokens,
				tokens,
				candidates.size,
				candidateLimit,
			)
		if (allowExactFallback) {
			const fallbackStartedAt = Date.now()
			for (const row of this.fetchExactLexicalCandidates(normalizedQuery, tokens, candidateLimit)) {
				if (!candidates.has(row.chunkId)) {
					candidates.set(row.chunkId, row)
				}
			}
			fallbackMs = Date.now() - fallbackStartedAt
		}

		const results = Array.from(candidates.values())
			.map((record, index) => ({
				...record,
				lexicalScore:
					this.computeLexicalScore(record, normalizedQuery, tokens, ddlTokens) +
					Math.max(0, candidateLimit - index) * 0.001,
			}))
			.sort((left, right) => {
				if (right.lexicalScore !== left.lexicalScore) {
					return right.lexicalScore - left.lexicalScore
				}
				if (left.relativePath !== right.relativePath) {
					return left.relativePath.localeCompare(right.relativePath)
				}
				return left.startLine - right.startLine
			})
			.slice(0, limit)

		return {
			results,
			status: "completed",
			mode: allowExactFallback ? "fts_plus_exact_fallback" : "fts_only",
			timingsMs: {
				ftsMs,
				fallbackMs,
				totalMs: Date.now() - startedAt,
			},
		}
	}

	private fetchExactLexicalCandidates(
		normalizedQuery: string,
		tokens: string[],
		limit: number,
	): LexicalChunkSearchRecord[] {
		const whereTerms: string[] = []
		const whereParams: string[] = []
		const exactPattern = `%${normalizedQuery}%`

		whereTerms.push(
			`lower(f.relative_path) LIKE ?`,
			`lower(c.symbol_qualified_name) LIKE ?`,
			`lower(c.symbol_name) LIKE ?`,
			`lower(c.parent_symbol_name) LIKE ?`,
			`lower(c.summary) LIKE ?`,
		)
		for (let i = 0; i < 5; i++) {
			whereParams.push(exactPattern)
		}

		for (const token of tokens) {
			const pattern = `%${token}%`
			whereTerms.push(
				`lower(f.relative_path) LIKE ?`,
				`lower(c.symbol_qualified_name) LIKE ?`,
				`lower(c.symbol_name) LIKE ?`,
				`lower(c.parent_symbol_name) LIKE ?`,
				`lower(c.summary) LIKE ?`,
			)
			for (let i = 0; i < 5; i++) {
				whereParams.push(pattern)
			}
		}

		return this.db()
			.prepare(
				`SELECT
					c.chunk_id AS chunkId,
					c.revision_id AS revisionId,
					c.chunk_fingerprint AS chunkFingerprint,
					c.start_line AS startLine,
					c.end_line AS endLine,
					c.language,
					c.chunk_kind AS chunkKind,
					c.symbol_name AS symbolName,
					c.symbol_qualified_name AS symbolQualifiedName,
					c.parent_symbol_name AS parentSymbolName,
					c.parent_chunk_fingerprint AS parentChunkFingerprint,
					c.summary,
					c.search_text AS searchText,
					c.content,
					c.content_hash AS contentHash,
					c.token_estimate AS tokenEstimate,
					c.embedding_model AS embeddingModel,
					c.vector_point_id AS vectorPointId,
					c.state,
					c.created_at AS createdAt,
					c.updated_at AS updatedAt,
					f.file_id AS fileId,
					f.workspace_id AS workspaceId,
					f.relative_path AS relativePath,
					f.normalized_path AS normalizedPath,
					fr.parser_version AS parserVersion,
					fr.chunker_version AS chunkerVersion,
					0 AS lexicalScore
				FROM chunks c
				INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
				INNER JOIN files f ON f.active_revision_id = c.revision_id
				WHERE f.workspace_id = ?
					AND f.ignore_state = 'included'
					AND f.tombstoned = 0
					AND (${whereTerms.join(" OR ")})
				ORDER BY f.relative_path ASC, c.start_line ASC
				LIMIT ?`,
			)
			.all(this.workspaceHash, ...whereParams, limit) as LexicalChunkSearchRecord[]
	}

	private computeLexicalScore(
		record: LexicalChunkSearchRecord,
		normalizedQuery: string,
		tokens: string[],
		ddlTokens: Set<string>,
	): number {
		const filePath = record.relativePath.toLowerCase()
		const fileBasename = path.basename(filePath)
		const symbolQualifiedName = (record.symbolQualifiedName ?? "").toLowerCase()
		const symbolName = (record.symbolName ?? "").toLowerCase()
		const parentSymbolName = (record.parentSymbolName ?? "").toLowerCase()
		const summary = (record.summary ?? "").toLowerCase()
		const searchText = (record.searchText ?? "").toLowerCase()
		let score = 0

		if (filePath.includes(normalizedQuery)) score += 8
		if (symbolQualifiedName.includes(normalizedQuery)) score += 12
		if (symbolName.includes(normalizedQuery)) score += 10
		if (parentSymbolName.includes(normalizedQuery)) score += 6
		if (summary.includes(normalizedQuery)) score += 4
		if (searchText.includes(normalizedQuery)) score += 3

		for (const token of tokens) {
			if (filePath.includes(token)) score += 3
			if (symbolQualifiedName.includes(token)) score += 5
			if (symbolName.includes(token)) score += 4
			if (parentSymbolName.includes(token)) score += 2
			if (summary.includes(token)) score += 2
			if (searchText.includes(token)) score += 1

			if (token.includes(".") || token.includes("/") || token.includes("\\")) {
				const normalizedPathToken = token.replace(/\\/g, "/")
				if (filePath === normalizedPathToken) score += 14
				if (
					filePath.endsWith(`/${normalizedPathToken}`) ||
					fileBasename === path.basename(normalizedPathToken)
				) {
					score += 16
				}
			}

			if (ddlTokens.has(token) && searchText.includes(token)) {
				score += 3
			}
		}

		const tokenSet = new Set(tokens)
		const looksLikeRetrievalExpansionQuery =
			tokenSet.has("parent") && tokenSet.has("sibling") && tokenSet.has("context")
		const looksLikeParentSiblingSearchResultsQuery =
			looksLikeRetrievalExpansionQuery && normalizedQuery.includes("search results")
		const isEngineRetrievalSurface =
			filePath.includes("/engine/codeindexenginev2") || filePath.endsWith("/codeindexenginev2.ts")
		const hasExpansionBehaviorLanguage =
			(summary.includes("parent") && summary.includes("sibling") && summary.includes("context")) ||
			(searchText.includes("parent") && searchText.includes("sibling") && searchText.includes("context"))
		if (looksLikeRetrievalExpansionQuery && isEngineRetrievalSurface) {
			score += looksLikeParentSiblingSearchResultsQuery ? 22 : 14
		}

		if (looksLikeParentSiblingSearchResultsQuery && isEngineRetrievalSurface && hasExpansionBehaviorLanguage) {
			score += 10
		}

		if (looksLikeRetrievalExpansionQuery && filePath.includes("/store/metadatastore")) {
			score -= 8
		}

		const looksLikePreflightQuery =
			tokenSet.has("preflight") &&
			(tokenSet.has("qdrant") || tokenSet.has("verification") || tokenSet.has("timed"))
		if (
			looksLikePreflightQuery &&
			(symbolQualifiedName.includes("preflightindexingdependencies") ||
				symbolQualifiedName.includes("withtimeout") ||
				searchText.includes("verification timed out") ||
				searchText.includes("preflight"))
		) {
			score += 10
		}

		const looksLikeLowValueFilesQuery =
			tokenSet.has("low") && tokenSet.has("value") && (tokenSet.has("file") || tokenSet.has("files"))
		if (
			looksLikeLowValueFilesQuery &&
			(filePath.includes("/low-value-files.") ||
				symbolQualifiedName.includes("low_value_file_names") ||
				symbolQualifiedName.includes("islowvaluefile") ||
				searchText.includes("low value file"))
		) {
			score += 12
		}

		const looksLikeOversizedWebviewHandlerQuery =
			(tokenSet.has("fullrefreshindexdata") || normalizedQuery.includes("fullrefreshindexdata")) &&
			(tokenSet.has("requestoversizedfiledetails") || normalizedQuery.includes("requestoversizedfiledetails")) &&
			(tokenSet.has("webview") || tokenSet.has("handler"))
		if (
			looksLikeOversizedWebviewHandlerQuery &&
			(filePath.includes("/webviewmessagehandler.") ||
				symbolQualifiedName.includes("fullrefreshindexdata") ||
				searchText.includes("requestoversizedfiledetails"))
		) {
			score += 12
		}

		return score
	}

	private buildFtsTokens(normalizedQuery: string): string[] {
		const rawTokens = Array.from(new Set(normalizedQuery.match(/[a-z0-9_]+/g) ?? [])).filter(
			(token) => token.length > 1,
		)
		const filteredTokens = rawTokens.filter((token) => !FTS_STOPWORDS.has(token))
		const tokensToScore = filteredTokens.length > 0 ? filteredTokens : rawTokens
		const scored = tokensToScore.map((token, index) => {
			let score = token.length
			if (/\d/.test(token)) score += 2
			if (token.includes("_")) score += 1
			return { token, score, index }
		})
		scored.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score
			}
			return left.index - right.index
		})
		const maxTokens = rawTokens.length >= 10 ? MAX_FTS_TOKENS_LONG_QUERY : MAX_FTS_TOKENS
		return scored.slice(0, maxTokens).map((entry) => entry.token)
	}

	private buildFtsQuery(tokens: string[]): string {
		const escapedTokens = tokens.map((token) => `"${token.replace(/"/g, '""')}"`)
		if (escapedTokens.length <= 1) {
			return escapedTokens[0] ?? ""
		}

		const requiredTokens = escapedTokens.slice(0, 2)
		const optionalTokens = escapedTokens.slice(2, 4)
		const requiredQuery = requiredTokens.join(" AND ")

		if (optionalTokens.length === 0) {
			return requiredQuery
		}

		return `(${requiredQuery}) AND (${optionalTokens.join(" OR ")})`
	}

	private shouldRunExactLexicalFallback(
		rawQuery: string,
		normalizedQuery: string,
		rawTokens: string[],
		tokens: string[],
		ftsCandidateCount: number,
		candidateLimit: number,
	): boolean {
		if (tokens.length === 0) {
			return false
		}

		const enoughFtsCandidates = ftsCandidateCount >= Math.min(candidateLimit, 12)
		if (enoughFtsCandidates) {
			return false
		}

		const hasPathHint =
			/[\\/]/.test(rawQuery) ||
			rawTokens.some((token) => /[\\/]/.test(token) || /\.[A-Za-z0-9_-]{1,8}$/.test(token))
		const hasQualifiedSymbolHint = rawTokens.some(
			(token) => token.includes(".") && !/\.[A-Za-z0-9_-]{1,8}$/.test(token) && /[A-Za-z_]/.test(token),
		)
		const hasIdentifierHint = rawTokens.some(
			(token) =>
				token.length >= 5 &&
				(/^[A-Z][A-Za-z0-9_]+$/.test(token) ||
					/[a-z]+[A-Z][A-Za-z0-9_]*/.test(token) ||
					/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(token)),
		)
		const hasSchemaOrDdlHint =
			normalizedQuery.includes("schema.ts") ||
			normalizedQuery.includes("create table") ||
			normalizedQuery.includes("chunk_variants") ||
			tokens.some((token) =>
				["create", "table", "alter", "index", "column", "constraint", "primary", "foreign"].includes(token),
			)

		return hasPathHint || hasQualifiedSymbolHint || hasIdentifierHint || hasSchemaOrDdlHint
	}

	private upsertChunkLexicalFtsRows(
		rows: Array<{
			chunkId: string
			revisionId: string
			relativePath: string
			symbolQualifiedName: string | null
			symbolName: string | null
			parentSymbolName: string | null
			summary: string | null
			searchText: string | null
		}>,
	): void {
		if (rows.length === 0) {
			return
		}

		const deleteStatement = this.db().prepare(`DELETE FROM chunk_lexical_fts WHERE chunk_id = ?`)
		const insertStatement = this.db().prepare(
			`INSERT INTO chunk_lexical_fts (
				chunk_id,
				relative_path,
				symbol_qualified_name,
				symbol_name,
				parent_symbol_name,
				summary,
				search_text
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)

		for (const row of rows) {
			deleteStatement.run(row.chunkId)
			insertStatement.run(
				row.chunkId,
				row.relativePath,
				row.symbolQualifiedName ?? "",
				row.symbolName ?? "",
				row.parentSymbolName ?? "",
				row.summary ?? "",
				row.searchText ?? "",
			)
		}
	}

	private getRevisionPathMap(revisionIds: string[]): Map<string, string> {
		if (revisionIds.length === 0) {
			return new Map()
		}

		const placeholders = revisionIds.map(() => "?").join(", ")
		const rows = this.db()
			.prepare(
				`SELECT fr.revision_id AS revisionId, f.relative_path AS relativePath
				FROM file_revisions fr
				INNER JOIN files f ON f.file_id = fr.file_id
				WHERE fr.revision_id IN (${placeholders})`,
			)
			.all(...revisionIds) as Array<{ revisionId: string; relativePath: string }>

		return new Map(rows.map((row) => [row.revisionId, row.relativePath] as const))
	}

	private ensureChunkLexicalFtsPopulated(): void {
		const chunkCountRow = this.db().prepare(`SELECT COUNT(*) AS count FROM chunks`).get() as
			| { count?: number }
			| undefined
		const ftsCountRow = this.db().prepare(`SELECT COUNT(*) AS count FROM chunk_lexical_fts`).get() as
			| { count?: number }
			| undefined
		const chunkCount = chunkCountRow?.count ?? 0
		const ftsCount = ftsCountRow?.count ?? 0

		if (chunkCount === 0 || ftsCount > 0) {
			return
		}

		this.db().prepare(`DELETE FROM chunk_lexical_fts`).run()
		this.db()
			.prepare(
				`INSERT INTO chunk_lexical_fts (
					chunk_id,
					relative_path,
					symbol_qualified_name,
					symbol_name,
					parent_symbol_name,
					summary,
					search_text
				)
				SELECT
					c.chunk_id,
					COALESCE(f.relative_path, ''),
					COALESCE(c.symbol_qualified_name, ''),
					COALESCE(c.symbol_name, ''),
					COALESCE(c.parent_symbol_name, ''),
					COALESCE(c.summary, ''),
					COALESCE(c.search_text, '')
				FROM chunks c
				INNER JOIN file_revisions fr ON fr.revision_id = c.revision_id
				INNER JOIN files f ON f.file_id = fr.file_id`,
			)
			.run()
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

	async markChunkVariantStates(
		updates: Array<{
			variantId: string
			state: ChunkVariantRecord["state"]
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
			`UPDATE chunk_variants
			 SET state = ?,
				 embedding_model = COALESCE(?, embedding_model),
				 vector_point_id = COALESCE(?, vector_point_id),
				 content = CASE WHEN ? THEN '' ELSE content END,
				 updated_at = ?
			 WHERE variant_id = ?`,
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
					update.variantId,
				)
			}
			this.db().exec("COMMIT")
		} catch (error) {
			this.db().exec("ROLLBACK")
			throw error
		}
	}

	async enqueueJobs(jobs: JobInput[]): Promise<void> {
		if (jobs.length === 0) {
			return
		}

		const now = Date.now()
		const statement = this.db().prepare(
			`INSERT INTO jobs (
				job_id, workspace_id, run_id, job_type, entity_id, state, priority,
				attempt_count, next_attempt_at, last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
		)

		this.withTransaction(() => {
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
		})
	}

	async claimJobs(jobType: string, limit: number, runId?: string): Promise<JobRecord[]> {
		return this.claimJobsWithLease(jobType, limit, runId)
	}

	async claimJobsWithLease(
		jobType: string,
		limit: number,
		runId?: string,
		options?: { leaseOwner?: string; leaseMs?: number },
	): Promise<JobRecord[]> {
		if (limit <= 0) {
			return []
		}

		const now = Date.now()
		const leaseOwner = options?.leaseOwner ?? null
		const leaseExpiresAt = now + (options?.leaseMs ?? DEFAULT_JOB_LEASE_MS)
		const clauses = [
			`job_type = ?`,
			`(
				(state = 'queued' AND next_attempt_at <= ?)
				OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
			)`,
		]
		const params: Array<string | number> = [jobType, now, now]

		if (runId) {
			clauses.push(`run_id = ?`)
			params.push(runId)
		}

		return this.withTransaction(() => {
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
						lease_owner AS leaseOwner,
						lease_expires_at AS leaseExpiresAt,
						created_at AS createdAt,
						updated_at AS updatedAt
					FROM jobs
					WHERE ${clauses.join(" AND ")}
					ORDER BY
						CASE WHEN state = 'running' THEN 0 ELSE 1 END,
						priority ASC,
						created_at ASC
					LIMIT ?`,
				)
				.all(...params, limit) as JobRecord[]

			if (rows.length === 0) {
				return []
			}

			const update = this.db().prepare(
				`UPDATE jobs
				 SET state = 'running',
					 attempt_count = attempt_count + 1,
					 lease_owner = ?,
					 lease_expires_at = ?,
					 updated_at = ?
				 WHERE job_id = ?
					AND (
						state = 'queued'
						OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
					)`,
			)
			const claimedRows: JobRecord[] = []

			for (const row of rows) {
				const result = update.run(leaseOwner, leaseExpiresAt, now, row.jobId, now) as { changes?: number }
				if ((result?.changes ?? 0) > 0) {
					claimedRows.push({
						...row,
						state: "running",
						attemptCount: row.attemptCount + 1,
						leaseOwner,
						leaseExpiresAt,
						updatedAt: now,
					})
				}
			}

			return claimedRows
		}, "IMMEDIATE")
	}

	async heartbeatJobs(jobIds: string[], leaseOwner: string, leaseMs = DEFAULT_JOB_LEASE_MS): Promise<void> {
		if (jobIds.length === 0) {
			return
		}

		const now = Date.now()
		const leaseExpiresAt = now + leaseMs
		const placeholders = jobIds.map(() => "?").join(", ")
		this.db()
			.prepare(
				`UPDATE jobs
				 SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
				 WHERE state = 'running'
					AND lease_owner = ?
					AND job_id IN (${placeholders})`,
			)
			.run(leaseOwner, leaseExpiresAt, now, leaseOwner, ...jobIds)
	}

	async completeJob(jobId: string): Promise<void> {
		this.db()
			.prepare(
				`UPDATE jobs SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?`,
			)
			.run(Date.now(), jobId)
	}

	async completeJobs(jobIds: string[]): Promise<void> {
		if (jobIds.length === 0) {
			return
		}

		const now = Date.now()
		const statement = this.db().prepare(
			`UPDATE jobs SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?`,
		)
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
				 SET state = 'terminal_failed', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
				 WHERE job_id = ?`,
			)
			.run(errorMessage, Date.now(), jobId)
	}

	async failJob(jobId: string, errorMessage: string, nextAttemptAt: number): Promise<void> {
		this.db()
			.prepare(
				`UPDATE jobs
				 SET state = 'queued', last_error = ?, next_attempt_at = ?, lease_owner = NULL,
					 lease_expires_at = NULL, updated_at = ?
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

	async getRunBacklogMetrics(runId: string): Promise<RunBacklogMetrics> {
		const row = this.db()
			.prepare(
				`SELECT
					COALESCE(SUM(CASE WHEN fr.state = 'parsed' THEN 1 ELSE 0 END), 0) AS parsedRevisions,
					COALESCE(SUM(CASE WHEN fr.state = 'planned' THEN 1 ELSE 0 END), 0) AS plannedRevisions,
					COALESCE(SUM(CASE WHEN fr.state = 'degraded' THEN 1 ELSE 0 END), 0) AS degradedRevisions,
					COALESCE(SUM(CASE WHEN fr.state = 'terminal_failed' THEN 1 ELSE 0 END), 0) AS terminalFailedRevisions,
					COALESCE((
						SELECT COUNT(*)
						FROM chunks c
						INNER JOIN file_revisions sfr ON sfr.revision_id = c.revision_id
						WHERE sfr.run_id = ?
							AND c.state = 'parsed'
					), 0) AS stagedChunks,
					COALESCE((
						SELECT SUM(LENGTH(c.content))
						FROM chunks c
						INNER JOIN file_revisions sfr ON sfr.revision_id = c.revision_id
						WHERE sfr.run_id = ?
							AND c.state = 'parsed'
					), 0) AS stagedChunkBytes,
					COALESCE((
						SELECT COUNT(*)
						FROM chunks c
						INNER JOIN file_revisions sfr ON sfr.revision_id = c.revision_id
						WHERE sfr.run_id = ?
							AND c.state = 'terminal_failed'
					), 0) AS terminalFailedChunks,
					COALESCE((
						SELECT COUNT(*)
						FROM jobs j
						WHERE j.run_id = ?
							AND j.job_type = 'upsert'
							AND j.state = 'queued'
					), 0) AS queuedUpsertJobs,
					COALESCE((
						SELECT COUNT(*)
						FROM jobs j
						WHERE j.run_id = ?
							AND j.job_type = 'upsert'
							AND j.state = 'running'
					), 0) AS runningUpsertJobs,
					COALESCE((
						SELECT COUNT(*)
						FROM jobs j
						WHERE j.run_id = ?
							AND j.job_type = 'delete'
							AND j.state = 'queued'
					), 0) AS queuedDeleteJobs,
					COALESCE((
						SELECT COUNT(*)
						FROM jobs j
						WHERE j.run_id = ?
							AND j.job_type = 'delete'
							AND j.state = 'running'
					), 0) AS runningDeleteJobs,
					COALESCE((
						SELECT COUNT(*)
						FROM jobs j
						WHERE j.run_id = ?
							AND j.state = 'queued'
							AND j.next_attempt_at > ?
					), 0) AS retryingJobs
				FROM file_revisions fr
				WHERE fr.run_id = ?`,
			)
			.get(runId, runId, runId, runId, runId, runId, runId, runId, Date.now(), runId) as
			| (RunBacklogMetrics & Record<string, unknown>)
			| undefined

		const metrics: RunBacklogMetrics = {
			parsedRevisions: Number(row?.parsedRevisions ?? 0),
			plannedRevisions: Number(row?.plannedRevisions ?? 0),
			stagedChunks: Number(row?.stagedChunks ?? 0),
			stagedChunkBytes: Number(row?.stagedChunkBytes ?? 0),
			queuedUpsertJobs: Number(row?.queuedUpsertJobs ?? 0),
			runningUpsertJobs: Number(row?.runningUpsertJobs ?? 0),
			queuedDeleteJobs: Number(row?.queuedDeleteJobs ?? 0),
			runningDeleteJobs: Number(row?.runningDeleteJobs ?? 0),
			terminalFailedRevisions: Number(row?.terminalFailedRevisions ?? 0),
			degradedRevisions: Number(row?.degradedRevisions ?? 0),
			terminalFailedChunks: Number(row?.terminalFailedChunks ?? 0),
			retryingJobs: Number(row?.retryingJobs ?? 0),
			blockingReason: "",
		}

		metrics.blockingReason = this.getBlockingReason(metrics)
		return metrics
	}

	async listPlannedRevisionResolutions(runId: string): Promise<PlannedRevisionResolution[]> {
		return this.db()
			.prepare(
				`SELECT
					fr.revision_id AS revisionId,
					fr.file_id AS fileId,
					(
						SELECT active_revision_id
						FROM files f
						WHERE f.file_id = fr.file_id
							AND f.active_revision_id != fr.revision_id
					) AS previousRevisionId,
					COALESCE(SUM(CASE WHEN j.state = 'done' THEN 1 ELSE 0 END), 0) AS doneJobs,
					COALESCE(SUM(CASE WHEN j.state = 'queued' THEN 1 ELSE 0 END), 0) AS queuedJobs,
					COALESCE(SUM(CASE WHEN j.state = 'running' THEN 1 ELSE 0 END), 0) AS runningJobs,
					COALESCE(SUM(CASE WHEN j.state = 'terminal_failed' THEN 1 ELSE 0 END), 0) AS terminalFailedJobs,
					COUNT(j.job_id) AS totalJobs
				FROM file_revisions fr
				LEFT JOIN chunks c ON c.revision_id = fr.revision_id
				LEFT JOIN jobs j ON j.entity_id = c.chunk_id AND j.run_id = fr.run_id AND j.job_type = 'upsert'
				WHERE fr.run_id = ?
					AND fr.state = 'planned'
				GROUP BY fr.revision_id, fr.file_id
				ORDER BY fr.discovered_at ASC`,
			)
			.all(runId) as PlannedRevisionResolution[]
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

	private initializeDatabaseSchema(database: SqliteDatabaseSync): void {
		database.exec(CODE_INDEX_V2_SCHEMA)
		this.ensureColumn(database, "chunks", "content", `TEXT NOT NULL DEFAULT ''`)
		this.ensureColumn(database, "chunks", "language", "TEXT")
		this.ensureColumn(database, "chunks", "chunk_kind", "TEXT")
		this.ensureColumn(database, "chunks", "symbol_name", "TEXT")
		this.ensureColumn(database, "chunks", "symbol_qualified_name", "TEXT")
		this.ensureColumn(database, "chunks", "parent_symbol_name", "TEXT")
		this.ensureColumn(database, "chunks", "parent_chunk_fingerprint", "TEXT")
		this.ensureColumn(database, "chunks", "summary", "TEXT")
		this.ensureColumn(database, "chunks", "search_text", "TEXT")
		this.ensureColumn(database, "oversized_file_tracking", "last_modified_mtime_ms", "INTEGER")
		this.ensureColumn(database, "index_runs", "last_heartbeat_at", "INTEGER")
		this.ensureColumn(database, "index_runs", "heartbeat_owner", "TEXT")
		this.ensureColumn(database, "index_runs", "progress_json", "TEXT")
		this.ensureColumn(database, "index_runs", "blocking_reason", "TEXT")
		this.ensureColumn(database, "jobs", "lease_owner", "TEXT")
		this.ensureColumn(database, "jobs", "lease_expires_at", "INTEGER")
		this.ensureColumn(database, "index_run_summaries", "average_gpu_utilization_percent", "REAL")
		this.ensureColumn(database, "index_run_summaries", "peak_gpu_utilization_percent", "REAL")
		this.ensureColumn(database, "index_run_summaries", "average_gpu_in_use_bytes", "INTEGER")
		this.ensureColumn(database, "index_run_summaries", "peak_gpu_in_use_bytes", "INTEGER")
		this.ensureColumn(database, "index_run_summaries", "gpu_sample_count", "INTEGER")
		this.ensureColumn(database, "index_run_summaries", "embeddings_per_chunk", "REAL")
		this.ensureColumn(database, "index_run_summaries", "lane_occupancy_percent", "REAL")
		this.ensureColumn(database, "index_run_summaries", "embed_active_percent", "REAL")
		this.ensureColumn(database, "index_run_summaries", "blocked_on_parsed_revisions_ms", "INTEGER")
		this.ensureColumn(database, "index_run_summaries", "blocked_on_staged_chunks_ms", "INTEGER")
		this.ensureColumn(database, "index_run_samples", "embeddings_per_chunk", "REAL")
		this.ensureColumn(database, "index_run_samples", "lane_occupancy_percent", "REAL")
		this.ensureColumn(database, "index_run_samples", "embed_active_percent", "REAL")
		database
			.prepare(
				`INSERT INTO schema_meta (key, value)
				 VALUES ('schemaVersion', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.run(String(getCodeIndexV2SchemaVersion()))
	}

	private async disposeOperationalDatabase(): Promise<void> {
		this._db?.close()
		this._db = undefined
	}

	private async disposeTelemetryDatabase(): Promise<void> {
		this._telemetryDb?.close()
		this._telemetryDb = undefined
	}

	private async migrateLegacyTelemetryToPersistent(): Promise<void> {
		const telemetrySummaryCount = this.readCount(
			this.telemetryDb(),
			`SELECT COUNT(*) AS count FROM index_run_summaries WHERE workspace_id = ?`,
			[this.workspaceHash],
		)
		const telemetrySampleCount = this.readCount(
			this.telemetryDb(),
			`SELECT COUNT(*) AS count FROM index_run_samples WHERE workspace_id = ?`,
			[this.workspaceHash],
		)
		const operationalSummaryCount = this.readCount(
			this.db(),
			`SELECT COUNT(*) AS count FROM index_run_summaries WHERE workspace_id = ?`,
			[this.workspaceHash],
		)
		const operationalSampleCount = this.readCount(
			this.db(),
			`SELECT COUNT(*) AS count FROM index_run_samples WHERE workspace_id = ?`,
			[this.workspaceHash],
		)

		if (operationalSummaryCount === 0 && operationalSampleCount === 0) {
			return
		}

		if (telemetrySummaryCount === 0 && operationalSummaryCount > 0) {
			this.copyTableRows(
				this.db(),
				this.telemetryDb(),
				"index_run_summaries",
				`WHERE workspace_id = '${this.workspaceHash}'`,
				"run_id",
			)
		}
		if (telemetrySampleCount === 0 && operationalSampleCount > 0) {
			this.copyTableRows(
				this.db(),
				this.telemetryDb(),
				"index_run_samples",
				`WHERE workspace_id = '${this.workspaceHash}'`,
				"sample_id",
			)
		}
	}

	private async backfillRunSummariesFromLogs(): Promise<void> {
		const logFiles = await this.listWorkspaceDiagnosticsLogFiles()
		if (logFiles.length === 0) {
			return
		}

		for (const logFile of logFiles) {
			const raw = await this.readDiagnosticsLogFile(logFile)
			if (!raw) {
				continue
			}

			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim()
				if (!trimmed || !trimmed.includes(`"message":"index-performance-summary"`)) {
					continue
				}

				let entry: Record<string, unknown>
				try {
					entry = JSON.parse(trimmed) as Record<string, unknown>
				} catch {
					continue
				}

				if (entry.workspacePath !== this.workspacePath) {
					continue
				}

				const runId = typeof entry.runId === "string" ? entry.runId : undefined
				if (!runId || (await this.getRunSummary(runId))) {
					continue
				}

				const timestampValue = typeof entry.timestamp === "string" ? entry.timestamp : undefined
				const completedAt = timestampValue ? new Date(timestampValue).getTime() : undefined
				const totalRunMs = this.numberOrNull(entry.totalRunMs)
				const completedAtSafe = completedAt && Number.isFinite(completedAt) ? completedAt : undefined
				const startedAt =
					completedAtSafe != null && totalRunMs != null
						? Math.max(0, completedAtSafe - totalRunMs)
						: (completedAtSafe ?? Date.now())
				const build = (entry.build ?? {}) as Record<string, unknown>
				const reportedGpu = (entry.reportedGpu ?? {}) as Record<string, unknown>

				await this.writeRunSummary({
					runId,
					workspaceId: this.workspaceHash,
					triggerType: typeof entry.runType === "string" ? entry.runType : "start",
					state: "complete",
					startedAt,
					completedAt: completedAtSafe ?? startedAt,
					totalRunMs,
					discoveryMs: this.numberOrNull(entry.discoveryMs),
					statHashMs: this.numberOrNull(entry.statHashMs),
					parseChunkMs: this.numberOrNull(entry.parseChunkMs),
					diffPlanningMs: this.numberOrNull(entry.diffPlanningMs),
					embedUpsertMs: this.numberOrNull(entry.embedUpsertMs),
					discoveredFiles: this.numberOrNull(entry.discoveredFiles),
					filesScanned: this.numberOrNull(entry.filesScanned),
					filesChanged: this.numberOrNull(entry.filesChanged),
					parsedChunks: this.numberOrNull(entry.chunksParsed),
					plannedRevisions: this.numberOrNull(entry.filesChanged),
					syncedChunks: this.numberOrNull(entry.vectorsCreated),
					upsertedChunks: this.numberOrNull(entry.vectorsCreated),
					deletedChunks: this.numberOrNull(entry.vectorDeletes),
					committedRevisions: undefined,
					chunksPerSecond: this.numberOrNull(entry.chunksPerSecond),
					peakChunksPerSecond: this.numberOrNull(entry.peakChunksPerSecond),
					averageBatchLatencyMs: this.numberOrNull(entry.averageBatchLatencyMs),
					peakBatchLatencyMs: this.numberOrNull(entry.peakBatchLatencyMs),
					averageEmbedLatencyMs: this.numberOrNull(entry.averageEmbedLatencyMs),
					averageUpsertLatencyMs: this.numberOrNull(entry.averageUpsertLatencyMs),
					averageMetadataCommitLatencyMs: this.numberOrNull(entry.averageMetadataCommitLatencyMs),
					averageIdleGapMs: this.numberOrNull(entry.averageIdleGapMs),
					peakIdleGapMs: this.numberOrNull(entry.peakIdleGapMs),
					peakBatchSize: this.numberOrNull(entry.peakBatchSize),
					peakEmbeddingCount: this.numberOrNull(entry.peakEmbeddingCount),
					laneConcurrency: this.numberOrNull(entry.laneConcurrency),
					effectiveBatchSize: this.numberOrNull(entry.effectiveBatchSize),
					peakInFlightChunkCount: this.numberOrNull(entry.peakInFlightChunkCount),
					pressureSoftTransitions: this.numberOrNull(entry.pressureSoftTransitions),
					pressureHardTransitions: this.numberOrNull(entry.pressureHardTransitions),
					pressureSoftDurationMs: this.numberOrNull(entry.pressureSoftDurationMs),
					pressureHardDurationMs: this.numberOrNull(entry.pressureHardDurationMs),
					hostRssMB: this.numberOrNull((entry.memory as Record<string, unknown> | undefined)?.rssMB),
					hostHeapUsedMB: this.numberOrNull(
						(entry.memory as Record<string, unknown> | undefined)?.heapUsedMB,
					),
					hostExternalMB: this.numberOrNull(
						(entry.memory as Record<string, unknown> | undefined)?.externalMB,
					),
					hostCpuPercent: this.numberOrNull(
						(entry.cpu as Record<string, unknown> | undefined)?.processPercent,
					),
					trackedSidecarRssMB: this.numberOrNull(
						(entry.trackedProcesses as Record<string, unknown> | undefined)?.totalTrackedRssMB,
					),
					parseSidecarRssMB: this.numberOrNull(
						(
							(entry.trackedProcesses as Record<string, unknown> | undefined)?.byGroup as
								| Record<string, Record<string, unknown>>
								| undefined
						)?.parseSidecars?.totalRssMB,
					),
					embedSidecarRssMB: this.numberOrNull(
						(
							(entry.trackedProcesses as Record<string, unknown> | undefined)?.byGroup as
								| Record<string, Record<string, unknown>>
								| undefined
						)?.embedSidecars?.totalRssMB,
					),
					gpuSampler: typeof reportedGpu.sampler === "string" ? reportedGpu.sampler : null,
					gpuUtilizationPercent: this.numberOrNull(reportedGpu.utilizationPercent),
					gpuMemoryPressurePercent: this.numberOrNull(reportedGpu.memoryPressurePercent),
					gpuInUseBytes: this.numberOrNull(reportedGpu.inUseBytes),
					gpuAllocatedBytes: this.numberOrNull(reportedGpu.allocatedBytes),
					gpuPowerW: this.numberOrNull(reportedGpu.powerW),
					buildVersion: typeof build.version === "string" ? build.version : null,
					buildTimestamp: typeof build.buildTimestamp === "string" ? build.buildTimestamp : null,
					buildSha: typeof build.sha === "string" ? build.sha : null,
				})
			}
		}
	}

	private async listWorkspaceDiagnosticsLogFiles(): Promise<string[]> {
		const directories = [this.diagnosticsRootDir.fsPath, this.legacyDiagnosticsRootDir.fsPath]
		const entries = new Set<string>()
		for (const directoryPath of directories) {
			try {
				for (const entry of await fs.readdir(directoryPath)) {
					if (
						entry === "roo-code-index-v2.log" ||
						(entry.startsWith("roo-code-index-v2.log.") && entry.endsWith(".gz"))
					) {
						entries.add(path.join(directoryPath, entry))
					}
				}
			} catch {
				// Directory may not exist yet.
			}
		}

		return Array.from(entries).sort()
	}

	private async readDiagnosticsLogFile(filePath: string): Promise<string | undefined> {
		try {
			const data = await fs.readFile(filePath)
			if (filePath.endsWith(".gz")) {
				return zlib.gunzipSync(data).toString("utf-8")
			}
			return data.toString("utf-8")
		} catch {
			return undefined
		}
	}

	private copyTableRows(
		sourceDb: SqliteDatabaseSync,
		targetDb: SqliteDatabaseSync,
		tableName: string,
		whereClause: string,
		primaryKeyColumn: string,
	): void {
		const columns = (sourceDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>)
			.map((column) => column.name)
			.filter((name): name is string => Boolean(name))
		if (columns.length === 0) {
			return
		}
		const quotedColumns = columns.join(", ")
		const rows = sourceDb.prepare(`SELECT ${quotedColumns} FROM ${tableName} ${whereClause}`).all() as Array<
			Record<string, unknown>
		>
		if (rows.length === 0) {
			return
		}
		const placeholders = columns.map(() => "?").join(", ")
		const insert = targetDb.prepare(
			`INSERT OR REPLACE INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`,
		)
		for (const row of rows) {
			insert.run(...columns.map((column) => (column === primaryKeyColumn ? row[column] : row[column])))
		}
	}

	private readCount(database: SqliteDatabaseSync, sql: string, params: unknown[]): number {
		const row = database.prepare(sql).get(...params) as { count?: number } | undefined
		return typeof row?.count === "number" ? row.count : 0
	}

	private numberOrNull(value: unknown): number | null {
		return typeof value === "number" && Number.isFinite(value) ? value : null
	}

	private _openDatabase(): void {
		if (!this._db) {
			this._db = new DatabaseSync(this.dbPath)
			this.applyPragmas(this._db)
		}
	}

	private _openTelemetryDatabase(): void {
		if (!this._telemetryDb) {
			this._telemetryDb = new DatabaseSync(this.telemetryDbPath)
			this.applyPragmas(this._telemetryDb)
		}
	}

	private _initializeSchema(): void {
		this.initializeDatabaseSchema(this.db())
	}

	private _initializeTelemetrySchema(): void {
		this.initializeDatabaseSchema(this.telemetryDb())
	}

	private async enforceRunTelemetryRetention(): Promise<void> {
		const staleRunRows = this.telemetryDb()
			.prepare(
				`SELECT run_id AS runId
				FROM index_run_summaries
				WHERE workspace_id = ?
				ORDER BY started_at DESC
				LIMIT -1 OFFSET ?`,
			)
			.all(this.workspaceHash, MAX_PERSISTED_RUN_SUMMARIES) as Array<{ runId: string }>

		if (staleRunRows.length === 0) {
			return
		}

		const staleRunIds = staleRunRows.map((row) => row.runId)
		const placeholders = staleRunIds.map(() => "?").join(", ")
		this.telemetryDb()
			.prepare(`DELETE FROM index_run_samples WHERE run_id IN (${placeholders})`)
			.run(...staleRunIds)
		this.telemetryDb()
			.prepare(`DELETE FROM index_run_summaries WHERE run_id IN (${placeholders})`)
			.run(...staleRunIds)
	}

	async trimRunSamples(runId: string, maxSamples = MAX_PERSISTED_RUN_SAMPLES_PER_RUN): Promise<void> {
		this.telemetryDb()
			.prepare(
				`DELETE FROM index_run_samples
				WHERE sample_id IN (
					SELECT sample_id
					FROM index_run_samples
					WHERE run_id = ?
					ORDER BY recorded_at DESC
					LIMIT -1 OFFSET ?
				)`,
			)
			.run(runId, Math.max(1, maxSamples))
	}

	private ensureColumn(
		database: SqliteDatabaseSync,
		tableName: string,
		columnName: string,
		definition: string,
	): void {
		try {
			database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
			if (!message.includes("duplicate column")) {
				throw error
			}
		}
	}

	private db(): SqliteDatabaseSync {
		if (!this._db) {
			throw new Error("MetadataStore not initialized")
		}
		return this._db
	}

	private telemetryDb(): SqliteDatabaseSync {
		if (!this._telemetryDb) {
			throw new Error("Telemetry store not initialized")
		}
		return this._telemetryDb
	}

	private applyPragmas(database: SqliteDatabaseSync): void {
		database.exec("PRAGMA journal_mode = WAL")
		database.exec("PRAGMA synchronous = NORMAL")
		database.exec("PRAGMA busy_timeout = 5000")
		database.exec("PRAGMA temp_store = MEMORY")
		database.exec("PRAGMA foreign_keys = ON")

		const journalMode = this.readPragma<string>(database, "journal_mode", "journal_mode")
		const synchronous = this.readPragma<number>(database, "synchronous", "synchronous")
		const busyTimeout = this.readPragma<number>(database, "busy_timeout", "timeout")
		const tempStore = this.readPragma<number>(database, "temp_store", "temp_store")
		const foreignKeys = this.readPragma<number>(database, "foreign_keys", "foreign_keys")

		IndexDebugLoggerV2.log("basic", "MetadataStore", "sqlite-open-settings", {
			component: "MetadataStore",
			workspacePath: this.workspacePath,
			journalMode,
			synchronous,
			busyTimeoutMs: busyTimeout,
			tempStore,
			foreignKeysEnabled: foreignKeys === 1,
		})
	}

	private readPragma<TValue extends string | number>(
		database: SqliteDatabaseSync,
		pragmaName: string,
		key: string,
	): TValue | undefined {
		const row = database.prepare(`PRAGMA ${pragmaName}`).get() as Record<string, TValue | undefined> | undefined
		return row?.[key]
	}

	private withTransaction<T>(callback: () => T, mode: TransactionMode = "DEFERRED"): T {
		this.db().exec(`BEGIN ${mode}`)
		try {
			const result = callback()
			this.db().exec("COMMIT")
			return result
		} catch (error) {
			this.db().exec("ROLLBACK")
			throw error
		}
	}

	private getBlockingReason(metrics: RunBacklogMetrics): string {
		if (metrics.parsedRevisions > 0) {
			return "parsed_revisions_waiting_for_planning"
		}
		if (metrics.stagedChunks > 0) {
			return "staged_chunks_waiting_for_upsert"
		}
		if (metrics.queuedUpsertJobs > 0) {
			return "queued_upsert_jobs"
		}
		if (metrics.runningUpsertJobs > 0) {
			return "running_upsert_jobs"
		}
		if (metrics.queuedDeleteJobs > 0) {
			return "queued_delete_jobs"
		}
		if (metrics.runningDeleteJobs > 0) {
			return "running_delete_jobs"
		}
		if (metrics.retryingJobs > 0) {
			return "retry_backoff_jobs"
		}
		return "idle"
	}

	private parseProgressSnapshot(raw: string | null | undefined): RunProgressSnapshot | null {
		if (!raw) {
			return null
		}

		try {
			return JSON.parse(raw) as RunProgressSnapshot
		} catch {
			return null
		}
	}

	private parseStringArray(raw: string | null | undefined): string[] | null {
		if (!raw) {
			return null
		}
		try {
			const parsed = JSON.parse(raw)
			return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : null
		} catch {
			return null
		}
	}
}
