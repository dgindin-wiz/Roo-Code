import { describe, expect, it, vi } from "vitest"
import { CodeIndexEvalRunner } from "../eval/CodeIndexEvalRunner"
import { formatRetrievalEvalReport } from "../eval/format-report"
import { ICodeIndexEngine } from "../engine/interfaces"

function createEngineMock(search: ICodeIndexEngine["search"] = vi.fn(async () => [])) {
	return {
		engine: "v2",
		start: vi.fn(),
		refreshAll: vi.fn(),
		stop: vi.fn(),
		clear: vi.fn(),
		search,
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
				},
			],
		})

		expect(output).toContain("Code Index Retrieval Eval")
		expect(output).toContain("Queries: 1")
		expect(output).toContain("MRR: 1.000")
		expect(output).toContain("[metadata-store] find metadata store")
		expect(output).toContain("First relevant rank: 1")
	})
})
