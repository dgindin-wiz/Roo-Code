import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createLexicalChunk,
	createResolvedMetadataPaths,
	createVectorHit,
	type EngineHarness,
} from "./CodeIndexEngineV2.testUtils"

const testState = vi.hoisted(() => ({
	mocks: {} as EngineHarness,
}))

vi.mock("fs/promises", () => ({
	access: (...args: unknown[]) => testState.mocks.fsAccess(...args),
	stat: (...args: unknown[]) => testState.mocks.fsStat(...args),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "codeIndex.debugLogging") {
					return false
				}
				if (key === "codeIndex.embeddingBatchSize") {
					return 60
				}
				return defaultValue
			}),
		}),
	},
	Uri: {
		joinPath: vi.fn((...parts: Array<{ fsPath?: string } | string>) => ({
			fsPath: parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? ""))).join("/"),
		})),
	},
}))

vi.mock("../store/MetadataStore", () => ({
	MetadataStore: vi.fn(() => testState.mocks.metadataStore),
}))

vi.mock("../sidecar/MetadataSidecarClient", () => ({
	MetadataSidecarClient: vi.fn((_paths: unknown, options?: { role?: string }) =>
		options?.role === "reader" ? testState.mocks.metadataReadStore : testState.mocks.metadataStore,
	),
}))

vi.mock("../store/MetadataPathResolver", () => ({
	resolveMetadataStorePaths: vi.fn((_context: unknown, workspacePath: string) =>
		createResolvedMetadataPaths(workspacePath),
	),
}))

vi.mock("../adapters/VsCodeWorkspaceAdapter", () => ({
	VsCodeWorkspaceAdapter: vi.fn(() => testState.mocks.workspaceAdapter),
}))

vi.mock("../adapters/CodeIndexParserAdapter", () => ({
	CodeIndexParserAdapter: vi.fn(),
}))

vi.mock("../discovery", () => ({
	DiscoveryService: vi.fn(() => testState.mocks.discoveryService),
}))

vi.mock("../pipeline", () => ({
	StatHashService: vi.fn(() => testState.mocks.statHashService),
	ParseChunkService: vi.fn(() => testState.mocks.parseChunkService),
	DiffPlanner: vi.fn(() => testState.mocks.diffPlanner),
	EmbedUpsertWorker: vi.fn(() => testState.mocks.embedUpsertWorker),
	SidecarParseExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
	SidecarEmbedUpsertExecutor: vi.fn(() => ({
		dispose: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("../reconciliation/ReconciliationService", () => ({
	ReconciliationService: vi.fn(() => testState.mocks.reconciliationService),
}))

vi.mock("../watcher", () => ({
	WatcherCoordinator: vi.fn(() => testState.mocks.watcherCoordinator),
}))

vi.mock("../../code-index/cache-manager", () => ({
	CacheManager: vi.fn(),
}))

vi.mock("../../code-index/service-factory", () => ({
	CodeIndexServiceFactory: vi.fn(() => testState.mocks.serviceFactory),
}))

vi.mock("../adapters/ExistingEmbedderAdapter", () => ({
	ExistingEmbedderAdapter: vi.fn(() => testState.mocks.embeddingAdapter),
}))

vi.mock("../adapters/QdrantRestVectorStoreAdapter", () => ({
	QdrantRestVectorStoreAdapter: vi.fn(() => testState.mocks.vectorStore),
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		configureDiagnosticsDirectory: (...args: unknown[]) =>
			(testState.mocks.logger.configureDiagnosticsDirectory as (...callArgs: unknown[]) => unknown)(...args),
		setContext: (...args: unknown[]) =>
			(testState.mocks.logger.setContext as (...callArgs: unknown[]) => unknown)(...args),
		log: (...args: unknown[]) => (testState.mocks.logger.log as (...callArgs: unknown[]) => unknown)(...args),
		getMemorySnapshot: (...args: unknown[]) =>
			(testState.mocks.logger.getMemorySnapshot as (...callArgs: unknown[]) => unknown)(...args),
		getCpuSnapshot: (...args: unknown[]) =>
			(testState.mocks.logger.getCpuSnapshot as (...callArgs: unknown[]) => unknown)(...args),
		getTrackedProcessSummary: (...args: unknown[]) =>
			(testState.mocks.logger.getTrackedProcessSummary as (...callArgs: unknown[]) => unknown)(...args),
		getBuildInfo: (...args: unknown[]) =>
			(testState.mocks.logger.getBuildInfo as (...callArgs: unknown[]) => unknown)(...args),
	},
}))

describe("CodeIndexEngineV2 search ranking", () => {
	const createHarness = () => createBaseEngineHarness()

	const createEngine = () =>
		new CodeIndexEngineV2(
			testState.mocks.context,
			"/workspace",
			testState.mocks.configManager,
			testState.mocks.stateManager as any,
		)

	beforeEach(() => {
		vi.restoreAllMocks()
		vi.useFakeTimers()
		testState.mocks = createHarness()
		vi.spyOn(CodeIndexEngineV2.prototype as any, "waitForPipelineTick").mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("reranks search results using symbol, path, and summary metadata", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-generic",
				score: 0.91,
				payload: {
					filePath: "src/auth/helpers.ts",
					chunkFingerprint: "child-generic",
					codeChunk: "export const helper = true",
					summary: "ts function helper in src/auth/helpers.ts:1-1",
				},
			}),
			createVectorHit({
				id: "point-symbol",
				score: 0.82,
				payload: {
					filePath: "src/auth/AssumeRoleWithWebIdentity.ts",
					chunkFingerprint: "child-symbol",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 10,
					endLine: 12,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
					parentSymbolName: "Auth",
					summary:
						"ts function AssumeRoleWithWebIdentity in Auth at src/auth/AssumeRoleWithWebIdentity.ts:10-12",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("AssumeRoleWithWebIdentity function", 5)

		expect(results).toHaveLength(2)
		expect(results[0].id).toBe("point-symbol")
		expect(results[0].rerankScore).toBeGreaterThan(results[0].score)
		expect(results[0].matchReasons).toContain("symbol token overlap")
		expect(results[0].matchReasons).toContain("path token overlap")
		expect(results[0].matchReasons).toContain("chunk kind match")
	})

	it("uses a real candidate floor for small limits", async () => {
		const engine = createEngine()
		await engine.start()

		await engine.search("find value", 1)

		expect(testState.mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20, 0.4)
		expect(testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			"find value",
			20,
			expect.any(Object),
		)
	})

	it("expands identifier-style queries for lexical retrieval without changing the grounding result", async () => {
		const engine = createEngine()
		await engine.start()

		await engine.search("refreshAllIndexData", 5)

		expect(testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			expect.stringContaining("refresh_all_index_data"),
			20,
			expect.objectContaining({
				allowExactFallback: true,
			}),
		)
		expect(testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			expect.stringContaining("refresh all index data"),
			20,
			expect.any(Object),
		)
	})

	it("filters vector and lexical candidates by directory prefix before reranking", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-auth",
				score: 0.81,
				payload: {
					filePath: "src/auth/validate.ts",
					chunkFingerprint: "auth-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 1,
					endLine: 3,
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
				},
			}),
			createVectorHit({
				id: "point-other",
				score: 0.95,
				payload: {
					filePath: "src/other.ts",
					chunkFingerprint: "other-fp",
					codeChunk: "export const validateToken = true",
				},
			}),
		])
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 1,
				fallbackMs: 0,
				totalMs: 1,
			},
		})

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("validateToken", 2, { directoryPrefix: "src/auth" })

		expect(testState.mocks.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 60, 0.4)
		expect(results).toHaveLength(1)
		expect(results[0].payload?.filePath).toBe("src/auth/validate.ts")
	})

	it("parses query intent once and threads it through search", async () => {
		const engine = createEngine()
		const parseQueryIntentSpy = vi.spyOn(engine as any, "parseQueryIntent")
		await engine.start()

		await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(parseQueryIntentSpy).toHaveBeenCalledTimes(1)
	})

	it("matches token overlap on whole tokens instead of substrings", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-submerged",
				payload: {
					filePath: "src/search/submerged.ts",
					chunkFingerprint: "submerged-fp",
					codeChunk: "const submerged = true",
					searchText: "submerged helper",
					startLine: 1,
					endLine: 2,
				},
			}),
			createVectorHit({
				id: "point-merge",
				payload: {
					filePath: "src/search/merge.ts",
					chunkFingerprint: "merge-fp",
					codeChunk: "export function merge() {}",
					searchText: "merge helper",
					startLine: 1,
					endLine: 2,
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("merge", 5)

		expect(results[0].id).toBe("point-merge")
		expect(results[0].matchReasons).toContain("content token overlap")
		expect(results[1].matchReasons ?? []).not.toContain("content token overlap")
	})

	it("boosts path-like query hints ahead of generic token overlap", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-generic",
				payload: {
					filePath: "src/services/helpers.ts",
					chunkFingerprint: "generic-fp",
					codeChunk: "export const helper = true",
				},
			}),
			createVectorHit({
				id: "point-path",
				score: 0.76,
				payload: {
					filePath: "src/services/auth/validate.ts",
					chunkFingerprint: "path-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("src/services/auth/validate.ts", 5)

		expect(results[0].id).toBe("point-path")
		expect(results[0].matchReasons).toContain("exact hinted path match")
	})

	it("boosts symbol-like query hints ahead of generic token overlap", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-generic",
				score: 0.89,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "generic-symbol-fp",
					codeChunk: "validate token helper",
					startLine: 1,
					endLine: 3,
				},
			}),
			createVectorHit({
				id: "point-symbol",
				score: 0.77,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "exact-symbol-fp",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 10,
					endLine: 14,
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("Auth.AssumeRoleWithWebIdentity", 5)

		expect(results[0].id).toBe("point-symbol")
		expect(results[0].matchReasons).toContain("exact hinted symbol match")
	})

	it("returns lexical candidates even when no query embedding is available", async () => {
		testState.mocks.embeddingAdapter.createEmbeddings
			.mockResolvedValueOnce({
				embeddings: [[0.1, 0.2, 0.3]],
			})
			.mockResolvedValueOnce({
				embeddings: [],
			})
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				createLexicalChunk({
					chunkId: "chunk-lexical",
					chunkFingerprint: "lexical-fp",
					startLine: 15,
					endLine: 19,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
					parentSymbolName: "Auth",
					summary: "ts function AssumeRoleWithWebIdentity in Auth at src/auth.ts:15-19",
					searchText: "AssumeRoleWithWebIdentity function",
					content: "export function AssumeRoleWithWebIdentity() {}",
					contentHash: "hash-lexical",
					vectorPointId: "vector-lexical",
					relativePath: "src/auth.ts",
					normalizedPath: "/workspace/src/auth.ts",
				}),
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 6,
				fallbackMs: 4,
				totalMs: 10,
			},
		})

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("AssumeRoleWithWebIdentity", 5)

		expect(results).toHaveLength(1)
		expect(testState.mocks.vectorStore.search).not.toHaveBeenCalled()
		expect(results[0].payload?.symbolQualifiedName).toBe("Auth.AssumeRoleWithWebIdentity")
		expect(results[0].matchReasons).toContain("lexical match")
	})

	it("boosts exact filename-style path hints during reranking", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "schema-point",
				score: 0.72,
				payload: {
					filePath: "src/services/code-index-v2/store/schema.ts",
					chunkFingerprint: "schema-fp",
					codeChunk: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					chunkKind: "module",
				},
			}),
			createVectorHit({
				id: "other-point",
				score: 0.74,
				payload: {
					filePath: "src/services/code-index-v2/store/types.ts",
					chunkFingerprint: "types-fp",
					codeChunk: "export type ChunkVariantType = ...",
					chunkKind: "type",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("schema.ts CREATE TABLE chunk_variants", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/store/schema.ts")
		expect(results[0].matchReasons).toContain("exact hinted filename match")
		expect(results[0].matchReasons).toContain("schema file match")
		expect(results[0].matchReasons).toContain("schema storage path match")
		expect(results[0].matchReasons).toContain("ddl token overlap")
	})

	it("penalizes blog content for natural-language code questions", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "blog-point",
				score: 0.95,
				payload: {
					filePath: "apps/web-roo-code/src/content/blog/example.md",
					chunkFingerprint: "blog-fp",
					codeChunk: "How does Roo add parent and sibling context to code search results?",
					startLine: 1,
					endLine: 4,
					summary: "Blog content about Roo adoption",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText: "expandSearchResultsWithParents parent sibling context code search results",
					startLine: 100,
					endLine: 130,
					summary: "Engine logic for parent and sibling context expansion",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("retrieval engine surface match")
		expect(results[1].matchReasons).toContain("non-code content penalty")
	})

	it("boosts startup oversized tracking queries toward the engine implementation", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "config-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index/config-manager.ts",
					chunkFingerprint: "config-fp",
					codeChunk: "getOversizedFileApproval() {}",
					searchText: "oversized approvals config manager",
					summary: "Oversized approval lookup in config manager",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async refreshTrackedOversizedFiles() {}",
					searchText: "refreshTrackedOversizedFiles startup reconcile oversized approvals",
					startLine: 200,
					endLine: 240,
					summary: "Refresh tracked oversized files on startup and reconcile approvals",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("refreshTrackedOversizedFiles startup reconcile oversized approvals", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("startup tracking engine surface match")
		expect(results[0].matchReasons).toContain("exact startup tracking match")
	})

	it("boosts full refresh manager queries toward the manager implementation entrypoint", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "custom-modes-point",
				score: 0.95,
				payload: {
					filePath: "src/core/config/CustomModesManager.ts",
					chunkFingerprint: "custom-modes-fp",
					codeChunk: "private refreshMergedState() {}",
					searchText: "refresh merged state custom modes manager",
					symbolName: "refreshMergedState",
					symbolQualifiedName: "CustomModesManager.refreshMergedState",
					summary: "Refresh custom modes manager merged state",
				},
			}),
			createVectorHit({
				id: "manager-point",
				score: 0.83,
				payload: {
					filePath: "src/services/code-index/manager.ts",
					chunkFingerprint: "manager-fp",
					codeChunk: "public async refreshAllIndexData() {}",
					searchText: "refreshAllIndexData full refresh manager workspace index",
					symbolName: "refreshAllIndexData",
					symbolQualifiedName: "CodeIndexManager.refreshAllIndexData",
					startLine: 200,
					endLine: 260,
					summary: "Run a non destructive full refresh of the workspace index",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("refreshAllIndexData full refresh manager", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index/manager.ts")
		expect(results[0].matchReasons).toContain("full refresh manager path match")
		expect(results[0].matchReasons).toContain("exact full refresh manager match")
	})

	it("penalizes wrapper surfaces for implementation-oriented hybrid retrieval queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "ui-point",
				score: 0.95,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "ui-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					summary: "Search result display component",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private mergeSearchCandidates() {}",
					searchText: "mergeSearchCandidates lexical vector hybrid retrieval",
					startLine: 50,
					endLine: 90,
					summary: "Engine logic for combining lexical and vector retrieval before reranking",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search(
			"How does V2 combine lexical search and vector search before returning results",
			5,
		)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("hybrid retrieval engine surface match")
		expect(results[1].matchReasons).toContain("wrapper surface penalty")
	})

	it("prefers engine parent and sibling context behavior over wrapper and fixture surfaces", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "display-point",
				score: 0.95,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "display-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					summary: "Search result display component",
				},
			}),
			createVectorHit({
				id: "fixture-point",
				score: 0.9,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "How does Roo add parent and sibling context to code search results",
					searchText: "eval benchmark fixture parent sibling context",
					summary: "Benchmark fixture for retrieval queries",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("retrieval engine surface match")
		expect(results.some((result) => result.matchReasons?.includes("fixture surface penalty"))).toBe(true)
	})

	it("penalizes context-management distractors for parent and sibling context retrieval queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "context-point",
				score: 0.95,
				payload: {
					filePath: "src/core/context/context-management/context-error-handling.ts",
					chunkFingerprint: "context-fp",
					codeChunk: "function checkContextWindowExceededError() {}",
					searchText: "context window management context handling",
					symbolName: "checkContextWindowExceededError",
					summary: "Context management error handling",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("context-management surface penalty")
	})

	it("prefers the search results display component over benchmark fixtures for display-oriented queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "fixture-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "codebase search results display parent context sibling context",
					searchText: "benchmark fixture search results display parent sibling context",
					summary: "Benchmark fixture",
				},
			}),
			createVectorHit({
				id: "display-point",
				score: 0.83,
				payload: {
					filePath: "webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx",
					chunkFingerprint: "display-fp",
					codeChunk: "function CodebaseSearchResultsDisplay() {}",
					searchText: "codebase search results display parent context sibling context",
					symbolName: "CodebaseSearchResultsDisplay",
					symbolQualifiedName: "CodebaseSearchResultsDisplay",
					summary: "Display codebase search results with parent and sibling context",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("codebase search results display parent context sibling context", 5)

		expect(results[0].payload?.filePath).toBe("webview-ui/src/components/chat/CodebaseSearchResultsDisplay.tsx")
		expect(results[0].matchReasons).toContain("search results display surface match")
		expect(results[1].matchReasons).toContain("fixture surface penalty")
	})

	it("penalizes parser adapter surfaces for parent and sibling context behavior queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "parser-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts",
					chunkFingerprint: "parser-fp",
					codeChunk: "buildSearchText() {}",
					searchText: "build search text parent sibling context code search results",
					symbolName: "buildSearchText",
					summary: "Build search text for code index chunks",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("parser/adapter surface penalty")
	})

	it("penalizes metadata store surfaces for parent and sibling context behavior queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "store-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/store/MetadataStore.ts",
					chunkFingerprint: "store-fp",
					codeChunk: "computeLexicalScore() {}",
					searchText: "compute lexical score parent sibling context code search results",
					symbolName: "computeLexicalScore",
					summary: "Compute lexical score for code index retrieval",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					searchText:
						"expandSearchResultsWithParents parent sibling context code search results add parent context add sibling context",
					symbolName: "expandSearchResultsWithParents",
					symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
					startLine: 100,
					endLine: 130,
					summary: "Expand code search results with parent and sibling context",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("How does Roo add parent and sibling context to code search results", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[1].matchReasons).toContain("storage surface penalty")
	})

	it("boosts preflight timeout queries toward the engine verification flow", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "cli-point",
				score: 0.95,
				payload: {
					filePath: "apps/cli/scripts/integration/cases/cancel-immediately-after-start-ack.ts",
					chunkFingerprint: "cli-fp",
					codeChunk: "onTimeoutMessage() {}",
					searchText: "timeout message qdrant verification timed out",
					symbolName: "onTimeoutMessage",
					summary: "CLI timeout message helper",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.82,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async preflightIndexingDependencies() {}",
					searchText: "preflightIndexingDependencies qdrant verification timed out after 10s preflight",
					symbolName: "preflightIndexingDependencies",
					symbolQualifiedName: "CodeIndexEngineV2.preflightIndexingDependencies",
					startLine: 200,
					endLine: 260,
					summary: "Verify Qdrant and embedding provider availability before indexing starts",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("Qdrant verification timed out after 10s preflight", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(results[0].matchReasons).toContain("preflight implementation match")
		expect(results[1].matchReasons).toContain("preflight cli surface penalty")
	})

	it("boosts low value file filtering queries toward the shared low value file implementation", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "fixture-point",
				score: 0.95,
				payload: {
					filePath: "src/services/code-index-v2/eval/fixtures/roo-code-benchmark.ts",
					chunkFingerprint: "fixture-fp",
					codeChunk: "low value file filtering code index",
					searchText: "low value file filtering benchmark fixture",
					summary: "Benchmark query fixture",
				},
			}),
			createVectorHit({
				id: "engine-point",
				score: 0.7,
				payload: {
					filePath: "src/services/code-index/shared/low-value-files.ts",
					chunkFingerprint: "shared-fp",
					codeChunk: "const LOW_VALUE_FILE_NAMES = new Set([])",
					searchText: "LOW_VALUE_FILE_NAMES low value file filtering code index",
					symbolName: "LOW_VALUE_FILE_NAMES",
					summary: "Low value file filtering list used by code index",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("low value file filtering code index", 5)

		expect(results[0].payload?.filePath).toBe("src/services/code-index/shared/low-value-files.ts")
		expect(results[0].matchReasons).toContain("low value files implementation match")
		expect(results[1].matchReasons).toContain("low value files non-code surface penalty")
	})

	it("boosts oversized webview handler queries toward the webview handler implementation", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "cli-point",
				score: 0.95,
				payload: {
					filePath: "apps/cli/src/agent/json-event-emitter.ts",
					chunkFingerprint: "cli-fp",
					codeChunk: "handleReasoningMessage() {}",
					searchText: "json event emitter handler message",
					symbolName: "handleReasoningMessage",
					summary: "CLI reasoning event handler",
				},
			}),
			createVectorHit({
				id: "handler-point",
				score: 0.79,
				payload: {
					filePath: "src/core/webview/webviewMessageHandler.ts",
					chunkFingerprint: "handler-fp",
					codeChunk: 'case "fullRefreshIndexData": requestOversizedFileDetails()',
					searchText: "fullRefreshIndexData requestOversizedFileDetails webview message handler",
					symbolName: "fullRefreshIndexData",
					summary: "Webview message handler for full refresh and oversized file details",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search(
			"fullRefreshIndexData requestOversizedFileDetails webview message handler",
			5,
		)

		expect(results[0].payload?.filePath).toBe("src/core/webview/webviewMessageHandler.ts")
		expect(results[0].matchReasons).toContain("oversized webview handler implementation match")
		expect(results[1].matchReasons).toContain("oversized webview handler unrelated surface penalty")
	})

	it("merges lexical and vector candidates for the same chunk", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-vector",
				score: 0.72,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in src/auth.ts:10-14",
				},
			}),
		])
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				createLexicalChunk({
					chunkId: "chunk-shared",
					chunkFingerprint: "shared-fp",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					parentSymbolName: "Auth",
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
					searchText: "validateToken function",
					content: "export function validateToken() {}",
					contentHash: "hash-shared",
					vectorPointId: "point-vector",
					relativePath: "src/auth.ts",
					normalizedPath: "/workspace/src/auth.ts",
				}),
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 5,
				fallbackMs: 3,
				totalMs: 8,
			},
		})

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("validateToken", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.chunkFingerprint).toBe("shared-fp")
		expect(results[0].matchReasons).toContain("lexical match")
		expect(results[0].matchReasons).toContain("symbol token overlap")
	})

	it("collapses multi-variant hits back to the raw-code payload", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-summary",
				score: 0.83,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					variantType: "summary",
					codeChunk: "export function validateToken() {}",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
				},
			}),
			createVectorHit({
				id: "point-raw",
				score: 0.79,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "shared-fp",
					variantType: "raw_code",
					codeChunk: "export function validateToken() { return true }",
					startLine: 10,
					endLine: 14,
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					summary: "ts function validateToken in Auth at src/auth.ts:10-14",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("where do we validate the token", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.variantType).toBe("raw_code")
		expect(results[0].payload?.codeChunk).toBe("export function validateToken() { return true }")
		expect(results[0].matchReasons).toContain("summary variant match")
		expect(results[0].matchReasons).toContain("raw code grounding")
	})

	it("boosts symbol signature variants for symbol-oriented queries while grounding to raw code", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-signature",
				score: 0.8,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "sig-fp",
					variantType: "symbol_signature",
					codeChunk: "export function AssumeRoleWithWebIdentity() {}",
					startLine: 20,
					endLine: 24,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			}),
			createVectorHit({
				id: "point-raw",
				score: 0.74,
				payload: {
					filePath: "src/auth.ts",
					chunkFingerprint: "sig-fp",
					variantType: "raw_code",
					codeChunk: "export function AssumeRoleWithWebIdentity() { return true }",
					startLine: 20,
					endLine: 24,
					chunkKind: "function",
					symbolName: "AssumeRoleWithWebIdentity",
					symbolQualifiedName: "Auth.AssumeRoleWithWebIdentity",
				},
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("Auth.AssumeRoleWithWebIdentity", 5)

		expect(results).toHaveLength(1)
		expect(results[0].payload?.variantType).toBe("raw_code")
		expect(results[0].matchReasons).toContain("symbol signature variant match")
		expect(results[0].matchReasons).toContain("raw code grounding")
	})
})
