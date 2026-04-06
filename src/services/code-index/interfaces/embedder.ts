export interface EmbedderDebugContext {
	runId?: string
	batchId?: string
	outerBatchSize?: number
}

export interface EmbedderCreateEmbeddingsOptions {
	isQuery?: boolean
	signal?: AbortSignal
	debugContext?: EmbedderDebugContext
}

/**
 * Interface for code index embedders.
 * This interface is implemented by both OpenAI and Ollama embedders.
 */
export interface IEmbedder {
	/**
	 * Creates embeddings for the given texts.
	 * @param texts Array of text strings to create embeddings for
	 * @param model Optional model ID to use for embeddings
	 * @param options Optional embedding options
	 * @param options.isQuery When true, applies query-specific prefixes for asymmetric models
	 *   (e.g., nomic-embed-code requires "Represent this query for searching relevant code: " for queries
	 *   but no prefix for documents). Defaults to false (document embedding).
	 * @returns Promise resolving to an EmbeddingResponse
	 */
	createEmbeddings(
		texts: string[],
		model?: string,
		options?: EmbedderCreateEmbeddingsOptions,
	): Promise<EmbeddingResponse>

	/**
	 * Validates the embedder configuration by testing connectivity and credentials.
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	validateConfiguration(): Promise<{ valid: boolean; error?: string }>

	/**
	 * Recycles the underlying HTTP client to release accumulated native memory.
	 * Called periodically by the scanner during long indexing runs.
	 * Optional — embedders using stateless transports (e.g. fetch) can skip this.
	 * Returns a Promise so the caller can await socket teardown (critical for
	 * freeing V8 external memory — unawaited destroys never process close events).
	 */
	recycleClient?(): Promise<void>

	get embedderInfo(): EmbedderInfo
}

export interface EmbeddingResponse {
	embeddings: number[][]
	usage?: {
		promptTokens: number
		totalTokens: number
	}
}

export type AvailableEmbedders =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "mistral"
	| "vercel-ai-gateway"
	| "bedrock"
	| "openrouter"

export interface EmbedderInfo {
	name: AvailableEmbedders
}
