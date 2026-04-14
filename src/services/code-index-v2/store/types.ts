export type FileRevisionState =
	| "hashed"
	| "parsed"
	| "planned"
	| "committed"
	| "degraded"
	| "terminal_failed"
	| "superseded"
	| "failed"

export type ChunkState = "parsed" | "upserted" | "deleted" | "abandoned" | "terminal_failed"
export type ChunkVariantType = "raw_code" | "summary" | "symbol_signature"
export type ChunkVariantState = ChunkState

export type JobState = "queued" | "running" | "done" | "abandoned" | "terminal_failed"

export type IndexRunState = "started" | "discovery_complete" | "complete" | "failed" | "stopped"
export type OversizedTrackingStatus = "skipped" | "needs_reapproval" | "approved" | "eligible" | "missing"

export interface WorkspaceRecord {
	workspaceId: string
	workspacePath: string
}

export interface FileRecord {
	fileId: string
	workspaceId: string
	relativePath: string
	normalizedPath: string
	lastSeenMtimeMs: number | null
	lastSeenSize: number | null
	ignoreState: string
	activeRevisionId: string | null
	tombstoned: boolean
}

export interface FileRecordWithRevision extends FileRecord {
	latestRevisionId: string | null
	latestRevisionContentHash: string | null
	latestRevisionFastFingerprint: string | null
	latestRevisionState: string | null
	latestRevisionParserVersion: string | null
	latestRevisionChunkerVersion: string | null
}

export interface FileRecordInput {
	workspaceId: string
	relativePath: string
	normalizedPath: string
	lastSeenMtimeMs?: number | null
	lastSeenSize?: number | null
	ignoreState: string
	tombstoned?: boolean
}

export interface FileRevisionRecord {
	revisionId: string
	fileId: string
	runId: string
	contentHash: string
	fastFingerprint: string | null
	parserVersion: string
	chunkerVersion: string
	state: FileRevisionState
	discoveredAt: number
	committedAt: number | null
	supersededAt: number | null
	failureReason: string | null
}

export interface FileRevisionWithFileRecord extends FileRevisionRecord {
	relativePath: string
	normalizedPath: string
	fileIgnoreState: string
}

export interface FileRevisionInput {
	fileId: string
	runId: string
	contentHash: string
	fastFingerprint?: string | null
	parserVersion: string
	chunkerVersion: string
	state?: FileRevisionState
	discoveredAt?: number
}

export interface ChunkRecord {
	chunkId: string
	revisionId: string
	chunkFingerprint: string
	startLine: number
	endLine: number
	language: string | null
	chunkKind: string | null
	symbolName: string | null
	symbolQualifiedName: string | null
	parentSymbolName: string | null
	parentChunkFingerprint: string | null
	summary: string | null
	searchText: string | null
	content: string
	contentHash: string
	tokenEstimate: number | null
	embeddingModel: string | null
	vectorPointId: string | null
	state: ChunkState
	createdAt: number
	updatedAt: number
}

export interface RevisionQueryOptions {
	runId?: string
	limit?: number
}

export interface ChunkInput {
	revisionId: string
	chunkFingerprint: string
	startLine: number
	endLine: number
	language?: string | null
	chunkKind?: string | null
	symbolName?: string | null
	symbolQualifiedName?: string | null
	parentSymbolName?: string | null
	parentChunkFingerprint?: string | null
	summary?: string | null
	searchText?: string | null
	content: string
	contentHash: string
	tokenEstimate?: number | null
	embeddingModel?: string | null
	vectorPointId?: string | null
	state?: ChunkState
}

export interface ChunkWithRevisionRecord extends ChunkRecord {
	fileId: string
	workspaceId: string
	relativePath: string
	normalizedPath: string
	parserVersion: string
	chunkerVersion: string
}

export interface LexicalChunkSearchRecord extends ChunkWithRevisionRecord {
	lexicalScore: number
}

export interface ChunkVariantRecord {
	variantId: string
	chunkId: string
	variantType: ChunkVariantType
	content: string
	contentHash: string
	tokenEstimate: number | null
	embeddingModel: string | null
	vectorPointId: string | null
	vectorEligible: boolean
	vectorPriority: number
	vectorEligibilityReason: string | null
	noveltyScore: number | null
	state: ChunkVariantState
	createdAt: number
	updatedAt: number
}

export interface ChunkVariantInput {
	chunkId: string
	variantType: ChunkVariantType
	content: string
	contentHash: string
	tokenEstimate?: number | null
	embeddingModel?: string | null
	vectorPointId?: string | null
	vectorEligible?: boolean
	vectorPriority?: number
	vectorEligibilityReason?: string | null
	noveltyScore?: number | null
	state?: ChunkVariantState
}

export type PersistParsedRevisionVariantInput = Omit<ChunkVariantInput, "chunkId">

export interface PersistParsedRevisionChunkInput extends Omit<ChunkInput, "revisionId"> {
	chunkId: string
	variants: PersistParsedRevisionVariantInput[]
}

export interface PersistParsedRevisionInput {
	revisionId: string
	relativePath: string
	chunks: PersistParsedRevisionChunkInput[]
}

export interface PersistParsedRevisionResult {
	insertedChunks: ChunkRecord[]
	insertedVariantCount: number
	chunkInsertLatencyMs: number
	lexicalFtsLatencyMs: number
	chunkVariantInsertLatencyMs: number
	revisionStateUpdateLatencyMs: number
	transactionLatencyMs: number
	metadataWriteLatencyMs: number
}

export interface JobRecord {
	jobId: string
	workspaceId: string
	runId: string
	jobType: string
	entityId: string
	state: JobState
	priority: number
	attemptCount: number
	nextAttemptAt: number
	lastError: string | null
	leaseOwner: string | null
	leaseExpiresAt: number | null
	createdAt: number
	updatedAt: number
}

export interface JobInput {
	workspaceId: string
	runId: string
	jobType: string
	entityId: string
	state?: JobState
	priority?: number
	nextAttemptAt?: number
}

export interface RunJobStateCounts {
	queued: number
	running: number
	done: number
	abandoned: number
	terminalFailed: number
}

export interface RunBacklogMetrics {
	parsedRevisions: number
	plannedRevisions: number
	stagedChunks: number
	stagedChunkBytes: number
	queuedUpsertJobs: number
	runningUpsertJobs: number
	queuedDeleteJobs: number
	runningDeleteJobs: number
	terminalFailedRevisions: number
	degradedRevisions: number
	terminalFailedChunks: number
	retryingJobs: number
	blockingReason: string
}

export interface RunProgressSnapshot {
	filesDiscovered: number
	filesHashed: number
	filesParsed: number
	filesPlanned: number
	filesCommitted: number
	stagedChunks: number
	stagedChunkBytes: number
	queuedUpsertJobs: number
	runningUpsertJobs: number
	queuedDeleteJobs: number
	runningDeleteJobs: number
	retryingParseRevisions: number
	terminalFailedParseRevisions: number
	retryingChunks: number
	terminalFailedChunks: number
	degradedRevisions: number
	terminalFailedRevisions: number
	parseThrottleMs: number
	averageParseBatchMs?: number
	averagePlanBatchMs?: number
	averageEmbedBatchMs?: number
	peakStagedChunks?: number
	peakQueuedJobs?: number
	blockingReason: string
}

export interface RunProgressRecord {
	runId: string
	state: IndexRunState
	triggerType: string
	startedAt: number
	completedAt: number | null
	lastHeartbeatAt: number | null
	heartbeatOwner: string | null
	blockingReason: string | null
	progress: RunProgressSnapshot | null
	errorMessage: string | null
}

export type IndexRunSampleStage =
	| "discovery"
	| "stat_hash"
	| "parse"
	| "planner"
	| "embed"
	| "delete"
	| "complete"
	| "error"
export type IndexRunSampleEventType =
	| "heartbeat"
	| "pressure_transition"
	| "stage_transition"
	| "recycle"
	| "throughput_drop"

export interface IndexRunTelemetryIdentity {
	buildVersion?: string | null
	buildTimestamp?: string | null
	buildSha?: string | null
	engineVersion?: string | null
	provider?: string | null
	modelId?: string | null
	runtimeKind?: string | null
	deviceHint?: string | null
}

export interface IndexRunSummaryInput extends IndexRunTelemetryIdentity {
	runId: string
	workspaceId: string
	triggerType: string
	state: IndexRunState
	startedAt: number
	completedAt?: number | null
	totalRunMs?: number | null
	discoveryMs?: number | null
	statHashMs?: number | null
	parseChunkMs?: number | null
	diffPlanningMs?: number | null
	embedUpsertMs?: number | null
	discoveredFiles?: number | null
	filesScanned?: number | null
	filesChanged?: number | null
	parsedChunks?: number | null
	plannedRevisions?: number | null
	syncedChunks?: number | null
	upsertedChunks?: number | null
	deletedChunks?: number | null
	committedRevisions?: number | null
	retryingParseRevisions?: number | null
	terminalFailedParseRevisions?: number | null
	retryingChunks?: number | null
	terminalFailedChunks?: number | null
	degradedRevisions?: number | null
	terminalFailedRevisions?: number | null
	chunksPerSecond?: number | null
	peakChunksPerSecond?: number | null
	averageBatchLatencyMs?: number | null
	peakBatchLatencyMs?: number | null
	averageEmbedLatencyMs?: number | null
	averageUpsertLatencyMs?: number | null
	averageMetadataCommitLatencyMs?: number | null
	averageIdleGapMs?: number | null
	peakIdleGapMs?: number | null
	peakBatchSize?: number | null
	peakEmbeddingCount?: number | null
	laneConcurrency?: number | null
	effectiveBatchSize?: number | null
	peakInFlightChunkCount?: number | null
	pressureSoftTransitions?: number | null
	pressureHardTransitions?: number | null
	pressureSoftDurationMs?: number | null
	pressureHardDurationMs?: number | null
	parseThrottleMs?: number | null
	peakStagedChunks?: number | null
	peakQueuedJobs?: number | null
	hostRssMB?: number | null
	hostHeapUsedMB?: number | null
	hostExternalMB?: number | null
	hostCpuPercent?: number | null
	trackedSidecarRssMB?: number | null
	parseSidecarRssMB?: number | null
	embedSidecarRssMB?: number | null
	gpuSampler?: string | null
	gpuUtilizationPercent?: number | null
	gpuMemoryPressurePercent?: number | null
	gpuInUseBytes?: number | null
	gpuAllocatedBytes?: number | null
	gpuPowerW?: number | null
	averageGpuUtilizationPercent?: number | null
	peakGpuUtilizationPercent?: number | null
	averageGpuInUseBytes?: number | null
	peakGpuInUseBytes?: number | null
	gpuSampleCount?: number | null
	embeddingsPerChunk?: number | null
	laneOccupancyPercent?: number | null
	embedActivePercent?: number | null
	blockedOnParsedRevisionsMs?: number | null
	blockedOnStagedChunksMs?: number | null
	lastBlockingReason?: string | null
	errorMessage?: string | null
}

export type IndexRunSummaryRecord = IndexRunSummaryInput

export interface IndexRunSampleInput {
	runId: string
	workspaceId: string
	recordedAt: number
	stage: IndexRunSampleStage
	eventType: IndexRunSampleEventType
	blockingReason?: string | null
	pressureState?: string | null
	pressureReasons?: string[] | null
	laneConcurrency?: number | null
	effectiveBatchSize?: number | null
	activeLaneCount?: number | null
	inFlightChunkCount?: number | null
	peakInFlightChunkCount?: number | null
	chunksPerSecond?: number | null
	peakChunksPerSecond?: number | null
	averageBatchLatencyMs?: number | null
	averageEmbedLatencyMs?: number | null
	averageUpsertLatencyMs?: number | null
	averageMetadataCommitLatencyMs?: number | null
	averageIdleGapMs?: number | null
	waitingForJobsMs?: number | null
	waitingForInFlightCapacityMs?: number | null
	waitingForPressureMs?: number | null
	requestedBatchSize?: number | null
	embeddingCount?: number | null
	providerBatchUtilization?: number | null
	embeddingsPerChunk?: number | null
	laneOccupancyPercent?: number | null
	embedActivePercent?: number | null
	stagedChunks?: number | null
	stagedChunkBytes?: number | null
	queuedUpsertJobs?: number | null
	runningUpsertJobs?: number | null
	queuedDeleteJobs?: number | null
	runningDeleteJobs?: number | null
	parsedRevisions?: number | null
	plannedRevisions?: number | null
	hostRssMB?: number | null
	hostHeapUsedMB?: number | null
	hostExternalMB?: number | null
	hostCpuPercent?: number | null
	trackedSidecarRssMB?: number | null
	parseSidecarRssMB?: number | null
	embedSidecarRssMB?: number | null
	gpuSampler?: string | null
	gpuUtilizationPercent?: number | null
	gpuMemoryPressurePercent?: number | null
	gpuInUseBytes?: number | null
	gpuAllocatedBytes?: number | null
	gpuPowerW?: number | null
	detailsJson?: string | null
}

export interface IndexRunSampleRecord extends IndexRunSampleInput {
	sampleId: string
}

export interface PlannedRevisionResolution {
	revisionId: string
	fileId: string
	previousRevisionId: string | null
	doneJobs: number
	queuedJobs: number
	runningJobs: number
	terminalFailedJobs: number
	totalJobs: number
}

export interface RevisionJobResolution {
	doneJobs: number
	queuedJobs: number
	runningJobs: number
	terminalFailedJobs: number
	totalJobs: number
}

export interface WatchEventRecord {
	eventId: string
	workspaceId: string
	relativePath: string
	eventType: string
	observedAt: number
	coalesced: boolean
}

export interface OversizedTrackedFileRecord {
	workspaceId: string
	relativePath: string
	normalizedPath: string
	status: OversizedTrackingStatus
	sizeBytes: number
	lastModifiedMtimeMs: number | null
	recommendation: "likely_useful" | "review_manually" | "probably_skip"
	reason: string
	approvedMaxBytes: number | null
	sourceRunId: string | null
	lastEvaluatedAt: number
}

export interface OversizedTrackedFileInput {
	workspaceId: string
	relativePath: string
	normalizedPath: string
	status: OversizedTrackingStatus
	sizeBytes: number
	lastModifiedMtimeMs?: number | null
	recommendation: "likely_useful" | "review_manually" | "probably_skip"
	reason: string
	approvedMaxBytes?: number | null
	sourceRunId?: string | null
	lastEvaluatedAt?: number
}

export interface PaginatedOversizedTrackedFiles {
	total: number
	actionable: number
	items: OversizedTrackedFileRecord[]
}

export interface StaleRunCleanupSummary {
	staleRunIds: string[]
	staleRunsMarkedFailed: number
	staleJobsAbandoned: number
	staleJobsPreservedForResume: number
	staleRevisionsFailed: number
	staleChunksAbandoned: number
	expiredRunsDeleted: number
	expiredJobsGarbageCollected: number
	expiredRevisionsGarbageCollected: number
	expiredChunksGarbageCollected: number
}

export interface RevisionWarningDetail {
	revisionId: string
	fileId: string
	relativePath: string
	state: "degraded" | "terminal_failed" | "failed"
	category: "parser_failed" | "failed" | "degraded"
	failureReason: string | null
	discoveredAt: number
}

export interface PaginatedRevisionWarningDetails {
	total: number
	items: RevisionWarningDetail[]
}

export type WarningDetailsFilter = "all" | "parser_failed" | "failed" | "degraded"
export type WarningDetailsSort = "severity" | "recent" | "path"
