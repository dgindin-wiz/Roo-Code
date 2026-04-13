import { OpenAI } from "openai"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { createIsolatedFetch, type IsolatedFetch } from "../utils/isolated-fetch"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES as MAX_RETRIES,
	INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { getDefaultModelId, getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import {
	withValidationErrorHandling,
	HttpError,
	formatEmbeddingError,
	parseRetryAfterMs,
} from "../shared/validation-helpers"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { Mutex } from "async-mutex"
import { handleOpenAIError } from "../../../api/providers/utils/openai-error-handler"
import { IndexDebugLoggerV2 } from "../../code-index-v2/logging/IndexDebugLoggerV2"
import { EmbedderCreateEmbeddingsOptions } from "../interfaces/embedder"

interface EmbeddingItem {
	embedding: string | number[]
	[key: string]: any
}

interface OpenAIEmbeddingResponse {
	data: EmbeddingItem[]
	usage?: {
		prompt_tokens?: number
		total_tokens?: number
	}
}

/**
 * OpenAI Compatible implementation of the embedder interface with batching and rate limiting.
 * This embedder allows using any OpenAI-compatible API endpoint by specifying a custom baseURL.
 */

export class OpenAICompatibleEmbedder implements IEmbedder {
	private static readonly PROVIDER_REQUEST_SOFT_LATENCY_MS = 4_000
	private static readonly PROVIDER_REQUEST_HARD_LATENCY_MS = 7_000
	private static readonly PROVIDER_REQUEST_FAST_LATENCY_MS = 1_500
	private static readonly PROVIDER_REQUEST_FAST_STREAK_FOR_GROWTH = 3
	private static readonly PROVIDER_REQUEST_MIN_ITEM_CAP = 32
	private static readonly PROVIDER_REQUEST_SOFT_REDUCTION_FACTOR = 0.8
	private static readonly PROVIDER_REQUEST_HARD_REDUCTION_FACTOR = 0.6
	private static readonly PROVIDER_REQUEST_GROWTH_FACTOR = 1.25
	private embeddingsClient: OpenAI
	private _isolatedFetch!: IsolatedFetch
	private readonly defaultModelId: string
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly isFullUrl: boolean
	private readonly maxItemTokens: number
	private providerRequestItemCap?: number
	private fastProviderRequestStreak = 0

	// Global rate limiting state shared across all instances
	private static globalRateLimitState = {
		isRateLimited: false,
		rateLimitResetTime: 0,
		consecutiveRateLimitErrors: 0,
		lastRateLimitError: 0,
		// Mutex to ensure thread-safe access to rate limit state
		mutex: new Mutex(),
	}

	/**
	 * Creates a new OpenAI Compatible embedder
	 * @param baseUrl The base URL for the OpenAI-compatible API endpoint
	 * @param apiKey The API key for authentication
	 * @param modelId Optional model identifier (defaults to "text-embedding-3-small")
	 * @param maxItemTokens Optional maximum tokens per item (defaults to MAX_ITEM_TOKENS)
	 */
	constructor(baseUrl: string, apiKey: string, modelId?: string, maxItemTokens?: number) {
		if (!baseUrl) {
			throw new Error(t("embeddings:validation.baseUrlRequired"))
		}
		if (!apiKey) {
			throw new Error(t("embeddings:validation.apiKeyRequired"))
		}

		this.baseUrl = baseUrl
		this.apiKey = apiKey

		// Create a dedicated undici Agent so recycleClient() can destroy it
		// and immediately free native connection pool buffers.
		this._isolatedFetch = createIsolatedFetch()

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			this.embeddingsClient = new OpenAI({
				baseURL: baseUrl,
				apiKey: apiKey,
				fetch: this._isolatedFetch.fetch,
			})
		} catch (error) {
			this._isolatedFetch.destroy()
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "OpenAI Compatible")
		}

		this.defaultModelId = modelId || getDefaultModelId("openai-compatible")
		// Cache the URL type check for performance
		this.isFullUrl = this.isFullEndpointUrl(baseUrl)
		this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
	}

	/**
	 * Recreates the underlying OpenAI HTTP client to release accumulated native
	 * memory (undici connection pool buffers). Called periodically by the scanner
	 * during long indexing runs to prevent external memory growth.
	 */
	async recycleClient(): Promise<void> {
		try {
			// Destroy the old Agent's connections and AWAIT socket teardown.
			// Awaiting is CRITICAL — without it, the socket close events never
			// get processed and native TLS buffers accumulate in V8 external memory.
			await this._isolatedFetch.destroy()
			this._isolatedFetch = createIsolatedFetch()
			this.embeddingsClient = new OpenAI({
				baseURL: this.baseUrl,
				apiKey: this.apiKey,
				fetch: this._isolatedFetch.fetch,
			})
		} catch {
			// If recreation fails, keep the existing client
		}
	}

	/**
	 * Creates embeddings for the given texts with batching and rate limiting
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(
		texts: string[],
		model?: string,
		options?: EmbedderCreateEmbeddingsOptions,
	): Promise<EmbeddingResponse> {
		if (options?.signal?.aborted) {
			throw new Error("Embedding request aborted")
		}

		const modelToUse = model || this.defaultModelId
		const requestStartedAt = Date.now()

		// Apply model-specific query prefix only for search queries (asymmetric embedding)
		// Document embeddings during indexing should NOT get the query prefix
		const queryPrefix = options?.isQuery ? getModelQueryPrefix("openai-compatible", modelToUse) : undefined
		const processedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					const prefixedText = `${queryPrefix}${text}`
					const estimatedTokens = Math.ceil(prefixedText.length / 4)
					if (estimatedTokens > MAX_ITEM_TOKENS) {
						console.warn(
							t("embeddings:textWithPrefixExceedsTokenLimit", {
								index,
								estimatedTokens,
								maxTokens: MAX_ITEM_TOKENS,
							}),
						)
						// Return original text if adding prefix would exceed limit
						return text
					}
					return prefixedText
				})
			: texts

		const allEmbeddings: number[][] = []
		const usage = { promptTokens: 0, totalTokens: 0 }
		const remainingTexts = [...processedTexts]
		let providerRequests = 0
		let providerRequestLatencyMs = 0
		let peakProviderRequestLatencyMs = 0
		let maxProviderRequestBatchSize = 0
		let maxProviderRequestTokens = 0

		IndexDebugLoggerV2.log("basic", "OpenAICompatibleEmbedder", "embedder-create-start", {
			component: "OpenAICompatibleEmbedder",
			runId: options?.debugContext?.runId,
			jobId: options?.debugContext?.batchId,
			provider: "openai-compatible",
			modelId: modelToUse,
			outerBatchSize: options?.debugContext?.outerBatchSize ?? texts.length,
			inputTexts: texts.length,
			processedTexts: processedTexts.length,
			isQuery: options?.isQuery ?? false,
			providerRequestItemCap: this.providerRequestItemCap,
		})

		while (remainingTexts.length > 0) {
			const activeProviderRequestItemCap = this.providerRequestItemCap
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > this.maxItemTokens) {
					console.warn(
						t("embeddings:textExceedsTokenLimit", {
							index: i,
							itemTokens,
							maxTokens: this.maxItemTokens,
						}),
					)
					processedIndices.push(i)
					continue
				}

				const withinTokenLimit = currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS
				const withinItemLimit =
					activeProviderRequestItemCap === undefined || currentBatch.length < activeProviderRequestItemCap

				if (withinTokenLimit && withinItemLimit) {
					currentBatch.push(text)
					currentBatchTokens += itemTokens
					processedIndices.push(i)
				} else {
					break
				}
			}

			// Remove processed items from remainingTexts (in reverse order to maintain correct indices)
			for (let i = processedIndices.length - 1; i >= 0; i--) {
				remainingTexts.splice(processedIndices[i], 1)
			}

			if (currentBatch.length > 0) {
				const batchResult = await this._embedBatchWithRetries(
					currentBatch,
					modelToUse,
					options?.debugContext,
					options?.signal,
				)
				allEmbeddings.push(...batchResult.embeddings)
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
				providerRequests++
				providerRequestLatencyMs += batchResult.requestLatencyMs
				peakProviderRequestLatencyMs = Math.max(peakProviderRequestLatencyMs, batchResult.requestLatencyMs)
				maxProviderRequestBatchSize = Math.max(maxProviderRequestBatchSize, currentBatch.length)
				maxProviderRequestTokens = Math.max(maxProviderRequestTokens, currentBatchTokens)

				IndexDebugLoggerV2.log("basic", "OpenAICompatibleEmbedder", "embedder-provider-batch", {
					component: "OpenAICompatibleEmbedder",
					runId: options?.debugContext?.runId,
					jobId: options?.debugContext?.batchId,
					provider: "openai-compatible",
					modelId: modelToUse,
					providerRequestIndex: providerRequests,
					providerRequestItemCap: activeProviderRequestItemCap,
					providerBatchSize: currentBatch.length,
					providerBatchTokens: currentBatchTokens,
					providerRequestLatencyMs: batchResult.requestLatencyMs,
					providerPromptTokens: batchResult.usage.promptTokens,
					providerTotalTokens: batchResult.usage.totalTokens,
				})

				this.updateProviderRequestItemCap(
					currentBatch.length,
					batchResult.requestLatencyMs,
					modelToUse,
					options?.debugContext,
				)
			}
		}

		IndexDebugLoggerV2.log("basic", "OpenAICompatibleEmbedder", "embedder-create-complete", {
			component: "OpenAICompatibleEmbedder",
			runId: options?.debugContext?.runId,
			jobId: options?.debugContext?.batchId,
			provider: "openai-compatible",
			modelId: modelToUse,
			outerBatchSize: options?.debugContext?.outerBatchSize ?? texts.length,
			inputTexts: texts.length,
			outputEmbeddings: allEmbeddings.length,
			providerRequests,
			providerRequestItemCap: this.providerRequestItemCap,
			totalProviderLatencyMs: providerRequestLatencyMs,
			averageProviderLatencyMs: providerRequests > 0 ? providerRequestLatencyMs / providerRequests : undefined,
			peakProviderLatencyMs: peakProviderRequestLatencyMs > 0 ? peakProviderRequestLatencyMs : undefined,
			maxProviderRequestBatchSize: maxProviderRequestBatchSize > 0 ? maxProviderRequestBatchSize : undefined,
			maxProviderRequestTokens: maxProviderRequestTokens > 0 ? maxProviderRequestTokens : undefined,
			totalElapsedMs: Date.now() - requestStartedAt,
		})

		return { embeddings: allEmbeddings, usage }
	}

	/**
	 * Determines if the provided URL is a full endpoint URL or a base URL that needs the endpoint appended by the SDK.
	 * Uses smart pattern matching for known providers while accepting we can't cover all possible patterns.
	 * @param url The URL to check
	 * @returns true if it's a full endpoint URL, false if it's a base URL
	 */
	private isFullEndpointUrl(url: string): boolean {
		// Known patterns for major providers
		const patterns = [
			// Azure OpenAI: /deployments/{deployment-name}/embeddings
			/\/deployments\/[^\/]+\/embeddings(\?|$)/,
			// Azure Databricks: /serving-endpoints/{endpoint-name}/invocations
			/\/serving-endpoints\/[^\/]+\/invocations(\?|$)/,
			// Direct endpoints: ends with /embeddings (before query params)
			/\/embeddings(\?|$)/,
			// Some providers use /embed instead of /embeddings
			/\/embed(\?|$)/,
		]

		return patterns.some((pattern) => pattern.test(url))
	}

	private updateProviderRequestItemCap(
		batchSize: number,
		requestLatencyMs: number,
		modelId: string,
		debugContext?: EmbedderCreateEmbeddingsOptions["debugContext"],
	): void {
		const previousCap = this.providerRequestItemCap
		let nextCap = previousCap
		let adjustmentReason: "soft_latency" | "hard_latency" | "recovered_latency" | undefined

		if (
			requestLatencyMs >= OpenAICompatibleEmbedder.PROVIDER_REQUEST_HARD_LATENCY_MS &&
			batchSize > OpenAICompatibleEmbedder.PROVIDER_REQUEST_MIN_ITEM_CAP
		) {
			nextCap = Math.max(
				OpenAICompatibleEmbedder.PROVIDER_REQUEST_MIN_ITEM_CAP,
				Math.floor(batchSize * OpenAICompatibleEmbedder.PROVIDER_REQUEST_HARD_REDUCTION_FACTOR),
			)
			this.fastProviderRequestStreak = 0
			adjustmentReason = "hard_latency"
		} else if (
			requestLatencyMs >= OpenAICompatibleEmbedder.PROVIDER_REQUEST_SOFT_LATENCY_MS &&
			batchSize > OpenAICompatibleEmbedder.PROVIDER_REQUEST_MIN_ITEM_CAP
		) {
			const reducedCap = Math.max(
				OpenAICompatibleEmbedder.PROVIDER_REQUEST_MIN_ITEM_CAP,
				Math.floor(batchSize * OpenAICompatibleEmbedder.PROVIDER_REQUEST_SOFT_REDUCTION_FACTOR),
			)
			nextCap = previousCap === undefined ? reducedCap : Math.min(previousCap, reducedCap)
			this.fastProviderRequestStreak = 0
			adjustmentReason = "soft_latency"
		} else if (
			previousCap !== undefined &&
			requestLatencyMs <= OpenAICompatibleEmbedder.PROVIDER_REQUEST_FAST_LATENCY_MS
		) {
			this.fastProviderRequestStreak += 1

			if (this.fastProviderRequestStreak >= OpenAICompatibleEmbedder.PROVIDER_REQUEST_FAST_STREAK_FOR_GROWTH) {
				nextCap = Math.max(
					previousCap + 1,
					Math.ceil(previousCap * OpenAICompatibleEmbedder.PROVIDER_REQUEST_GROWTH_FACTOR),
				)
				this.fastProviderRequestStreak = 0
				adjustmentReason = "recovered_latency"
			}
		} else {
			this.fastProviderRequestStreak = 0
		}

		if (nextCap !== previousCap) {
			this.providerRequestItemCap = nextCap
			IndexDebugLoggerV2.log("basic", "OpenAICompatibleEmbedder", "embedder-provider-request-cap-adjusted", {
				component: "OpenAICompatibleEmbedder",
				runId: debugContext?.runId,
				jobId: debugContext?.batchId,
				provider: "openai-compatible",
				modelId,
				providerRequestBatchSize: batchSize,
				providerRequestLatencyMs: requestLatencyMs,
				previousProviderRequestItemCap: previousCap,
				providerRequestItemCap: nextCap,
				adjustmentReason,
			})
		}
	}

	/**
	 * Makes a direct HTTP request to the embeddings endpoint
	 * Used when the user provides a full endpoint URL (e.g., Azure OpenAI with query parameters)
	 * @param url The full endpoint URL
	 * @param batchTexts Array of texts to embed
	 * @param model Model identifier to use
	 * @returns Promise resolving to OpenAI-compatible response
	 */
	private async makeDirectEmbeddingRequest(
		url: string,
		batchTexts: string[],
		model: string,
		signal?: AbortSignal,
	): Promise<OpenAIEmbeddingResponse> {
		// Use the isolated fetch (private undici Agent) instead of global fetch.
		// Global fetch routes through Node's shared dispatcher whose native TLS
		// buffers are never freed, causing monotonic external memory growth.
		const response = await this._isolatedFetch.fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// Azure OpenAI uses 'api-key' header, while OpenAI uses 'Authorization'
				// We'll try 'api-key' first for Azure compatibility
				"api-key": this.apiKey,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				input: batchTexts,
				model: model,
				encoding_format: "base64",
			}),
			signal,
		})

		if (!response || !response.ok) {
			const status = response?.status || 0
			let errorText = "No response"
			try {
				if (response && typeof response.text === "function") {
					errorText = await response.text()
				} else if (response) {
					errorText = `Error ${status}`
				}
			} catch {
				// Ignore text parsing errors
				errorText = `Error ${status}`
			}
			const error = new Error(`HTTP ${status}: ${errorText}`) as HttpError
			error.status = status || response?.status || 0
			// Capture response headers for Retry-After parsing
			if (response?.headers) {
				error.response = {
					status: response.status,
					headers: response.headers,
				}
			}
			throw error
		}

		try {
			return await response.json()
		} catch (e) {
			const error = new Error(`Failed to parse response JSON`) as HttpError
			error.status = response.status
			throw error
		}
	}

	/**
	 * Helper method to handle batch embedding with retries and exponential backoff
	 * @param batchTexts Array of texts to embed in this batch
	 * @param model Model identifier to use
	 * @returns Promise resolving to embeddings and usage statistics
	 */
	private async _embedBatchWithRetries(
		batchTexts: string[],
		model: string,
		debugContext?: EmbedderCreateEmbeddingsOptions["debugContext"],
		signal?: AbortSignal,
	): Promise<{
		embeddings: number[][]
		usage: { promptTokens: number; totalTokens: number }
		requestLatencyMs: number
	}> {
		// Use cached value for performance
		const isFullUrl = this.isFullUrl

		for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
			if (signal?.aborted) {
				throw new Error("Embedding request aborted")
			}

			// Check global rate limit before attempting request
			await this.waitForGlobalRateLimit()

			try {
				let response: OpenAIEmbeddingResponse
				const requestStartedAt = Date.now()

				if (isFullUrl) {
					// Use direct HTTP request for full endpoint URLs
					response = await this.makeDirectEmbeddingRequest(this.baseUrl, batchTexts, model, signal)
				} else {
					// Use OpenAI SDK for base URLs
					const requestBody = {
						input: batchTexts,
						model: model,
						// OpenAI package (as of v4.78.1) has a parsing issue that truncates embedding dimensions to 256
						// when processing numeric arrays, which breaks compatibility with models using larger dimensions.
						// By requesting base64 encoding, we bypass the package's parser and handle decoding ourselves.
						encoding_format: "base64" as const,
					}
					response = signal
						? ((await this.embeddingsClient.embeddings.create(requestBody, {
								signal,
							} as any)) as OpenAIEmbeddingResponse)
						: ((await this.embeddingsClient.embeddings.create(requestBody)) as OpenAIEmbeddingResponse)
				}
				const requestLatencyMs = Date.now() - requestStartedAt

				// Decode base64 embeddings in a single pass and avoid extra map/object churn
				// on the extension-host thread during large indexing runs.
				const embeddings = new Array<number[]>(response.data.length)
				for (let index = 0; index < response.data.length; index++) {
					const item = response.data[index]
					if (typeof item.embedding === "string") {
						const buffer = Buffer.from(item.embedding, "base64")
						const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
						const decoded = new Array<number>(float32.length)
						for (let valueIndex = 0; valueIndex < float32.length; valueIndex++) {
							decoded[valueIndex] = float32[valueIndex]!
						}
						embeddings[index] = decoded
					} else {
						embeddings[index] = item.embedding as number[]
					}
				}

				return {
					embeddings: embeddings,
					usage: {
						promptTokens: response.usage?.prompt_tokens || 0,
						totalTokens: response.usage?.total_tokens || 0,
					},
					requestLatencyMs,
				}
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && /aborted/i.test(error.message))) {
					throw new Error("Embedding request aborted")
				}

				// Capture telemetry before error is reformatted
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "OpenAICompatibleEmbedder:_embedBatchWithRetries",
					attempt: attempts + 1,
				})

				const hasMoreAttempts = attempts < MAX_RETRIES - 1

				// Check if it's a rate limit error
				const httpError = error as HttpError
				if (httpError?.status === 429) {
					// Update global rate limit state
					await this.updateGlobalRateLimitState(httpError)

					if (hasMoreAttempts) {
						// Calculate delay: prefer server's Retry-After header, fall back to exponential backoff
						const retryAfterDelay = parseRetryAfterMs(httpError)
						const baseDelay = INITIAL_DELAY_MS * Math.pow(2, attempts)
						const globalDelay = await this.getGlobalRateLimitDelay()
						const delayMs = retryAfterDelay ?? Math.max(baseDelay, globalDelay)

						console.warn(
							t("embeddings:rateLimitRetry", {
								delayMs,
								attempt: attempts + 1,
								maxRetries: MAX_RETRIES,
							}),
						)
						IndexDebugLoggerV2.log("basic", "OpenAICompatibleEmbedder", "embedder-provider-retry", {
							component: "OpenAICompatibleEmbedder",
							runId: debugContext?.runId,
							jobId: debugContext?.batchId,
							provider: "openai-compatible",
							modelId: model,
							attempt: attempts + 1,
							delayMs,
							providerBatchSize: batchTexts.length,
							errorMessage: error instanceof Error ? error.message : String(error),
						})
						await new Promise((resolve) => setTimeout(resolve, delayMs))
						continue
					}
				}

				// Log the error for debugging
				console.error(`OpenAI Compatible embedder error (attempt ${attempts + 1}/${MAX_RETRIES}):`, error)

				// Format and throw the error
				throw formatEmbeddingError(error, MAX_RETRIES)
			}
		}

		throw new Error(t("embeddings:failedMaxAttempts", { attempts: MAX_RETRIES }))
	}

	/**
	 * Validates the OpenAI-compatible embedder configuration by testing endpoint connectivity and API key
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				// Test with a minimal embedding request
				const testTexts = ["test"]
				const modelToUse = this.defaultModelId

				let response: OpenAIEmbeddingResponse

				if (this.isFullUrl) {
					// Test direct HTTP request for full endpoint URLs
					response = await this.makeDirectEmbeddingRequest(this.baseUrl, testTexts, modelToUse)
				} else {
					// Test using OpenAI SDK for base URLs
					response = (await this.embeddingsClient.embeddings.create({
						input: testTexts,
						model: modelToUse,
						encoding_format: "base64",
					})) as OpenAIEmbeddingResponse
				}

				// Check if we got a valid response
				if (!response?.data || response.data.length === 0) {
					return {
						valid: false,
						error: "embeddings:validation.invalidResponse",
					}
				}

				return { valid: true }
			} catch (error) {
				// Capture telemetry for validation errors
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "OpenAICompatibleEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "openai-compatible")
	}

	/**
	 * Returns information about this embedder
	 */
	get embedderInfo(): EmbedderInfo {
		return {
			name: "openai-compatible",
		}
	}

	/**
	 * Waits if there's an active global rate limit
	 */
	private async waitForGlobalRateLimit(): Promise<void> {
		const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
		try {
			const state = OpenAICompatibleEmbedder.globalRateLimitState

			if (state.isRateLimited && state.rateLimitResetTime > Date.now()) {
				const waitTime = state.rateLimitResetTime - Date.now()
				// Silent wait - no logging to prevent flooding
				release() // Release mutex before waiting
				await new Promise((resolve) => setTimeout(resolve, waitTime))
				return
			}

			// Reset rate limit if time has passed
			if (state.isRateLimited && state.rateLimitResetTime <= Date.now()) {
				state.isRateLimited = false
				state.consecutiveRateLimitErrors = 0
			}
		} finally {
			// Only release if we haven't already
			try {
				release()
			} catch {
				// Already released
			}
		}
	}

	/**
	 * Updates global rate limit state when a 429 error occurs
	 */
	private async updateGlobalRateLimitState(error: HttpError): Promise<void> {
		const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
		try {
			const state = OpenAICompatibleEmbedder.globalRateLimitState
			const now = Date.now()

			// Increment consecutive rate limit errors
			if (now - state.lastRateLimitError < 60000) {
				// Within 1 minute
				state.consecutiveRateLimitErrors++
			} else {
				state.consecutiveRateLimitErrors = 1
			}

			state.lastRateLimitError = now

			// Calculate exponential backoff based on consecutive errors
			const baseDelay = 5000 // 5 seconds base
			const maxDelay = 300000 // 5 minutes max
			const exponentialDelay = Math.min(baseDelay * Math.pow(2, state.consecutiveRateLimitErrors - 1), maxDelay)

			// Set global rate limit
			state.isRateLimited = true
			state.rateLimitResetTime = now + exponentialDelay

			// Silent rate limit activation - no logging to prevent flooding
		} finally {
			release()
		}
	}

	/**
	 * Gets the current global rate limit delay
	 */
	private async getGlobalRateLimitDelay(): Promise<number> {
		const release = await OpenAICompatibleEmbedder.globalRateLimitState.mutex.acquire()
		try {
			const state = OpenAICompatibleEmbedder.globalRateLimitState

			if (state.isRateLimited && state.rateLimitResetTime > Date.now()) {
				return state.rateLimitResetTime - Date.now()
			}

			return 0
		} finally {
			release()
		}
	}
}
