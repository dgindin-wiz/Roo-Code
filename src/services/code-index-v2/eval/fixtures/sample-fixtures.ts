import { RetrievalEvalFixture } from "../types"

export const sampleCodeIndexEvalFixtures: RetrievalEvalFixture[] = [
	{
		id: "codebase-search-tool",
		query: "codebase search tool output formatting",
		expectedPaths: ["src/core/tools/CodebaseSearchTool.ts"],
		notes: "Natural-language query for the user-facing codebase search tool.",
	},
	{
		id: "metadata-store-lexical",
		query: "searchActiveChunksLexically metadata store",
		expectedPaths: ["src/services/code-index-v2/store/MetadataStore.ts"],
		expectedSymbols: ["searchActiveChunksLexically"],
		notes: "Exact symbol/path-oriented query for the lexical retrieval implementation.",
	},
	{
		id: "engine-search",
		query: "CodeIndexEngineV2 search",
		expectedPaths: ["src/services/code-index-v2/engine/CodeIndexEngineV2.ts"],
		expectedSymbols: ["CodeIndexEngineV2.search"],
		notes: "Symbol-oriented query for the V2 engine search entrypoint.",
	},
]
