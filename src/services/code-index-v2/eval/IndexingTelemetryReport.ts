import * as fs from "fs"
import * as path from "path"
import { analyzeIndexingRunFromDebugLog } from "./IndexingRunDiagnosis"
import { IndexingTelemetryReport, IndexingTelemetryTrend } from "./types"
import {
	CODE_INDEX_V2_DB_BASENAME,
	CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME,
	CODE_INDEX_V2_PERSISTENT_DIR_BASENAME,
	CODE_INDEX_V2_TELEMETRY_DB_BASENAME,
} from "../shared/constants"

const { DatabaseSync } = require("node:sqlite") as {
	DatabaseSync: new (path: string) => {
		prepare(sql: string): {
			get(...params: unknown[]): Record<string, unknown> | undefined
			all(...params: unknown[]): Array<Record<string, unknown>>
		}
		close(): void
	}
}

export async function buildIndexingTelemetryReport(input: {
	dbPath: string
	runId?: string
	logPath?: string
	sampleLimit?: number
}): Promise<IndexingTelemetryReport> {
	const resolvedDbPath = resolveTelemetryDbPath(input.dbPath)
	const resolvedLogPath = input.logPath ?? resolveDefaultTelemetryLogPath(resolvedDbPath)
	const db = new DatabaseSync(resolvedDbPath)
	try {
		const summary =
			(input.runId
				? db
						.prepare(
							`SELECT *
							FROM index_run_summaries
							WHERE run_id = ?`,
						)
						.get(input.runId)
				: db
						.prepare(
							`SELECT *
							FROM index_run_summaries
							ORDER BY started_at DESC
							LIMIT 1`,
						)
						.get()) ?? undefined
		const runId = (summary?.run_id as string | undefined) ?? input.runId
		const samples = runId
			? (db
					.prepare(
						`SELECT *
							FROM index_run_samples
							WHERE run_id = ?
							ORDER BY recorded_at ASC
							LIMIT ?`,
					)
					.all(runId, Math.max(1, input.sampleLimit ?? 200)) as Array<Record<string, unknown>>)
			: []
		const recentRuns = db
			.prepare(
				`SELECT
					run_id AS runId,
					started_at AS startedAt,
					state,
					files_changed AS filesChanged,
					total_run_ms AS totalRunMs,
					chunks_per_second AS chunksPerSecond,
					pressure_hard_transitions AS pressureHardTransitions,
					host_rss_mb AS hostRssMB
				FROM index_run_summaries
				ORDER BY started_at DESC
				LIMIT 10`,
			)
			.all() as unknown as IndexingTelemetryTrend[]

		const logFiles = resolveLogFiles(resolvedLogPath)
		const diagnosis =
			runId && resolvedLogPath
				? await analyzeIndexingRunFromDebugLog({
						logPath: resolvedLogPath,
						runId,
					}).catch(() => undefined)
				: undefined

		return {
			runId,
			dbPath: resolvedDbPath,
			logFiles,
			workspaceId: (summary?.workspace_id as string | undefined) ?? undefined,
			summary,
			samples,
			recentRuns,
			analysis: buildDerivedAnalysis(summary, samples),
			diagnosis: diagnosis
				? {
						completed: diagnosis.completed,
						lastTimestamp: diagnosis.lastTimestamp,
						lastMessage: diagnosis.lastMessage,
						lastBlockingReason: diagnosis.lastBlockingReason,
					}
				: undefined,
		}
	} finally {
		db.close()
	}
}

function resolveLogFiles(logPath: string | undefined): string[] {
	if (!logPath) {
		return []
	}
	if (!logPath || !fs.existsSync(logPath)) {
		return []
	}
	if (fs.statSync(logPath).isDirectory()) {
		return fs
			.readdirSync(logPath)
			.filter((entry) => entry.startsWith("roo-code-index-v2.log"))
			.map((entry) => path.join(logPath, entry))
			.sort()
	}
	return [logPath]
}

function resolveTelemetryDbPath(inputPath: string): string {
	if (path.basename(inputPath) === CODE_INDEX_V2_TELEMETRY_DB_BASENAME && fs.existsSync(inputPath)) {
		return inputPath
	}

	const normalized = path.normalize(inputPath)
	if (path.basename(normalized) === CODE_INDEX_V2_DB_BASENAME) {
		const workspaceHash = path.basename(path.dirname(normalized))
		const codeIndexRoot = path.dirname(path.dirname(normalized))
		const candidate = path.join(
			codeIndexRoot,
			CODE_INDEX_V2_PERSISTENT_DIR_BASENAME,
			workspaceHash,
			CODE_INDEX_V2_TELEMETRY_DB_BASENAME,
		)
		if (fs.existsSync(candidate)) {
			return candidate
		}
	}

	return inputPath
}

export function resolveDefaultTelemetryLogPath(dbPath: string): string | undefined {
	const normalized = path.normalize(dbPath)
	if (path.basename(normalized) === CODE_INDEX_V2_TELEMETRY_DB_BASENAME) {
		const candidate = path.join(path.dirname(normalized), CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME)
		return fs.existsSync(candidate) ? candidate : undefined
	}
	if (path.basename(normalized) === CODE_INDEX_V2_DB_BASENAME) {
		const resolvedDbPath = resolveTelemetryDbPath(dbPath)
		if (resolvedDbPath !== dbPath) {
			return resolveDefaultTelemetryLogPath(resolvedDbPath)
		}
	}
	return undefined
}

function buildDerivedAnalysis(
	summary: Record<string, unknown> | undefined,
	samples: Array<Record<string, unknown>>,
): IndexingTelemetryReport["analysis"] {
	const activeEmbedSamples = samples.filter(
		(sample) =>
			sample["stage"] === "embed" &&
			(typeof sample["gpu_utilization_percent"] === "number" ||
				typeof sample["gpu_in_use_bytes"] === "number" ||
				typeof sample["embeddings_per_chunk"] === "number"),
	)
	const gpuUtilValues = activeEmbedSamples
		.map((sample) => sample["gpu_utilization_percent"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const gpuInUseValues = activeEmbedSamples
		.map((sample) => sample["gpu_in_use_bytes"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const embeddingsPerChunkValues = activeEmbedSamples
		.map((sample) => sample["embeddings_per_chunk"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const embedLatencyValues = activeEmbedSamples
		.map((sample) => sample["average_embed_latency_ms"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const upsertLatencyValues = activeEmbedSamples
		.map((sample) => sample["average_upsert_latency_ms"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const laneOccupancyValues = activeEmbedSamples
		.map((sample) => sample["lane_occupancy_percent"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const embedActiveValues = activeEmbedSamples
		.map((sample) => sample["embed_active_percent"])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
	const averageEmbedLatencyMs =
		numberOrUndefined(summary?.["average_embed_latency_ms"]) ?? average(embedLatencyValues)
	const averageUpsertLatencyMs =
		numberOrUndefined(summary?.["average_upsert_latency_ms"]) ?? average(upsertLatencyValues)
	const totalFusedLatencyMs =
		averageEmbedLatencyMs != null && averageUpsertLatencyMs != null
			? averageEmbedLatencyMs + averageUpsertLatencyMs
			: undefined

	return {
		averageEmbedLatencyMs,
		averageUpsertLatencyMs,
		embedTimeSharePercent:
			totalFusedLatencyMs && totalFusedLatencyMs > 0 && averageEmbedLatencyMs != null
				? Number(((averageEmbedLatencyMs / totalFusedLatencyMs) * 100).toFixed(1))
				: undefined,
		upsertTimeSharePercent:
			totalFusedLatencyMs && totalFusedLatencyMs > 0 && averageUpsertLatencyMs != null
				? Number(((averageUpsertLatencyMs / totalFusedLatencyMs) * 100).toFixed(1))
				: undefined,
		averageGpuUtilizationPercent:
			numberOrUndefined(summary?.["average_gpu_utilization_percent"]) ?? average(gpuUtilValues),
		peakGpuUtilizationPercent: numberOrUndefined(summary?.["peak_gpu_utilization_percent"]) ?? max(gpuUtilValues),
		averageGpuInUseBytes: numberOrUndefined(summary?.["average_gpu_in_use_bytes"]) ?? average(gpuInUseValues),
		peakGpuInUseBytes: numberOrUndefined(summary?.["peak_gpu_in_use_bytes"]) ?? max(gpuInUseValues),
		gpuSampleCount:
			numberOrUndefined(summary?.["gpu_sample_count"]) ??
			(activeEmbedSamples.length > 0 ? activeEmbedSamples.length : undefined),
		embeddingsPerChunk: numberOrUndefined(summary?.["embeddings_per_chunk"]) ?? average(embeddingsPerChunkValues),
		laneOccupancyPercent: numberOrUndefined(summary?.["lane_occupancy_percent"]) ?? average(laneOccupancyValues),
		embedActivePercent: numberOrUndefined(summary?.["embed_active_percent"]) ?? average(embedActiveValues),
		blockedOnParsedRevisionsMs: numberOrUndefined(summary?.["blocked_on_parsed_revisions_ms"]),
		blockedOnStagedChunksMs: numberOrUndefined(summary?.["blocked_on_staged_chunks_ms"]),
	}
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function average(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
}

function max(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	return Number(Math.max(...values).toFixed(2))
}
