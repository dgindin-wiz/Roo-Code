import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExistingEmbedderAdapter } from "../adapters/ExistingEmbedderAdapter"
import { QdrantRestVectorStoreAdapter } from "../adapters/QdrantRestVectorStoreAdapter"
import { CodeIndexEngineV2 } from "../engine/CodeIndexEngineV2"
import {
	createBaseEngineHarness,
	createChunkRecord,
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
	MetadataSidecarClient: vi.fn(() => testState.mocks.metadataStore),
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

describe("CodeIndexEngineV2 search context", () => {
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

	it("returns stage snapshots through searchDebug without changing the final result shape", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "schema-point",
				score: 0.72,
				payload: {
					filePath: "src/services/code-index-v2/store/schema.ts",
					chunkFingerprint: "schema-fp",
					codeChunk: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					startLine: 1,
					endLine: 10,
					chunkKind: "module",
				},
			}),
		])
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				createLexicalChunk({
					chunkId: "schema-lexical",
					chunkFingerprint: "schema-fp",
					chunkKind: "module",
					summary: "schema definitions for code index tables",
					searchText: "CREATE TABLE chunk_variants",
					content: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
					contentHash: "schema-content-hash",
					vectorPointId: "schema-point",
					relativePath: "src/services/code-index-v2/store/schema.ts",
					normalizedPath: "/workspace/src/services/code-index-v2/store/schema.ts",
					lexicalScore: 28,
				}),
			],
			status: "completed",
			mode: "fts_plus_exact_fallback",
			timingsMs: {
				ftsMs: 7,
				fallbackMs: 3,
				totalMs: 10,
			},
		})

		const engine = createEngine()
		await engine.start()

		const trace = await engine.searchDebug!("schema.ts CREATE TABLE chunk_variants", 5)

		expect(trace.timingsMs.totalMs).toBeGreaterThanOrEqual(0)
		expect(trace.timingsMs.lexicalRetrievalMs).toBeGreaterThanOrEqual(0)
		expect(trace.lexicalStatus).toBe("completed")
		expect(trace.lexicalMode).toBe("fts_plus_exact_fallback")
		expect(trace.stages.vector).toHaveLength(1)
		expect(trace.stages.lexical).toHaveLength(1)
		expect(trace.stages.merged).toHaveLength(1)
		expect(trace.stages.final).toHaveLength(1)
		expect(trace.stages.final[0]?.payload?.filePath).toBe("src/services/code-index-v2/store/schema.ts")
	})

	it("skips lexical retrieval in searchDebug for broad long natural language queries without retrieval hints", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([])
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValueOnce({
			results: [
				createLexicalChunk({
					chunkId: "lexical-1",
					chunkFingerprint: "lexical-fp",
					chunkKind: "module",
					summary: "ignored",
					searchText: "ignored",
					content: "ignored",
					contentHash: "ignored",
					vectorPointId: "vector-1",
					relativePath: "src/ignored.ts",
					normalizedPath: "/workspace/src/ignored.ts",
					lexicalScore: 28,
				}),
			],
			status: "completed",
			mode: "fts_only",
			timingsMs: {
				ftsMs: 9,
				fallbackMs: 0,
				totalMs: 9,
			},
		})

		const engine = createEngine()
		await engine.start()

		const trace = await engine.searchDebug!(
			"How does Roo decide what code to use for general workspace behavior",
			5,
		)

		expect(testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus).not.toHaveBeenCalled()
		expect(trace.stages.lexical).toHaveLength(0)
		expect(trace.timingsMs.lexicalRetrievalMs).toBe(0)
		expect(trace.lexicalStatus).toBe("skipped")
		expect(trace.lexicalMode).toBe("none")
	})

	it("runs FTS-only lexical retrieval for natural-language implementation queries", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "vector-point",
				score: 0.88,
				payload: {
					filePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
					chunkFingerprint: "engine-fp",
					codeChunk: "private async expandSearchResultsWithParents() {}",
					startLine: 1,
					endLine: 10,
					chunkKind: "method",
				},
			}),
		])
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockReset()
		testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus.mockResolvedValue({
			results: [],
			status: "completed",
			mode: "fts_only",
			timingsMs: {
				ftsMs: 12,
				fallbackMs: 0,
				totalMs: 12,
			},
		})

		const engine = createEngine()
		await engine.start()

		const trace = await engine.searchDebug!("How does Roo add parent and sibling context to code search results", 5)

		expect(testState.mocks.metadataStore.searchActiveChunksLexicallyWithStatus).toHaveBeenCalledWith(
			"How does Roo add parent and sibling context to code search results",
			20,
			{ allowExactFallback: false },
		)
		expect(trace.lexicalStatus).toBe("completed")
		expect(trace.lexicalMode).toBe("fts_only")
		expect(trace.stages.lexical).toHaveLength(0)
		expect(trace.stages.final[0]?.payload?.filePath).toBe("src/services/code-index-v2/engine/CodeIndexEngineV2.ts")
		expect(trace.timingsMs.lexicalRetrievalMs).toBeGreaterThanOrEqual(0)
	})

	it("uses separate dependency instances for indexing and search", async () => {
		const engine = createEngine()

		await engine.start()
		await engine.searchDebug!("schema.ts CREATE TABLE chunk_variants", 5)

		expect(vi.mocked(ExistingEmbedderAdapter)).toHaveBeenCalledTimes(2)
		expect(vi.mocked(QdrantRestVectorStoreAdapter)).toHaveBeenCalledTimes(2)
	})

	it("expands parent chunks after strong child hits", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-method",
				score: 0.88,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-fp",
					codeChunk: "validateToken(token: string) { return token.length > 0 }",
					startLine: 20,
					endLine: 24,
					chunkKind: "method",
					symbolName: "validateToken",
					symbolQualifiedName: "AuthService.validateToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				},
			}),
			createVectorHit({
				id: "point-other",
				score: 0.7,
				payload: {
					filePath: "src/services/other.ts",
					chunkFingerprint: "child-other-fp",
					codeChunk: "other helper",
					startLine: 1,
					endLine: 2,
				},
			}),
		])
		testState.mocks.metadataStore.getActiveChunksByFingerprints.mockResolvedValueOnce([
			createChunkRecord({
				chunkId: "chunk-parent",
				chunkFingerprint: "parent-class-fp",
				startLine: 1,
				endLine: 40,
				chunkKind: "class",
				symbolName: "AuthService",
				symbolQualifiedName: "AuthService",
				summary: "ts class AuthService in src/services/auth.ts:1-40",
				searchText: "AuthService class definition",
				content: "class AuthService { validateToken() {} }",
				contentHash: "hash-parent",
				tokenEstimate: 25,
				vectorPointId: "vector-parent",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("validateToken method", 3)

		expect(testState.mocks.metadataStore.getActiveChunksByFingerprints).toHaveBeenCalledWith([
			{
				relativePath: "src/services/auth.ts",
				chunkFingerprint: "parent-class-fp",
			},
		])
		expect(results).toHaveLength(3)
		expect(results[0].payload?.symbolQualifiedName).toBe("AuthService.validateToken")
		expect(results[1].payload?.symbolQualifiedName).toBe("AuthService")
		expect(results[1].matchReasons).toContain("expanded parent context")
		expect(results[1].payload?.chunkKind).toBe("class")
		expect(results[2].id).toBe("point-other")
	})

	it("collapses duplicate child hits from the same parent and adds one sibling context", async () => {
		testState.mocks.vectorStore.search.mockResolvedValueOnce([
			createVectorHit({
				id: "point-method-1",
				score: 0.89,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-a",
					codeChunk: "validateToken(token: string) {}",
					startLine: 20,
					endLine: 24,
					chunkKind: "method",
					symbolName: "validateToken",
					symbolQualifiedName: "AuthService.validateToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				},
			}),
			createVectorHit({
				id: "point-method-2",
				score: 0.87,
				payload: {
					filePath: "src/services/auth.ts",
					chunkFingerprint: "child-method-b",
					codeChunk: "refreshToken(token: string) {}",
					startLine: 30,
					endLine: 34,
					chunkKind: "method",
					symbolName: "refreshToken",
					symbolQualifiedName: "AuthService.refreshToken",
					parentSymbolName: "AuthService",
					parentChunkFingerprint: "parent-class-fp",
					summary: "ts method refreshToken in AuthService at src/services/auth.ts:30-34",
				},
			}),
			createVectorHit({
				id: "point-other",
				score: 0.7,
				payload: {
					filePath: "src/services/other.ts",
					chunkFingerprint: "child-other-fp",
					codeChunk: "other helper",
					startLine: 1,
					endLine: 2,
				},
			}),
		])
		testState.mocks.metadataStore.getActiveChunksByFingerprints.mockResolvedValueOnce([
			createChunkRecord({
				chunkId: "chunk-parent",
				chunkFingerprint: "parent-class-fp",
				startLine: 1,
				endLine: 40,
				chunkKind: "class",
				symbolName: "AuthService",
				symbolQualifiedName: "AuthService",
				summary: "ts class AuthService in src/services/auth.ts:1-40",
				searchText: "AuthService class definition",
				content: "class AuthService { validateToken() {} refreshToken() {} }",
				contentHash: "hash-parent",
				tokenEstimate: 25,
				vectorPointId: "vector-parent",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
			}),
		])
		testState.mocks.metadataStore.getActiveChunksByRelativePaths.mockResolvedValueOnce([
			createChunkRecord({
				chunkId: "chunk-method-a",
				chunkFingerprint: "child-method-a",
				startLine: 20,
				endLine: 24,
				chunkKind: "method",
				symbolName: "validateToken",
				symbolQualifiedName: "AuthService.validateToken",
				parentSymbolName: "AuthService",
				parentChunkFingerprint: "parent-class-fp",
				summary: "ts method validateToken in AuthService at src/services/auth.ts:20-24",
				searchText: "validateToken method",
				content: "validateToken(token: string) {}",
				contentHash: "hash-a",
				tokenEstimate: 10,
				vectorPointId: "vector-method-a",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
			}),
			createChunkRecord({
				chunkId: "chunk-method-b",
				chunkFingerprint: "child-method-b",
				startLine: 30,
				endLine: 34,
				chunkKind: "method",
				symbolName: "refreshToken",
				symbolQualifiedName: "AuthService.refreshToken",
				parentSymbolName: "AuthService",
				parentChunkFingerprint: "parent-class-fp",
				summary: "ts method refreshToken in AuthService at src/services/auth.ts:30-34",
				searchText: "refreshToken method",
				content: "refreshToken(token: string) {}",
				contentHash: "hash-b",
				tokenEstimate: 10,
				vectorPointId: "vector-method-b",
				relativePath: "src/services/auth.ts",
				normalizedPath: "/workspace/src/services/auth.ts",
			}),
		])

		const engine = createEngine()
		await engine.start()

		const results = await engine.search("token method", 4)

		expect(results).toHaveLength(4)
		expect(results[0].payload?.symbolQualifiedName).toBe("AuthService.validateToken")
		expect(results[1].payload?.symbolQualifiedName).toBe("AuthService")
		expect(results[1].matchReasons).toContain("expanded parent context")
		expect(results[2].payload?.symbolQualifiedName).toBe("AuthService.refreshToken")
		expect(results[2].matchReasons).toContain("expanded sibling context")
		expect(results[3].id).toBe("point-other")
		expect(results.filter((result) => result.id === "point-method-2")).toHaveLength(0)
	})
})
