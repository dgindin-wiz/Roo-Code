import * as vscode from "vscode"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { runCodeIndexEvalForCurrentWorkspace } from "../registerCommands"
import { CodeIndexManager } from "../../services/code-index/manager"
import { rooCodeBenchmarkFixtures } from "../../services/code-index-v2/eval"

vi.mock("vscode", () => ({
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
	},
}))

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

describe("runCodeIndexEvalForCurrentWorkspace", () => {
	const mockOutputChannel = {
		appendLine: vi.fn(),
		append: vi.fn(),
		clear: vi.fn(),
		hide: vi.fn(),
		name: "mock",
		replace: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
	} as unknown as vscode.OutputChannel

	const mockProvider = {
		contextProxy: {},
		getCurrentCodeIndexWorkspacePath: vi.fn().mockReturnValue("/mock/workspace"),
	} as any

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("runs the Roo Code benchmark through the manager search path and writes a report", async () => {
		const mockManager = {
			isInitialized: true,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			selectedEngine: "v2",
			initialize: vi.fn(),
			searchIndex: vi.fn(async (query: string, _options?: { limit?: number; directoryPrefix?: string }) => {
				const fixture = rooCodeBenchmarkFixtures.find((item) => item.query === query)
				if (!fixture) {
					return []
				}

				return [
					{
						id: fixture.id,
						score: 0.9,
						rerankScore: 1.02,
						matchReasons: ["lexical match", "path token overlap"],
						payload: {
							filePath: fixture.expectedPaths?.[0] ?? "src/unknown.ts",
							symbolQualifiedName: fixture.expectedSymbols?.[0],
							codeChunk: fixture.expectedSymbols?.[0] ?? fixture.expectedPaths?.[0] ?? "codeChunk",
							startLine: 1,
							endLine: 1,
						},
					},
				]
			}),
			searchIndexDebug: vi.fn(async (query: string, limit: number) => {
				const results = await mockManager.searchIndex(query, { limit })
				return {
					query,
					limit,
					candidateLimit: limit * 3,
					lexicalStatus: "completed",
					lexicalMode: "fts_only",
					timingsMs: {
						queryEmbeddingMs: 5,
						vectorRetrievalMs: 4,
						lexicalFtsMs: 2,
						lexicalFallbackMs: 1,
						lexicalRetrievalMs: 3,
						mergeMs: 1,
						rerankMs: 2,
						expansionMs: 2,
						totalMs: 17,
					},
					stages: {
						vector: results,
						lexical: results,
						merged: results,
						final: results,
					},
				}
			}),
		}

		vi.mocked(CodeIndexManager.getInstance).mockReturnValue(mockManager as any)

		await runCodeIndexEvalForCurrentWorkspace({
			context: {} as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider,
		})

		expect(CodeIndexManager.getInstance).toHaveBeenCalledWith({}, "/mock/workspace")
		expect(mockManager.searchIndexDebug).toHaveBeenCalledWith("codebase search tool output formatting", 5)
		expect(mockManager.searchIndexDebug).toHaveBeenCalledWith("schema.ts CREATE TABLE chunk_variants", 5)
		expect(mockManager.searchIndexDebug).toHaveBeenCalledWith(
			"runCodeIndexEvalForCurrentWorkspace register commands",
			5,
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			`[CodeIndexEval] Running Roo Code retrieval benchmark against the current workspace index (${rooCodeBenchmarkFixtures.length} queries)...`,
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[CodeIndexEval] Query 1/"))
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("complete: [codebase-search-tool]"),
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Code Index Retrieval Eval"))
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Stage Comparison"))
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Performance"))
		expect(mockOutputChannel.show).toHaveBeenCalledWith(true)
	})

	it("reports when v2 is not the selected engine", async () => {
		vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
			isInitialized: true,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			selectedEngine: "legacy",
			initialize: vi.fn(),
		} as any)

		await runCodeIndexEvalForCurrentWorkspace({
			context: {} as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider,
		})

		expect(CodeIndexManager.getInstance).toHaveBeenCalledWith({}, "/mock/workspace")
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[CodeIndexEval] The active code index engine is 'legacy'. Switch to 'v2' to run the V2 retrieval eval.",
		)
		expect(mockOutputChannel.show).toHaveBeenCalledWith(true)
	})
})
