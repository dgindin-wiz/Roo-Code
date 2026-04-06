import { RetrievalEvalReport } from "./types"

export function formatRetrievalEvalReport(report: RetrievalEvalReport): string {
	const aggregateLines = [
		`Queries: ${report.aggregate.totalQueries}`,
		`MRR: ${report.aggregate.mrr.toFixed(3)}`,
		...Object.entries(report.aggregate.recallAt).map(([k, value]) => `Recall@${k}: ${value.toFixed(3)}`),
	]

	const queryLines = report.queries.flatMap((query) => [
		"",
		`[${query.fixture.id}] ${query.fixture.query}`,
		`First relevant rank: ${query.firstRelevantRank ?? "miss"}`,
		`MRR: ${query.mrr.toFixed(3)}`,
		...Object.entries(query.recallAt).map(([k, value]) => `Recall@${k}: ${value.toFixed(3)}`),
	])

	return ["Code Index Retrieval Eval", ...aggregateLines, ...queryLines].join("\n")
}
