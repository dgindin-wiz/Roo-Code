import { VectorStoreSearchResult } from "../../code-index/interfaces"

export interface RetrievalEvalFixture {
	id: string
	query: string
	expectedPaths?: string[]
	expectedSymbols?: string[]
	expectedChunkFingerprints?: string[]
	notes?: string
}

export interface RetrievalEvalQueryResult {
	fixture: RetrievalEvalFixture
	results: VectorStoreSearchResult[]
	firstRelevantRank: number | null
	mrr: number
	recallAt: Record<number, number>
}

export interface RetrievalEvalAggregate {
	totalQueries: number
	mrr: number
	recallAt: Record<number, number>
}

export interface RetrievalEvalReport {
	queries: RetrievalEvalQueryResult[]
	aggregate: RetrievalEvalAggregate
}
