import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { CodeIndexDebugLexicalMode, CodeIndexDebugLexicalStatus } from "../engine/interfaces"

export interface RetrievalEvalFixture {
	id: string
	query: string
	expectedPaths?: string[]
	expectedSymbols?: string[]
	expectedChunkFingerprints?: string[]
	notes?: string
}

export interface RetrievalEvalHitSummary {
	rank: number
	filePath?: string
	symbol?: string
	chunkKind?: string
	variantType?: string
	score: number
	rerankScore?: number
	matchReasons?: string[]
}

export interface RetrievalEvalTimings {
	queryEmbeddingMs: number
	vectorRetrievalMs: number
	lexicalFtsMs: number
	lexicalFallbackMs: number
	lexicalRetrievalMs: number
	mergeMs: number
	rerankMs: number
	expansionMs: number
	totalMs: number
}

export interface RetrievalEvalStageResult {
	stage: "vector" | "lexical" | "merged" | "final"
	firstRelevantRank: number | null
	mrr: number
	recallAt: Record<number, number>
	topHits: RetrievalEvalHitSummary[]
	elapsedMs?: number
}

export interface RetrievalEvalQueryResult {
	fixture: RetrievalEvalFixture
	results: VectorStoreSearchResult[]
	firstRelevantRank: number | null
	mrr: number
	recallAt: Record<number, number>
	topHits: RetrievalEvalHitSummary[]
	lexicalStatus?: CodeIndexDebugLexicalStatus
	lexicalMode?: CodeIndexDebugLexicalMode
	stageResults?: RetrievalEvalStageResult[]
	timingsMs?: RetrievalEvalTimings
}

export interface RetrievalEvalAggregate {
	totalQueries: number
	mrr: number
	recallAt: Record<number, number>
}

export interface RetrievalEvalPerformanceAggregate {
	queryEmbeddingMs: number
	vectorRetrievalMs: number
	lexicalFtsMs: number
	lexicalFallbackMs: number
	lexicalRetrievalMs: number
	mergeMs: number
	rerankMs: number
	expansionMs: number
	totalMs: number
	lexicalCompletedQueries: number
	lexicalSkippedQueries: number
	lexicalFtsOnlyQueries: number
	lexicalExactFallbackQueries: number
}

export interface RetrievalEvalReport {
	queries: RetrievalEvalQueryResult[]
	aggregate: RetrievalEvalAggregate
	stageAggregates?: RetrievalEvalStageResult[]
	performance?: RetrievalEvalPerformanceAggregate
}

export interface IndexingBenchmarkScenario {
	id: string
	totalFiles: number
	changedFiles: number
	averageChunksPerFile: number
	parseFilesPerTick: number
	plannerFilesPerTick: number
	embedChunksPerTick: number
	deleteChunksPerTick?: number
	parseRetryRate?: number
	chunkRetryRate?: number
	terminalChunkFailureRate?: number
	ticks?: number
	slowEmbedEveryTicks?: number
	slowEmbedMultiplier?: number
}

export interface IndexingBenchmarkTickSnapshot {
	tick: number
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
	retryingChunks: number
	terminalFailedRevisions: number
	terminalFailedChunks: number
	blockingReason: string
	parseThrottled: boolean
}

export interface IndexingBenchmarkAggregate {
	totalTicks: number
	completed: boolean
	filesCommitted: number
	peakStagedChunks: number
	peakStagedChunkBytes: number
	peakQueuedJobs: number
	parseThrottleTicks: number
	retryingParseRevisions: number
	retryingChunks: number
	terminalFailedRevisions: number
	terminalFailedChunks: number
	finalBlockingReason: string
}

export interface IndexingBenchmarkReport {
	scenario: IndexingBenchmarkScenario
	aggregate: IndexingBenchmarkAggregate
	snapshots: IndexingBenchmarkTickSnapshot[]
}

export interface IndexingTelemetryTrend {
	runId: string
	startedAt: number
	state: string
	filesChanged?: number | null
	totalRunMs?: number | null
	chunksPerSecond?: number | null
	pressureHardTransitions?: number | null
	hostRssMB?: number | null
}

export interface IndexingTelemetryReport {
	runId?: string
	dbPath: string
	logFiles: string[]
	workspaceId?: string
	summary?: Record<string, unknown>
	samples: Array<Record<string, unknown>>
	recentRuns: IndexingTelemetryTrend[]
	analysis?: {
		averageEmbedLatencyMs?: number
		averageUpsertLatencyMs?: number
		embedTimeSharePercent?: number
		upsertTimeSharePercent?: number
		averageGpuUtilizationPercent?: number
		peakGpuUtilizationPercent?: number
		averageGpuInUseBytes?: number
		peakGpuInUseBytes?: number
		gpuSampleCount?: number
		embeddingsPerChunk?: number
		laneOccupancyPercent?: number
		embedActivePercent?: number
		blockedOnParsedRevisionsMs?: number
		blockedOnStagedChunksMs?: number
	}
	diagnosis?: {
		completed: boolean
		lastTimestamp?: string
		lastMessage?: string
		lastBlockingReason?: string
	}
}
