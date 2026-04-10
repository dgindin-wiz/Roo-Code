import { ICodeIndexEngine } from "../engine/interfaces"
import { RetrievalEvaluator } from "./RetrievalEvaluator"
import {
	RetrievalEvalFixture,
	RetrievalEvalPerformanceAggregate,
	RetrievalEvalQueryResult,
	RetrievalEvalReport,
} from "./types"

export class CodeIndexEvalRunner {
	constructor(
		private readonly engine: ICodeIndexEngine,
		private readonly options: {
			limit?: number
			kValues?: number[]
			onQueryStart?: (context: { index: number; total: number; id: string; query: string }) => void
			onQueryComplete?: (context: {
				index: number
				total: number
				id: string
				query: string
				firstRelevantRank: number | null
				totalMs: number
			}) => void
		} = {},
	) {}

	async run(fixtures: RetrievalEvalFixture[]): Promise<RetrievalEvalReport> {
		const limit = this.options.limit ?? 5
		const evaluator = new RetrievalEvaluator(this.options.kValues ?? [1, 3, 5])
		const maxLimit = Math.max(limit, ...(this.options.kValues ?? [1, 3, 5]))

		if (this.engine.searchDebug) {
			const queries: RetrievalEvalQueryResult[] = []
			for (const [index, fixture] of fixtures.entries()) {
				this.options.onQueryStart?.({
					index: index + 1,
					total: fixtures.length,
					id: fixture.id,
					query: fixture.query,
				})
				const trace = await this.engine.searchDebug(fixture.query, maxLimit)
				const finalQuery = evaluator.evaluateResults(fixture, trace.stages.final)
				finalQuery.lexicalStatus = trace.lexicalStatus
				finalQuery.lexicalMode = trace.lexicalMode
				finalQuery.timingsMs = {
					...trace.timingsMs,
				}
				finalQuery.stageResults = [
					{
						...evaluator.createStageResult("vector", fixture, trace.stages.vector),
						elapsedMs: trace.timingsMs.queryEmbeddingMs + trace.timingsMs.vectorRetrievalMs,
					},
					{
						...evaluator.createStageResult("lexical", fixture, trace.stages.lexical),
						elapsedMs: trace.timingsMs.lexicalRetrievalMs,
					},
					{
						...evaluator.createStageResult("merged", fixture, trace.stages.merged),
						elapsedMs: trace.timingsMs.mergeMs,
					},
					{
						...evaluator.createStageResult("final", fixture, trace.stages.final),
						elapsedMs: trace.timingsMs.totalMs,
					},
				]
				queries.push(finalQuery)
				this.options.onQueryComplete?.({
					index: index + 1,
					total: fixtures.length,
					id: fixture.id,
					query: fixture.query,
					firstRelevantRank: finalQuery.firstRelevantRank,
					totalMs: trace.timingsMs.totalMs,
				})
			}

			return {
				queries,
				aggregate: evaluator.buildAggregate(queries),
				stageAggregates: [
					evaluator.buildStageAggregate("vector", queries),
					evaluator.buildStageAggregate("lexical", queries),
					evaluator.buildStageAggregate("merged", queries),
					evaluator.buildStageAggregate("final", queries),
				],
				performance: this.buildPerformanceAggregate(queries),
			}
		}

		return evaluator.evaluate(fixtures, async (query, requestedLimit) =>
			this.engine.search(query, Math.max(maxLimit, requestedLimit)),
		)
	}

	private buildPerformanceAggregate(
		queries: RetrievalEvalQueryResult[],
	): RetrievalEvalPerformanceAggregate | undefined {
		const timedQueries = queries.filter(
			(
				query,
			): query is RetrievalEvalQueryResult & { timingsMs: NonNullable<RetrievalEvalQueryResult["timingsMs"]> } =>
				Boolean(query.timingsMs),
		)
		if (timedQueries.length === 0) {
			return undefined
		}

		const average = (selector: (query: NonNullable<(typeof timedQueries)[number]>) => number) =>
			timedQueries.reduce((sum, query) => sum + selector(query), 0) / timedQueries.length

		return {
			queryEmbeddingMs: average((query) => query.timingsMs.queryEmbeddingMs),
			vectorRetrievalMs: average((query) => query.timingsMs.vectorRetrievalMs),
			lexicalFtsMs: average((query) => query.timingsMs.lexicalFtsMs),
			lexicalFallbackMs: average((query) => query.timingsMs.lexicalFallbackMs),
			lexicalRetrievalMs: average((query) => query.timingsMs.lexicalRetrievalMs),
			mergeMs: average((query) => query.timingsMs.mergeMs),
			rerankMs: average((query) => query.timingsMs.rerankMs),
			expansionMs: average((query) => query.timingsMs.expansionMs),
			totalMs: average((query) => query.timingsMs.totalMs),
			lexicalCompletedQueries: timedQueries.filter((query) => query.lexicalStatus === "completed").length,
			lexicalSkippedQueries: timedQueries.filter((query) => query.lexicalStatus === "skipped").length,
			lexicalFtsOnlyQueries: timedQueries.filter((query) => query.lexicalMode === "fts_only").length,
			lexicalExactFallbackQueries: timedQueries.filter((query) => query.lexicalMode === "fts_plus_exact_fallback")
				.length,
		}
	}
}
