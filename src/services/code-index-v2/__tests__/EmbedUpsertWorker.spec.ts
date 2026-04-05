import { beforeEach, describe, expect, it, vi } from "vitest"
import { EmbedUpsertWorker } from "../pipeline/EmbedUpsertWorker"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "codeIndex.embeddingBatchSize") {
					return 2
				}
				if (key === "codeIndex.embeddingLaneConcurrency") {
					return 2
				}
				return defaultValue
			}),
		}),
	},
}))

describe("EmbedUpsertWorker", () => {
	const createWorkerDeps = () => {
		const metadataStore = {
			claimJobs: vi.fn(),
			getChunksByIds: vi.fn(),
			completeJob: vi.fn().mockResolvedValue(undefined),
			completeJobs: vi.fn().mockResolvedValue(undefined),
			failJob: vi.fn().mockResolvedValue(undefined),
			markJobTerminalFailed: vi.fn().mockResolvedValue(undefined),
			markChunkState: vi.fn().mockResolvedValue(undefined),
			markChunkStates: vi.fn().mockResolvedValue(undefined),
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
			createEmbeddings: vi.fn(),
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
			if (texts[0] === "bad") {
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
			if (texts[0] === "bad") {
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
		expect(embeddingAdapter.recycleClient).toHaveBeenCalledTimes(1)
		expect(vectorStore.recycleClient).toHaveBeenCalledTimes(1)
	})
})
