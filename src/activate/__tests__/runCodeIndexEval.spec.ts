import * as vscode from "vscode"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { runCodeIndexEvalForCurrentWorkspace } from "../registerCommands"
import { CodeIndexManager } from "../../services/code-index/manager"

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
			searchIndex: vi.fn(async (query: string) => {
				if (query === "codebase search tool output formatting") {
					return [
						{
							id: "1",
							score: 0.9,
							payload: {
								filePath: "src/core/tools/CodebaseSearchTool.ts",
								codeChunk: "class CodebaseSearchTool {}",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "search active chunks lexically metadata store") {
					return [
						{
							id: "2",
							score: 0.91,
							payload: {
								filePath: "src/services/code-index-v2/store/MetadataStore.ts",
								symbolQualifiedName: "searchActiveChunksLexically",
								codeChunk: "searchActiveChunksLexically(...)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "CodeIndexEngineV2 search reranking") {
					return [
						{
							id: "3",
							score: 0.92,
							payload: {
								filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
								symbolQualifiedName: "CodeIndexEngineV2.search",
								codeChunk: "search(query, limit)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "parse chunk service build chunk variants") {
					return [
						{
							id: "4",
							score: 0.88,
							payload: {
								filePath: "src/services/code-index-v2/pipeline/ParseChunkService.ts",
								codeChunk: "buildChunkVariants(chunk, relativePath)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "embed upsert worker create embeddings variant pairs") {
					return [
						{
							id: "5",
							score: 0.87,
							payload: {
								filePath: "src/services/code-index-v2/pipeline/EmbedUpsertWorker.ts",
								codeChunk: "createEmbeddings(variantPairs.map(...))",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "code index parser adapter build search text summary") {
					return [
						{
							id: "6",
							score: 0.86,
							payload: {
								filePath: "src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts",
								codeChunk: "buildSearchText(...)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "Qdrant REST vector store adapter search payload variant type") {
					return [
						{
							id: "7",
							score: 0.85,
							payload: {
								filePath: "src/services/code-index-v2/adapters/QdrantRestVectorStoreAdapter.ts",
								codeChunk: "variantType",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "schema.ts CREATE TABLE chunk_variants") {
					return [
						{
							id: "8",
							score: 0.84,
							payload: {
								filePath: "src/services/code-index-v2/store/schema.ts",
								codeChunk: "CREATE TABLE chunk_variants",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "low value file filtering code index") {
					return [
						{
							id: "9",
							score: 0.83,
							payload: {
								filePath: "src/services/code-index/shared/low-value-files.ts",
								codeChunk: "isLowValueCodeIndexPath(...)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "runCodeIndexEvalForCurrentWorkspace register commands") {
					return [
						{
							id: "10",
							score: 0.82,
							payload: {
								filePath: "src/activate/registerCommands.ts",
								symbolQualifiedName: "runCodeIndexEvalForCurrentWorkspace",
								codeChunk: "runCodeIndexEvalForCurrentWorkspace(...)",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "code index popover save settings clear index") {
					return [
						{
							id: "11",
							score: 0.81,
							payload: {
								filePath: "webview-ui/src/components/chat/CodeIndexPopover.tsx",
								codeChunk: "handleSaveSettings()",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				if (query === "codebase search results display parent context sibling context") {
					return [
						{
							id: "12",
							score: 0.8,
							payload: {
								filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
								codeChunk: "Parent Context",
								startLine: 1,
								endLine: 1,
							},
						},
					]
				}

				return []
			}),
		}

		vi.mocked(CodeIndexManager.getInstance).mockReturnValue(mockManager as any)

		await runCodeIndexEvalForCurrentWorkspace({
			context: {} as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider,
		})

		expect(mockManager.searchIndex).toHaveBeenCalledWith("codebase search tool output formatting", 5)
		expect(mockManager.searchIndex).toHaveBeenCalledWith("search active chunks lexically metadata store", 5)
		expect(mockManager.searchIndex).toHaveBeenCalledWith("CodeIndexEngineV2 search reranking", 5)
		expect(mockManager.searchIndex).toHaveBeenCalledWith("schema.ts CREATE TABLE chunk_variants", 5)
		expect(mockManager.searchIndex).toHaveBeenCalledWith("runCodeIndexEvalForCurrentWorkspace register commands", 5)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[CodeIndexEval] Running Roo Code retrieval benchmark against the current workspace index (12 queries)...",
		)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Code Index Retrieval Eval"))
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

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[CodeIndexEval] The active code index engine is 'legacy'. Switch to 'v2' to run the V2 retrieval eval.",
		)
		expect(mockOutputChannel.show).toHaveBeenCalledWith(true)
	})
})
