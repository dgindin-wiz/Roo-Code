import { beforeEach, describe, expect, it, vi } from "vitest"
import { ParseChunkService } from "../pipeline/ParseChunkService"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		log: vi.fn(),
	},
}))

describe("ParseChunkService", () => {
	const createDeps = () => {
		const metadataStore = {
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
			getRevisionsByState: vi.fn(),
			persistParsedRevision: vi.fn().mockImplementation(async ({ revisionId, chunks }: any) => ({
				insertedChunks: chunks.map((chunk: any) => ({
					chunkId: chunk.chunkId,
					revisionId,
					chunkFingerprint: chunk.chunkFingerprint,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					language: chunk.language ?? null,
					chunkKind: chunk.chunkKind ?? null,
					symbolName: chunk.symbolName ?? null,
					symbolQualifiedName: chunk.symbolQualifiedName ?? null,
					parentSymbolName: chunk.parentSymbolName ?? null,
					parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
					summary: chunk.summary ?? null,
					searchText: chunk.searchText ?? null,
					content: chunk.content,
					contentHash: chunk.contentHash,
					tokenEstimate: chunk.tokenEstimate ?? null,
					embeddingModel: null,
					vectorPointId: null,
					state: chunk.state,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})),
				insertedVariantCount: chunks.reduce(
					(total: number, chunk: { variants?: unknown[] }) => total + (chunk.variants?.length ?? 0),
					0,
				),
				chunkInsertLatencyMs: 5,
				lexicalFtsLatencyMs: 3,
				chunkVariantInsertLatencyMs: 2,
				revisionStateUpdateLatencyMs: 1,
				transactionLatencyMs: 11,
				metadataWriteLatencyMs: 11,
			})),
			markRevisionState: vi.fn().mockResolvedValue(undefined),
			markRevisionTerminalFailure: vi.fn().mockResolvedValue(undefined),
		}

		const workspaceAdapter = {
			readFile: vi.fn(),
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
		}

		const parserAdapter = {
			parseFile: vi.fn(),
		}

		return { metadataStore, workspaceAdapter, parserAdapter }
	}

	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("retries a transient parse failure and succeeds within the same run", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const value = 1")
		parserAdapter.parseFile.mockRejectedValueOnce(new Error("Canceled")).mockResolvedValueOnce([
			{
				chunkFingerprint: "fp-1",
				startLine: 1,
				endLine: 1,
				content: "const value = 1",
			},
		])

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(parserAdapter.parseFile).toHaveBeenCalledTimes(2)
		expect(parserAdapter.parseFile).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				filePath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			}),
		)
		expect(metadataStore.persistParsedRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				revisionId: "revision-1",
				relativePath: "src/a.ts",
			}),
		)
		expect(metadataStore.markRevisionTerminalFailure).not.toHaveBeenCalled()
		expect(summary.parsedRevisions).toBe(1)
		expect(summary.parsedChunks).toBe(1)
		expect(summary.retryingRevisions).toBe(1)
		expect(summary.terminalFailedRevisions).toBe(0)
	})

	it("creates raw-code, summary, and symbol-signature variants for structured chunks", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/auth.ts",
				relativePath: "src/auth.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("export function validateToken(token: string) {}")
		parserAdapter.parseFile.mockResolvedValue([
			{
				chunkFingerprint: "fp-1",
				startLine: 10,
				endLine: 12,
				content: "export function validateToken(token: string) {}",
				searchText:
					"Path: src/auth.ts\nLanguage: ts\nKind: function\nLines: 10-12\nSymbol: validateToken\nSymbol Words: validate token\nQualified Symbol: Auth.validateToken\nParent: Auth\nPreview: export function validateToken token: string",
				language: "ts",
				chunkKind: "function",
				symbolName: "validateToken",
				symbolQualifiedName: "Auth.validateToken",
				parentSymbolName: "Auth",
				summary: "ts function validateToken in Auth at src/auth.ts:10-12",
			},
		])

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		await service.run("run-1")

		expect(metadataStore.persistParsedRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				chunks: expect.arrayContaining([
					expect.objectContaining({
						variants: expect.arrayContaining([
							expect.objectContaining({
								variantType: "raw_code",
								content:
									"Path: src/auth.ts\nLanguage: ts\nKind: function\nLines: 10-12\nSymbol: validateToken\nSymbol Words: validate token\nQualified Symbol: Auth.validateToken\nParent: Auth\n\nexport function validateToken(token: string) {}",
							}),
							expect.objectContaining({
								variantType: "summary",
								content: "ts function validateToken in Auth at src/auth.ts:10-12",
							}),
							expect.objectContaining({ variantType: "symbol_signature" }),
						]),
					}),
				]),
			}),
		)
	})

	it("marks a revision terminal_failed after bounded parse retries and continues", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-bad",
				fileId: "file-bad",
				runId: "run-1",
				normalizedPath: "/workspace/src/bad.ts",
				relativePath: "src/bad.ts",
			},
			{
				revisionId: "revision-good",
				fileId: "file-good",
				runId: "run-1",
				normalizedPath: "/workspace/src/good.ts",
				relativePath: "src/good.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("content")
		parserAdapter.parseFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
			if (filePath.endsWith("bad.ts")) {
				throw new Error("memory access out of bounds")
			}
			return [
				{
					chunkFingerprint: "fp-good",
					startLine: 1,
					endLine: 1,
					content: "good",
				},
			]
		})

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.markRevisionTerminalFailure).toHaveBeenCalledWith(
			"revision-bad",
			"memory access out of bounds",
		)
		expect(metadataStore.persistParsedRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				revisionId: "revision-good",
			}),
		)
		expect(summary.parsedRevisions).toBe(1)
		expect(summary.retryingRevisions).toBe(2)
		expect(summary.terminalFailedRevisions).toBe(1)
		expect(summary.parsedRevisionIds).toEqual(["revision-good"])
	})

	it("reports parsed chunk counts from inserted chunks instead of raw parser output", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const value = 1")
		parserAdapter.parseFile.mockResolvedValue([
			{ chunkFingerprint: "fp-1", startLine: 1, endLine: 1, content: "const value = 1" },
			{ chunkFingerprint: "fp-2", startLine: 2, endLine: 2, content: "const next = 2" },
		])
		metadataStore.persistParsedRevision.mockResolvedValueOnce({
			insertedChunks: [
				{
					chunkId: "chunk-1",
					revisionId: "revision-1",
					chunkFingerprint: "fp-1",
					startLine: 1,
					endLine: 1,
					language: null,
					chunkKind: null,
					symbolName: null,
					symbolQualifiedName: null,
					parentSymbolName: null,
					parentChunkFingerprint: null,
					summary: null,
					searchText: "const value = 1",
					content: "const value = 1",
					contentHash: "hash-1",
					tokenEstimate: null,
					embeddingModel: null,
					vectorPointId: null,
					state: "parsed",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
			insertedVariantCount: 1,
			chunkInsertLatencyMs: 1,
			lexicalFtsLatencyMs: 1,
			chunkVariantInsertLatencyMs: 1,
			revisionStateUpdateLatencyMs: 1,
			transactionLatencyMs: 4,
			metadataWriteLatencyMs: 4,
		})
		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(summary.parsedChunks).toBe(1)
	})

	it("stages parsed chunks and variants without waiting on any embedding worker", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("export const value = 1")
		parserAdapter.parseFile.mockResolvedValue([
			{
				chunkFingerprint: "fp-1",
				startLine: 1,
				endLine: 1,
				content: "export const value = 1",
				searchText: "Path: src/a.ts\n\nexport const value = 1",
			},
		])

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.persistParsedRevision).toHaveBeenCalledTimes(1)
		expect(summary.parsedChunks).toBe(1)
	})

	it("logs parse metadata write timings for each stored revision batch", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("export const value = 1")
		parserAdapter.parseFile.mockResolvedValue([
			{
				chunkFingerprint: "fp-1",
				startLine: 1,
				endLine: 1,
				content: "export const value = 1",
				searchText: "Path: src/a.ts\n\nexport const value = 1",
			},
		])
		const logSpy = vi.spyOn(IndexDebugLoggerV2, "log").mockImplementation(() => {})

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		await service.run("run-1")

		const timingCall = logSpy.mock.calls.find(([, , message]) => message === "parse-chunk-revision-stored")
		expect(timingCall?.[3]).toEqual(
			expect.objectContaining({
				runId: "run-1",
				revisionId: "revision-1",
				relativePath: "src/a.ts",
				insertedChunkCount: 1,
				insertedVariantCount: expect.any(Number),
				chunkInsertLatencyMs: expect.any(Number),
				lexicalFtsLatencyMs: expect.any(Number),
				chunkVariantInsertLatencyMs: expect.any(Number),
				revisionStateUpdateLatencyMs: expect.any(Number),
				transactionLatencyMs: expect.any(Number),
				metadataWriteLatencyMs: expect.any(Number),
			}),
		)
	})

	it("parses multiple revisions with bounded concurrency", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue(
			Array.from({ length: 6 }, (_, index) => ({
				revisionId: `revision-${index + 1}`,
				fileId: `file-${index + 1}`,
				runId: "run-1",
				normalizedPath: `/workspace/src/file-${index + 1}.ts`,
				relativePath: `src/file-${index + 1}.ts`,
			})),
		)
		workspaceAdapter.readFile.mockImplementation(async (filePath: string) => `content for ${filePath}`)
		let inFlight = 0
		let maxInFlight = 0
		parserAdapter.parseFile.mockImplementation(async () => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise((resolve) => setTimeout(resolve, 10))
			inFlight--
			return [{ chunkFingerprint: `fp-${maxInFlight}`, startLine: 1, endLine: 1, content: "value" }]
		})

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(summary.parsedRevisions).toBe(6)
		expect(maxInFlight).toBeGreaterThan(1)
		expect(maxInFlight).toBeLessThanOrEqual(4)
	})

	it("treats missing files as superseded instead of parser failures", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-missing",
				fileId: "file-missing",
				runId: "run-1",
				normalizedPath: "/workspace/src/missing.ts",
				relativePath: "src/missing.ts",
			},
		])
		const error = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		workspaceAdapter.readFile.mockRejectedValue(error)

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.markRevisionState).toHaveBeenCalledWith("revision-missing", "superseded")
		expect(metadataStore.markRevisionTerminalFailure).not.toHaveBeenCalled()
		expect(parserAdapter.parseFile).not.toHaveBeenCalled()
		expect(summary.parsedRevisions).toBe(0)
		expect(summary.parsedChunks).toBe(0)
		expect(summary.retryingRevisions).toBe(0)
		expect(summary.terminalFailedRevisions).toBe(0)
	})

	it("can offload parsing to a sidecar executor while keeping host-side persistence", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		const parseExecutor = {
			parseRevision: vi.fn().mockResolvedValue({
				chunks: [
					{
						chunkFingerprint: "fp-1",
						startLine: 1,
						endLine: 1,
						content: "const value = 1",
						searchText: "Path: src/a.ts\n\nconst value = 1",
					},
				],
				parseLatencyMs: 12,
			}),
			dispose: vi.fn().mockResolvedValue(undefined),
		}

		const service = new ParseChunkService(
			metadataStore as any,
			workspaceAdapter as any,
			parserAdapter as any,
			undefined,
			parseExecutor as any,
		)
		const summary = await service.run("run-1")

		expect(parseExecutor.parseRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				revisionId: "revision-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
				signal: undefined,
			}),
		)
		expect(workspaceAdapter.readFile).not.toHaveBeenCalled()
		expect(parserAdapter.parseFile).not.toHaveBeenCalled()
		expect(metadataStore.persistParsedRevision).toHaveBeenCalled()
		expect(summary.parsedRevisions).toBe(1)
		expect(summary.parsedChunks).toBe(1)
	})

	it("passes the abort signal through to a sidecar parse executor", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		const parseExecutor = {
			parseRevision: vi.fn().mockResolvedValue({
				chunks: [
					{
						chunkFingerprint: "fp-1",
						startLine: 1,
						endLine: 1,
						content: "const value = 1",
					},
				],
				parseLatencyMs: 12,
			}),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		const abortController = new AbortController()

		const service = new ParseChunkService(
			metadataStore as any,
			workspaceAdapter as any,
			parserAdapter as any,
			undefined,
			parseExecutor as any,
		)
		await service.run("run-1", abortController.signal)

		expect(parseExecutor.parseRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				revisionId: "revision-1",
				signal: abortController.signal,
			}),
		)
	})

	it("aborts during sidecar startup without marking the revision parsed", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
			},
		])
		const parseExecutor = {
			parseRevision: vi.fn().mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
				await new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Parse/chunk stage aborted")), {
						once: true,
					})
				})
				throw new Error("unreachable")
			}),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		const abortController = new AbortController()
		const service = new ParseChunkService(
			metadataStore as any,
			workspaceAdapter as any,
			parserAdapter as any,
			undefined,
			parseExecutor as any,
		)

		const runPromise = service.run("run-1", abortController.signal)
		abortController.abort()

		await expect(runPromise).rejects.toThrow("Parse/chunk stage aborted")
		expect(metadataStore.persistParsedRevision).not.toHaveBeenCalled()
	})
})
