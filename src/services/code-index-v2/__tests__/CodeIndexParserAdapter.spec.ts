import { describe, expect, it, vi } from "vitest"
import { CodeIndexParserAdapter } from "../adapters/CodeIndexParserAdapter"

const mocks = vi.hoisted(() => ({
	parseFile: vi.fn(),
}))

vi.mock("../../code-index/processors/parser", () => ({
	codeParser: {
		parseFile: mocks.parseFile,
	},
}))

describe("CodeIndexParserAdapter", () => {
	it("adds humanized symbol words to search text and summary", async () => {
		mocks.parseFile.mockResolvedValueOnce([
			{
				segmentHash: "fp-1",
				content: "private async expandSearchResultsWithParents() {}",
				type: "method",
				identifier: "expandSearchResultsWithParents",
				parentIdentifier: "CodeIndexEngineV2",
				parentChunkFingerprint: "parent-fp",
				start_line: 10,
				end_line: 12,
			},
		])

		const adapter = new CodeIndexParserAdapter()
		const chunks = await adapter.parseFile({
			filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
			content: "private async expandSearchResultsWithParents() {}",
		})

		expect(chunks).toHaveLength(1)
		expect(chunks[0]?.searchText).toContain("Symbol Words: expand search results with parents")
		expect(chunks[0]?.searchText).toContain("Qualified Symbol: CodeIndexEngineV2.expandSearchResultsWithParents")
		expect(chunks[0]?.summary).toContain("expand search results with parents")
	})

	it("adds behavior-oriented phrases for parent and sibling context expansion methods", async () => {
		mocks.parseFile.mockResolvedValueOnce([
			{
				segmentHash: "fp-2",
				content: "private createParentContextResult() {}",
				type: "method",
				identifier: "createParentContextResult",
				parentIdentifier: "CodeIndexEngineV2",
				parentChunkFingerprint: "parent-fp",
				start_line: 20,
				end_line: 24,
			},
			{
				segmentHash: "fp-3",
				content: "private findBestSiblingContextChunk() {}",
				type: "method",
				identifier: "findBestSiblingContextChunk",
				parentIdentifier: "CodeIndexEngineV2",
				parentChunkFingerprint: "parent-fp",
				start_line: 26,
				end_line: 31,
			},
		])

		const adapter = new CodeIndexParserAdapter()
		const chunks = await adapter.parseFile({
			filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
			content: "class CodeIndexEngineV2 {}",
		})

		expect(chunks[0]?.searchText).toContain("Behavior: add parent context to code search results")
		expect(chunks[0]?.summary).toContain("create parent context result for code search expansion")
		expect(chunks[1]?.searchText).toContain("Behavior: choose sibling context chunk for code search expansion")
		expect(chunks[1]?.summary).toContain("find best sibling context chunk near the matching result")
	})

	it("normalizes mixed chunk kinds by preferring exact semantic kind matches", async () => {
		mocks.parseFile.mockResolvedValueOnce([
			{
				segmentHash: "fp-4",
				content: "class Example { method() {} }",
				type: "class_method",
				identifier: "method",
				parentIdentifier: "Example",
				parentChunkFingerprint: "parent-fp",
				start_line: 1,
				end_line: 3,
			},
		])

		const adapter = new CodeIndexParserAdapter()
		const chunks = await adapter.parseFile({
			filePath: "src/example.ts",
			content: "class Example { method() {} }",
		})

		expect(chunks[0]?.chunkKind).toBe("method")
		expect(chunks[0]?.searchText).toContain("Language: ts")
	})

	it("adds broader behavior phrases for refresh manager surfaces without exact one-off path checks", async () => {
		mocks.parseFile.mockResolvedValueOnce([
			{
				segmentHash: "fp-5",
				content: "async refreshAllIndexData() {}",
				type: "method",
				identifier: "refreshAllIndexData",
				parentIdentifier: "CodeIndexManager",
				parentChunkFingerprint: "parent-fp",
				start_line: 30,
				end_line: 36,
			},
		])

		const adapter = new CodeIndexParserAdapter()
		const chunks = await adapter.parseFile({
			filePath: "src/services/code-index/manager.ts",
			content: "class CodeIndexManager {}",
		})

		expect(chunks[0]?.summary).toContain("run a non destructive full refresh of the workspace index")
		expect(chunks[0]?.searchText).toContain("Behavior: refresh all indexed files without clearing the index first")
	})
})
