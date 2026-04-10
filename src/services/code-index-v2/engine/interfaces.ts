import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { CodeIndexEngineKind } from "../shared/constants"

export type CodeIndexDebugLexicalStatus = "completed" | "skipped"
export type CodeIndexDebugLexicalMode = "none" | "fts_only" | "fts_plus_exact_fallback"

export interface CodeIndexDebugSearchTimings {
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

export interface CodeIndexDebugSearchTrace {
	query: string
	limit: number
	candidateLimit: number
	lexicalStatus: CodeIndexDebugLexicalStatus
	lexicalMode: CodeIndexDebugLexicalMode
	timingsMs: CodeIndexDebugSearchTimings
	stages: {
		vector: VectorStoreSearchResult[]
		lexical: VectorStoreSearchResult[]
		merged: VectorStoreSearchResult[]
		final: VectorStoreSearchResult[]
	}
}

export interface CodeIndexStatus {
	engine: CodeIndexEngineKind
	state: "idle" | "starting" | "running" | "stopping" | "error"
	message?: string
}

export interface ICodeIndexEngine {
	readonly engine: CodeIndexEngineKind

	start(): Promise<void>
	refreshAll(): Promise<void>
	stop(): Promise<void>
	clear(): Promise<void>
	clearDatabase?(): Promise<void>
	search(query: string, limit: number): Promise<VectorStoreSearchResult[]>
	searchDebug?(query: string, limit: number): Promise<CodeIndexDebugSearchTrace>
	enqueuePathsChanged(paths: string[], reason: "watcher" | "manual" | "reconcile"): Promise<void>
	getStatus(): Promise<CodeIndexStatus>
	getWarningDetails(
		offset: number,
		limit: number,
		filter: "all" | "parser_failed" | "failed" | "degraded",
		sort: "severity" | "recent" | "path",
	): Promise<{
		total: number
		items: Array<{
			relativePath: string
			state: "degraded" | "terminal_failed" | "failed"
			category?: "parser_failed" | "failed" | "degraded"
			failureReason?: string | null
		}>
	}>
	getOversizedFileDetails(
		offset: number,
		limit: number,
	): Promise<{
		total: number
		actionable: number
		items: Array<{
			relativePath: string
			normalizedPath: string
			status: "skipped" | "needs_reapproval" | "approved" | "eligible" | "missing"
			sizeBytes: number
			lastModifiedMtimeMs: number | null
			recommendation: "likely_useful" | "review_manually" | "probably_skip"
			reason: string
			approvedMaxBytes: number | null
			lastEvaluatedAt: number
		}>
	}>
	retryWarningFiles(
		filter: "all" | "parser_failed" | "failed" | "degraded",
		relativePaths?: string[],
	): Promise<{ retriedFiles: number }>
}
