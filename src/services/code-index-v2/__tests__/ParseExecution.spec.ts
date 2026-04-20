import { describe, expect, it } from "vitest"
import { buildChunkVariants } from "../pipeline/ParseExecution"

describe("buildChunkVariants", () => {
	it("keeps raw_code canonical and prefers symbol signatures for structured symbols", () => {
		const variants = buildChunkVariants(
			{
				chunkId: "chunk-1",
				content: "export function validateToken(token: string) { return token.length > 0 }",
				summary: "ts function validateToken in Auth at src/auth.ts:10-18",
				searchText:
					"Path: src/auth.ts\nLanguage: ts\nKind: function\nLines: 10-18\nSymbol: validateToken\nQualified Symbol: Auth.validateToken",
				symbolName: "validateToken",
				symbolQualifiedName: "Auth.validateToken",
				parentSymbolName: "Auth",
				language: "ts",
				chunkKind: "function",
				startLine: 10,
				endLine: 18,
			},
			"src/auth.ts",
		)

		expect(variants).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					variantType: "raw_code",
					vectorEligible: true,
				}),
				expect.objectContaining({
					variantType: "summary",
					vectorEligible: false,
				}),
				expect.objectContaining({
					variantType: "symbol_signature",
					vectorEligible: true,
					vectorEligibilityReason: "extracted_symbol_signature",
				}),
			]),
		)
	})

	it("allows both auxiliaries when summary and signature carry distinct high-signal intent", () => {
		const variants = buildChunkVariants(
			{
				chunkId: "chunk-2",
				content: "export function refreshIndexData(force: boolean) { return force }",
				summary:
					"ts function refreshIndexData (refresh index data) in CodeIndexManager at src/manager.ts:40-55 • run a non destructive full refresh of the workspace index • refresh all indexed files without clearing the index first",
				searchText:
					"Path: src/manager.ts\nLanguage: ts\nKind: function\nLines: 40-55\nSymbol: refreshIndexData\nQualified Symbol: CodeIndexManager.refreshIndexData",
				symbolName: "refreshIndexData",
				symbolQualifiedName: "CodeIndexManager.refreshIndexData",
				parentSymbolName: "CodeIndexManager",
				language: "ts",
				chunkKind: "function",
				startLine: 40,
				endLine: 55,
			},
			"src/services/code-index/manager.ts",
		)

		expect(variants.find((variant) => variant.variantType === "summary")).toMatchObject({
			vectorEligible: true,
			vectorEligibilityReason: "behavioral_summary",
		})
		expect(variants.find((variant) => variant.variantType === "symbol_signature")).toMatchObject({
			vectorEligible: true,
		})
	})

	it("keeps boilerplate chunks raw-only for vectorization", () => {
		const variants = buildChunkVariants(
			{
				chunkId: "chunk-3",
				content: "const noop = true",
				summary: "ts chunk chunk in src/a.ts:1-1",
				searchText: "Path: src/a.ts\nPreview: const noop = true",
				language: "ts",
				chunkKind: "chunk",
				startLine: 1,
				endLine: 1,
			},
			"src/a.ts",
		)

		expect(variants).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					variantType: "raw_code",
					vectorEligible: true,
				}),
				expect.objectContaining({
					variantType: "summary",
					vectorEligible: false,
					vectorEligibilityReason: "lexical_only:boilerplate_summary",
				}),
			]),
		)
		expect(variants.find((variant) => variant.variantType === "symbol_signature")).toMatchObject({
			vectorEligible: false,
		})
	})
})
