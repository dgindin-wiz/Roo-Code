import { RetrievalEvalFixture } from "../types"

export const rooCodeBenchmarkFixtures: RetrievalEvalFixture[] = [
	{
		id: "codebase-search-tool",
		query: "codebase search tool output formatting",
		expectedPaths: ["src/core/tools/CodebaseSearchTool.ts"],
		notes: "LLM-facing codebase search tool output and formatting logic.",
	},
	{
		id: "metadata-store-lexical",
		query: "search active chunks lexically metadata store",
		expectedPaths: ["src/services/code-index-v2/store/MetadataStore.ts"],
		expectedSymbols: ["searchActiveChunksLexically"],
		notes: "Lexical retrieval in the metadata store.",
	},
	{
		id: "engine-search",
		query: "CodeIndexEngineV2 search reranking",
		expectedPaths: ["src/services/code-index-v2/engine/CodeIndexEngineV2.ts"],
		expectedSymbols: ["CodeIndexEngineV2.search"],
		notes: "Primary V2 search entrypoint and ranking logic.",
	},
	{
		id: "parse-chunk-service",
		query: "parse chunk service build chunk variants",
		expectedPaths: ["src/services/code-index-v2/pipeline/ParseChunkService.ts"],
		expectedSymbols: ["buildChunkVariants"],
		notes: "Chunk parsing and variant creation.",
	},
	{
		id: "embed-upsert-worker",
		query: "embed upsert worker create embeddings variant pairs",
		expectedPaths: ["src/services/code-index-v2/pipeline/EmbedUpsertWorker.ts"],
		notes: "Embedding/upsert worker batch processing.",
	},
	{
		id: "parser-adapter",
		query: "code index parser adapter build search text summary",
		expectedPaths: ["src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts"],
		notes: "Parser adapter summary and search text generation.",
	},
	{
		id: "vector-store-adapter",
		query: "Qdrant REST vector store adapter search payload variant type",
		expectedPaths: ["src/services/code-index-v2/adapters/QdrantRestVectorStoreAdapter.ts"],
		notes: "Vector store search payload mapping.",
	},
	{
		id: "metadata-schema",
		query: "schema.ts CREATE TABLE chunk_variants",
		expectedPaths: ["src/services/code-index-v2/store/schema.ts"],
		notes: "SQLite schema for chunks and chunk variants.",
	},
	{
		id: "low-value-files",
		query: "low value file filtering code index",
		expectedPaths: ["src/services/code-index/shared/low-value-files.ts"],
		notes: "Candidate filtering for low-value files.",
	},
	{
		id: "code-index-command",
		query: "runCodeIndexEvalForCurrentWorkspace register commands",
		expectedPaths: ["src/activate/registerCommands.ts"],
		expectedSymbols: ["runCodeIndexEvalForCurrentWorkspace"],
		notes: "Extension command entrypoint for eval runs.",
	},
	{
		id: "code-index-popover",
		query: "code index popover save settings clear index",
		expectedPaths: ["webview-ui/src/components/chat/CodeIndexPopover.tsx"],
		notes: "User-facing indexing settings and actions UI.",
	},
	{
		id: "search-results-display",
		query: "codebase search results display parent context sibling context",
		expectedPaths: ["webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx"],
		notes: "Search result display and bundled context rendering.",
	},
]
