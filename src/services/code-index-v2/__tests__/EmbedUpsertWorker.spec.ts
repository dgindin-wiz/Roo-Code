import { beforeEach, describe, expect, it, vi } from "vitest"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { EmbedUpsertWorker } from "../pipeline/EmbedUpsertWorker"
import { MacGpuTelemetrySampler } from "../telemetry"
import { buildRawCodeVariantContent } from "../shared/chunkSurfaces"

const mockConfigValues: Record<string, unknown> = {
	"codeIndex.embeddingBatchSize": 2,
	"codeIndex.embeddingLaneConcurrency": 2,
}

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => mockConfigValues[key] ?? defaultValue),
			inspect: vi.fn((key: string) =>
				key in mockConfigValues
					? {
							defaultValue: undefined,
							globalValue: mockConfigValues[key],
						}
					: undefined,
			),
		}),
	},
}))

describe("EmbedUpsertWorker", () => {
	const createWorkerDeps = () => {
		const metadataStore = {
			claimJobs: vi.fn(),
			getChunksByIds: vi.fn(),
			getChunkVariantsByChunkIds: vi.fn().mockResolvedValue([]),
			releaseJobs: vi.fn().mockResolvedValue(undefined),
			completeJob: vi.fn().mockResolvedValue(undefined),
			completeJobs: vi.fn().mockResolvedValue(undefined),
			failJob: vi.fn().mockResolvedValue(undefined),
			markJobTerminalFailed: vi.fn().mockResolvedValue(undefined),
			markChunkState: vi.fn().mockResolvedValue(undefined),
			markChunkStates: vi.fn().mockResolvedValue(undefined),
			markChunkVariantStates: vi.fn().mockResolvedValue(undefined),
			getNextRetryAt: vi.fn(),
			getRevisionsByState: vi.fn(),
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
			getRevisionJobResolution: vi.fn(),
			getDiffBaselineRevision: vi.fn(),
			markRevisionCommitted: vi.fn().mockResolvedValue(undefined),
			markRevisionDegraded: vi.fn().mockResolvedValue(undefined),
			markRevisionTerminalFailure: vi.fn().mockResolvedValue(undefined),
			markRevisionSuperseded: vi.fn().mockResolvedValue(undefined),
		}

		const embeddingAdapter = {
			provider: "openai-compatible",
			modelId: "test-embed-model",
			runtimeKind: "remote" as "local" | "remote",
			runtimeLabel: "Remote embedder",
			createEmbeddings: vi.fn(),
			getRecommendedDocumentBatchSize: vi.fn(),
			recycleClient: vi.fn().mockResolvedValue(undefined),
		}

		const vectorStore = {
			initialize: vi.fn().mockResolvedValue(undefined),
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByIds: vi.fn().mockResolvedValue(undefined),
			recycleClient: vi.fn().mockResolvedValue(undefined),
		}

		return { metadataStore, embeddingAdapter, vectorStore }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
		mockConfigValues["codeIndex.embeddingBatchSize"] = 2
		mockConfigValues["codeIndex.embeddingLaneConcurrency"] = 2
	})

	it("retries a transient single-chunk embedding failure and eventually commits the revision", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const jobAttempt1 = {
			jobId: "job-1",
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: "chunk-1",
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}
		const jobAttempt2 = {
			...jobAttempt1,
			attemptCount: 2,
		}
		const chunk = {
			chunkId: "chunk-1",
			revisionId: "revision-1",
			chunkFingerprint: "fp-1",
			startLine: 1,
			endLine: 3,
			content: "const ok = true",
			contentHash: "hash-1",
			tokenEstimate: 12,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: "file-1",
			workspaceId: "workspace-1",
			relativePath: "src/a.ts",
			normalizedPath: "/workspace/src/a.ts",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}

		let upsertClaimCount = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string) => {
			if (jobType === "delete") {
				return []
			}

			upsertClaimCount++
			if (upsertClaimCount === 1) {
				return [jobAttempt1]
			}
			if (upsertClaimCount === 2) {
				return [jobAttempt2]
			}
			return []
		})
		metadataStore.getChunksByIds.mockResolvedValue([chunk])
		metadataStore.getNextRetryAt.mockImplementation(async (jobType: string) => {
			if (jobType === "upsert" && upsertClaimCount === 1) {
				return Date.now()
			}
			return undefined
		})
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
			},
		])
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings
			.mockRejectedValueOnce(new Error("temporary embed failure"))
			.mockResolvedValueOnce({ embeddings: [[0.1, 0.2, 0.3]] })

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(metadataStore.failJob).toHaveBeenCalledTimes(1)
		expect(metadataStore.completeJobs).toHaveBeenCalledTimes(1)
		expect(metadataStore.markRevisionCommitted).toHaveBeenCalledWith("revision-1")
		expect(summary.retryingChunks).toBe(1)
		expect(summary.upsertedChunks).toBe(1)
		expect(summary.committedRevisions).toBe(1)
		expect(summary.laneConcurrency).toBe(2)
		expect(summary.peakInFlightChunkCount).toBeGreaterThanOrEqual(1)
	})

	it("embeds the primary rich raw-code variant plus symbol variants while keeping chunk-level job semantics", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const job = {
			jobId: "job-1",
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: "chunk-1",
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}
		const chunk = {
			chunkId: "chunk-1",
			revisionId: "revision-1",
			chunkFingerprint: "fp-1",
			startLine: 10,
			endLine: 18,
			content: "export function validateToken(token: string) { return token.length > 0 }",
			contentHash: "hash-1",
			tokenEstimate: 20,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: "file-1",
			workspaceId: "workspace-1",
			relativePath: "src/auth.ts",
			normalizedPath: "/workspace/src/auth.ts",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			chunkKind: "function",
			symbolName: "validateToken",
			symbolQualifiedName: "Auth.validateToken",
			parentSymbolName: "Auth",
			parentChunkFingerprint: null,
			language: "ts",
			summary: "ts function validateToken in Auth at src/auth.ts:10-18",
			searchText:
				"Path: src/auth.ts\nSymbol: validateToken\nParent: Auth\n\nexport function validateToken(token: string) { return token.length > 0 }",
		}
		metadataStore.claimJobs.mockImplementation(async (jobType: string) => {
			if (jobType === "delete") {
				return []
			}
			return metadataStore.claimJobs.mock.calls.filter(([type]) => type === "upsert").length === 1 ? [job] : []
		})
		metadataStore.getChunksByIds.mockResolvedValue([chunk])
		metadataStore.getChunkVariantsByChunkIds.mockResolvedValue([
			{
				variantId: "variant-raw",
				chunkId: "chunk-1",
				variantType: "raw_code",
				content: buildRawCodeVariantContent({
					relativePath: chunk.relativePath,
					content: chunk.content,
					language: chunk.language,
					chunkKind: chunk.chunkKind,
					symbolName: chunk.symbolName,
					symbolQualifiedName: chunk.symbolQualifiedName,
					parentSymbolName: chunk.parentSymbolName,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
				}),
				contentHash: "hash-raw",
				tokenEstimate: 20,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
			},
		])
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue([
			{ revisionId: "revision-1", fileId: "file-1", runId: "run-1" },
		])
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockResolvedValue({
			embeddings: [
				[0.1, 0.2, 0.3],
				[0.4, 0.5, 0.6],
			],
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(embeddingAdapter.createEmbeddings).toHaveBeenCalledWith(
			[
				buildRawCodeVariantContent({
					relativePath: chunk.relativePath,
					content: chunk.content,
					language: chunk.language,
					chunkKind: chunk.chunkKind,
					symbolName: chunk.symbolName,
					symbolQualifiedName: chunk.symbolQualifiedName,
					parentSymbolName: chunk.parentSymbolName,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
				}),
			],
			expect.any(Object),
		)
		expect(vectorStore.upsertPoints).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ payload: expect.objectContaining({ variantType: "raw_code" }) }),
			]),
		)
		expect(metadataStore.markChunkVariantStates).toHaveBeenCalled()
		expect(metadataStore.markChunkStates).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					chunkId: "chunk-1",
					vectorPointId: expect.any(String),
				}),
			]),
		)
		expect(summary.upsertedChunks).toBe(1)
	})

	it("trims a claimed chunk batch to the current embedding budget", () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		embeddingAdapter.getRecommendedDocumentBatchSize = vi.fn().mockReturnValue(2)
		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const now = Date.now()
		const jobPairs = [1, 2].map((index) => ({
			job: {
				jobId: `job-${index}`,
				runId: "run-1",
				entityId: `chunk-${index}`,
			},
			chunk: {
				chunkId: `chunk-${index}`,
				revisionId: "revision-1",
				chunkFingerprint: `fp-${index}`,
				startLine: index,
				endLine: index + 1,
				content: `export function fn${index}() { return ${index} }`,
				contentHash: `hash-${index}`,
				tokenEstimate: 12,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
				fileId: "file-1",
				workspaceId: "workspace-1",
				relativePath: "src/a.ts",
				normalizedPath: "/workspace/src/a.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
				chunkKind: "function",
				symbolName: `fn${index}`,
				symbolQualifiedName: `A.fn${index}`,
				parentSymbolName: "A",
				parentChunkFingerprint: null,
				language: "ts",
				summary: null,
				searchText: null,
			},
		}))
		const variantsByChunkId = new Map(
			jobPairs.map(({ chunk }) => [
				chunk.chunkId,
				[
					{
						variantId: `${chunk.chunkId}-raw`,
						chunkId: chunk.chunkId,
						variantType: "raw_code" as const,
						content: `raw:${chunk.chunkId}`,
						vectorEligible: true,
						vectorPriority: 1000,
						vectorEligibilityReason: "canonical_grounding_surface",
						noveltyScore: 1,
					},
					{
						variantId: `${chunk.chunkId}-sig`,
						chunkId: chunk.chunkId,
						variantType: "symbol_signature" as const,
						content: `sig:${chunk.chunkId}`,
						vectorEligible: true,
						vectorPriority: 800,
						vectorEligibilityReason: "extracted_symbol_signature",
						noveltyScore: 0.5,
					},
				],
			]),
		)

		const selected = (worker as any).selectJobPairsWithinEmbeddingBudget(jobPairs, variantsByChunkId, 2)

		expect(selected).toHaveLength(1)
		expect(selected[0]?.job.jobId).toBe("job-1")
	})

	it("isolates a permanently failing chunk so an unrelated chunk can still commit", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const jobs = [
			{
				jobId: "job-bad",
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-bad",
				state: "running" as const,
				priority: 100,
				attemptCount: 3,
				nextAttemptAt: now,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			},
			{
				jobId: "job-good",
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-good",
				state: "running" as const,
				priority: 100,
				attemptCount: 1,
				nextAttemptAt: now,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			},
		]
		const chunks = [
			{
				chunkId: "chunk-bad",
				revisionId: "revision-bad",
				chunkFingerprint: "fp-bad",
				startLine: 1,
				endLine: 2,
				content: "bad",
				contentHash: "hash-bad",
				tokenEstimate: 4,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
				fileId: "file-bad",
				workspaceId: "workspace-1",
				relativePath: "src/bad.ts",
				normalizedPath: "/workspace/src/bad.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
			{
				chunkId: "chunk-good",
				revisionId: "revision-good",
				chunkFingerprint: "fp-good",
				startLine: 1,
				endLine: 2,
				content: "good",
				contentHash: "hash-good",
				tokenEstimate: 4,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
				fileId: "file-good",
				workspaceId: "workspace-1",
				relativePath: "src/good.ts",
				normalizedPath: "/workspace/src/good.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
		]

		let upsertClaimed = false
		metadataStore.claimJobs.mockImplementation(async (jobType: string) => {
			if (jobType === "delete") {
				return []
			}
			if (!upsertClaimed) {
				upsertClaimed = true
				return jobs
			}
			return []
		})
		metadataStore.getChunksByIds.mockResolvedValue(chunks)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue([
			{ revisionId: "revision-bad", fileId: "file-bad", runId: "run-1" },
			{ revisionId: "revision-good", fileId: "file-good", runId: "run-1" },
		])
		metadataStore.getRevisionJobResolution.mockImplementation(async (revisionId: string) => {
			if (revisionId === "revision-bad") {
				return {
					doneJobs: 0,
					queuedJobs: 0,
					runningJobs: 0,
					terminalFailedJobs: 1,
					totalJobs: 1,
				}
			}
			return {
				doneJobs: 1,
				queuedJobs: 0,
				runningJobs: 0,
				terminalFailedJobs: 0,
				totalJobs: 1,
			}
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			if (texts.length === 2) {
				throw new Error("batch failed")
			}
			if (texts[0]?.includes("\nbad")) {
				throw new Error("bad chunk")
			}
			return { embeddings: [[0.4, 0.5, 0.6]] }
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(metadataStore.markJobTerminalFailed).toHaveBeenCalledWith("job-bad", "bad chunk")
		expect(metadataStore.markRevisionTerminalFailure).toHaveBeenCalledWith(
			"revision-bad",
			expect.stringContaining("1 chunk jobs failed permanently"),
		)
		expect(metadataStore.markRevisionCommitted).toHaveBeenCalledWith("revision-good")
		expect(summary.terminallyFailedChunks).toBe(1)
		expect(summary.terminalFailedRevisions).toBe(1)
		expect(summary.committedRevisions).toBe(1)
		expect(summary.upsertedChunks).toBe(1)
	})

	it("marks a mixed-success revision as degraded instead of fully committed", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const jobs = [
			{
				jobId: "job-bad",
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-bad",
				state: "running" as const,
				priority: 100,
				attemptCount: 3,
				nextAttemptAt: now,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			},
			{
				jobId: "job-good",
				workspaceId: "workspace-1",
				runId: "run-1",
				jobType: "upsert",
				entityId: "chunk-good",
				state: "running" as const,
				priority: 100,
				attemptCount: 1,
				nextAttemptAt: now,
				lastError: null,
				createdAt: now,
				updatedAt: now,
			},
		]
		const chunks = [
			{
				chunkId: "chunk-bad",
				revisionId: "revision-mixed",
				chunkFingerprint: "fp-bad",
				startLine: 1,
				endLine: 2,
				content: "bad",
				contentHash: "hash-bad",
				tokenEstimate: 4,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
				fileId: "file-mixed",
				workspaceId: "workspace-1",
				relativePath: "src/mixed.ts",
				normalizedPath: "/workspace/src/mixed.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
			{
				chunkId: "chunk-good",
				revisionId: "revision-mixed",
				chunkFingerprint: "fp-good",
				startLine: 3,
				endLine: 4,
				content: "good",
				contentHash: "hash-good",
				tokenEstimate: 4,
				embeddingModel: null,
				vectorPointId: null,
				state: "parsed" as const,
				createdAt: now,
				updatedAt: now,
				fileId: "file-mixed",
				workspaceId: "workspace-1",
				relativePath: "src/mixed.ts",
				normalizedPath: "/workspace/src/mixed.ts",
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
			},
		]

		let upsertClaimed = false
		metadataStore.claimJobs.mockImplementation(async (jobType: string) => {
			if (jobType === "delete") {
				return []
			}
			if (!upsertClaimed) {
				upsertClaimed = true
				return jobs
			}
			return []
		})
		metadataStore.getChunksByIds.mockResolvedValue(chunks)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue([
			{ revisionId: "revision-mixed", fileId: "file-mixed", runId: "run-1" },
		])
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 1,
			totalJobs: 2,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue({
			revisionId: "previous-revision",
		})
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			if (texts.length === 2) {
				throw new Error("batch failed")
			}
			if (texts[0]?.includes("\nbad")) {
				throw new Error("bad chunk")
			}
			return { embeddings: [[0.7, 0.8, 0.9]] }
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(metadataStore.markRevisionDegraded).toHaveBeenCalledWith(
			"revision-mixed",
			expect.stringContaining("1 chunk jobs failed permanently"),
		)
		expect(metadataStore.markRevisionSuperseded).toHaveBeenCalledWith("previous-revision")
		expect(metadataStore.markRevisionCommitted).not.toHaveBeenCalledWith("revision-mixed")
		expect(summary.degradedRevisions).toBe(1)
		expect(summary.terminallyFailedChunks).toBe(1)
		expect(summary.upsertedChunks).toBe(1)
	})

	it("processes upsert batches with bounded concurrency and tracks in-flight counts", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const jobs = Array.from({ length: 4 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))

		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}

			if (claimIndex >= jobs.length) {
				return []
			}

			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)

		let concurrentEmbeds = 0
		let peakConcurrentEmbeds = 0
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			concurrentEmbeds++
			peakConcurrentEmbeds = Math.max(peakConcurrentEmbeds, concurrentEmbeds)
			await new Promise((resolve) => setTimeout(resolve, texts.length === 1 ? 5 : 20))
			concurrentEmbeds--
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) }
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const progressSnapshots: Array<{ inFlightChunkCount: number; peakInFlightChunkCount: number }> = []
		const summary = await worker.run("run-1", undefined, (progress) => {
			progressSnapshots.push({
				inFlightChunkCount: progress.inFlightChunkCount,
				peakInFlightChunkCount: progress.peakInFlightChunkCount,
			})
		})

		expect(peakConcurrentEmbeds).toBeGreaterThan(1)
		expect(summary.laneConcurrency).toBe(2)
		expect(summary.peakInFlightChunkCount).toBeLessThanOrEqual(summary.laneConcurrency * 60)
		expect(progressSnapshots.some((snapshot) => snapshot.peakInFlightChunkCount >= 2)).toBe(true)
		expect(summary.upsertedChunks).toBe(4)
	})

	it("drains and recycles shared clients after sustained batch volume", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const jobs = Array.from({ length: 50 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))

		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}

			if (claimIndex >= jobs.length) {
				return []
			}

			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockResolvedValue({
			embeddings: Array.from({ length: 2 }, () => [0.1, 0.2, 0.3]),
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(summary.batchesCompleted).toBe(25)
		expect(embeddingAdapter.recycleClient).toHaveBeenCalledTimes(2)
		expect(vectorStore.recycleClient).toHaveBeenCalledTimes(2)
	})

	it("uses conservative local-runtime defaults when the user has not explicitly configured them", async () => {
		delete mockConfigValues["codeIndex.embeddingBatchSize"]
		delete mockConfigValues["codeIndex.embeddingLaneConcurrency"]
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		embeddingAdapter.runtimeKind = "local"
		embeddingAdapter.runtimeLabel = "Local embedder"

		metadataStore.claimJobs.mockResolvedValue([])
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue([])

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")

		expect(summary.laneConcurrency).toBe(1)
		expect(summary.effectiveBatchSize).toBe(30)
	})

	it("ramps local lane concurrency upward under sustained GPU headroom", async () => {
		vi.useFakeTimers()
		delete mockConfigValues["codeIndex.embeddingBatchSize"]
		delete mockConfigValues["codeIndex.embeddingLaneConcurrency"]
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		embeddingAdapter.runtimeKind = "local"
		embeddingAdapter.runtimeLabel = "Local embedder"
		const now = Date.now()
		const jobs = Array.from({ length: 240 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))
		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}
			if (claimIndex >= jobs.length) {
				return []
			}
			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			await vi.advanceTimersByTimeAsync(5_100)
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) }
		})
		vi.spyOn(MacGpuTelemetrySampler.prototype, "sample").mockResolvedValue({
			sampler: "ioreg",
			utilizationPercent: 60,
			deviceUtilizationPercent: 60,
			inUseBytes: 2_500_000_000,
			allocatedBytes: 6_800_000_000,
			sampleAgeMs: 0,
		})
		const memorySpy = vi.spyOn(IndexDebugLoggerV2, "getMemorySnapshot").mockReturnValue({
			rssMB: 1100,
			heapUsedMB: 120,
			heapTotalMB: 140,
			externalMB: 140,
			arrayBuffersMB: 0,
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")
		memorySpy.mockRestore()

		expect(summary.laneConcurrency).toBeGreaterThan(1)
		expect(summary.laneConcurrency).toBeLessThanOrEqual(3)
	})

	it("does not auto-ramp local lane concurrency when the user explicitly configured it", async () => {
		vi.useFakeTimers()
		mockConfigValues["codeIndex.embeddingBatchSize"] = 30
		mockConfigValues["codeIndex.embeddingLaneConcurrency"] = 1
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		embeddingAdapter.runtimeKind = "local"
		embeddingAdapter.runtimeLabel = "Local embedder"
		const now = Date.now()
		const jobs = Array.from({ length: 120 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))
		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}
			if (claimIndex >= jobs.length) {
				return []
			}
			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			await vi.advanceTimersByTimeAsync(5_100)
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) }
		})
		vi.spyOn(MacGpuTelemetrySampler.prototype, "sample").mockResolvedValue({
			sampler: "ioreg",
			utilizationPercent: 58,
			deviceUtilizationPercent: 58,
			inUseBytes: 2_400_000_000,
			allocatedBytes: 6_800_000_000,
			sampleAgeMs: 0,
		})
		const memorySpy = vi.spyOn(IndexDebugLoggerV2, "getMemorySnapshot").mockReturnValue({
			rssMB: 1100,
			heapUsedMB: 120,
			heapTotalMB: 140,
			externalMB: 140,
			arrayBuffersMB: 0,
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")
		memorySpy.mockRestore()

		expect(summary.laneConcurrency).toBe(1)
	})

	it("reduces effective batch size under soft pressure and emits pressure telemetry", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		mockConfigValues["codeIndex.embeddingBatchSize"] = 4
		mockConfigValues["codeIndex.embeddingLaneConcurrency"] = 2
		const now = Date.now()
		const jobs = Array.from({ length: 8 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))
		const claimSizes: number[] = []
		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}
			claimSizes.push(limit)
			if (claimIndex >= jobs.length) {
				return []
			}
			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockResolvedValue({
			embeddings: Array.from({ length: 4 }, () => [0.1, 0.2, 0.3]),
		})
		const memorySpy = vi
			.spyOn(IndexDebugLoggerV2, "getMemorySnapshot")
			.mockReturnValueOnce({
				rssMB: 1650,
				heapUsedMB: 120,
				heapTotalMB: 140,
				externalMB: 820,
				arrayBuffersMB: 0,
			})
			.mockReturnValue({
				rssMB: 1500,
				heapUsedMB: 110,
				heapTotalMB: 130,
				externalMB: 700,
				arrayBuffersMB: 0,
			})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")
		memorySpy.mockRestore()

		expect(claimSizes[0]).toBe(4)
		expect(claimSizes.some((size) => size < 4)).toBe(true)
		expect(summary.pressureState).toBeDefined()
		expect(summary.upsertedChunks).toBe(8)
	})

	it("caps queued upsert work after soft pressure is detected", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		mockConfigValues["codeIndex.embeddingBatchSize"] = 200
		mockConfigValues["codeIndex.embeddingLaneConcurrency"] = 2
		const now = Date.now()
		const jobs = Array.from({ length: 700 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))
		const claimSizes: number[] = []
		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}
			claimSizes.push(limit)
			if (claimIndex >= jobs.length) {
				return []
			}
			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)

		let activeEmbeds = 0
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			activeEmbeds++
			const delayMs = activeEmbeds === 1 ? 5 : 25
			await new Promise((resolve) => setTimeout(resolve, delayMs))
			activeEmbeds--
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) }
		})

		const memorySpy = vi
			.spyOn(IndexDebugLoggerV2, "getMemorySnapshot")
			.mockReturnValueOnce({
				rssMB: 1650,
				heapUsedMB: 120,
				heapTotalMB: 140,
				externalMB: 820,
				arrayBuffersMB: 0,
			})
			.mockReturnValue({
				rssMB: 1500,
				heapUsedMB: 110,
				heapTotalMB: 130,
				externalMB: 700,
				arrayBuffersMB: 0,
			})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")
		memorySpy.mockRestore()

		expect(claimSizes.slice(0, 2)).toEqual([200, 200])
		expect(claimSizes.some((size) => size < 200)).toBe(true)
		expect(Math.min(...claimSizes)).toBeLessThanOrEqual(100)
		expect(summary.pressureState).toBeDefined()
		expect(summary.upsertedChunks).toBe(700)
	})

	it("clamps concurrency to one and recycles earlier under hard pressure", async () => {
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		mockConfigValues["codeIndex.embeddingBatchSize"] = 2
		mockConfigValues["codeIndex.embeddingLaneConcurrency"] = 2
		const now = Date.now()
		const jobs = Array.from({ length: 6 }, (_, index) => ({
			jobId: `job-${index + 1}`,
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: `chunk-${index + 1}`,
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}))
		const chunks = jobs.map((job, index) => ({
			chunkId: job.entityId,
			revisionId: `revision-${index + 1}`,
			chunkFingerprint: `fp-${index + 1}`,
			startLine: 1,
			endLine: 2,
			content: `content-${index + 1}`,
			contentHash: `hash-${index + 1}`,
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: `file-${index + 1}`,
			workspaceId: "workspace-1",
			relativePath: `src/file-${index + 1}.ts`,
			normalizedPath: `/workspace/src/file-${index + 1}.ts`,
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}))
		let claimIndex = 0
		metadataStore.claimJobs.mockImplementation(async (jobType: string, limit: number) => {
			if (jobType === "delete") {
				return []
			}
			if (claimIndex >= jobs.length) {
				return []
			}
			const claimed = jobs.slice(claimIndex, claimIndex + limit)
			claimIndex += claimed.length
			return claimed
		})
		metadataStore.getChunksByIds.mockImplementation(async (chunkIds: string[]) =>
			chunks.filter((chunk) => chunkIds.includes(chunk.chunkId)),
		)
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue(
			chunks.map((chunk) => ({ revisionId: chunk.revisionId, fileId: chunk.fileId, runId: "run-1" })),
		)
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockImplementation(
			async (texts: string[]) =>
				new Promise((resolve) =>
					setTimeout(() => resolve({ embeddings: texts.map(() => [0.1, 0.2, 0.3]) }), 10),
				),
		)
		const memorySpy = vi.spyOn(IndexDebugLoggerV2, "getMemorySnapshot").mockReturnValue({
			rssMB: 1900,
			heapUsedMB: 125,
			heapTotalMB: 145,
			externalMB: 980,
			arrayBuffersMB: 0,
		})

		const worker = new EmbedUpsertWorker(metadataStore as any, embeddingAdapter as any, vectorStore as any)
		const summary = await worker.run("run-1")
		memorySpy.mockRestore()

		expect(summary.laneConcurrency).toBe(1)
		expect(summary.effectiveBatchSize).toBe(2)
		expect(summary.pressureState).toBe("hard")
		expect(embeddingAdapter.recycleClient).toHaveBeenCalled()
		expect(vectorStore.recycleClient).toHaveBeenCalled()
	})

	it("routes worker heartbeat and completion telemetry with workspacePath", async () => {
		vi.useFakeTimers()
		const { metadataStore, embeddingAdapter, vectorStore } = createWorkerDeps()
		const now = Date.now()
		const job = {
			jobId: "job-1",
			workspaceId: "workspace-1",
			runId: "run-1",
			jobType: "upsert",
			entityId: "chunk-1",
			state: "running" as const,
			priority: 100,
			attemptCount: 1,
			nextAttemptAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		}
		const chunk = {
			chunkId: "chunk-1",
			revisionId: "revision-1",
			chunkFingerprint: "fp-1",
			startLine: 1,
			endLine: 2,
			content: "const ok = true",
			contentHash: "hash-1",
			tokenEstimate: 5,
			embeddingModel: null,
			vectorPointId: null,
			state: "parsed" as const,
			createdAt: now,
			updatedAt: now,
			fileId: "file-1",
			workspaceId: "workspace-1",
			relativePath: "src/file-1.ts",
			normalizedPath: "/workspace/src/file-1.ts",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
		}
		metadataStore.claimJobs.mockImplementation(async (jobType: string) => {
			if (jobType === "delete") {
				return []
			}
			return metadataStore.claimJobs.mock.calls.filter(([type]) => type === "upsert").length === 1 ? [job] : []
		})
		metadataStore.getChunksByIds.mockResolvedValue([chunk])
		metadataStore.getNextRetryAt.mockResolvedValue(undefined)
		metadataStore.getRevisionsByState.mockResolvedValue([
			{ revisionId: "revision-1", fileId: "file-1", runId: "run-1" },
		])
		metadataStore.getRevisionJobResolution.mockResolvedValue({
			doneJobs: 1,
			queuedJobs: 0,
			runningJobs: 0,
			terminalFailedJobs: 0,
			totalJobs: 1,
		})
		metadataStore.getDiffBaselineRevision.mockResolvedValue(undefined)
		embeddingAdapter.createEmbeddings.mockImplementation(async (texts: string[]) => {
			await vi.advanceTimersByTimeAsync(5_100)
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) }
		})
		vi.spyOn(MacGpuTelemetrySampler.prototype, "sample").mockResolvedValue({
			sampler: "ioreg",
			utilizationPercent: 61,
			deviceUtilizationPercent: 61,
			inUseBytes: 2_500_000_000,
			allocatedBytes: 6_800_000_000,
			sampleAgeMs: 0,
		})
		const logSpy = vi.spyOn(IndexDebugLoggerV2, "log").mockImplementation(() => {})

		const worker = new EmbedUpsertWorker(
			metadataStore as any,
			embeddingAdapter as any,
			vectorStore as any,
			undefined,
			"/tmp/workspace-a",
		)
		await worker.run("run-1")

		const heartbeatCall = logSpy.mock.calls.find(([, , message]) => message === "embed-upsert-heartbeat")
		const completeCall = logSpy.mock.calls.find(([, , message]) => message === "embed-upsert-complete")

		expect(heartbeatCall?.[3]).toEqual(
			expect.objectContaining({
				workspacePath: "/tmp/workspace-a",
			}),
		)
		expect(completeCall?.[3]).toEqual(
			expect.objectContaining({
				workspacePath: "/tmp/workspace-a",
			}),
		)
	})
})
