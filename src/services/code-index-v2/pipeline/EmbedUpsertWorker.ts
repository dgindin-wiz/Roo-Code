import { EmbeddingAdapter } from "../adapters/EmbeddingAdapter"
import { VectorStoreAdapter } from "../adapters/VectorStoreAdapter"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { CodeIndexV2GpuSnapshot } from "../logging/log-types"
import {
	createPointId,
	executeUpsertBatch,
	getChunkVariantsForEmbedding,
	type EmbedUpsertBatchItem,
	type EmbedUpsertExecutionResult,
} from "./EmbedUpsertExecution"
import type { MetadataGateway } from "../store/MetadataGateway"
import type { EmbedWorkerPhase, PlannedRevisionResolution, ReadyRevisionResolution } from "../store/types"
import {
	getConfiguredEmbeddingBatchSize,
	getConfiguredEmbeddingLaneConcurrency,
	hasExplicitConfiguredEmbeddingBatchSize,
	hasExplicitConfiguredEmbeddingLaneConcurrency,
} from "../settings"
import { MacGpuTelemetrySampler } from "../telemetry"

type EmbedPressureState = "normal" | "soft" | "hard"
type EmbedPressureReason = "rss" | "external" | "latency" | "throughput_drop"

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
	averageSidecarRoundTripLatencyMs?: number
	averageSidecarDeliveryDelayMs?: number
	averageHostFinalizeLatencyMs?: number
	averagePressureLatencyMs?: number
	averageIdleGapMs?: number
	peakChunksPerSecond?: number
	peakBatchLatencyMs?: number
	peakIdleGapMs?: number
	peakBatchSize?: number
	peakEmbeddingCount?: number
	pressureState?: EmbedPressureState
	effectiveBatchSize?: number
	workerPhase?: EmbedWorkerPhase
	pressureReasons?: EmbedPressureReason[]
	pressureSoftTransitions?: number
	pressureHardTransitions?: number
	pressureSoftDurationMs?: number
	pressureHardDurationMs?: number
	waitingForJobsMs?: number
	waitingForInFlightCapacityMs?: number
	waitingForPressureMs?: number
	vectorWriteQueueDepth?: number
	queuedVectorWriteBatches?: number
	queuedVectorWriteEmbeddings?: number
	vectorWriteBackpressureMs?: number
	laneReleasedAfterEmbedMs?: number
	providerBatchUtilization?: number
	embeddingsPerChunk?: number
	storedVariantsPerChunk?: number
	embeddedVariantsPerChunk?: number
	storedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	embeddedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	skippedVectorizationReasons?: Record<string, number>
	laneOccupancyPercent?: number
	embedActivePercent?: number
	averageGpuUtilizationPercent?: number
	peakGpuUtilizationPercent?: number
	averageGpuInUseBytes?: number
	peakGpuInUseBytes?: number
	gpuSampleCount?: number
	activationBurstLatencyMs?: number
	readyRevisionCount?: number
	activatedChunkCount?: number
	supersededChunkCount?: number
	gpu?: CodeIndexV2GpuSnapshot | null
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
	lastSidecarRoundTripLatencyMs?: number
	lastSidecarDeliveryDelayMs?: number
	lastHostFinalizeLatencyMs?: number
	lastPressureLatencyMs?: number
	lastIdleGapMs?: number
	lastBatchLatencyMs?: number
	averageBatchLatencyMs?: number
	averageEmbedLatencyMs?: number
	averageUpsertLatencyMs?: number
	averageMetadataCommitLatencyMs?: number
	averageSidecarRoundTripLatencyMs?: number
	averageSidecarDeliveryDelayMs?: number
	averageHostFinalizeLatencyMs?: number
	averagePressureLatencyMs?: number
	averageIdleGapMs?: number
	chunksPerSecond?: number
	peakChunksPerSecond?: number
	peakBatchLatencyMs?: number
	peakIdleGapMs?: number
	peakBatchSize?: number
	peakEmbeddingCount?: number
	pressureState?: EmbedPressureState
	effectiveBatchSize?: number
	workerPhase?: EmbedWorkerPhase
	pressureReasons?: EmbedPressureReason[]
	pressureSoftTransitions?: number
	pressureHardTransitions?: number
	pressureSoftDurationMs?: number
	pressureHardDurationMs?: number
	waitingForJobsMs?: number
	waitingForInFlightCapacityMs?: number
	waitingForPressureMs?: number
	vectorWriteQueueDepth?: number
	queuedVectorWriteBatches?: number
	queuedVectorWriteEmbeddings?: number
	vectorWriteBackpressureMs?: number
	laneReleasedAfterEmbedMs?: number
	providerBatchUtilization?: number
	embeddingsPerChunk?: number
	storedVariantsPerChunk?: number
	embeddedVariantsPerChunk?: number
	storedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	embeddedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	skippedVectorizationReasons?: Record<string, number>
	laneOccupancyPercent?: number
	embedActivePercent?: number
	averageGpuUtilizationPercent?: number
	peakGpuUtilizationPercent?: number
	averageGpuInUseBytes?: number
	peakGpuInUseBytes?: number
	gpuSampleCount?: number
	activationBurstLatencyMs?: number
	readyRevisionCount?: number
	activatedChunkCount?: number
	supersededChunkCount?: number
	gpu?: CodeIndexV2GpuSnapshot | null
}

interface BatchTelemetry {
	batchKind: "upsert" | "delete"
	batchSize: number
	embeddingCount: number
	storedVariantCount?: number
	embeddedVariantCount?: number
	storedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	embeddedVariantCountsByType?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
	skippedVectorizationReasons?: Record<string, number>
	laneId: number
	idleGapMs?: number
	embedLatencyMs?: number
	upsertLatencyMs?: number
	metadataCommitLatencyMs?: number
	sidecarRoundTripLatencyMs?: number
	sidecarDeliveryDelayMs?: number
	hostFinalizeLatencyMs?: number
	pressureLatencyMs?: number
	vectorWriteQueueDepth?: number
	queuedVectorWriteBatches?: number
	queuedVectorWriteEmbeddings?: number
	vectorWriteBackpressureMs?: number
	laneReleasedAfterEmbedMs?: number
	totalLatencyMs: number
}

interface EmbedUpsertEmbeddedEvent {
	embeddingCount: number
	embedLatencyMs: number
	pointIds: string[]
	sidecarRoundTripLatencyMs?: number
	sidecarDeliveryDelayMs?: number
	vectorWriteQueueDepth?: number
	queuedVectorWriteBatches?: number
	queuedVectorWriteEmbeddings?: number
	vectorWriteBackpressureMs?: number
	laneReleasedAfterEmbedMs?: number
}

interface EmbedUpsertExecutor {
	executeUpsertBatch(
		runId: string,
		laneId: number,
		items: EmbedUpsertBatchItem[],
		signal?: AbortSignal,
		options?: {
			onEmbedded?: (event: EmbedUpsertEmbeddedEvent) => void
		},
	): Promise<EmbedUpsertExecutionResult>
	recycleClients?(reason: "pressure" | "interval" | "shutdown"): Promise<void>
	dispose?(): Promise<void>
}

type ClaimedJobs = Awaited<ReturnType<MetadataGateway["claimJobs"]>>
type ClaimedJob = ClaimedJobs[number]
type ChunkRecord = Awaited<ReturnType<MetadataGateway["getChunksByIds"]>>[number]
type ChunkVariantRecord = Awaited<ReturnType<MetadataGateway["getChunkVariantsByChunkIds"]>>[number]

function incrementVariantCountMap(
	target: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>,
	source?: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>,
) {
	if (!source) {
		return
	}
	for (const [variantType, count] of Object.entries(source) as Array<
		["raw_code" | "summary" | "symbol_signature", number | undefined]
	>) {
		if (!count) {
			continue
		}
		target[variantType] = (target[variantType] ?? 0) + count
	}
}

function incrementReasonCountMap(target: Record<string, number>, source?: Record<string, number>) {
	if (!source) {
		return
	}
	for (const [reason, count] of Object.entries(source)) {
		if (!count) {
			continue
		}
		target[reason] = (target[reason] ?? 0) + count
	}
}

export class EmbedUpsertWorker {
	private static readonly MAX_JOB_ATTEMPTS = 3
	private static readonly RETRY_DELAY_BASE_MS = 1_000
	private static readonly RETRY_DELAY_MAX_MS = 30_000
	private static readonly MAX_LANE_CONCURRENCY = 3
	private static readonly RECYCLE_DRAIN_TIMEOUT_MS = 15_000
	private static readonly LOCAL_DEFAULT_BATCH_SIZE = 30
	private static readonly LOCAL_DEFAULT_LANE_CONCURRENCY = 1
	private static readonly V2_CLIENT_RECYCLE_INTERVAL = 10
	private static readonly SOFT_PRESSURE_RSS_MB = 1600
	private static readonly SOFT_PRESSURE_EXTERNAL_MB = 800
	private static readonly HARD_PRESSURE_RSS_MB = 1850
	private static readonly HARD_PRESSURE_EXTERNAL_MB = 950
	private static readonly SOFT_PRESSURE_BATCH_LATENCY_MS = 4000
	private static readonly HARD_PRESSURE_BATCH_LATENCY_MS = 5500
	private static readonly HEARTBEAT_INTERVAL_MS = 5000
	private static readonly THROUGHPUT_DROP_RATIO = 0.7
	private static readonly HARD_PRESSURE_BATCH_SIZE = 20
	private static readonly SOFT_PRESSURE_MAX_IN_FLIGHT_CHUNKS = 200
	private static readonly HARD_PRESSURE_MAX_IN_FLIGHT_CHUNKS = 40
	private static readonly WAIT_ACCUMULATION_MS = 250
	private static readonly JOB_HEARTBEAT_INTERVAL_MS = 10_000
	private static readonly ACTIVATION_BURST_LIMIT = 32
	private static readonly LOCAL_LANE_RAMP_GPU_TARGET_PERCENT = 82
	private static readonly LOCAL_LANE_RAMP_REQUIRED_WINDOWS = 3
	private static readonly LOCAL_LANE_RAMP_COOLDOWN_WINDOWS = 2
	private static readonly LOCAL_LANE_RAMP_EXTERNAL_DELTA_MB = 96
	private static readonly LOCAL_LANE_RAMP_EXTERNAL_HEADROOM_MB = 120
	private static readonly LOCAL_LANE_RAMP_WRITE_TAIL_MS = 250
	private static readonly LOCAL_LANE_RAMP_MAX_WRITE_LATENCY_MS = 750
	private static readonly LOCAL_LANE_RAMP_MAX_METADATA_COMMIT_LATENCY_MS = 750
	private readonly batchSize: number
	private readonly laneConcurrency: number
	private readonly laneConcurrencyCap: number
	private readonly dynamicLocalLaneRampEnabled: boolean
	private lastBatchCompletedAt = 0
	private activeLaneCount = 0
	private inFlightChunkCount = 0
	private peakInFlightChunkCount = 0
	private completedBatchCount = 0
	private workerPhase: EmbedWorkerPhase = "idle"
	private readonly leaseOwner = `embed-worker:${process.pid}:${Math.random().toString(16).slice(2)}`
	private readonly workspacePath: string | undefined

	constructor(
		private readonly metadataStore: MetadataGateway,
		private readonly embeddingAdapter: EmbeddingAdapter,
		private readonly vectorStore: VectorStoreAdapter,
		private readonly upsertExecutor?: EmbedUpsertExecutor,
		workspacePath?: string,
	) {
		this.workspacePath = workspacePath
		const configuredBatchSize = getConfiguredEmbeddingBatchSize()
		const configuredLaneConcurrency = getConfiguredEmbeddingLaneConcurrency()
		const recommendedBatchSize = this.embeddingAdapter.getRecommendedDocumentBatchSize?.()
		const useLocalBatchDefault =
			this.embeddingAdapter.runtimeKind === "local" &&
			!hasExplicitConfiguredEmbeddingBatchSize() &&
			recommendedBatchSize == null
		const useLocalLaneDefault =
			this.embeddingAdapter.runtimeKind === "local" && !hasExplicitConfiguredEmbeddingLaneConcurrency()
		this.batchSize =
			!hasExplicitConfiguredEmbeddingBatchSize() && recommendedBatchSize != null
				? Math.max(1, Math.min(configuredBatchSize, recommendedBatchSize))
				: useLocalBatchDefault
					? EmbedUpsertWorker.LOCAL_DEFAULT_BATCH_SIZE
					: configuredBatchSize
		this.dynamicLocalLaneRampEnabled = useLocalLaneDefault
		this.laneConcurrency = Math.max(
			1,
			Math.min(
				EmbedUpsertWorker.MAX_LANE_CONCURRENCY,
				useLocalLaneDefault ? EmbedUpsertWorker.LOCAL_DEFAULT_LANE_CONCURRENCY : configuredLaneConcurrency,
			),
		)
		this.laneConcurrencyCap = Math.max(
			1,
			Math.min(
				EmbedUpsertWorker.MAX_LANE_CONCURRENCY,
				useLocalLaneDefault ? EmbedUpsertWorker.MAX_LANE_CONCURRENCY : configuredLaneConcurrency,
			),
		)
	}

	async dispose(): Promise<void> {
		await this.upsertExecutor?.dispose?.()
	}

	private setWorkerPhase(nextPhase: EmbedWorkerPhase) {
		this.workerPhase = nextPhase
	}

	private static getMaxInFlightChunks(
		pressureState: EmbedPressureState,
		effectiveLaneConcurrency: number,
		effectiveBatchSize: number,
	): number {
		if (pressureState === "hard") {
			return Math.max(
				effectiveBatchSize,
				Math.min(
					EmbedUpsertWorker.HARD_PRESSURE_MAX_IN_FLIGHT_CHUNKS,
					effectiveBatchSize * effectiveLaneConcurrency,
				),
			)
		}

		if (pressureState === "soft") {
			return Math.max(
				effectiveBatchSize,
				Math.min(
					EmbedUpsertWorker.SOFT_PRESSURE_MAX_IN_FLIGHT_CHUNKS,
					effectiveBatchSize * effectiveLaneConcurrency,
				),
			)
		}

		return Number.POSITIVE_INFINITY
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
		let totalSidecarRoundTripLatencyMs = 0
		let totalSidecarDeliveryDelayMs = 0
		let totalHostFinalizeLatencyMs = 0
		let totalPressureLatencyMs = 0
		let totalIdleGapMs = 0
		let totalEmbeddingCount = 0
		let totalRequestedChunkCount = 0
		let totalStoredVariantCount = 0
		let totalEmbeddedVariantCount = 0
		const totalStoredVariantCountsByType: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>> = {}
		const totalEmbeddedVariantCountsByType: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>> =
			{}
		const totalSkippedVectorizationReasons: Record<string, number> = {}
		let peakChunksPerSecond = 0
		let peakBatchLatencyMs = 0
		let peakIdleGapMs = 0
		let peakBatchSize = 0
		let peakEmbeddingCount = 0
		let effectiveLaneConcurrency = this.laneConcurrency
		let effectiveBatchSize = this.batchSize
		let pressureState: EmbedPressureState = "normal"
		let pressureTriggeredRecyclePending = false
		let lastHeartbeatAt = 0
		let throughputDropStreak = 0
		let totalWaitingForJobsMs = 0
		let totalWaitingForInFlightCapacityMs = 0
		let totalWaitingForPressureMs = 0
		let totalVectorWriteBackpressureMs = 0
		let latestVectorWriteQueueDepth: number | undefined
		let latestQueuedVectorWriteBatches: number | undefined
		let latestQueuedVectorWriteEmbeddings: number | undefined
		let latestLaneReleasedAfterEmbedMs: number | undefined
		let latestPressureReasons: EmbedPressureReason[] = []
		let pressureSoftTransitions = 0
		let pressureHardTransitions = 0
		let pressureSoftDurationMs = 0
		let pressureHardDurationMs = 0
		let lastPressureDurationAt = 0
		let latestGpuSample: CodeIndexV2GpuSnapshot | null = null
		let gpuSampleCount = 0
		let totalGpuUtilizationPercent = 0
		let peakGpuUtilizationPercent = 0
		let totalGpuInUseBytes = 0
		let peakGpuInUseBytes = 0
		let activationBurstLatencyMs: number | undefined
		let readyRevisionCount: number | undefined
		let activatedChunkCount: number | undefined
		let supersededChunkCount: number | undefined
		let localLaneRampHeadroomWindows = 0
		let localLaneRampCooldownWindows = 0
		let lastLaneRampExternalMB: number | undefined
		let laneRampHardCapLogged = false
		let laneRampPressureBackoffLogged = false
		let laneRampLatencyBackoffLogged = false
		const gpuSampler = this.embeddingAdapter.runtimeKind === "local" ? new MacGpuTelemetrySampler() : undefined
		const recentBatchLatencies: number[] = []
		const recentUpsertLatencies: number[] = []
		const recentMetadataCommitLatencies: number[] = []
		const recentWriteTailLatencies: number[] = []
		const workerStartedAt = Date.now()
		lastPressureDurationAt = workerStartedAt
		this.lastBatchCompletedAt = workerStartedAt
		this.activeLaneCount = 0
		this.inFlightChunkCount = 0
		this.peakInFlightChunkCount = 0
		this.completedBatchCount = 0
		this.workerPhase = "idle"

		const recordRecentLatency = (target: number[], latencyMs: number | undefined) => {
			if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
				return
			}
			target.push(latencyMs)
			if (target.length > 4) {
				target.shift()
			}
		}

		const averageRecentLatency = (values: number[]) =>
			values.length > 0 ? values.reduce((sum, latency) => sum + latency, 0) / values.length : 0

		const updatePressureDurations = (now = Date.now()) => {
			const elapsed = Math.max(now - lastPressureDurationAt, 0)
			if (pressureState === "soft") {
				pressureSoftDurationMs += elapsed
			} else if (pressureState === "hard") {
				pressureHardDurationMs += elapsed
			}
			lastPressureDurationAt = now
		}

		const recordGpuSample = (sample: CodeIndexV2GpuSnapshot | null | undefined) => {
			if (!sample) {
				return
			}
			if (typeof sample.utilizationPercent === "number" && Number.isFinite(sample.utilizationPercent)) {
				gpuSampleCount += 1
				totalGpuUtilizationPercent += sample.utilizationPercent
				peakGpuUtilizationPercent = Math.max(peakGpuUtilizationPercent, sample.utilizationPercent)
			}
			if (typeof sample.inUseBytes === "number" && Number.isFinite(sample.inUseBytes)) {
				totalGpuInUseBytes += sample.inUseBytes
				peakGpuInUseBytes = Math.max(peakGpuInUseBytes, sample.inUseBytes)
			}
		}

		const computeWorkerUtilizationMetrics = () => {
			const elapsedMs = Math.max(Date.now() - workerStartedAt, 1)
			const embeddingsPerChunk =
				totalRequestedChunkCount > 0
					? Number((totalEmbeddingCount / totalRequestedChunkCount).toFixed(3))
					: undefined
			const storedVariantsPerChunk =
				totalRequestedChunkCount > 0
					? Number((totalStoredVariantCount / totalRequestedChunkCount).toFixed(3))
					: undefined
			const embeddedVariantsPerChunk =
				totalRequestedChunkCount > 0
					? Number((totalEmbeddedVariantCount / totalRequestedChunkCount).toFixed(3))
					: undefined
			const laneOccupancyPercent = Number(
				Math.min(
					100,
					(totalBatchLatencyMs / Math.max(elapsedMs * Math.max(effectiveLaneConcurrency, 1), 1)) * 100,
				).toFixed(1),
			)
			const waitingTotalMs = totalWaitingForJobsMs + totalWaitingForInFlightCapacityMs + totalWaitingForPressureMs
			const embedActivePercent = Number(
				Math.max(0, Math.min(100, ((elapsedMs - waitingTotalMs) / elapsedMs) * 100)).toFixed(1),
			)
			return {
				embeddingsPerChunk,
				storedVariantsPerChunk,
				embeddedVariantsPerChunk,
				storedVariantCountsByType: { ...totalStoredVariantCountsByType },
				embeddedVariantCountsByType: { ...totalEmbeddedVariantCountsByType },
				skippedVectorizationReasons: { ...totalSkippedVectorizationReasons },
				laneOccupancyPercent,
				embedActivePercent,
				averageGpuUtilizationPercent:
					gpuSampleCount > 0 ? Number((totalGpuUtilizationPercent / gpuSampleCount).toFixed(1)) : undefined,
				peakGpuUtilizationPercent:
					peakGpuUtilizationPercent > 0 ? Number(peakGpuUtilizationPercent.toFixed(1)) : undefined,
				averageGpuInUseBytes: gpuSampleCount > 0 ? Math.round(totalGpuInUseBytes / gpuSampleCount) : undefined,
				peakGpuInUseBytes: peakGpuInUseBytes > 0 ? peakGpuInUseBytes : undefined,
				gpuSampleCount: gpuSampleCount > 0 ? gpuSampleCount : undefined,
			}
		}

		const updatePressureState = (
			batchTelemetry?: BatchTelemetry,
		): {
			previousState: EmbedPressureState
			currentState: EmbedPressureState
			memory: ReturnType<typeof IndexDebugLoggerV2.getMemorySnapshot>
			reasons: EmbedPressureReason[]
			hardMemoryPressure: boolean
			softMemoryPressure: boolean
		} => {
			const memory = IndexDebugLoggerV2.getMemorySnapshot()
			const pressureLatencyMs = batchTelemetry?.pressureLatencyMs ?? batchTelemetry?.totalLatencyMs
			recordRecentLatency(recentBatchLatencies, pressureLatencyMs)
			recordRecentLatency(recentUpsertLatencies, batchTelemetry?.upsertLatencyMs)
			recordRecentLatency(recentMetadataCommitLatencies, batchTelemetry?.metadataCommitLatencyMs)
			const writeTailLatencyMs =
				(batchTelemetry?.upsertLatencyMs ?? 0) +
				(batchTelemetry?.metadataCommitLatencyMs ?? 0) +
				(batchTelemetry?.sidecarDeliveryDelayMs ?? 0) +
				(batchTelemetry?.hostFinalizeLatencyMs ?? 0)
			recordRecentLatency(recentWriteTailLatencies, writeTailLatencyMs > 0 ? writeTailLatencyMs : undefined)
			const averagePressureLatency = averageRecentLatency(recentBatchLatencies)
			const { laneOccupancyPercent } = computeWorkerUtilizationMetrics()
			const previousState = pressureState
			const reasons: EmbedPressureReason[] = []
			const hardMemoryPressure =
				memory.rssMB >= EmbedUpsertWorker.HARD_PRESSURE_RSS_MB ||
				memory.externalMB >= EmbedUpsertWorker.HARD_PRESSURE_EXTERNAL_MB
			const softMemoryPressure =
				hardMemoryPressure ||
				memory.rssMB >= EmbedUpsertWorker.SOFT_PRESSURE_RSS_MB ||
				memory.externalMB >= EmbedUpsertWorker.SOFT_PRESSURE_EXTERNAL_MB
			const latencyPressure = averagePressureLatency >= EmbedUpsertWorker.SOFT_PRESSURE_BATCH_LATENCY_MS
			const hardLatencyPressure = averagePressureLatency >= EmbedUpsertWorker.HARD_PRESSURE_BATCH_LATENCY_MS
			const hasActiveEmbedWork =
				this.inFlightChunkCount > 0 ||
				this.activeLaneCount > 0 ||
				Boolean(batchTelemetry && batchTelemetry.batchSize > 0)
			const wellFed = hasActiveEmbedWork && laneOccupancyPercent >= 65
			const throughputPressure =
				peakChunksPerSecond > 0 &&
				(batchesCompleted >= 2 || this.completedBatchCount >= 2) &&
				wellFed &&
				(upsertedChunks + deletedChunks > 0
					? (upsertedChunks + deletedChunks) / (Math.max(Date.now() - workerStartedAt, 1) / 1000)
					: 0) <=
					peakChunksPerSecond * EmbedUpsertWorker.THROUGHPUT_DROP_RATIO
			if (memory.rssMB >= EmbedUpsertWorker.SOFT_PRESSURE_RSS_MB) {
				reasons.push("rss")
			}
			if (memory.externalMB >= EmbedUpsertWorker.SOFT_PRESSURE_EXTERNAL_MB) {
				reasons.push("external")
			}
			if (latencyPressure) {
				reasons.push("latency")
			}
			if (throughputPressure) {
				reasons.push("throughput_drop")
			}

			const hardPressure = hardMemoryPressure || (hardLatencyPressure && throughputPressure)
			const softPressure = softMemoryPressure || (latencyPressure && throughputPressure)

			if (hardPressure) {
				updatePressureDurations()
				pressureState = "hard"
			} else if (softPressure) {
				updatePressureDurations()
				pressureState = "soft"
			} else if (
				memory.rssMB < EmbedUpsertWorker.SOFT_PRESSURE_RSS_MB - 100 &&
				memory.externalMB < EmbedUpsertWorker.SOFT_PRESSURE_EXTERNAL_MB - 100 &&
				averagePressureLatency < EmbedUpsertWorker.SOFT_PRESSURE_BATCH_LATENCY_MS * 0.85
			) {
				updatePressureDurations()
				pressureState = "normal"
			}
			if (previousState !== pressureState) {
				if (pressureState === "soft") {
					pressureSoftTransitions++
				}
				if (pressureState === "hard") {
					pressureHardTransitions++
				}
			}
			latestPressureReasons = reasons

			if (pressureState === "hard") {
				effectiveLaneConcurrency = hardMemoryPressure
					? 1
					: Math.max(1, Math.min(effectiveLaneConcurrency, this.laneConcurrencyCap))
				effectiveBatchSize = Math.max(
					1,
					Math.min(
						this.batchSize,
						hardMemoryPressure
							? EmbedUpsertWorker.HARD_PRESSURE_BATCH_SIZE
							: Math.floor(this.batchSize * (this.embeddingAdapter.runtimeKind === "local" ? 0.8 : 0.75)),
					),
				)
				pressureTriggeredRecyclePending = hardMemoryPressure
			} else if (pressureState === "soft") {
				effectiveBatchSize = Math.max(
					1,
					Math.min(
						this.batchSize,
						Math.floor(
							this.batchSize *
								(softMemoryPressure
									? 0.75
									: this.embeddingAdapter.runtimeKind === "local"
										? 0.9
										: 0.85),
						),
					),
				)
				pressureTriggeredRecyclePending = softMemoryPressure
			} else {
				effectiveBatchSize = this.batchSize
				effectiveLaneConcurrency = Math.max(1, Math.min(effectiveLaneConcurrency, this.laneConcurrencyCap))
			}

			return {
				previousState,
				currentState: pressureState,
				memory,
				reasons,
				hardMemoryPressure,
				softMemoryPressure,
			}
		}

		const maybeLogHeartbeat = async (
			chunksPerSecond: number | undefined,
			averageBatchLatencyMs: number | undefined,
			averagePressureLatencyMs: number | undefined,
			averageHostFinalizeLatencyMs: number | undefined,
			averageSidecarDeliveryDelayMs: number | undefined,
			memory: ReturnType<typeof IndexDebugLoggerV2.getMemorySnapshot>,
			options: {
				hardMemoryPressure: boolean
				softMemoryPressure: boolean
			},
			force = false,
		) => {
			const now = Date.now()
			if (!force && now - lastHeartbeatAt < EmbedUpsertWorker.HEARTBEAT_INTERVAL_MS) {
				return
			}
			lastHeartbeatAt = now
			latestGpuSample = gpuSampler ? await gpuSampler.sample(force) : null
			recordGpuSample(latestGpuSample)
			maybeAdjustLocalLaneConcurrency(memory, options)
			const utilizationMetrics = computeWorkerUtilizationMetrics()
			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-heartbeat", {
				component: "EmbedUpsertWorker",
				runId,
				workspacePath: this.workspacePath,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				workerPhase: this.workerPhase,
				laneConcurrency: effectiveLaneConcurrency,
				activeLaneCount: this.activeLaneCount,
				inFlightChunkCount: this.inFlightChunkCount,
				peakInFlightChunkCount: this.peakInFlightChunkCount,
				effectiveBatchSize,
				chunksPerSecond,
				averageBatchLatencyMs,
				averagePressureLatencyMs,
				averageHostFinalizeLatencyMs,
				averageSidecarDeliveryDelayMs,
				pressureState,
				pressureReasons: latestPressureReasons,
				rssMB: memory.rssMB,
				heapUsedMB: memory.heapUsedMB,
				externalMB: memory.externalMB,
				waitingForJobsMs: totalWaitingForJobsMs,
				waitingForInFlightCapacityMs: totalWaitingForInFlightCapacityMs,
				waitingForPressureMs: totalWaitingForPressureMs,
				embeddingsPerChunk: utilizationMetrics.embeddingsPerChunk,
				laneOccupancyPercent: utilizationMetrics.laneOccupancyPercent,
				embedActivePercent: utilizationMetrics.embedActivePercent,
				gpu: latestGpuSample,
			})
		}

		const maybeAdjustLocalLaneConcurrency = (
			memory: ReturnType<typeof IndexDebugLoggerV2.getMemorySnapshot>,
			options: {
				hardMemoryPressure: boolean
				softMemoryPressure: boolean
			},
		) => {
			const externalDeltaMB = lastLaneRampExternalMB != null ? memory.externalMB - lastLaneRampExternalMB : 0
			const hasStableExternalMemory =
				lastLaneRampExternalMB == null || externalDeltaMB < EmbedUpsertWorker.LOCAL_LANE_RAMP_EXTERNAL_DELTA_MB
			const hasExternalHeadroom =
				memory.externalMB <=
				EmbedUpsertWorker.SOFT_PRESSURE_EXTERNAL_MB - EmbedUpsertWorker.LOCAL_LANE_RAMP_EXTERNAL_HEADROOM_MB
			const gpuUtilizationPercent = latestGpuSample?.utilizationPercent
			const hasGpuHeadroom =
				typeof gpuUtilizationPercent === "number" &&
				Number.isFinite(gpuUtilizationPercent) &&
				gpuUtilizationPercent < EmbedUpsertWorker.LOCAL_LANE_RAMP_GPU_TARGET_PERCENT
			const enoughQueuedWork =
				this.activeLaneCount >= effectiveLaneConcurrency &&
				this.inFlightChunkCount >= Math.max(effectiveBatchSize, effectiveLaneConcurrency * effectiveBatchSize)
			const averageUpsertLatencyMs = averageRecentLatency(recentUpsertLatencies)
			const averageMetadataCommitLatencyMs = averageRecentLatency(recentMetadataCommitLatencies)
			const averageWriteTailLatencyMs = averageRecentLatency(recentWriteTailLatencies)
			const utilizationMetrics = computeWorkerUtilizationMetrics()
			const writeTailGap =
				averageWriteTailLatencyMs >= EmbedUpsertWorker.LOCAL_LANE_RAMP_WRITE_TAIL_MS &&
				utilizationMetrics.embedActivePercent < 95
			const rampSignals = [
				hasGpuHeadroom ? "gpu-headroom" : undefined,
				writeTailGap ? "write-tail-gap" : undefined,
			].filter((signal): signal is string => Boolean(signal))
			const hasRampSignal = rampSignals.length > 0
			const writeLatencyHealthy =
				averageUpsertLatencyMs === 0 ||
				averageUpsertLatencyMs <= EmbedUpsertWorker.LOCAL_LANE_RAMP_MAX_WRITE_LATENCY_MS
			const metadataCommitLatencyHealthy =
				averageMetadataCommitLatencyMs === 0 ||
				averageMetadataCommitLatencyMs <= EmbedUpsertWorker.LOCAL_LANE_RAMP_MAX_METADATA_COMMIT_LATENCY_MS
			const hasRetryOrFailureSignals =
				retryingChunks > 0 || terminallyFailedChunks > 0 || degradedRevisions > 0 || terminalFailedRevisions > 0
			const logLaneRampDecision = (message: string, reason: string) => {
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", message, {
					component: "EmbedUpsertWorker",
					runId,
					workspacePath: this.workspacePath,
					provider: this.embeddingAdapter.provider,
					modelId: this.embeddingAdapter.modelId,
					laneConcurrency: effectiveLaneConcurrency,
					laneConcurrencyCap: this.laneConcurrencyCap,
					reason,
					rampSignals,
					pressureState,
					activeLaneCount: this.activeLaneCount,
					inFlightChunkCount: this.inFlightChunkCount,
					effectiveBatchSize,
					averageUpsertLatencyMs,
					averageMetadataCommitLatencyMs,
					averageWriteTailLatencyMs,
					externalMB: memory.externalMB,
					rssMB: memory.rssMB,
					gpuUtilizationPercent,
				})
			}

			if (!this.dynamicLocalLaneRampEnabled) {
				if (
					this.embeddingAdapter.runtimeKind === "local" &&
					!laneRampHardCapLogged &&
					hasRampSignal &&
					enoughQueuedWork
				) {
					laneRampHardCapLogged = true
					logLaneRampDecision("embed-upsert-lane-ramp-blocked", "hard-cap")
				}
				lastLaneRampExternalMB = memory.externalMB
				return
			}

			if (options.hardMemoryPressure) {
				localLaneRampHeadroomWindows = 0
				localLaneRampCooldownWindows = EmbedUpsertWorker.LOCAL_LANE_RAMP_COOLDOWN_WINDOWS
				if (effectiveLaneConcurrency > 1) {
					const previousLaneConcurrency = effectiveLaneConcurrency
					effectiveLaneConcurrency = 1
					IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-lane-ramped", {
						component: "EmbedUpsertWorker",
						runId,
						workspacePath: this.workspacePath,
						provider: this.embeddingAdapter.provider,
						modelId: this.embeddingAdapter.modelId,
						previousLaneConcurrency,
						laneConcurrency: effectiveLaneConcurrency,
						reason: "hard-memory-pressure",
						externalMB: memory.externalMB,
						rssMB: memory.rssMB,
						gpuUtilizationPercent,
					})
				}
				lastLaneRampExternalMB = memory.externalMB
				return
			}

			if (options.softMemoryPressure) {
				localLaneRampHeadroomWindows = 0
				localLaneRampCooldownWindows = EmbedUpsertWorker.LOCAL_LANE_RAMP_COOLDOWN_WINDOWS
				if (!laneRampPressureBackoffLogged && hasRampSignal && enoughQueuedWork) {
					laneRampPressureBackoffLogged = true
					logLaneRampDecision("embed-upsert-lane-ramp-blocked", "pressure-backoff")
				}
				lastLaneRampExternalMB = memory.externalMB
				return
			}

			if (localLaneRampCooldownWindows > 0) {
				localLaneRampCooldownWindows--
				localLaneRampHeadroomWindows = 0
				lastLaneRampExternalMB = memory.externalMB
				return
			}

			if (
				pressureState === "normal" &&
				hasRampSignal &&
				hasExternalHeadroom &&
				hasStableExternalMemory &&
				enoughQueuedWork &&
				writeLatencyHealthy &&
				metadataCommitLatencyHealthy &&
				!hasRetryOrFailureSignals &&
				effectiveLaneConcurrency < this.laneConcurrencyCap
			) {
				localLaneRampHeadroomWindows++
				if (localLaneRampHeadroomWindows >= EmbedUpsertWorker.LOCAL_LANE_RAMP_REQUIRED_WINDOWS) {
					const previousLaneConcurrency = effectiveLaneConcurrency
					effectiveLaneConcurrency = Math.min(this.laneConcurrencyCap, effectiveLaneConcurrency + 1)
					localLaneRampHeadroomWindows = 0
					localLaneRampCooldownWindows = EmbedUpsertWorker.LOCAL_LANE_RAMP_COOLDOWN_WINDOWS
					IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-lane-ramped", {
						component: "EmbedUpsertWorker",
						runId,
						workspacePath: this.workspacePath,
						provider: this.embeddingAdapter.provider,
						modelId: this.embeddingAdapter.modelId,
						previousLaneConcurrency,
						laneConcurrency: effectiveLaneConcurrency,
						reason: rampSignals[0] ?? "gpu-headroom",
						rampSignals,
						externalMB: memory.externalMB,
						rssMB: memory.rssMB,
						averageUpsertLatencyMs,
						averageMetadataCommitLatencyMs,
						averageWriteTailLatencyMs,
						gpuUtilizationPercent,
					})
				}
			} else {
				if (
					hasRampSignal &&
					enoughQueuedWork &&
					effectiveLaneConcurrency >= this.laneConcurrencyCap &&
					!laneRampHardCapLogged
				) {
					laneRampHardCapLogged = true
					logLaneRampDecision("embed-upsert-lane-ramp-blocked", "hard-cap")
				} else if (
					hasRampSignal &&
					enoughQueuedWork &&
					pressureState !== "normal" &&
					!laneRampPressureBackoffLogged
				) {
					laneRampPressureBackoffLogged = true
					logLaneRampDecision("embed-upsert-lane-ramp-blocked", "pressure-backoff")
				} else if (
					hasRampSignal &&
					enoughQueuedWork &&
					(!writeLatencyHealthy || !metadataCommitLatencyHealthy || hasRetryOrFailureSignals) &&
					!laneRampLatencyBackoffLogged
				) {
					laneRampLatencyBackoffLogged = true
					logLaneRampDecision("embed-upsert-lane-ramp-blocked", "latency-or-retry-backoff")
				}
				localLaneRampHeadroomWindows = 0
			}

			lastLaneRampExternalMB = memory.externalMB
		}

		const emitProgress = async (batchTelemetry?: BatchTelemetry) => {
			if (batchTelemetry && batchTelemetry.batchSize > 0) {
				batchesCompleted++
				totalBatchLatencyMs += batchTelemetry.totalLatencyMs
				totalEmbedLatencyMs += batchTelemetry.embedLatencyMs ?? 0
				totalUpsertLatencyMs += batchTelemetry.upsertLatencyMs ?? 0
				totalMetadataCommitLatencyMs += batchTelemetry.metadataCommitLatencyMs ?? 0
				totalSidecarRoundTripLatencyMs += batchTelemetry.sidecarRoundTripLatencyMs ?? 0
				totalSidecarDeliveryDelayMs += batchTelemetry.sidecarDeliveryDelayMs ?? 0
				totalHostFinalizeLatencyMs += batchTelemetry.hostFinalizeLatencyMs ?? 0
				totalPressureLatencyMs += batchTelemetry.pressureLatencyMs ?? 0
				totalIdleGapMs += batchTelemetry.idleGapMs ?? 0
				totalVectorWriteBackpressureMs += batchTelemetry.vectorWriteBackpressureMs ?? 0
				latestVectorWriteQueueDepth = batchTelemetry.vectorWriteQueueDepth
				latestQueuedVectorWriteBatches = batchTelemetry.queuedVectorWriteBatches
				latestQueuedVectorWriteEmbeddings = batchTelemetry.queuedVectorWriteEmbeddings
				latestLaneReleasedAfterEmbedMs = batchTelemetry.laneReleasedAfterEmbedMs
				totalEmbeddingCount += batchTelemetry.embeddingCount
				totalRequestedChunkCount += batchTelemetry.batchSize
				totalStoredVariantCount += batchTelemetry.storedVariantCount ?? 0
				totalEmbeddedVariantCount += batchTelemetry.embeddedVariantCount ?? batchTelemetry.embeddingCount
				incrementVariantCountMap(totalStoredVariantCountsByType, batchTelemetry.storedVariantCountsByType)
				incrementVariantCountMap(totalEmbeddedVariantCountsByType, batchTelemetry.embeddedVariantCountsByType)
				incrementReasonCountMap(totalSkippedVectorizationReasons, batchTelemetry.skippedVectorizationReasons)
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
			const averageBatchLatencyMs = batchesCompleted > 0 ? totalBatchLatencyMs / batchesCompleted : undefined
			const averageSidecarRoundTripLatencyMs =
				batchesCompleted > 0 ? totalSidecarRoundTripLatencyMs / batchesCompleted : undefined
			const averageSidecarDeliveryDelayMs =
				batchesCompleted > 0 ? totalSidecarDeliveryDelayMs / batchesCompleted : undefined
			const averageHostFinalizeLatencyMs =
				batchesCompleted > 0 ? totalHostFinalizeLatencyMs / batchesCompleted : undefined
			const averagePressureLatencyMs =
				batchesCompleted > 0 ? totalPressureLatencyMs / batchesCompleted : undefined
			const providerBatchUtilization =
				batchTelemetry && batchTelemetry.embeddingCount > 0
					? Number((batchTelemetry.embeddingCount / Math.max(batchTelemetry.batchSize, 1)).toFixed(3))
					: undefined
			const utilizationMetrics = computeWorkerUtilizationMetrics()
			const { previousState, currentState, memory, reasons, hardMemoryPressure, softMemoryPressure } =
				updatePressureState(batchTelemetry)
			if (previousState !== currentState) {
				latestGpuSample = gpuSampler ? await gpuSampler.sample(true) : latestGpuSample
				recordGpuSample(latestGpuSample)
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-pressure-state-changed", {
					component: "EmbedUpsertWorker",
					runId,
					workspacePath: this.workspacePath,
					provider: this.embeddingAdapter.provider,
					modelId: this.embeddingAdapter.modelId,
					previousPressureState: previousState,
					pressureState: currentState,
					pressureReasons: reasons,
					laneConcurrency: effectiveLaneConcurrency,
					effectiveBatchSize,
					activeLaneCount: this.activeLaneCount,
					inFlightChunkCount: this.inFlightChunkCount,
					peakInFlightChunkCount: this.peakInFlightChunkCount,
					chunksPerSecond,
					averageBatchLatencyMs,
					averagePressureLatencyMs,
					rssMB: memory.rssMB,
					heapUsedMB: memory.heapUsedMB,
					externalMB: memory.externalMB,
					gpu: latestGpuSample,
				})
			}
			if (
				chunksPerSecond !== undefined &&
				peakChunksPerSecond > 0 &&
				utilizationMetrics.laneOccupancyPercent >= 65 &&
				chunksPerSecond <= peakChunksPerSecond * EmbedUpsertWorker.THROUGHPUT_DROP_RATIO
			) {
				throughputDropStreak++
				if (throughputDropStreak >= 2) {
					IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-throughput-drop", {
						component: "EmbedUpsertWorker",
						runId,
						workspacePath: this.workspacePath,
						provider: this.embeddingAdapter.provider,
						modelId: this.embeddingAdapter.modelId,
						chunksPerSecond,
						peakChunksPerSecond,
						averageBatchLatencyMs,
						averagePressureLatencyMs,
						pressureState,
						laneConcurrency: effectiveLaneConcurrency,
						effectiveBatchSize,
					})
					throughputDropStreak = 0
				}
			} else {
				throughputDropStreak = 0
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
				effectiveBatchSize,
				workerPhase: this.workerPhase,
				pressureState,
				pressureReasons: reasons,
				pressureSoftTransitions,
				pressureHardTransitions,
				pressureSoftDurationMs,
				pressureHardDurationMs,
				activeLaneCount: this.activeLaneCount,
				inFlightChunkCount: this.inFlightChunkCount,
				peakInFlightChunkCount: this.peakInFlightChunkCount,
				lastBatchSize: batchTelemetry?.batchSize,
				lastEmbeddingCount: batchTelemetry?.embeddingCount,
				lastEmbedLatencyMs: batchTelemetry?.embedLatencyMs,
				lastUpsertLatencyMs: batchTelemetry?.upsertLatencyMs,
				lastMetadataCommitLatencyMs: batchTelemetry?.metadataCommitLatencyMs,
				lastSidecarRoundTripLatencyMs: batchTelemetry?.sidecarRoundTripLatencyMs,
				lastSidecarDeliveryDelayMs: batchTelemetry?.sidecarDeliveryDelayMs,
				lastHostFinalizeLatencyMs: batchTelemetry?.hostFinalizeLatencyMs,
				lastPressureLatencyMs: batchTelemetry?.pressureLatencyMs,
				lastIdleGapMs: batchTelemetry?.idleGapMs,
				lastBatchLatencyMs: batchTelemetry?.totalLatencyMs,
				averageBatchLatencyMs,
				averageEmbedLatencyMs: batchesCompleted > 0 ? totalEmbedLatencyMs / batchesCompleted : undefined,
				averageUpsertLatencyMs: batchesCompleted > 0 ? totalUpsertLatencyMs / batchesCompleted : undefined,
				averageMetadataCommitLatencyMs:
					batchesCompleted > 0 ? totalMetadataCommitLatencyMs / batchesCompleted : undefined,
				averageSidecarRoundTripLatencyMs,
				averageSidecarDeliveryDelayMs,
				averageHostFinalizeLatencyMs,
				averagePressureLatencyMs,
				averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
				chunksPerSecond,
				peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
				peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
				peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
				peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
				peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
				waitingForJobsMs: totalWaitingForJobsMs,
				waitingForInFlightCapacityMs: totalWaitingForInFlightCapacityMs,
				waitingForPressureMs: totalWaitingForPressureMs,
				vectorWriteQueueDepth: latestVectorWriteQueueDepth,
				queuedVectorWriteBatches: latestQueuedVectorWriteBatches,
				queuedVectorWriteEmbeddings: latestQueuedVectorWriteEmbeddings,
				vectorWriteBackpressureMs: totalVectorWriteBackpressureMs,
				laneReleasedAfterEmbedMs: latestLaneReleasedAfterEmbedMs,
				providerBatchUtilization,
				embeddingsPerChunk: utilizationMetrics.embeddingsPerChunk,
				storedVariantsPerChunk: utilizationMetrics.storedVariantsPerChunk,
				embeddedVariantsPerChunk: utilizationMetrics.embeddedVariantsPerChunk,
				storedVariantCountsByType: utilizationMetrics.storedVariantCountsByType,
				embeddedVariantCountsByType: utilizationMetrics.embeddedVariantCountsByType,
				skippedVectorizationReasons: utilizationMetrics.skippedVectorizationReasons,
				laneOccupancyPercent: utilizationMetrics.laneOccupancyPercent,
				embedActivePercent: utilizationMetrics.embedActivePercent,
				averageGpuUtilizationPercent: utilizationMetrics.averageGpuUtilizationPercent,
				peakGpuUtilizationPercent: utilizationMetrics.peakGpuUtilizationPercent,
				averageGpuInUseBytes: utilizationMetrics.averageGpuInUseBytes,
				peakGpuInUseBytes: utilizationMetrics.peakGpuInUseBytes,
				gpuSampleCount: utilizationMetrics.gpuSampleCount,
				activationBurstLatencyMs,
				readyRevisionCount,
				activatedChunkCount,
				supersededChunkCount,
				gpu: latestGpuSample,
			})

			if (batchTelemetry && batchTelemetry.batchSize > 0) {
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-batch", {
					component: "EmbedUpsertWorker",
					runId,
					workspacePath: this.workspacePath,
					provider: this.embeddingAdapter.provider,
					modelId: this.embeddingAdapter.modelId,
					workerPhase: this.workerPhase,
					batchKind: batchTelemetry.batchKind,
					laneId: batchTelemetry.laneId,
					laneConcurrency: effectiveLaneConcurrency,
					effectiveBatchSize,
					pressureState,
					pressureReasons: reasons,
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
					sidecarRoundTripLatencyMs: batchTelemetry.sidecarRoundTripLatencyMs,
					sidecarDeliveryDelayMs: batchTelemetry.sidecarDeliveryDelayMs,
					hostFinalizeLatencyMs: batchTelemetry.hostFinalizeLatencyMs,
					pressureLatencyMs: batchTelemetry.pressureLatencyMs,
					vectorWriteQueueDepth: batchTelemetry.vectorWriteQueueDepth,
					queuedVectorWriteBatches: batchTelemetry.queuedVectorWriteBatches,
					queuedVectorWriteEmbeddings: batchTelemetry.queuedVectorWriteEmbeddings,
					vectorWriteBackpressureMs: batchTelemetry.vectorWriteBackpressureMs,
					laneReleasedAfterEmbedMs: batchTelemetry.laneReleasedAfterEmbedMs,
					idleGapMs: batchTelemetry.idleGapMs,
					providerBatchUtilization,
					embeddingsPerChunk: utilizationMetrics.embeddingsPerChunk,
					storedVariantsPerChunk: utilizationMetrics.storedVariantsPerChunk,
					embeddedVariantsPerChunk: utilizationMetrics.embeddedVariantsPerChunk,
					storedVariantCountsByType: batchTelemetry.storedVariantCountsByType,
					embeddedVariantCountsByType: batchTelemetry.embeddedVariantCountsByType,
					skippedVectorizationReasons: batchTelemetry.skippedVectorizationReasons,
					laneOccupancyPercent: utilizationMetrics.laneOccupancyPercent,
					embedActivePercent: utilizationMetrics.embedActivePercent,
					batchesCompleted,
					syncedChunks,
				})
			}

			await maybeLogHeartbeat(
				chunksPerSecond,
				averageBatchLatencyMs,
				averagePressureLatencyMs,
				averageHostFinalizeLatencyMs,
				averageSidecarDeliveryDelayMs,
				memory,
				{
					hardMemoryPressure,
					softMemoryPressure,
				},
				!batchTelemetry,
			)
		}

		const claimJobs = async (jobType: "upsert" | "delete", batchSize: number) => {
			const claimWithLease = (
				this.metadataStore as MetadataGateway & {
					claimJobsWithLease?: (
						jobType: string,
						limit: number,
						runId?: string,
						options?: { leaseOwner?: string; leaseMs?: number },
					) => Promise<ClaimedJobs>
				}
			).claimJobsWithLease

			if (claimWithLease) {
				return claimWithLease.call(this.metadataStore, jobType, batchSize, runId, {
					leaseOwner: this.leaseOwner,
				})
			}

			return this.metadataStore.claimJobs(jobType, batchSize, runId)
		}

		const clampConcurrency = (error: unknown) => {
			if (effectiveLaneConcurrency <= 1 || !this.isConcurrencyPressureError(error)) {
				return
			}

			effectiveLaneConcurrency = Math.max(1, effectiveLaneConcurrency - 1)
			pressureTriggeredRecyclePending = true
			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-lane-clamped", {
				component: "EmbedUpsertWorker",
				runId,
				workspacePath: this.workspacePath,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				laneConcurrency: effectiveLaneConcurrency,
				errorMessage: error instanceof Error ? error.message : String(error),
			})
			void emitProgress()
		}

		const listPlannedRevisionResolutions = async (): Promise<PlannedRevisionResolution[]> => {
			const listViaStore = await (
				this.metadataStore as MetadataGateway & {
					listPlannedRevisionResolutions?: (runId: string) => Promise<PlannedRevisionResolution[]>
				}
			).listPlannedRevisionResolutions?.(runId)
			if (listViaStore) {
				return listViaStore
			}

			const revisions = await this.metadataStore.getRevisionsByState(
				this.metadataStore.getWorkspaceId(),
				"planned",
			)
			return Promise.all(
				revisions
					.filter((revision) => revision.runId === runId)
					.map(async (revision) => ({
						revisionId: revision.revisionId,
						fileId: revision.fileId,
						previousRevisionId:
							(await this.metadataStore.getDiffBaselineRevision(revision.fileId, revision.revisionId))
								?.revisionId ?? null,
						...(await this.metadataStore.getRevisionJobResolution(revision.revisionId, runId, "upsert")),
					})),
			)
		}

		const listReadyRevisionResolutions = async (limit: number): Promise<PlannedRevisionResolution[]> => {
			const listViaStore = await (
				this.metadataStore as MetadataGateway & {
					listReadyRevisionResolutions?: (
						runId: string,
						limit: number,
					) => Promise<PlannedRevisionResolution[]>
				}
			).listReadyRevisionResolutions?.(runId, limit)
			if (listViaStore) {
				return listViaStore
			}

			return (await listPlannedRevisionResolutions())
				.map((resolution) => buildReadyRevisionResolution(resolution))
				.filter((resolution): resolution is ReadyRevisionResolution => Boolean(resolution))
				.slice(0, limit)
				.map((resolution) => ({
					revisionId: resolution.revisionId,
					fileId: resolution.fileId,
					previousRevisionId: resolution.previousRevisionId,
					doneJobs: resolution.disposition === "terminal_failed" ? 0 : 1,
					queuedJobs: 0,
					runningJobs: 0,
					terminalFailedJobs: resolution.disposition === "committed" ? 0 : 1,
					totalJobs: 1,
				}))
		}

		const buildReadyRevisionResolution = (
			resolution: PlannedRevisionResolution,
		): ReadyRevisionResolution | undefined => {
			if (resolution.queuedJobs > 0 || resolution.runningJobs > 0) {
				return undefined
			}

			if (resolution.terminalFailedJobs === 0) {
				return {
					revisionId: resolution.revisionId,
					fileId: resolution.fileId,
					previousRevisionId: resolution.previousRevisionId,
					disposition: "committed",
					failureReason: null,
				}
			}

			if (resolution.doneJobs > 0 || resolution.totalJobs === 0) {
				return {
					revisionId: resolution.revisionId,
					fileId: resolution.fileId,
					previousRevisionId: resolution.previousRevisionId,
					disposition: "degraded",
					failureReason: `${resolution.terminalFailedJobs} chunk jobs failed permanently during embedding.`,
				}
			}

			return {
				revisionId: resolution.revisionId,
				fileId: resolution.fileId,
				previousRevisionId: resolution.previousRevisionId,
				disposition: "terminal_failed",
				failureReason: `${resolution.terminalFailedJobs} chunk jobs failed permanently before any vectors were stored.`,
			}
		}

		const finalizeReadyRevisionBurstFallback = async (resolutions: ReadyRevisionResolution[]) => {
			const startedAt = Date.now()
			let fallbackCommittedRevisions = 0
			let fallbackDegradedRevisions = 0
			let fallbackTerminalFailedRevisions = 0
			const fallbackSupersededRevisions = new Set<string>()

			for (const resolution of resolutions) {
				if (resolution.disposition === "committed") {
					await this.metadataStore.markRevisionCommitted(resolution.revisionId)
					if (resolution.previousRevisionId) {
						await this.metadataStore.markRevisionSuperseded(resolution.previousRevisionId)
						fallbackSupersededRevisions.add(resolution.previousRevisionId)
					}
					fallbackCommittedRevisions++
					continue
				}

				if (resolution.disposition === "degraded") {
					await this.metadataStore.markRevisionDegraded(
						resolution.revisionId,
						resolution.failureReason ?? "Embedding completed with degraded results.",
					)
					if (resolution.previousRevisionId) {
						await this.metadataStore.markRevisionSuperseded(resolution.previousRevisionId)
						fallbackSupersededRevisions.add(resolution.previousRevisionId)
					}
					fallbackDegradedRevisions++
					continue
				}

				await this.metadataStore.markRevisionTerminalFailure(
					resolution.revisionId,
					resolution.failureReason ?? "Embedding failed permanently before vectors were stored.",
				)
				fallbackTerminalFailedRevisions++
			}

			return {
				committedRevisions: fallbackCommittedRevisions,
				degradedRevisions: fallbackDegradedRevisions,
				terminalFailedRevisions: fallbackTerminalFailedRevisions,
				supersededRevisions: fallbackSupersededRevisions.size,
				activatedChunkCount: 0,
				supersededChunkCount: 0,
				lexicalFtsSyncLatencyMs: 0,
				activationBurstLatencyMs: Date.now() - startedAt,
			}
		}

		const finalizeReadyRevisionBurst = async (): Promise<boolean> => {
			const readyResolutions = (await listReadyRevisionResolutions(EmbedUpsertWorker.ACTIVATION_BURST_LIMIT))
				.map((resolution) => buildReadyRevisionResolution(resolution))
				.filter((resolution): resolution is ReadyRevisionResolution => Boolean(resolution))

			if (readyResolutions.length === 0) {
				return false
			}

			this.setWorkerPhase("activation")
			const finalizeBatch = (
				this.metadataStore as MetadataGateway & {
					finalizeReadyRevisionsBatch?: (input: {
						runId: string
						resolutions: ReadyRevisionResolution[]
					}) => Promise<{
						committedRevisions: number
						degradedRevisions: number
						terminalFailedRevisions: number
						supersededRevisions: number
						activatedChunkCount: number
						supersededChunkCount: number
						lexicalFtsSyncLatencyMs: number
						activationBurstLatencyMs: number
					}>
				}
			).finalizeReadyRevisionsBatch

			const summary = finalizeBatch
				? await finalizeBatch.call(this.metadataStore, {
						runId,
						resolutions: readyResolutions,
					})
				: await finalizeReadyRevisionBurstFallback(readyResolutions)

			committedRevisions += summary.committedRevisions
			degradedRevisions += summary.degradedRevisions
			terminalFailedRevisions += summary.terminalFailedRevisions
			activationBurstLatencyMs = summary.activationBurstLatencyMs
			readyRevisionCount = readyResolutions.length
			activatedChunkCount = summary.activatedChunkCount
			supersededChunkCount = summary.supersededChunkCount

			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "revision-activation-burst-complete", {
				component: "EmbedUpsertWorker",
				runId,
				workspacePath: this.workspacePath,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				readyRevisionCount: readyResolutions.length,
				committedRevisions: summary.committedRevisions,
				degradedRevisions: summary.degradedRevisions,
				terminalFailedRevisions: summary.terminalFailedRevisions,
				supersededRevisions: summary.supersededRevisions,
				activatedChunkCount: summary.activatedChunkCount,
				supersededChunkCount: summary.supersededChunkCount,
				lexicalFtsSyncLatencyMs: summary.lexicalFtsSyncLatencyMs,
				activationBurstLatencyMs: summary.activationBurstLatencyMs,
			})
			await emitProgress()
			return true
		}

		await this.processUpsertStage(runId, signal, emitProgress, {
			onRetryScheduled: () => {
				retryingChunks++
				void emitProgress()
			},
			onChunkTerminalFailure: () => {
				terminallyFailedChunks++
				void emitProgress()
			},
			onChunksUpserted: (count) => {
				upsertedChunks += count
			},
			onClientsRecycled: () => {
				localLaneRampCooldownWindows = Math.max(
					localLaneRampCooldownWindows,
					EmbedUpsertWorker.LOCAL_LANE_RAMP_COOLDOWN_WINDOWS,
				)
				localLaneRampHeadroomWindows = 0
			},
			onConcurrencyPressure: clampConcurrency,
			getLaneConcurrency: () => effectiveLaneConcurrency,
			getBatchSize: () => effectiveBatchSize,
			getEmbeddingBudget: () => this.getEmbeddingBudget(effectiveBatchSize),
			getPressureState: () => pressureState,
			recordWaitForJobs: (ms) => {
				totalWaitingForJobsMs += ms
			},
			recordWaitForInFlightCapacity: (ms) => {
				totalWaitingForInFlightCapacityMs += ms
			},
			recordWaitForPressure: (ms) => {
				totalWaitingForPressureMs += ms
			},
			shouldRecycleClients: () => pressureTriggeredRecyclePending,
			consumeRecycleRequest: () => {
				const recycleReason: "pressure" | "interval" = pressureTriggeredRecyclePending ? "pressure" : "interval"
				pressureTriggeredRecyclePending = false
				return recycleReason
			},
			finalizeReadyRevisionBurst,
		})

		for (;;) {
			if (signal?.aborted) {
				throw new Error("Embed/upsert worker aborted")
			}

			this.setWorkerPhase("delete")
			const deleteJobs = await claimJobs("delete", this.batchSize)
			if (deleteJobs.length === 0) {
				this.setWorkerPhase("waiting_retry")
				const nextRetryAt = await this.metadataStore.getNextRetryAt("delete", runId)
				if (nextRetryAt === undefined) {
					this.setWorkerPhase("idle")
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
						void emitProgress()
					},
					onChunksDeleted: (count) => {
						deletedChunks += count
					},
				})
			} finally {
				this.activeLaneCount = 0
				this.inFlightChunkCount = 0
				this.setWorkerPhase("idle")
			}
		}

		while (await finalizeReadyRevisionBurst()) {
			// Keep draining any remaining activation backlog before final summary logging.
		}
		this.setWorkerPhase("idle")
		updatePressureDurations()
		const finalUtilizationMetrics = computeWorkerUtilizationMetrics()

		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-complete", {
			component: "EmbedUpsertWorker",
			runId,
			workspacePath: this.workspacePath,
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
			effectiveBatchSize,
			workerPhase: this.workerPhase,
			pressureState,
			pressureReasons: latestPressureReasons,
			pressureSoftTransitions,
			pressureHardTransitions,
			pressureSoftDurationMs,
			pressureHardDurationMs,
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
			averageSidecarRoundTripLatencyMs:
				batchesCompleted > 0 ? totalSidecarRoundTripLatencyMs / batchesCompleted : undefined,
			averageSidecarDeliveryDelayMs:
				batchesCompleted > 0 ? totalSidecarDeliveryDelayMs / batchesCompleted : undefined,
			averageHostFinalizeLatencyMs:
				batchesCompleted > 0 ? totalHostFinalizeLatencyMs / batchesCompleted : undefined,
			averagePressureLatencyMs: batchesCompleted > 0 ? totalPressureLatencyMs / batchesCompleted : undefined,
			averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
			peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
			peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
			peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
			peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
			peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
			waitingForJobsMs: totalWaitingForJobsMs,
			waitingForInFlightCapacityMs: totalWaitingForInFlightCapacityMs,
			waitingForPressureMs: totalWaitingForPressureMs,
			vectorWriteQueueDepth: latestVectorWriteQueueDepth,
			queuedVectorWriteBatches: latestQueuedVectorWriteBatches,
			queuedVectorWriteEmbeddings: latestQueuedVectorWriteEmbeddings,
			vectorWriteBackpressureMs: totalVectorWriteBackpressureMs,
			laneReleasedAfterEmbedMs: latestLaneReleasedAfterEmbedMs,
			embeddingsPerChunk: finalUtilizationMetrics.embeddingsPerChunk,
			storedVariantsPerChunk: finalUtilizationMetrics.storedVariantsPerChunk,
			embeddedVariantsPerChunk: finalUtilizationMetrics.embeddedVariantsPerChunk,
			storedVariantCountsByType: finalUtilizationMetrics.storedVariantCountsByType,
			embeddedVariantCountsByType: finalUtilizationMetrics.embeddedVariantCountsByType,
			skippedVectorizationReasons: finalUtilizationMetrics.skippedVectorizationReasons,
			laneOccupancyPercent: finalUtilizationMetrics.laneOccupancyPercent,
			embedActivePercent: finalUtilizationMetrics.embedActivePercent,
			averageGpuUtilizationPercent: finalUtilizationMetrics.averageGpuUtilizationPercent,
			peakGpuUtilizationPercent: finalUtilizationMetrics.peakGpuUtilizationPercent,
			averageGpuInUseBytes: finalUtilizationMetrics.averageGpuInUseBytes,
			peakGpuInUseBytes: finalUtilizationMetrics.peakGpuInUseBytes,
			gpuSampleCount: finalUtilizationMetrics.gpuSampleCount,
			activationBurstLatencyMs,
			readyRevisionCount,
			activatedChunkCount,
			supersededChunkCount,
			gpu: latestGpuSample,
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
			effectiveBatchSize,
			workerPhase: this.workerPhase,
			pressureState,
			pressureReasons: latestPressureReasons,
			pressureSoftTransitions,
			pressureHardTransitions,
			pressureSoftDurationMs,
			pressureHardDurationMs,
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
			averageSidecarRoundTripLatencyMs:
				batchesCompleted > 0 ? totalSidecarRoundTripLatencyMs / batchesCompleted : undefined,
			averageSidecarDeliveryDelayMs:
				batchesCompleted > 0 ? totalSidecarDeliveryDelayMs / batchesCompleted : undefined,
			averageHostFinalizeLatencyMs:
				batchesCompleted > 0 ? totalHostFinalizeLatencyMs / batchesCompleted : undefined,
			averagePressureLatencyMs: batchesCompleted > 0 ? totalPressureLatencyMs / batchesCompleted : undefined,
			averageIdleGapMs: batchesCompleted > 0 ? totalIdleGapMs / batchesCompleted : undefined,
			peakChunksPerSecond: peakChunksPerSecond > 0 ? peakChunksPerSecond : undefined,
			peakBatchLatencyMs: peakBatchLatencyMs > 0 ? peakBatchLatencyMs : undefined,
			peakIdleGapMs: peakIdleGapMs > 0 ? peakIdleGapMs : undefined,
			peakBatchSize: peakBatchSize > 0 ? peakBatchSize : undefined,
			peakEmbeddingCount: peakEmbeddingCount > 0 ? peakEmbeddingCount : undefined,
			waitingForJobsMs: totalWaitingForJobsMs,
			waitingForInFlightCapacityMs: totalWaitingForInFlightCapacityMs,
			waitingForPressureMs: totalWaitingForPressureMs,
			vectorWriteQueueDepth: latestVectorWriteQueueDepth,
			queuedVectorWriteBatches: latestQueuedVectorWriteBatches,
			queuedVectorWriteEmbeddings: latestQueuedVectorWriteEmbeddings,
			vectorWriteBackpressureMs: totalVectorWriteBackpressureMs,
			laneReleasedAfterEmbedMs: latestLaneReleasedAfterEmbedMs,
			embeddingsPerChunk: finalUtilizationMetrics.embeddingsPerChunk,
			storedVariantsPerChunk: finalUtilizationMetrics.storedVariantsPerChunk,
			embeddedVariantsPerChunk: finalUtilizationMetrics.embeddedVariantsPerChunk,
			storedVariantCountsByType: finalUtilizationMetrics.storedVariantCountsByType,
			embeddedVariantCountsByType: finalUtilizationMetrics.embeddedVariantCountsByType,
			skippedVectorizationReasons: finalUtilizationMetrics.skippedVectorizationReasons,
			laneOccupancyPercent: finalUtilizationMetrics.laneOccupancyPercent,
			embedActivePercent: finalUtilizationMetrics.embedActivePercent,
			averageGpuUtilizationPercent: finalUtilizationMetrics.averageGpuUtilizationPercent,
			peakGpuUtilizationPercent: finalUtilizationMetrics.peakGpuUtilizationPercent,
			averageGpuInUseBytes: finalUtilizationMetrics.averageGpuInUseBytes,
			peakGpuInUseBytes: finalUtilizationMetrics.peakGpuInUseBytes,
			gpuSampleCount: finalUtilizationMetrics.gpuSampleCount,
			activationBurstLatencyMs,
			readyRevisionCount,
			activatedChunkCount,
			supersededChunkCount,
			gpu: latestGpuSample,
		}
	}

	private async processUpsertStage(
		runId: string,
		signal: AbortSignal | undefined,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => Promise<void>,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onClientsRecycled: () => void
			onConcurrencyPressure: (error: unknown) => void
			getLaneConcurrency: () => number
			getBatchSize: () => number
			getEmbeddingBudget: () => number
			getPressureState: () => EmbedPressureState
			recordWaitForJobs: (ms: number) => void
			recordWaitForInFlightCapacity: (ms: number) => void
			recordWaitForPressure: (ms: number) => void
			shouldRecycleClients: () => boolean
			consumeRecycleRequest: () => "pressure" | "interval"
			finalizeReadyRevisionBurst: () => Promise<boolean>
		},
	): Promise<void> {
		const activeTasks = new Set<Promise<void>>()
		const schedulerWakeups = new Set<() => void>()
		let nextLaneId = 1
		let nextRecycleAtBatch = EmbedUpsertWorker.V2_CLIENT_RECYCLE_INTERVAL
		const wakeScheduler = () => {
			for (const wake of Array.from(schedulerWakeups)) {
				wake()
			}
		}
		const waitForSchedulerWake = () => {
			let wake: (() => void) | undefined
			const promise = new Promise<void>((resolve) => {
				wake = () => {
					if (wake) {
						schedulerWakeups.delete(wake)
					}
					resolve()
				}
				schedulerWakeups.add(wake)
			})
			return {
				promise,
				cancel: () => {
					if (wake) {
						schedulerWakeups.delete(wake)
					}
				},
			}
		}

		const launchNextBatch = async (): Promise<"launched" | "no-jobs" | "capacity"> => {
			if (signal?.aborted) {
				throw new Error("Embed/upsert worker aborted")
			}

			const maxInFlightChunks = EmbedUpsertWorker.getMaxInFlightChunks(
				callbacks.getPressureState(),
				callbacks.getLaneConcurrency(),
				callbacks.getBatchSize(),
			)
			const remainingInFlightCapacity = Number.isFinite(maxInFlightChunks)
				? Math.max(0, maxInFlightChunks - this.inFlightChunkCount)
				: undefined
			if (remainingInFlightCapacity !== undefined && remainingInFlightCapacity === 0) {
				return "capacity"
			}
			const claimLimit =
				remainingInFlightCapacity !== undefined
					? Math.min(callbacks.getBatchSize(), remainingInFlightCapacity)
					: callbacks.getBatchSize()
			if (claimLimit <= 0) {
				return "capacity"
			}

			const claimWithLease = (
				this.metadataStore as MetadataGateway & {
					claimJobsWithLease?: (
						jobType: string,
						limit: number,
						runId?: string,
						options?: { leaseOwner?: string; leaseMs?: number },
					) => Promise<ClaimedJobs>
				}
			).claimJobsWithLease
			const claimStartedAt = Date.now()
			const upsertJobs = claimWithLease
				? await claimWithLease.call(this.metadataStore, "upsert", claimLimit, runId, {
						leaseOwner: this.leaseOwner,
					})
				: await this.metadataStore.claimJobs("upsert", claimLimit, runId)
			callbacks.recordWaitForJobs(Math.max(Date.now() - claimStartedAt, 0))
			if (upsertJobs.length === 0) {
				return "no-jobs"
			}

			const laneId = nextLaneId++
			this.activeLaneCount++
			this.inFlightChunkCount += upsertJobs.length
			this.peakInFlightChunkCount = Math.max(this.peakInFlightChunkCount, this.inFlightChunkCount)
			let trackedClaimCount = upsertJobs.length
			let embeddingLaneReleased = false
			const releaseEmbeddingLane = () => {
				if (embeddingLaneReleased) {
					return
				}
				embeddingLaneReleased = true
				this.activeLaneCount = Math.max(0, this.activeLaneCount - 1)
				if (this.activeLaneCount === 0 && this.inFlightChunkCount === 0) {
					this.setWorkerPhase("idle")
				}
				wakeScheduler()
			}
			this.setWorkerPhase("embedding")

			const task = (async () => {
				try {
					await this.processUpsertJobs(upsertJobs, signal, laneId, emitBatchProgress, {
						onRetryScheduled: callbacks.onRetryScheduled,
						onChunkTerminalFailure: callbacks.onChunkTerminalFailure,
						onChunksUpserted: callbacks.onChunksUpserted,
						onConcurrencyPressure: callbacks.onConcurrencyPressure,
						getEmbeddingBudget: callbacks.getEmbeddingBudget,
						onJobsReleased: (count) => {
							if (count <= 0) {
								return
							}
							trackedClaimCount = Math.max(0, trackedClaimCount - count)
							this.inFlightChunkCount = Math.max(0, this.inFlightChunkCount - count)
						},
						onEmbeddingLaneReleased: releaseEmbeddingLane,
					})
				} finally {
					releaseEmbeddingLane()
					this.inFlightChunkCount = Math.max(0, this.inFlightChunkCount - trackedClaimCount)
					if (this.activeLaneCount === 0 && this.inFlightChunkCount === 0) {
						this.setWorkerPhase("idle")
					}
				}
			})()

			activeTasks.add(task)
			task.finally(() => {
				activeTasks.delete(task)
				wakeScheduler()
			}).catch(() => undefined)
			return "launched"
		}

		for (;;) {
			const recyclePending = callbacks.shouldRecycleClients() || this.completedBatchCount >= nextRecycleAtBatch

			while (!recyclePending && this.activeLaneCount < callbacks.getLaneConcurrency()) {
				this.setWorkerPhase("claiming")
				const launched = await launchNextBatch()
				if (launched === "capacity") {
					callbacks.recordWaitForInFlightCapacity(EmbedUpsertWorker.WAIT_ACCUMULATION_MS)
				}
				if (launched !== "launched") {
					break
				}
			}

			if (recyclePending) {
				this.setWorkerPhase("waiting_retry")
				const recycleStartedAt = Date.now()
				const recycleReason =
					this.completedBatchCount >= nextRecycleAtBatch ? "interval" : callbacks.consumeRecycleRequest()
				await this.maybeRecycleClients(runId, activeTasks, signal, recycleReason)
				callbacks.onClientsRecycled()
				if (recycleReason === "pressure") {
					callbacks.recordWaitForPressure(Math.max(Date.now() - recycleStartedAt, 0))
				}
				while (this.completedBatchCount >= nextRecycleAtBatch) {
					nextRecycleAtBatch += EmbedUpsertWorker.V2_CLIENT_RECYCLE_INTERVAL
				}
				continue
			}

			if (activeTasks.size === 0) {
				this.setWorkerPhase("activation")
				if (await callbacks.finalizeReadyRevisionBurst()) {
					continue
				}
				this.setWorkerPhase("waiting_retry")
				const nextRetryAt = await this.metadataStore.getNextRetryAt("upsert", runId)
				if (nextRetryAt === undefined) {
					this.setWorkerPhase("idle")
					break
				}
				await this.waitForNextRetry(nextRetryAt, signal)
				continue
			}

			this.setWorkerPhase("embedding")
			const schedulerWake = waitForSchedulerWake()
			try {
				await Promise.race([...Array.from(activeTasks), schedulerWake.promise])
			} finally {
				schedulerWake.cancel()
			}
		}
	}

	private async processUpsertJobs(
		jobs: ClaimedJobs,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => Promise<void>,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onConcurrencyPressure: (error: unknown) => void
			onJobsReleased: (count: number) => void
			onEmbeddingLaneReleased: () => void
			getEmbeddingBudget: () => number
		},
	): Promise<void> {
		await (
			this.metadataStore as MetadataGateway & {
				heartbeatJobs?: (jobIds: string[], leaseOwner: string) => Promise<void>
			}
		).heartbeatJobs?.(
			jobs.map((job) => job.jobId),
			this.leaseOwner,
		)

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
		recycleReason: "pressure" | "interval",
	): Promise<void> {
		const recycleStartedAt = Date.now()
		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycle-pending", {
			component: "EmbedUpsertWorker",
			runId,
			workspacePath: this.workspacePath,
			provider: this.embeddingAdapter.provider,
			modelId: this.embeddingAdapter.modelId,
			laneConcurrency: this.laneConcurrency,
			activeLaneCount: activeTasks.size,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			recycleIntervalBatches: EmbedUpsertWorker.V2_CLIENT_RECYCLE_INTERVAL,
			completedBatches: this.completedBatchCount,
			recycleReason,
		})

		const drained = await this.waitForActiveTasksToDrain(activeTasks, signal)
		if (!drained) {
			IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycle-skipped", {
				component: "EmbedUpsertWorker",
				runId,
				workspacePath: this.workspacePath,
				provider: this.embeddingAdapter.provider,
				modelId: this.embeddingAdapter.modelId,
				laneConcurrency: this.laneConcurrency,
				activeLaneCount: activeTasks.size,
				inFlightChunkCount: this.inFlightChunkCount,
				peakInFlightChunkCount: this.peakInFlightChunkCount,
				recycleIntervalBatches: EmbedUpsertWorker.V2_CLIENT_RECYCLE_INTERVAL,
				timeoutMs: EmbedUpsertWorker.RECYCLE_DRAIN_TIMEOUT_MS,
				elapsedMs: Date.now() - recycleStartedAt,
				reason: "active-lanes-did-not-drain",
				recycleReason,
			})
			return
		}

		const memoryBefore = IndexDebugLoggerV2.getMemorySnapshot()
		if (this.upsertExecutor?.recycleClients) {
			await this.upsertExecutor.recycleClients(recycleReason)
		} else {
			await this.embeddingAdapter.recycleClient?.()
			await this.vectorStore.recycleClient?.()
		}
		const memoryAfter = IndexDebugLoggerV2.getMemorySnapshot()

		IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-recycled-clients", {
			component: "EmbedUpsertWorker",
			runId,
			workspacePath: this.workspacePath,
			provider: this.embeddingAdapter.provider,
			modelId: this.embeddingAdapter.modelId,
			laneConcurrency: this.laneConcurrency,
			activeLaneCount: activeTasks.size,
			inFlightChunkCount: this.inFlightChunkCount,
			peakInFlightChunkCount: this.peakInFlightChunkCount,
			recycleIntervalBatches: EmbedUpsertWorker.V2_CLIENT_RECYCLE_INTERVAL,
			completedBatches: this.completedBatchCount,
			elapsedMs: Date.now() - recycleStartedAt,
			recycleReason,
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

	private startJobLeaseHeartbeat(jobIds: string[]): () => void {
		const heartbeatJobs = (
			this.metadataStore as MetadataGateway & {
				heartbeatJobs?: (jobIds: string[], leaseOwner: string) => Promise<void>
			}
		).heartbeatJobs
		if (!heartbeatJobs || jobIds.length === 0) {
			return () => undefined
		}

		const timer = setInterval(() => {
			heartbeatJobs.call(this.metadataStore, jobIds, this.leaseOwner).catch((error: unknown) => {
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-job-heartbeat-failed", {
					component: "EmbedUpsertWorker",
					workspacePath: this.workspacePath,
					jobCount: jobIds.length,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}, EmbedUpsertWorker.JOB_HEARTBEAT_INTERVAL_MS)
		timer.unref?.()
		return () => clearInterval(timer)
	}

	private async processUpsertJobPairs(
		jobPairs: Array<{
			job: ClaimedJob
			chunk: ChunkRecord
		}>,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => Promise<void>,
		callbacks: {
			onRetryScheduled: () => void
			onChunkTerminalFailure: () => void
			onChunksUpserted: (count: number) => void
			onConcurrencyPressure: (error: unknown) => void
			onJobsReleased: (count: number) => void
			onEmbeddingLaneReleased: () => void
			getEmbeddingBudget: () => number
		},
	): Promise<void> {
		if (jobPairs.length === 0) {
			return
		}

		if (signal?.aborted) {
			throw new Error("Embed/upsert worker aborted")
		}

		let activeJobPairs = jobPairs
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
			const embeddingBudget = callbacks.getEmbeddingBudget()
			const selectedJobPairs = this.selectJobPairsWithinEmbeddingBudget(
				jobPairs,
				variantsByChunkId,
				embeddingBudget,
			)
			activeJobPairs = selectedJobPairs
			const releasedJobPairs = jobPairs.slice(selectedJobPairs.length)
			if (releasedJobPairs.length > 0) {
				await this.metadataStore.releaseJobs(
					releasedJobPairs.map(({ job }) => job.jobId),
					this.leaseOwner,
				)
				callbacks.onJobsReleased(releasedJobPairs.length)
				IndexDebugLoggerV2.log("basic", "EmbedUpsertWorker", "embed-upsert-batch-trimmed", {
					component: "EmbedUpsertWorker",
					runId: jobPairs[0]?.job.runId,
					workspacePath: this.workspacePath,
					provider: this.embeddingAdapter.provider,
					modelId: this.embeddingAdapter.modelId,
					laneId,
					claimedChunkCount: jobPairs.length,
					selectedChunkCount: selectedJobPairs.length,
					releasedChunkCount: releasedJobPairs.length,
					embeddingBudget,
				})
			}
			const items = selectedJobPairs.map(({ chunk }) => this.buildUpsertBatchItem(chunk, variantsByChunkId))
			const embeddingCount = items.reduce((sum, item) => sum + item.variants.length, 0)
			if (embeddingCount === 0) {
				await this.metadataStore.completeJobs(selectedJobPairs.map(({ job }) => job.jobId))
				return
			}

			const batchStartedAt = Date.now()
			const idleGapMs = Math.max(batchStartedAt - this.lastBatchCompletedAt, 0)
			const stopLeaseHeartbeat = this.startJobLeaseHeartbeat(selectedJobPairs.map(({ job }) => job.jobId))
			let embeddingLaneReleased = false
			const releaseEmbeddingLane = () => {
				if (embeddingLaneReleased) {
					return
				}
				embeddingLaneReleased = true
				callbacks.onEmbeddingLaneReleased()
			}
			let execution: EmbedUpsertExecutionResult
			try {
				execution = this.upsertExecutor
					? await this.upsertExecutor.executeUpsertBatch(
							selectedJobPairs[0]?.job.runId ?? "run",
							laneId,
							items,
							signal,
							{
								onEmbedded: releaseEmbeddingLane,
							},
						)
					: await executeUpsertBatch(items, this.embeddingAdapter, this.vectorStore, {
							signal,
							debugContext: {
								runId: selectedJobPairs[0]?.job.runId,
								batchId: `${selectedJobPairs[0]?.job.runId ?? "run"}:${selectedJobPairs[0]?.job.jobId ?? "job"}:${embeddingCount}`,
								outerBatchSize: embeddingCount,
							},
						})
			} finally {
				stopLeaseHeartbeat()
			}

			const metadataCommitStartedAt = Date.now()
			await this.metadataStore.markChunkVariantStates(
				items.flatMap(({ chunk, variants }) =>
					variants.map((variant) => ({
						variantId: variant.variantId,
						state: "upserted" as const,
						embeddingModel: this.embeddingAdapter.modelId,
						vectorPointId: createPointId(chunk, variant.variantType),
						clearContent: true,
					})),
				),
			)
			await this.metadataStore.markChunkStates(
				selectedJobPairs.map(({ chunk }) => ({
					chunkId: chunk.chunkId,
					state: "upserted" as const,
					embeddingModel: this.embeddingAdapter.modelId,
					vectorPointId: createPointId(
						{
							chunkId: chunk.chunkId,
							revisionId: chunk.revisionId,
							chunkFingerprint: chunk.chunkFingerprint,
							startLine: chunk.startLine,
							endLine: chunk.endLine,
							content: chunk.content,
							fileId: chunk.fileId,
							workspaceId: chunk.workspaceId,
							relativePath: chunk.relativePath,
							parserVersion: chunk.parserVersion,
							chunkerVersion: chunk.chunkerVersion,
							language: chunk.language ?? null,
							chunkKind: chunk.chunkKind ?? null,
							symbolName: chunk.symbolName ?? null,
							symbolQualifiedName: chunk.symbolQualifiedName ?? null,
							parentSymbolName: chunk.parentSymbolName ?? null,
							parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
							summary: chunk.summary ?? null,
							searchText: chunk.searchText ?? null,
						},
						"raw_code",
					),
					clearContent: true,
				})),
			)
			await this.metadataStore.completeJobs(selectedJobPairs.map(({ job }) => job.jobId))
			const metadataCommitLatencyMs = Date.now() - metadataCommitStartedAt
			const totalLatencyMs = Date.now() - batchStartedAt
			const sidecarRoundTripLatencyMs =
				execution.sidecarRoundTripLatencyMs ?? execution.embedLatencyMs + execution.upsertLatencyMs
			const sidecarDeliveryDelayMs =
				execution.sidecarDeliveryDelayMs ??
				Math.max(sidecarRoundTripLatencyMs - execution.embedLatencyMs - execution.upsertLatencyMs, 0)
			const hostFinalizeLatencyMs = Math.max(
				totalLatencyMs - sidecarRoundTripLatencyMs - metadataCommitLatencyMs,
				0,
			)
			const pressureLatencyMs = execution.embedLatencyMs + execution.upsertLatencyMs + metadataCommitLatencyMs
			this.lastBatchCompletedAt = Date.now()
			this.completedBatchCount++

			callbacks.onChunksUpserted(selectedJobPairs.length)
			await emitBatchProgress({
				batchKind: "upsert",
				batchSize: selectedJobPairs.length,
				embeddingCount: execution.embeddingCount,
				storedVariantCount: execution.variantTelemetry.storedVariantCount,
				embeddedVariantCount: execution.variantTelemetry.embeddedVariantCount,
				storedVariantCountsByType: execution.variantTelemetry.storedVariantCountsByType,
				embeddedVariantCountsByType: execution.variantTelemetry.embeddedVariantCountsByType,
				skippedVectorizationReasons: execution.variantTelemetry.skippedVectorizationReasons,
				laneId,
				idleGapMs,
				embedLatencyMs: execution.embedLatencyMs,
				upsertLatencyMs: execution.upsertLatencyMs,
				metadataCommitLatencyMs,
				sidecarRoundTripLatencyMs,
				sidecarDeliveryDelayMs,
				hostFinalizeLatencyMs,
				pressureLatencyMs,
				vectorWriteQueueDepth: execution.vectorWriteQueueDepth,
				queuedVectorWriteBatches: execution.queuedVectorWriteBatches,
				queuedVectorWriteEmbeddings: execution.queuedVectorWriteEmbeddings,
				vectorWriteBackpressureMs: execution.vectorWriteBackpressureMs,
				laneReleasedAfterEmbedMs: execution.laneReleasedAfterEmbedMs,
				totalLatencyMs,
			})
		} catch (error) {
			if (this.isConcurrencyPressureError(error)) {
				callbacks.onConcurrencyPressure(error)
			}

			if (activeJobPairs.length === 1) {
				await this.handleSingleUpsertFailure(activeJobPairs[0], error, callbacks)
				return
			}

			const midpoint = Math.ceil(activeJobPairs.length / 2)
			await this.processUpsertJobPairs(
				activeJobPairs.slice(0, midpoint),
				signal,
				laneId,
				emitBatchProgress,
				callbacks,
			)
			await this.processUpsertJobPairs(
				activeJobPairs.slice(midpoint),
				signal,
				laneId,
				emitBatchProgress,
				callbacks,
			)
		}
	}

	private buildUpsertBatchItem(
		chunk: ChunkRecord,
		variantsByChunkId: Map<string, ChunkVariantRecord[]>,
	): EmbedUpsertBatchItem {
		const chunkInput = {
			chunkId: chunk.chunkId,
			revisionId: chunk.revisionId,
			chunkFingerprint: chunk.chunkFingerprint,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			content: chunk.content,
			fileId: chunk.fileId,
			workspaceId: chunk.workspaceId,
			relativePath: chunk.relativePath,
			parserVersion: chunk.parserVersion,
			chunkerVersion: chunk.chunkerVersion,
			language: chunk.language ?? null,
			chunkKind: chunk.chunkKind ?? null,
			symbolName: chunk.symbolName ?? null,
			symbolQualifiedName: chunk.symbolQualifiedName ?? null,
			parentSymbolName: chunk.parentSymbolName ?? null,
			parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
			summary: chunk.summary ?? null,
			searchText: chunk.searchText ?? null,
		}
		const variants = getChunkVariantsForEmbedding(
			chunkInput,
			(variantsByChunkId.get(chunk.chunkId) ?? []).map((variant) => ({
				variantId: variant.variantId,
				chunkId: variant.chunkId,
				variantType: variant.variantType,
				content: variant.content,
				vectorEligible: variant.vectorEligible,
				vectorPriority: variant.vectorPriority,
				vectorEligibilityReason: variant.vectorEligibilityReason,
				noveltyScore: variant.noveltyScore,
			})),
		)
		return {
			chunk: chunkInput,
			variants,
		}
	}

	private selectJobPairsWithinEmbeddingBudget(
		jobPairs: Array<{
			job: ClaimedJob
			chunk: ChunkRecord
		}>,
		variantsByChunkId: Map<string, ChunkVariantRecord[]>,
		embeddingBudget: number,
	): typeof jobPairs {
		const clampedBudget = Math.max(1, embeddingBudget)
		const selected: typeof jobPairs = []
		let predictedEmbeddingCount = 0

		for (const pair of jobPairs) {
			const predictedVariants = this.buildUpsertBatchItem(pair.chunk, variantsByChunkId).variants.length
			const nextPredictedEmbeddingCount = predictedEmbeddingCount + Math.max(predictedVariants, 1)
			if (selected.length > 0 && nextPredictedEmbeddingCount > clampedBudget) {
				break
			}
			selected.push(pair)
			predictedEmbeddingCount = nextPredictedEmbeddingCount
		}

		return selected.length > 0 ? selected : jobPairs.slice(0, 1)
	}

	private async handleSingleUpsertFailure(
		jobPair: {
			job: ClaimedJob
			chunk: ChunkRecord
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
		jobs: ClaimedJobs,
		signal: AbortSignal | undefined,
		laneId: number,
		emitBatchProgress: (batchTelemetry?: BatchTelemetry) => Promise<void>,
		callbacks: {
			onRetryScheduled: () => void
			onChunksDeleted: (count: number) => void
		},
	): Promise<void> {
		await (
			this.metadataStore as MetadataGateway & {
				heartbeatJobs?: (jobIds: string[], leaseOwner: string) => Promise<void>
			}
		).heartbeatJobs?.(
			jobs.map((job) => job.jobId),
			this.leaseOwner,
		)

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
			job: ClaimedJob
			chunk: ChunkRecord
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
			const totalLatencyMs = Date.now() - batchStartedAt
			const hostFinalizeLatencyMs = Math.max(totalLatencyMs - upsertLatencyMs - metadataCommitLatencyMs, 0)
			this.lastBatchCompletedAt = Date.now()
			this.completedBatchCount++

			callbacks.onChunksDeleted(deletePointIds.length)
			await emitBatchProgress({
				batchKind: "delete",
				batchSize: jobPairs.length,
				embeddingCount: 0,
				laneId,
				idleGapMs,
				upsertLatencyMs,
				metadataCommitLatencyMs,
				sidecarRoundTripLatencyMs: upsertLatencyMs,
				sidecarDeliveryDelayMs: 0,
				hostFinalizeLatencyMs,
				pressureLatencyMs: upsertLatencyMs + metadataCommitLatencyMs,
				totalLatencyMs,
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

	private getEmbeddingBudget(effectiveBatchSize: number): number {
		const recommendedBatchSize = this.embeddingAdapter.getRecommendedDocumentBatchSize?.()
		if (recommendedBatchSize == null) {
			return Math.max(1, effectiveBatchSize)
		}

		return Math.max(1, Math.min(effectiveBatchSize, recommendedBatchSize))
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
}
