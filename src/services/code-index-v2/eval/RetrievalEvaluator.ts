import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { RetrievalEvalAggregate, RetrievalEvalFixture, RetrievalEvalQueryResult, RetrievalEvalReport } from "./types"

export class RetrievalEvaluator {
	constructor(private readonly kValues: number[] = [1, 3, 5]) {}

	async evaluate(
		fixtures: RetrievalEvalFixture[],
		retrieve: (query: string, limit: number) => Promise<VectorStoreSearchResult[]>,
	): Promise<RetrievalEvalReport> {
		const maxK = Math.max(...this.kValues, 1)
		const queries: RetrievalEvalQueryResult[] = []

		for (const fixture of fixtures) {
			const results = await retrieve(fixture.query, maxK)
			const firstRelevantRank = this.findFirstRelevantRank(fixture, results)
			const recallAt = Object.fromEntries(
				this.kValues.map((k) => [k, this.computeRecallAt(fixture, results, k)]),
			) as Record<number, number>

			queries.push({
				fixture,
				results,
				firstRelevantRank,
				mrr: firstRelevantRank ? 1 / firstRelevantRank : 0,
				recallAt,
			})
		}

		return {
			queries,
			aggregate: this.buildAggregate(queries),
		}
	}

	private buildAggregate(queries: RetrievalEvalQueryResult[]): RetrievalEvalAggregate {
		const totalQueries = queries.length
		const recallAt = Object.fromEntries(
			this.kValues.map((k) => [
				k,
				totalQueries === 0
					? 0
					: queries.reduce((sum, query) => sum + (query.recallAt[k] ?? 0), 0) / totalQueries,
			]),
		) as Record<number, number>

		return {
			totalQueries,
			mrr: totalQueries === 0 ? 0 : queries.reduce((sum, query) => sum + query.mrr, 0) / totalQueries,
			recallAt,
		}
	}

	private computeRecallAt(fixture: RetrievalEvalFixture, results: VectorStoreSearchResult[], k: number): number {
		if (!this.hasRelevantTargets(fixture)) {
			return 0
		}

		return results.slice(0, k).some((result) => this.isRelevant(fixture, result)) ? 1 : 0
	}

	private findFirstRelevantRank(fixture: RetrievalEvalFixture, results: VectorStoreSearchResult[]): number | null {
		const index = results.findIndex((result) => this.isRelevant(fixture, result))
		return index === -1 ? null : index + 1
	}

	private isRelevant(fixture: RetrievalEvalFixture, result: VectorStoreSearchResult): boolean {
		const payload = result.payload
		if (!payload) {
			return false
		}

		const path = payload.filePath
		const symbol = payload.symbolQualifiedName ?? payload.symbolName
		const chunkFingerprint = payload.chunkFingerprint

		return (
			(fixture.expectedPaths ?? []).includes(path) ||
			(fixture.expectedSymbols ?? []).includes(symbol ?? "") ||
			(fixture.expectedChunkFingerprints ?? []).includes(chunkFingerprint ?? "")
		)
	}

	private hasRelevantTargets(fixture: RetrievalEvalFixture): boolean {
		return (
			(fixture.expectedPaths?.length ?? 0) > 0 ||
			(fixture.expectedSymbols?.length ?? 0) > 0 ||
			(fixture.expectedChunkFingerprints?.length ?? 0) > 0
		)
	}
}
