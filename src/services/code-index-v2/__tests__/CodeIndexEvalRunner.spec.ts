import { describe, expect, it, vi } from "vitest"
import { CodeIndexEvalRunner } from "../eval/CodeIndexEvalRunner"
import { formatRetrievalEvalReport } from "../eval/format-report"
import { CodeIndexDebugSearchTrace, ICodeIndexEngine } from "../engine/interfaces"

function createEngineMock(
	search: ICodeIndexEngine["search"] = vi.fn(async () => []),
	searchDebug?: ICodeIndexEngine["searchDebug"],
) {
	return {
		engine: "v2",
		start: vi.fn(),
		refreshAll: vi.fn(),
		stop: vi.fn(),
		clear: vi.fn(),
		search,
		searchDebug,
		enqueuePathsChanged: vi.fn(),
		getStatus: vi.fn(),
		getWarningDetails: vi.fn(),
		getOversizedFileDetails: vi.fn(),
		retryWarningFiles: vi.fn(),
	} satisfies ICodeIndexEngine
}

describe("CodeIndexEvalRunner", () => {
	it("evaluates fixtures through the engine search interface using the larger requested limit", async () => {
		const search = vi.fn(async (query: string, limit: number) => {
			if (query === "find metadata store") {
				return [
					{
						id: "metadata-store",
						score: 0.94,
						payload: {
							filePath: "src/services/code-index-v2/store/MetadataStore.ts",
							symbolQualifiedName: "MetadataStore.searchActiveChunksLexically",
							codeChunk: "searchActiveChunksLexically(query, limit)",
							startLine: 1,
							endLine: 1,
						},
					},
				]
			}

			return []
		})
		const runner = new CodeIndexEvalRunner(createEngineMock(search), {
			limit: 2,
			kValues: [1, 5],
		})

		const report = await runner.run([
			{
				id: "metadata-store",
				query: "find metadata store",
				expectedPaths: ["src/services/code-index-v2/store/MetadataStore.ts"],
			},
		])

		expect(search).toHaveBeenCalledWith("find metadata store", 5)
		expect(report.aggregate.totalQueries).toBe(1)
		expect(report.aggregate.recallAt[1]).toBe(1)
		expect(report.aggregate.recallAt[5]).toBe(1)
		expect(report.aggregate.mrr).toBe(1)
	})

	it("uses the debug search path to collect stage comparisons when available", async () => {
		const trace: CodeIndexDebugSearchTrace = {
			query: "find metadata store",
			limit: 5,
			candidateLimit: 15,
			lexicalStatus: "completed",
			lexicalMode: "fts_plus_exact_fallback",
			timingsMs: {
				queryEmbeddingMs: 12,
				vectorRetrievalMs: 8,
				lexicalFtsMs: 3,
				lexicalFallbackMs: 1,
				lexicalRetrievalMs: 4,
				mergeMs: 1,
				rerankMs: 2,
				expansionMs: 3,
				totalMs: 30,
			},
			stages: {
				vector: [],
				lexical: [
					{
						id: "metadata-store",
						score: 0.94,
						payload: {
							filePath: "src/services/code-index-v2/store/MetadataStore.ts",
							symbolQualifiedName: "MetadataStore.searchActiveChunksLexically",
							codeChunk: "searchActiveChunksLexically(query, limit)",
							startLine: 1,
							endLine: 1,
						},
					},
				],
				merged: [
					{
						id: "metadata-store",
						score: 0.95,
						payload: {
							filePath: "src/services/code-index-v2/store/MetadataStore.ts",
							symbolQualifiedName: "MetadataStore.searchActiveChunksLexically",
							codeChunk: "searchActiveChunksLexically(query, limit)",
							startLine: 1,
							endLine: 1,
						},
					},
				],
				final: [
					{
						id: "metadata-store",
						score: 0.96,
						rerankScore: 1.02,
						matchReasons: ["lexical match", "symbol token overlap"],
						payload: {
							filePath: "src/services/code-index-v2/store/MetadataStore.ts",
							symbolQualifiedName: "MetadataStore.searchActiveChunksLexically",
							codeChunk: "searchActiveChunksLexically(query, limit)",
							startLine: 1,
							endLine: 1,
						},
					},
				],
			},
		}

		const runner = new CodeIndexEvalRunner(
			createEngineMock(
				vi.fn(async () => []),
				vi.fn(async () => trace),
			),
			{
				limit: 5,
				kValues: [1, 3, 5],
			},
		)

		const report = await runner.run([
			{
				id: "metadata-store",
				query: "find metadata store",
				expectedPaths: ["src/services/code-index-v2/store/MetadataStore.ts"],
			},
		])

		expect(report.stageAggregates?.map((stage) => stage.stage)).toEqual(["vector", "lexical", "merged", "final"])
		expect(report.queries[0]?.stageResults?.find((stage) => stage.stage === "final")?.firstRelevantRank).toBe(1)
		expect(report.queries[0]?.topHits[0]?.matchReasons).toContain("lexical match")
		expect(report.queries[0]?.lexicalStatus).toBe("completed")
		expect(report.queries[0]?.lexicalMode).toBe("fts_plus_exact_fallback")
		expect(report.performance?.totalMs).toBe(30)
	})

	it("emits per-query progress callbacks while using the debug search path", async () => {
		const onQueryStart = vi.fn()
		const onQueryComplete = vi.fn()
		const trace: CodeIndexDebugSearchTrace = {
			query: "find metadata store",
			limit: 5,
			candidateLimit: 15,
			lexicalStatus: "skipped",
			lexicalMode: "none",
			timingsMs: {
				queryEmbeddingMs: 12,
				vectorRetrievalMs: 8,
				lexicalFtsMs: 0,
				lexicalFallbackMs: 0,
				lexicalRetrievalMs: 4,
				mergeMs: 1,
				rerankMs: 2,
				expansionMs: 3,
				totalMs: 30,
			},
			stages: {
				vector: [],
				lexical: [],
				merged: [],
				final: [],
			},
		}

		const runner = new CodeIndexEvalRunner(
			createEngineMock(
				vi.fn(async () => []),
				vi.fn(async () => trace),
			),
			{
				onQueryStart,
				onQueryComplete,
			},
		)

		await runner.run([
			{ id: "first", query: "first query" },
			{ id: "second", query: "second query" },
		])

		expect(onQueryStart).toHaveBeenNthCalledWith(1, {
			index: 1,
			total: 2,
			id: "first",
			query: "first query",
		})
		expect(onQueryStart).toHaveBeenNthCalledWith(2, {
			index: 2,
			total: 2,
			id: "second",
			query: "second query",
		})
		expect(onQueryComplete).toHaveBeenNthCalledWith(1, {
			index: 1,
			total: 2,
			id: "first",
			query: "first query",
			firstRelevantRank: null,
			totalMs: 30,
		})
		expect(onQueryComplete).toHaveBeenNthCalledWith(2, {
			index: 2,
			total: 2,
			id: "second",
			query: "second query",
			firstRelevantRank: null,
			totalMs: 30,
		})
	})
})

describe("formatRetrievalEvalReport", () => {
	it("renders aggregate and per-query metrics in a compact report", () => {
		const output = formatRetrievalEvalReport({
			aggregate: {
				totalQueries: 1,
				mrr: 1,
				recallAt: {
					1: 1,
					3: 1,
				},
			},
			queries: [
				{
					fixture: {
						id: "metadata-store",
						query: "find metadata store",
					},
					results: [],
					firstRelevantRank: 1,
					mrr: 1,
					recallAt: {
						1: 1,
						3: 1,
					},
					topHits: [],
					lexicalStatus: "completed",
					lexicalMode: "fts_only",
					timingsMs: {
						queryEmbeddingMs: 9,
						vectorRetrievalMs: 6,
						lexicalFtsMs: 2,
						lexicalFallbackMs: 1,
						lexicalRetrievalMs: 3,
						mergeMs: 1,
						rerankMs: 2,
						expansionMs: 4,
						totalMs: 25,
					},
					stageResults: [
						{
							stage: "vector",
							firstRelevantRank: 2,
							mrr: 0.5,
							recallAt: { 1: 0, 3: 1 },
							topHits: [],
						},
						{
							stage: "final",
							firstRelevantRank: 1,
							mrr: 1,
							recallAt: { 1: 1, 3: 1 },
							topHits: [],
						},
					],
				},
			],
			stageAggregates: [
				{
					stage: "vector",
					firstRelevantRank: null,
					mrr: 0.5,
					recallAt: { 1: 0, 3: 1 },
					topHits: [],
				},
				{
					stage: "final",
					firstRelevantRank: null,
					mrr: 1,
					recallAt: { 1: 1, 3: 1 },
					topHits: [],
				},
			],
			performance: {
				queryEmbeddingMs: 9,
				vectorRetrievalMs: 6,
				lexicalFtsMs: 2,
				lexicalFallbackMs: 1,
				lexicalRetrievalMs: 3,
				lexicalCompletedQueries: 0,
				lexicalSkippedQueries: 0,
				lexicalFtsOnlyQueries: 1,
				lexicalExactFallbackQueries: 0,
				mergeMs: 1,
				rerankMs: 2,
				expansionMs: 4,
				totalMs: 25,
			},
		})

		expect(output).toContain("Code Index Retrieval Eval")
		expect(output).toContain("Queries: 1")
		expect(output).toContain("MRR: 1.000")
		expect(output).toContain("Performance")
		expect(output).toContain("Stage Comparison")
		expect(output).toContain("Slowest Queries")
		expect(output).toContain("lexical FTS-only: 1")
		expect(output).toContain("[metadata-store] find metadata store")
		expect(output).toContain("First relevant rank: 1")
		expect(output).toContain("Stages: vector=2 | final=1")
	})
})
