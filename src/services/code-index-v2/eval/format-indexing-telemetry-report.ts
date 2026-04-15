import { IndexingTelemetryReport } from "./types"

export function formatIndexingTelemetryReport(report: IndexingTelemetryReport): string {
	const summary = report.summary ?? {}
	const samples = report.samples
	const latestSample = samples[samples.length - 1] ?? {}
	const analysis = report.analysis ?? {}

	return [
		"Code Index V2 Telemetry Report",
		"",
		`DB: ${report.dbPath}`,
		`Run: ${report.runId ?? "unknown"}`,
		`State: ${String(summary["state"] ?? "unknown")}`,
		`Started: ${String(summary["started_at"] ?? "unknown")}`,
		`Files changed: ${formatNumber(summary["files_changed"])}`,
		`Parsed chunks: ${formatNumber(summary["parsed_chunks"])}`,
		`Upserted chunks: ${formatNumber(summary["upserted_chunks"])}`,
		`Deleted chunks: ${formatNumber(summary["deleted_chunks"])}`,
		`Total run ms: ${formatNumber(summary["total_run_ms"])}`,
		`Chunks/sec: ${formatNumber(summary["chunks_per_second"])}`,
		`Peak chunks/sec: ${formatNumber(summary["peak_chunks_per_second"])}`,
		`Avg embed latency ms: ${formatNumber(analysis.averageEmbedLatencyMs ?? summary["average_embed_latency_ms"])}`,
		`Avg sync latency ms: ${formatNumber(analysis.averageUpsertLatencyMs ?? summary["average_upsert_latency_ms"])}`,
		`Embed vs sync time share %: ${formatNumber(analysis.embedTimeSharePercent)} / ${formatNumber(analysis.upsertTimeSharePercent)}`,
		`Pressure: soft=${formatNumber(summary["pressure_soft_transitions"])} hard=${formatNumber(summary["pressure_hard_transitions"])}`,
		`Host RSS MB: ${formatNumber(summary["host_rss_mb"])}`,
		`Metadata sidecar RSS MB: ${formatNumber(summary["metadata_sidecar_rss_mb"])}`,
		`Metadata sidecar CPU %: ${formatNumber(summary["metadata_sidecar_cpu_percent"])}`,
		`Embed sidecar RSS MB: ${formatNumber(summary["embed_sidecar_rss_mb"])}`,
		`GPU util avg/max %: ${formatNumber(analysis.averageGpuUtilizationPercent)} / ${formatNumber(analysis.peakGpuUtilizationPercent)}`,
		`GPU memory avg/max: ${formatBytes(analysis.averageGpuInUseBytes)} / ${formatBytes(analysis.peakGpuInUseBytes)}`,
		`GPU samples: ${formatNumber(analysis.gpuSampleCount)}`,
		`Embeddings/chunk: ${formatNumber(analysis.embeddingsPerChunk)}`,
		`Lane occupancy %: ${formatNumber(analysis.laneOccupancyPercent)}`,
		`Embed active %: ${formatNumber(analysis.embedActivePercent)}`,
		`Blocked on planner ms: ${formatNumber(analysis.blockedOnParsedRevisionsMs)}`,
		`Blocked on staged sync ms: ${formatNumber(analysis.blockedOnStagedChunksMs)}`,
		"",
		`Samples captured: ${samples.length.toLocaleString()}`,
		`Latest sample stage: ${String(latestSample["stage"] ?? "unknown")}`,
		`Latest sample pressure: ${String(latestSample["pressure_state"] ?? "unknown")}`,
		`Latest sample blocking reason: ${String(latestSample["blocking_reason"] ?? "none")}`,
		"",
		"Recent runs:",
		...report.recentRuns.map(
			(run) =>
				`- ${run.runId} ${run.state} changed=${formatNumber(run.filesChanged)} totalMs=${formatNumber(run.totalRunMs)} cps=${formatNumber(run.chunksPerSecond)} hardPressure=${formatNumber(run.pressureHardTransitions)}`,
		),
		...(report.diagnosis
			? [
					"",
					`Log diagnosis: completed=${report.diagnosis.completed ? "yes" : "no"} last=${report.diagnosis.lastTimestamp ?? "unknown"} ${report.diagnosis.lastMessage ?? "unknown"} blocking=${report.diagnosis.lastBlockingReason ?? "none"}`,
				]
			: []),
	].join("\n")
}

function formatNumber(value: unknown): string {
	return typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "n/a"
}

function formatBytes(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "n/a"
	}
	if (value < 1024) {
		return `${Math.round(value)} B`
	}
	const kb = value / 1024
	if (kb < 1024) {
		return `${kb.toFixed(1)} KB`
	}
	const mb = kb / 1024
	if (mb < 1024) {
		return `${mb.toFixed(1)} MB`
	}
	return `${(mb / 1024).toFixed(2)} GB`
}
