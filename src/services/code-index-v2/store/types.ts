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

export type JobState = "queued" | "running" | "done" | "abandoned" | "terminal_failed"

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
