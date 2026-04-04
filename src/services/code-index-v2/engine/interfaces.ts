import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { CodeIndexEngineKind } from "../shared/constants"

export interface CodeIndexStatus {
	engine: CodeIndexEngineKind
	state: "idle" | "starting" | "running" | "stopping" | "error"
	message?: string
}

export interface ICodeIndexEngine {
	readonly engine: CodeIndexEngineKind

	start(): Promise<void>
	stop(): Promise<void>
	clear(): Promise<void>
	search(query: string, limit: number): Promise<VectorStoreSearchResult[]>
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
	retryWarningFiles(
		filter: "all" | "parser_failed" | "failed" | "degraded",
		relativePaths?: string[],
	): Promise<{ retriedFiles: number }>
}
