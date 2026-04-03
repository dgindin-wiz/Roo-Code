import * as path from "path"
import { VectorStoreSearchResult } from "./interfaces"
import { IEmbedder } from "./interfaces/embedder"
import { IVectorStore } from "./interfaces/vector-store"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { SEARCH_EMBEDDING_TIMEOUT_MS } from "./constants"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Service responsible for searching the code index.
 */
export class CodeIndexSearchService {
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
	) {}

	/**
	 * Wraps a promise with a timeout. Rejects with a descriptive error if the
	 * promise does not settle within `timeoutMs` milliseconds.
	 */
	private _withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			promise.then(
				(value) => {
					clearTimeout(timer)
					resolve(value)
				},
				(error) => {
					clearTimeout(timer)
					reject(error)
				},
			)
		})
	}

	/**
	 * Searches the code index for relevant content.
	 *
	 * IMPORTANT: Search errors do NOT transition the system to Error state when
	 * indexing is in progress. A transient embedding or Qdrant failure during a
	 * search query should not abort an active indexing operation. The Error state
	 * is only set when the system is idle (Indexed state).
	 *
	 * @param query The search query
	 * @param directoryPrefix Optional directory path to filter results by
	 * @returns Array of search results
	 * @throws Error if the service is not properly configured or ready
	 */
	public async searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}

		const minScore = this.configManager.currentSearchMinScore
		const maxResults = this.configManager.currentSearchMaxResults

		const currentState = this.stateManager.getCurrentStatus().systemStatus
		if (currentState !== "Indexed" && currentState !== "Indexing") {
			// Allow search during Indexing too
			throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
		}

		try {
			// Generate embedding for query with timeout to prevent indefinite hangs.
			// The scanner has _withBatchTimeout() for indexing batches; search needs
			// the same protection since it calls the same embedder API.
			const embeddingResponse = await this._withTimeout(
				this.embedder.createEmbeddings([query], undefined, { isQuery: true }),
				SEARCH_EMBEDDING_TIMEOUT_MS,
				"Search embedding generation",
			)
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			// Handle directory prefix
			let normalizedPrefix: string | undefined = undefined
			if (directoryPrefix) {
				normalizedPrefix = path.normalize(directoryPrefix)
			}

			// Perform search
			const results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
			return results
		} catch (error) {
			console.error("[CodeIndexSearchService] Error during search:", error)

			// Only transition to Error state if we're in Indexed (idle) state.
			// If indexing is in progress, a search failure should NOT disrupt it —
			// the error is transient and the indexer should keep running.
			const stateAtError = this.stateManager.getCurrentStatus().systemStatus
			if (stateAtError !== "Indexing") {
				this.stateManager.setSystemState("Error", `Search failed: ${(error as Error).message}`)
			}

			// Capture telemetry for the error
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: (error as Error).message,
				stack: (error as Error).stack,
				location: "searchIndex",
			})

			throw error // Re-throw the error after setting state
		}
	}
}
