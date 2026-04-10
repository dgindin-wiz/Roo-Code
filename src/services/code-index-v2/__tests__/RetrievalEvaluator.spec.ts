import { describe, expect, it } from "vitest"
import { RetrievalEvaluator } from "../eval/RetrievalEvaluator"

describe("RetrievalEvaluator", () => {
	it("computes recall@k and mrr from fixture expectations", async () => {
		const evaluator = new RetrievalEvaluator([1, 3, 5])

		const report = await evaluator.evaluate(
			[
				{
					id: "query-1",
					query: "find validate token",
					expectedPaths: ["src/auth.ts"],
				},
				{
					id: "query-2",
					query: "metadata store lexical",
					expectedSymbols: ["searchActiveChunksLexically"],
				},
			],
			async (query) => {
				if (query === "find validate token") {
					return [
						{
							id: "result-1",
							score: 0.9,
							payload: {
								filePath: "src/auth.ts",
								codeChunk: "export function validateToken() {}",
								startLine: 1,
								endLine: 3,
							},
						},
					]
				}

				return [
					{
						id: "result-2",
						score: 0.95,
						payload: {
							filePath: "src/other.ts",
							codeChunk: "other",
							startLine: 1,
							endLine: 1,
						},
					},
					{
						id: "result-3",
						score: 0.8,
						payload: {
							filePath: "src/services/code-index-v2/store/MetadataStore.ts",
							symbolQualifiedName: "searchActiveChunksLexically",
							codeChunk: "searchActiveChunksLexically(...)",
							startLine: 10,
							endLine: 20,
						},
					},
				]
			},
		)

		expect(report.aggregate.totalQueries).toBe(2)
		expect(report.aggregate.recallAt[1]).toBe(0.5)
		expect(report.aggregate.recallAt[3]).toBe(1)
		expect(report.aggregate.mrr).toBe(0.75)
		expect(report.queries[1]?.firstRelevantRank).toBe(2)
		expect(report.queries[1]?.topHits[0]?.filePath).toBe("src/other.ts")
	})

	it("treats path and symbol expectations within one fixture as alternative acceptable hits", async () => {
		const evaluator = new RetrievalEvaluator([1, 3])

		const report = await evaluator.evaluate(
			[
				{
					id: "query-1",
					query: "find metadata store search",
					expectedPaths: ["src/services/code-index-v2/store/MetadataStore.ts"],
					expectedSymbols: ["MetadataStore.searchActiveChunksLexically"],
				},
			],
			async () => [
				{
					id: "result-1",
					score: 0.9,
					payload: {
						filePath: "src/services/code-index-v2/store/MetadataStore.ts",
						codeChunk: "searchActiveChunksLexically(query, limit)",
						startLine: 1,
						endLine: 3,
					},
				},
			],
		)

		expect(report.aggregate.recallAt[1]).toBe(1)
		expect(report.aggregate.recallAt[3]).toBe(1)
		expect(report.aggregate.mrr).toBe(1)
	})

	it("creates stage aggregates from query stage results", () => {
		const evaluator = new RetrievalEvaluator([1, 3])

		const aggregate = evaluator.buildStageAggregate("vector", [
			{
				fixture: { id: "q1", query: "query" },
				results: [],
				firstRelevantRank: 1,
				mrr: 1,
				recallAt: { 1: 1, 3: 1 },
				topHits: [],
				stageResults: [
					{
						stage: "vector",
						firstRelevantRank: 2,
						mrr: 0.5,
						recallAt: { 1: 0, 3: 1 },
						topHits: [],
					},
				],
			},
		])

		expect(aggregate.stage).toBe("vector")
		expect(aggregate.mrr).toBe(0.5)
		expect(aggregate.recallAt[1]).toBe(0)
		expect(aggregate.recallAt[3]).toBe(1)
	})
})
