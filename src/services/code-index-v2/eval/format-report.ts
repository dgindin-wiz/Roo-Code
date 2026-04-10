import { RetrievalEvalReport } from "./types"

export function formatRetrievalEvalReport(report: RetrievalEvalReport): string {
	const aggregateLines = [
		`Queries: ${report.aggregate.totalQueries}`,
		`MRR: ${report.aggregate.mrr.toFixed(3)}`,
		...Object.entries(report.aggregate.recallAt).map(([k, value]) => `Recall@${k}: ${value.toFixed(3)}`),
	]

	const performanceLines = report.performance
		? [
				"",
				"Performance",
				`- search total: avg ${report.performance.totalMs.toFixed(1)} ms`,
				`- query embedding: avg ${report.performance.queryEmbeddingMs.toFixed(1)} ms`,
				`- vector retrieval: avg ${report.performance.vectorRetrievalMs.toFixed(1)} ms`,
				`- lexical FTS: avg ${report.performance.lexicalFtsMs.toFixed(1)} ms`,
				`- lexical fallback: avg ${report.performance.lexicalFallbackMs.toFixed(1)} ms`,
				`- lexical retrieval: avg ${report.performance.lexicalRetrievalMs.toFixed(1)} ms`,
				`- lexical completed: ${report.performance.lexicalCompletedQueries}`,
				`- lexical skipped: ${report.performance.lexicalSkippedQueries}`,
				`- lexical FTS-only: ${report.performance.lexicalFtsOnlyQueries}`,
				`- lexical exact fallback: ${report.performance.lexicalExactFallbackQueries}`,
				`- merge: avg ${report.performance.mergeMs.toFixed(1)} ms`,
				`- rerank: avg ${report.performance.rerankMs.toFixed(1)} ms`,
				`- expansion: avg ${report.performance.expansionMs.toFixed(1)} ms`,
			]
		: []

	const stageAggregateLines = report.stageAggregates?.length
		? [
				"",
				"Stage Comparison",
				...report.stageAggregates.map(
					(stage) =>
						`- ${stage.stage}: MRR ${stage.mrr.toFixed(3)}, ${Object.entries(stage.recallAt)
							.map(([k, value]) => `Recall@${k} ${value.toFixed(3)}`)
							.join(", ")}`,
				),
			]
		: []

	const queryLines = report.queries.flatMap((query) => {
		const baseLines = [
			"",
			`[${query.fixture.id}] ${query.fixture.query}`,
			`First relevant rank: ${query.firstRelevantRank ?? "miss"}`,
			`MRR: ${query.mrr.toFixed(3)}`,
			...Object.entries(query.recallAt).map(([k, value]) => `Recall@${k}: ${value.toFixed(3)}`),
		]

		const stageLine = query.stageResults?.length
			? [
					`Stages: ${query.stageResults
						.map((stage) => `${stage.stage}=${stage.firstRelevantRank ?? "miss"}`)
						.join(" | ")}`,
				]
			: []

		const timingLines =
			query.timingsMs && (query.firstRelevantRank == null || query.firstRelevantRank > 1)
				? [
						`Lexical: ${query.lexicalStatus ?? "unknown"} (${query.lexicalMode ?? "unknown"})`,
						`Timing: total=${query.timingsMs.totalMs.toFixed(1)} ms | embed=${query.timingsMs.queryEmbeddingMs.toFixed(
							1,
						)} | vector=${query.timingsMs.vectorRetrievalMs.toFixed(1)} | lexical_fts=${query.timingsMs.lexicalFtsMs.toFixed(
							1,
						)} | lexical_fallback=${query.timingsMs.lexicalFallbackMs.toFixed(1)} | lexical=${query.timingsMs.lexicalRetrievalMs.toFixed(
							1,
						)} | merge=${query.timingsMs.mergeMs.toFixed(1)} | rerank=${query.timingsMs.rerankMs.toFixed(
							1,
						)} | expansion=${query.timingsMs.expansionMs.toFixed(1)}`,
					]
				: []

		const inspectionLines =
			query.firstRelevantRank == null || query.firstRelevantRank > 1
				? [
						"Top hits:",
						...query.topHits.map((hit) => {
							const parts = [
								`${hit.rank}. ${hit.filePath ?? "unknown path"}`,
								hit.symbol ? `[${hit.symbol}]` : null,
								`score=${hit.score.toFixed(3)}`,
								hit.rerankScore != null ? `rerank=${hit.rerankScore.toFixed(3)}` : null,
								hit.matchReasons?.length ? `reasons=${hit.matchReasons.join(", ")}` : null,
							].filter(Boolean)
							return parts.join(" ")
						}),
					]
				: []

		return [...baseLines, ...stageLine, ...timingLines, ...inspectionLines]
	})

	const slowQueries = [...report.queries]
		.filter((query) => query.timingsMs)
		.sort((left, right) => (right.timingsMs?.totalMs ?? 0) - (left.timingsMs?.totalMs ?? 0))
		.slice(0, 3)

	const slowQueryLines = slowQueries.length
		? [
				"",
				"Slowest Queries",
				...slowQueries.map(
					(query) =>
						`- [${query.fixture.id}] ${query.fixture.query} (${query.timingsMs?.totalMs.toFixed(1)} ms, rank ${query.firstRelevantRank ?? "miss"})`,
				),
			]
		: []

	return [
		"Code Index Retrieval Eval",
		...aggregateLines,
		...performanceLines,
		...stageAggregateLines,
		...slowQueryLines,
		...queryLines,
	].join("\n")
}
