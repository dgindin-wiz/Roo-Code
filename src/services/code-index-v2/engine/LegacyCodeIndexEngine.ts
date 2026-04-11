import { VectorStoreSearchResult } from "../../code-index/interfaces"
import { CODE_INDEX_LEGACY_ENGINE_ID } from "../shared/constants"
import { CodeIndexStatus, ICodeIndexEngine } from "./interfaces"

interface LegacyCodeIndexEngineDeps {
	startIndexing: () => Promise<void>
	stopIndexing: () => void
	clearIndexData: () => Promise<void>
	searchIndex: (query: string, limit: number) => Promise<VectorStoreSearchResult[]>
	getStatus: () => { systemStatus: string; message?: string }
}

export class LegacyCodeIndexEngine implements ICodeIndexEngine {
	public readonly engine = CODE_INDEX_LEGACY_ENGINE_ID

	constructor(private readonly deps: LegacyCodeIndexEngineDeps) {}

	async start(): Promise<void> {
		await this.deps.startIndexing()
	}

	async refreshAll(): Promise<void> {
		await this.deps.startIndexing()
	}

	async stop(): Promise<void> {
		this.deps.stopIndexing()
	}

	async clear(): Promise<void> {
		await this.deps.clearIndexData()
	}

	async clearDatabase(): Promise<void> {
		await this.deps.clearIndexData()
	}

	async search(
		query: string,
		limit: number,
		_options?: { directoryPrefix?: string },
	): Promise<VectorStoreSearchResult[]> {
		return this.deps.searchIndex(query, limit)
	}

	async enqueuePathsChanged(_paths: string[], _reason: "watcher" | "manual" | "reconcile"): Promise<void> {
		// Legacy engine does not expose a targeted enqueue API yet.
	}

	async getStatus(): Promise<CodeIndexStatus> {
		const current = this.deps.getStatus()
		const mappedState =
			current.systemStatus === "Indexing"
				? "running"
				: current.systemStatus === "Stopping"
					? "stopping"
					: current.systemStatus === "Error"
						? "error"
						: "idle"

		return {
			engine: this.engine,
			state: mappedState,
			message: current.message,
		}
	}

	async getWarningDetails(): Promise<{
		total: number
		items: Array<{
			relativePath: string
			state: "degraded" | "terminal_failed" | "failed"
			category?: "parser_failed" | "failed" | "degraded"
			failureReason?: string | null
		}>
	}> {
		return {
			total: 0,
			items: [],
		}
	}

	async getOversizedFileDetails(): Promise<{
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
	}> {
		return {
			total: 0,
			actionable: 0,
			items: [],
		}
	}

	async retryWarningFiles(
		_filter?: "all" | "parser_failed" | "failed" | "degraded",
		_relativePaths?: string[],
	): Promise<{ retriedFiles: number }> {
		return { retriedFiles: 0 }
	}
}
