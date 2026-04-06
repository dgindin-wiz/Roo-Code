import { createHash } from "crypto"
import { CLIENT_RECYCLE_INTERVAL } from "../../code-index/constants"
import { EmbeddingAdapter } from "../adapters/EmbeddingAdapter"
import { VectorPoint, VectorStoreAdapter } from "../adapters/VectorStoreAdapter"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { getConfiguredEmbeddingBatchSize, getConfiguredEmbeddingLaneConcurrency } from "../settings"

export interface EmbedUpsertSummary {
	runId: string
	upsertedChunks: number
	deletedChunks: number
	committedRevisions: number
	degradedRevisions: number
	terminalFailedRevisions: number
	terminallyFailedChunks: number
	retryingChunks: number
	batchesCompleted: number
	laneConcurrency: number
	activeLaneCount: number
	inFlightChunkCount: number
	peakInFlightChunkCount: number
	chunksPerSecond?: number
	averageBatchLatencyMs?: number
	averageEmbedLatencyMs?: number
	averageUpsertLatencyMs?: number
	averageMetadataCommitLatencyMs?: number
	averageIdleGapMs?: number
	peakChunksPerSecond?: number
	peakBatchLatencyMs?: number
	peakIdleGapMs?: number
	peakBatchSize?: number
	peakEmbeddingCount?: number
}

export interface EmbedUpsertProgress {
	upsertedChunks: number
	deletedChunks: number
	committedRevisions: number
	degradedRevisions: number
	terminalFailedRevisions: number
	terminallyFailedChunks: number
	retryingChunks: number
	batchesCompleted: number
	laneConcurrency: number
	activeLaneCount: number
	inFlightChunkCount: number
	peakInFlightChunkCount: number
	lastBatchSize?: number
	lastEmbeddingCount?: number
	lastEmbedLatencyMs?: number
	lastUpsertLatencyMs?: number
	lastMetadataCommitLatencyMs?: number
	lastIdleGapMs?: number
	lastBatchLatencyMs?: number
	averageBatchLatencyMs?: number
	averageEmbedLatencyMs?: number
	averageUpsertLatencyMs?: number
	averageMetadataCommitLatencyMs?: number
	averageIdleGapMs?: number
	chunksPerSecond?: number
	peakChunksPerSecond?: number
	peakBatchLatencyMs?: number
	peakIdleGapMs?: number
	peakBatchSize?: number
	peakEmbeddingCount?: number
}

interface BatchTelemetry {
	batchKind: "upsert" | "delete"
	batchSize: number
	embeddingCount: number
	laneId: number
	idleGapMs?: number
	embedLatencyMs?: number
	upsertLatencyMs?: number
	metadataCommitLatencyMs?: number
	totalLatencyMs: number
}

export class EmbedUpsertWorker {
	private static readonly MAX_JOB_ATTEMPTS = 3
	private static readonly RETRY_DELAY_BASE_MS = 1_000
	private static readonly RETRY_DELAY_MAX_MS = 30_000
	private static readonly MAX_LANE_CONCURRENCY = 3
	private static readonly RECYCLE_DRAIN_TIMEOUT_MS = 15_000
	private readonly batchSize: number
	private readonly laneConcurrency: number
	private lastBatchCompletedAt = 0
	private activeLaneCount = 0
	private inFlightChunkCount = 0
	private peakInFlightChunkCount = 0
	private completedBatchCount = 0

	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly embeddingAdapter: EmbeddingAdapter,
		private readonly vectorStore: VectorStoreAdapter,
	) {
		this.batchSize = getConfiguredEmbeddingBatchSize()
		this.laneConcurrency = Math.max(
			1,
			Math.min(EmbedUpsertWorker.MAX_LANE_CONCURRENCY, getConfiguredEmbeddingLaneConcurrency()),
		)
	}

	async run(
		runId: string,
		signal?: AbortSignal,
		onProgress?: (progress: EmbedUpsertProgress) => void,
	): Promise<EmbedUpsertSummary> {
		await this.vectorStore.initialize()

		let upsertedChunks = 0
		let deletedChunks = 0
		let retryingChunks = 0
		let terminallyFailedChunks = 0
		let committedRevisions = 0
		let degradedRevisions = 0
		let terminalFailedRevisions = 0
		let batchesCompleted = 0
		let totalBatchLatencyMs = 0
		let totalEmbedLatencyMs = 0
		let totalUpsertLatencyMs = 0
		let totalMetadataCommitLatencyMs = 0
		let totalIdleGapMs = 0
		let peakChunksPerSecond = 0
		let peakBatchLatencyMs = 0
		let peakIdleGapMs = 0
		let peakBatchSize = 0
		let peakEmbeddingCount = 0
		let effectiveLaneConcurrency = this.laneConcurrency
		const workerStartedAt = Date.now()
		this.lastBatchCompletedAt = workerStartedAt
		this.activeLaneCount = 0
		this.inFlightChunkCount = 0
		this.peakInFlightChunkCount = 0
		this.completedBatchCount = 0

		const emitProgress = (batchTelemetry?: BatchTelemetry) => {
			if (batchTelemetry && batchTelemetry.batchSize > 0) {
				batchesCompleted++
				totalBatchLatencyMs += batchTelemetry.totalLatencyMs
				totalEmbedLatencyMs += batchTelemetry.embedLatencyMs ?? 0
				totalUpsertLatencyMs += batchTelemetry.upsertLatencyMs ?? 0
				totalMetadataCommitLatencyMs += batchTelemetry.metadataCommitLatencyMs ?? 0
				totalIdleGapMs += batchTelemetry.idleGapMs ?? 0
				peakBatchLatencyMs = Math.max(peakBatchLatencyMs, batchTelemetry.totalLatencyMs)
				peakIdleGapMs = Math.max(peakIdleGapMs, batchTelemetry.idleGapMs ?? 0)
				peakBatchSize = Math.max(peakBatchSize, batchTelemetry.batchSize)
				peakEmbeddingCount = Math.max(peakEmbeddingCount, batchTelemetry.embeddingCount)
			}

			const syncedChunks = upsertedChunks + deletedChunks
			const elapsedMs = Math.max(Date.now() - workerStartedAt, 1)
			const chunksPerSecond = syncedChunks > 0 ? syncedChunks / (elapsedMs / 1000) : undefined
			if (chunksPerSecond !== undefined) {
				peakChunksPerSecond = Math.max(peakChunksPerSecond, chunksPerSecond)
			}

			onProgress?.({
				upsertedChunks,
				deletedChunks,
				committedRevisions,
				degradedRevisions,
				terminalFailedRevisions,
				terminallyFailedChunks,
				retryingChunks,
				batchesCompleted,
				laneConcurrency: effectiveLaneConcurrency,
				activeLaneCount: this.activeLaneCount,
				inFlightChunkCount: this.inFlightChunkCount,
				peakInFlightChunkCount: this.peakInFlightChunkCount,
				lastBatchSize: batchTelemetry?.batchSize,
				lastEmbeddingCount: batchTelemetry?.embeddingCount,
				lastEmbedLatencyMs: batchTelemetry?.embedLatencyMs,
				lastUpsertLatencyMs: batchTelemetry?.upsertLatencyMs,
				lastMetadataCommitLatencyMs: batchTelemetry?.metadataCommitLatencyMs,
				lastIdleGapMs: batchTelemetry?.idleGapMs,
				lastBatchLatencyMs: batchTelemetry?.totalLatencyMs,
				averageBatchLatencyMs: batchesCompleted > 0 ? totalBatchLatencyMs / batchesCompleted : undefined,
				averageEmbedLatencyMs: batchesCompleted > 0 ? totalEmbedLatencyMs / batchesCompleted : undefined,
				averageUpsertLatencyMs: batchesCompleted > 0 ? totalUpsertLatencyMs / batchesCompleted : undefined,
				averageMetadataCommitLatencyMs:
					batchesCompleted > 0 ? totalMetadataCommitLatencyMs / batchesCompleted : undefined,
				averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
				chunksPerSecond,
				peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
				peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
				peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
				peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
				peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
			})

			if (batchTelemetry && batchTelemetry.batchSize > 0) {
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-batch", {
					component: "EmbedUpsertWorker",
					runId,
					provider: this.embeddingAdapter.provider,
					modelId: this.embeddingAdapter.modelId,
					batchKind: batchTelemetry.batchKind,
					laneId: batchTelemetry.laneId,
					laneConcurrency: effectiveLaneConcurrency,
					activeLaneCount: this.activeLaneCount,
					inFlightChunkCount: this.inFlightChunkCount,
					peakInFlightChunkCount: this.peakInFlightChunkCount,
					batchSize: batchTelemetry.batchSize,
					effectiveProviderBatchSize: batchTelemetry.embeddingCount,
					chunksPerSecond,
					batchLatencyMs: batchTelemetry.totalLatencyMs,
					embedLatencyMs: batchTelemetry.embedLatencyMs,
					upsertLatencyMs: batchTelemetry.upsertLatencyMs,
					metadataCommitLatencyMs: batchTelemetry.metadataCommitLatencyMs,
					idleGapMs: batchTelemetry.idleGapMs,
					batchesCompleted,
					syncedChunks,
				})
			}
		}

		const clampConcurrency = (error: unknown) => {
			if (effectiveLaneConcurrency <= 1 || !this.isConcurrencyPressureError(error)) {
				return
			}

			effectiveLaneConcurrency = Math.max(1, effectiveLaneConcurrency - 1)
			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-lane-clamped", {
				component: "EmbedUpsertWorker",
				runId,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				laneConcurrency: effectiveLaneConcurrency,
				errorMessage: error instanceof Error ? error.message : String(error),
			})
			emitProgress()
		}

		await this.processUpsertStage(runId, signal, emitProgress, {
			onRetryScheduled: () => {
				retryingChunks++
				emitProgress()
			},
			onChunkTerminalFailure: () => {
				terminallyFailedChunks++
				emitProgress()
			},
			onChunksUpserted: (count) => {
				upsertedChunks += count
			},
			onConcurrencyPressure: clampConcurrency,
			getLaneConcurrency: () => effectiveLaneConcurrency,
		})

		for (;;) {
			if (signal?.aborted) {
				throw new Error("Embed/upsert worker aborted")
			}

			const deleteJobs = await this.metadataStore.claimJobs("delete", this.batchSize, runId)
			if (deleteJobs.length === 0) {
				const nextRetryAt = await this.metadataStore.getNextRetryAt("delete", runId)
				if (nextRetryAt === undefined) {
					break
				}
				await this.waitForNextRetry(nextRetryAt, signal)
				continue
			}

			this.activeLaneCount = 1
			this.inFlightChunkCount = deleteJobs.length
			this.peakInFlightChunkCount = Math.max(this.peakInFlightChunkCount, this.inFlightChunkCount)
			try {
				await this.processDeleteJobs(deleteJobs, signal, 1, emitProgress, {
					onRetryScheduled: () => {
						emitProgress()
					},
					onChunksDeleted: (count) => {
						deletedChunks += count
					},
				})
			} finally {
				this.activeLaneCount = 0
				this.inFlightChunkCount = 0
			}
		}

		const plannedRevisions = await this.metadataStore.getRevisionsByState(
			this.metadataStore.getWorkspaceId(),
			"planned",
		)
		for (const revision of plannedRevisions) {
			if (revision.runId !== runId) {
				continue
			}

			const resolution = await this.metadataStore.getRevisionJobResolution(revision.revisionId, runId, "upsert")
			const previousRevision = await this.metadataStore.getDiffBaselineRevision(
				revision.fileId,
				revision.revisionId,
			)

			if (resolution.queuedJobs > 0 || resolution.runningJobs > 0) {
				continue
			}

			if (resolution.terminalFailedJobs === 0) {
				await this.metadataStore.markRevisionCommitted(revision.revisionId)
				if (previousRevision) {
					await this.metadataStore.markRevisionSuperseded(previousRevision.revisionId)
				}
				committedRevisions++
			} else if (resolution.doneJobs > 0 || resolution.totalJobs === 0) {
				await this.metadataStore.markRevisionDegraded(
					revision.revisionId,
					`${resolution.terminalFailedJobs} chunk jobs failed permanently during embedding.`,
				)
				if (previousRevision) {
					await this.metadataStore.markRevisionSuperseded(previousRevision.revisionId)
				}
				degradedRevisions++
			} else {
				await this.metadataStore.markRevisionTerminalFailure(
					revision.revisionId,
					`${resolution.terminalFailedJobs} chunk jobs failed permanently before any vectors were stored.`,
				)
				terminalFailedRevisions++
			}
			emitProgress()
		}

		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-complete", {
			component: "EmbedUpsertWorker",
			runId,
			provider: this.embeddingAdapter.provider,
			modelId: this.embeddingAdapter.modelId,
			jobId: `${upsertedChunks}:${deletedChunks}:${committedRevisions}:${degradedRevisions}:${terminalFailedRevisions}:${terminallyFailedChunks}:${batchesCompleted}`,
			upsertedChunks,
			deletedChunks,
			committedRevisions,
			degradedRevisions,
			terminalFailedRevisions,
			terminallyFailedChunks,
			retryingChunks,
			batchesCompleted,
			laneConcurrency: effectiveLaneConcurrency,
			activeLaneCount: this.activeLaneCount,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			chunksPerSecond:
				upsertedChunks + deletedChunks > 0
					? (upsertedChunks + deletedChunks) / (Math.max(Date.now() - workerStartedAt, 1) / 1000)
					: undefined,
			averageBatchLatencyMs: batchesCompleted > 0 ? totalBatchLatencyMs / batchesCompleted : undefined,
			averageEmbedLatencyMs: batchesCompleted > 0 ? totalEmbedLatencyMs / batchesCompleted : undefined,
			averageUpsertLatencyMs: batchesCompleted > 0 ? totalUpsertLatencyMs / batchesCompleted : undefined,
			averageMetadataCommitLatencyMs:
				batchesCompleted > 0 ? totalMetadataCommitLatencyMs / batchesCompleted : undefined,
			averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
			peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
			peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
			peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
			peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
			peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
		})

		return {
			runId,
			upsertedChunks,
			deletedChunks,
			committedRevisions,
			degradedRevisions,
			terminalFailedRevisions,
			terminallyFailedChunks,
			retryingChunks,
			batchesCompleted,
			laneConcurrency: effectiveLaneConcurrency,
			activeLaneCount: this.activeLaneCount,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			chunksPerSecond:
				upsertedChunks + deletedChunks > 0
					? (upsertedChunks + deletedChunks) / (Math.max(Date.now() - workerStartedAt, 1) / 1000)
					: undefined,
			averageBatchLatencyMs: batchesCompleted > 0 ? totalBatchLatencyMs / batchesCompleted : undefined,
			averageEmbedLatencyMs: batchesCompleted > 0 ? totalEmbedLatencyMs / batchesCompleted : undefined,
			averageUpsertLatencyMs: batchesCompleted > 0 ? totalUpsertLatencyMs / batchesCompleted : undefined,
			averageMetadataCommitLatencyMs:
				batchesCompleted > 0 ? totalMetadataCommitLatencyMs / batchesCompleted : undefined,
			averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
			peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
			peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
			peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
			peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
			peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
		}
	}

	private async processUpsertStage(
		runId: string,
		signal: AbortSignal | undefined,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => void,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onConcurrencyPressure: (error: unknown) => void
			getLaneConcurrency: () => number
		},
	): Promise<void> {
		const activeTasks = new Set<Promise<void>>()
		let nextLaneId = 1
		let nextRecycleAtBatch = CLIENT_RECYCLE_INTERVAL

		const launchNextBatch = async (): Promise<boolean> => {
			if (signal?.aborted) {
				throw new Error("Embed/upsert worker aborted")
			}

			const upsertJobs = await this.metadataStore.claimJobs("upsert", this.batchSize, runId)
			if (upsertJobs.length === 0) {
				return false
			}

			const laneId = nextLaneId++
			this.activeLaneCount++
			this.inFlightChunkCount += upsertJobs.length
			this.peakInFlightChunkCount = Math.max(this.peakInFlightChunkCount, this.inFlightChunkCount)

			const task = (async () => {
				try {
					await this.processUpsertJobs(upsertJobs, signal, laneId, emitBatchProgress, callbacks)
				} finally {
					this.activeLaneCount = Math.max(0, this.activeLaneCount - 1)
					this.inFlightChunkCount = Math.max(0, this.inFlightChunkCount - upsertJobs.length)
				}
			})()

			activeTasks.add(task)
			task.finally(() => activeTasks.delete(task)).catch(() => undefined)
			return true
		}

		for (;;) {
			const recyclePending = CLIENT_RECYCLE_INTERVAL > 0 && this.completedBatchCount >= nextRecycleAtBatch

			while (!recyclePending && activeTasks.size < callbacks.getLaneConcurrency()) {
				const launched = await launchNextBatch()
				if (!launched) {
					break
				}
			}

			if (recyclePending) {
				await this.maybeRecycleClients(runId, activeTasks, signal)
				nextRecycleAtBatch += CLIENT_RECYCLE_INTERVAL
				continue
			}

			if (activeTasks.size === 0) {
				const nextRetryAt = await this.metadataStore.getNextRetryAt("upsert", runId)
				if (nextRetryAt === undefined) {
					break
				}
				await this.waitForNextRetry(nextRetryAt, signal)
				continue
			}

			await Promise.race(Array.from(activeTasks))
		}
	}

	private async processUpsertJobs(
		jobs: Awaited<ReturnType<MetadataStore["claimJobs"]>>,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => void,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onConcurrencyPressure: (error: unknown) => void
		},
	): Promise<void> {
		const chunks = await this.metadataStore.getChunksByIds(jobs.map((job) => job.entityId))
		const chunkMap = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
		const orderedPairs = jobs
			.map((job) => {
				const chunk = chunkMap.get(job.entityId)
				return chunk ? { job, chunk } : undefined
			})
			.filter((pair): pair is { job: (typeof jobs)[number]; chunk: (typeof chunks)[number] } => Boolean(pair))

		if (orderedPairs.length === 0) {
			await this.metadataStore.completeJobs(jobs.map((job) => job.jobId))
			return
		}

		await this.processUpsertJobPairs(orderedPairs, signal, laneId, emitBatchProgress, callbacks)
	}

	private async maybeRecycleClients(
		runId: string,
		activeTasks: Set<Promise<void>>,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const recycleStartedAt = Date.now()
		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycle-pending", {
			component: "EmbedUpsertWorker",
			runId,
			provider: this.embeddingAdapter.provider,
			modelId: this.embeddingAdapter.modelId,
			laneConcurrency: this.laneConcurrency,
			activeLaneCount: activeTasks.size,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			recycleIntervalBatches: CLIENT_RECYCLE_INTERVAL,
			completedBatches: this.completedBatchCount,
		})

		const drained = await this.waitForActiveTasksToDrain(activeTasks, signal)
		if (!drained) {
			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycle-skipped", {
				component: "EmbedUpsertWorker",
				runId,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				laneConcurrency: this.laneConcurrency,
				activeLaneCount: activeTasks.size,
				inFlightChunkCount: this.inFlightChunkCount,
				peakInFlightChunkCount: this.peakInFlightChunkCount,
				recycleIntervalBatches: CLIENT_RECYCLE_INTERVAL,
				timeoutMs: EmbedUpsertWorker.RECYCLE_DRAIN_TIMEOUT_MS,
				elapsedMs: Date.now() - recycleStartedAt,
				reason: "active-lanes-did-not-drain",
			})
			return
		}

		const memoryBefore = IndexDebugLoggerV2.getMemorySnapshot()
		await this.embeddingAdapter.recycleClient?.()
		await this.vectorStore.recycleClient?.()
		const memoryAfter = IndexDebugLoggerV2.getMemorySnapshot()

		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycled-clients", {
			component: "EmbedUpsertWorker",
			runId,
			provider: this.embeddingAdapter.provider,
			modelId: this.embeddingAdapter.modelId,
			laneConcurrency: this.laneConcurrency,
			activeLaneCount: activeTasks.size,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			recycleIntervalBatches: CLIENT_RECYCLE_INTERVAL,
			completedBatches: this.completedBatchCount,
			elapsedMs: Date.now() - recycleStartedAt,
			memoryBefore,
			memoryAfter,
			externalDeltaMB: memoryAfter.externalMB - memoryBefore.externalMB,
			rssDeltaMB: memoryAfter.rssMB - memoryBefore.rssMB,
			arrayBuffersDeltaMB: (memoryAfter.arrayBuffersMB ?? 0) - (memoryBefore.arrayBuffersMB ?? 0),
		})
	}

	private async waitForActiveTasksToDrain(
		activeTasks: Set<Promise<void>>,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		if (activeTasks.size === 0) {
			return true
		}

		let abortListener: (() => void) | undefined
		try {
			return await Promise.race([
				Promise.allSettled(Array.from(activeTasks)).then(() => true),
				new Promise<boolean>((resolve, reject) => {
					const timer = setTimeout(() => {
						if (abortListener) {
							signal?.removeEventListener("abort", abortListener)
						}
						resolve(false)
					}, EmbedUpsertWorker.RECYCLE_DRAIN_TIMEOUT_MS)

					abortListener = () => {
						clearTimeout(timer)
						if (abortListener) {
							signal?.removeEventListener("abort", abortListener)
						}
						reject(new Error("Embed/upsert worker aborted"))
					}

					signal?.addEventListener("abort", abortListener, { once: true })
				}),
			])
		} finally {
			if (abortListener) {
				signal?.removeEventListener("abort", abortListener)
			}
		}
	}

	private async processUpsertJobPairs(
		jobPairs: Array<{
			job: Awaited<ReturnType<MetadataStore["claimJobs"]>>[number]
			chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number]
		}>,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => void,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onConcurrencyPressure: (error: unknown) => void
		},
	): Promise<void> {
		if (jobPairs.length === 0) {
			return
		}

		if (signal?.aborted) {
			throw new Error("Embed/upsert worker aborted")
		}

		try {
			const variants = await this.metadataStore.getChunkVariantsByChunkIds(
				jobPairs.map(({ chunk }) => chunk.chunkId),
			)
			const variantsByChunkId = new Map<string, typeof variants>()
			for (const variant of variants) {
				const group = variantsByChunkId.get(variant.chunkId) ?? []
				group.push(variant)
				variantsByChunkId.set(variant.chunkId, group)
			}
			const variantPairs = jobPairs.flatMap(({ job, chunk }) =>
				this.getChunkVariantsForEmbedding(chunk, variantsByChunkId.get(chunk.chunkId) ?? []).map((variant) => ({
					job,
					chunk,
					variant,
				})),
			)
			if (variantPairs.length === 0) {
				await this.metadataStore.completeJobs(jobPairs.map(({ job }) => job.jobId))
				return
			}

			const batchStartedAt = Date.now()
			const idleGapMs = Math.max(batchStartedAt - this.lastBatchCompletedAt, 0)
			const embedStartedAt = Date.now()
			const embeddingResponse = await this.embeddingAdapter.createEmbeddings(
				variantPairs.map(({ variant }) => variant.content),
				{
					signal,
					debugContext: {
						runId: jobPairs[0]?.job.runId,
						batchId: `${jobPairs[0]?.job.runId ?? "run"}:${jobPairs[0]?.job.jobId ?? "job"}:${variantPairs.length}`,
						outerBatchSize: variantPairs.length,
					},
				},
			)
			const embedLatencyMs = Date.now() - embedStartedAt

			const points = variantPairs.map(({ chunk, variant }, index) =>
				this.createPoint(chunk, variant, embeddingResponse.embeddings[index] ?? []),
			)
			const upsertStartedAt = Date.now()
			await this.vectorStore.upsertPoints(points)
			const upsertLatencyMs = Date.now() - upsertStartedAt

			const metadataCommitStartedAt = Date.now()
			await this.metadataStore.markChunkVariantStates(
				variantPairs.map(({ variant, chunk }) => ({
					variantId: variant.variantId,
					state: "upserted" as const,
					embeddingModel: this.embeddingAdapter.modelId,
					vectorPointId: this.createPointId(chunk, variant.variantType),
					clearContent: true,
				})),
			)
			await this.metadataStore.markChunkStates(
				jobPairs.map(({ chunk }) => ({
					chunkId: chunk.chunkId,
					state: "upserted" as const,
					embeddingModel: this.embeddingAdapter.modelId,
					vectorPointId: this.createPointId(chunk, "raw_code"),
					clearContent: true,
				})),
			)
			await this.metadataStore.completeJobs(jobPairs.map(({ job }) => job.jobId))
			const metadataCommitLatencyMs = Date.now() - metadataCommitStartedAt
			this.lastBatchCompletedAt = Date.now()
			this.completedBatchCount++

			callbacks.onChunksUpserted(jobPairs.length)
			emitBatchProgress({
				batchKind: "upsert",
				batchSize: jobPairs.length,
				embeddingCount: embeddingResponse.embeddings.length,
				laneId,
				idleGapMs,
				embedLatencyMs,
				upsertLatencyMs,
				metadataCommitLatencyMs,
				totalLatencyMs: Date.now() - batchStartedAt,
			})
		} catch (error) {
			if (this.isConcurrencyPressureError(error)) {
				callbacks.onConcurrencyPressure(error)
			}

			if (jobPairs.length === 1) {
				await this.handleSingleUpsertFailure(jobPairs[0], error, callbacks)
				return
			}

			const midpoint = Math.ceil(jobPairs.length / 2)
			await this.processUpsertJobPairs(jobPairs.slice(0, midpoint), signal, laneId, emitBatchProgress, callbacks)
			await this.processUpsertJobPairs(jobPairs.slice(midpoint), signal, laneId, emitBatchProgress, callbacks)
		}
	}

	private async handleSingleUpsertFailure(
		jobPair: {
			job: Awaited<ReturnType<MetadataStore["claimJobs"]>>[number]
			chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number]
		},
		error: unknown,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
		},
	): Promise<void> {
		const errorMessage = error instanceof Error ? error.message : String(error)
		if (this.shouldTerminalFail(jobPair.job.attemptCount)) {
			await this.metadataStore.markChunkState(jobPair.chunk.chunkId, "terminal_failed")
			await this.metadataStore.markJobTerminalFailed(jobPair.job.jobId, errorMessage)
			callbacks.onChunkTerminalFailure()
			return
		}

		await this.metadataStore.failJob(
			jobPair.job.jobId,
			errorMessage,
			this.getNextAttemptAt(jobPair.job.attemptCount),
		)
		callbacks.onRetryScheduled()
	}

	private async processDeleteJobs(
		jobs: Awaited<ReturnType<MetadataStore["claimJobs"]>>,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => void,
		callbacks: {
			onRetryScheduled: () => void
			onChunksDeleted: (count: number) => void
		},
	): Promise<void> {
		const chunks = await this.metadataStore.getChunksByIds(jobs.map((job) => job.entityId))
		const chunkMap = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
		const orderedPairs = jobs
			.map((job) => {
				const chunk = chunkMap.get(job.entityId)
				return chunk ? { job, chunk } : undefined
			})
			.filter((pair): pair is { job: (typeof jobs)[number]; chunk: (typeof chunks)[number] } => Boolean(pair))

		if (orderedPairs.length === 0) {
			await this.metadataStore.completeJobs(jobs.map((job) => job.jobId))
			return
		}

		await this.processDeleteJobPairs(orderedPairs, signal, laneId, emitBatchProgress, callbacks)
	}

	private async processDeleteJobPairs(
		jobPairs: Array<{
			job: Awaited<ReturnType<MetadataStore["claimJobs"]>>[number]
			chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number]
		}>,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => void,
		callbacks: {
			onRetryScheduled: () => void
			onChunksDeleted: (count: number) => void
		},
	): Promise<void> {
		if (jobPairs.length === 0) {
			return
		}

		if (signal?.aborted) {
			throw new Error("Embed/upsert worker aborted")
		}

		const variants = await this.metadataStore.getChunkVariantsByChunkIds(jobPairs.map(({ chunk }) => chunk.chunkId))
		const variantPointIds = variants
			.map((variant) => variant.vectorPointId)
			.filter((pointId): pointId is string => Boolean(pointId))
		const deletePointIds =
			variantPointIds.length > 0
				? variantPointIds
				: jobPairs
						.map(({ chunk }) => chunk.vectorPointId)
						.filter((pointId): pointId is string => Boolean(pointId))

		try {
			const batchStartedAt = Date.now()
			const idleGapMs = Math.max(batchStartedAt - this.lastBatchCompletedAt, 0)
			const upsertStartedAt = Date.now()
			await this.vectorStore.deletePointsByIds(deletePointIds)
			const upsertLatencyMs = Date.now() - upsertStartedAt

			const metadataCommitStartedAt = Date.now()
			await this.metadataStore.markChunkVariantStates(
				variants.map((variant) => ({
					variantId: variant.variantId,
					state: "deleted" as const,
					clearContent: true,
				})),
			)
			await this.metadataStore.markChunkStates(
				jobPairs.map(({ chunk }) => ({
					chunkId: chunk.chunkId,
					state: "deleted" as const,
					clearContent: true,
				})),
			)
			await this.metadataStore.completeJobs(jobPairs.map(({ job }) => job.jobId))
			const metadataCommitLatencyMs = Date.now() - metadataCommitStartedAt
			this.lastBatchCompletedAt = Date.now()
			this.completedBatchCount++

			callbacks.onChunksDeleted(deletePointIds.length)
			emitBatchProgress({
				batchKind: "delete",
				batchSize: jobPairs.length,
				embeddingCount: 0,
				laneId,
				idleGapMs,
				upsertLatencyMs,
				metadataCommitLatencyMs,
				totalLatencyMs: Date.now() - batchStartedAt,
			})
		} catch (error) {
			if (jobPairs.length === 1) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				if (this.shouldTerminalFail(jobPairs[0].job.attemptCount)) {
					await this.metadataStore.markJobTerminalFailed(jobPairs[0].job.jobId, errorMessage)
					return
				}

				await this.metadataStore.failJob(
					jobPairs[0].job.jobId,
					errorMessage,
					this.getNextAttemptAt(jobPairs[0].job.attemptCount),
				)
				callbacks.onRetryScheduled()
				return
			}

			const midpoint = Math.ceil(jobPairs.length / 2)
			await this.processDeleteJobPairs(jobPairs.slice(0, midpoint), signal, laneId, emitBatchProgress, callbacks)
			await this.processDeleteJobPairs(jobPairs.slice(midpoint), signal, laneId, emitBatchProgress, callbacks)
		}
	}

	private shouldTerminalFail(attemptCount: number): boolean {
		return attemptCount >= EmbedUpsertWorker.MAX_JOB_ATTEMPTS
	}

	private getNextAttemptAt(attemptCount: number): number {
		const delayMs = Math.min(
			EmbedUpsertWorker.RETRY_DELAY_MAX_MS,
			EmbedUpsertWorker.RETRY_DELAY_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
		)
		return Date.now() + delayMs
	}

	private isConcurrencyPressureError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
		return (
			message.includes("rate limit") ||
			message.includes("429") ||
			message.includes("timeout") ||
			message.includes("timed out") ||
			message.includes("deadline exceeded") ||
			message.includes("too many requests")
		)
	}

	private async waitForNextRetry(nextRetryAt: number, signal?: AbortSignal): Promise<void> {
		const delayMs = Math.max(nextRetryAt - Date.now(), 0)
		if (delayMs <= 0) {
			return
		}

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, delayMs)

			const onAbort = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				reject(new Error("Embed/upsert worker aborted"))
			}

			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	private createPoint(
		chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number],
		variant:
			| Awaited<ReturnType<MetadataStore["getChunkVariantsByChunkIds"]>>[number]
			| {
					variantId: string
					chunkId: string
					variantType: "raw_code"
					content: string
			  },
		vector: number[],
	): VectorPoint {
		return {
			id: this.createPointId(chunk, variant.variantType),
			vector,
			payload: {
				workspaceId: chunk.workspaceId,
				fileId: chunk.fileId,
				relativePath: chunk.relativePath,
				revisionId: chunk.revisionId,
				chunkFingerprint: chunk.chunkFingerprint,
				variantType: variant.variantType,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language ?? undefined,
				chunkKind: chunk.chunkKind ?? undefined,
				symbolName: chunk.symbolName ?? undefined,
				symbolQualifiedName: chunk.symbolQualifiedName ?? undefined,
				parentSymbolName: chunk.parentSymbolName ?? undefined,
				parentChunkFingerprint: chunk.parentChunkFingerprint ?? undefined,
				summary: chunk.summary ?? undefined,
				modelId: this.embeddingAdapter.modelId,
				parserVersion: chunk.parserVersion,
				chunkerVersion: chunk.chunkerVersion,
				codeChunk: chunk.content,
				searchText: chunk.searchText ?? undefined,
				filePath: chunk.relativePath,
				pathSegments: chunk.relativePath
					.split(/[\\/]/)
					.filter(Boolean)
					.reduce<Record<string, string>>((acc, segment, index) => {
						acc[index.toString()] = segment
						return acc
					}, {}),
			},
		}
	}

	private getChunkVariantsForEmbedding(
		chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number],
		variants: Awaited<ReturnType<MetadataStore["getChunkVariantsByChunkIds"]>>,
	): Array<
		| Awaited<ReturnType<MetadataStore["getChunkVariantsByChunkIds"]>>[number]
		| {
				variantId: string
				chunkId: string
				variantType: "raw_code"
				content: string
		  }
	> {
		if (variants.length > 0) {
			return variants
		}

		return [
			{
				variantId: `legacy:${chunk.chunkId}`,
				chunkId: chunk.chunkId,
				variantType: "raw_code",
				content: chunk.searchText || chunk.content,
			},
		]
	}

	private createPointId(
		chunk: Awaited<ReturnType<MetadataStore["getChunksByIds"]>>[number],
		variantType: "raw_code" | "summary" | "symbol_signature",
	): string {
		const seed = [
			chunk.workspaceId,
			chunk.relativePath,
			chunk.revisionId,
			chunk.parserVersion,
			chunk.chunkFingerprint,
			variantType,
		].join(":")
		const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("")
		hex[12] = "5"
		hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
		const uuid = hex.join("")
		return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`
	}
}
