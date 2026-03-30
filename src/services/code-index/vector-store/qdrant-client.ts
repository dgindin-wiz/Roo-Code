import { QdrantClient, Schemas } from "@qdrant/js-client-rest"
import { createHash } from "crypto"
import * as path from "path"
import { v5 as uuidv5 } from "uuid"
import { IVectorStore } from "../interfaces/vector-store"
import { Payload, VectorStoreSearchResult } from "../interfaces"
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_MIN_SCORE, QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"
import { t } from "../../../i18n"

/**
 * Custom error class for transient Qdrant connectivity issues.
 * Thrown when the error is likely temporary (network hiccup, server restart)
 * and the caller should NOT assume the collection is missing.
 */
export class QdrantTransientError extends Error {
	constructor(
		message: string,
		public override readonly cause?: unknown,
	) {
		super(message)
		this.name = "QdrantTransientError"
	}
}

/**
 * Qdrant implementation of the vector store interface
 */
export class QdrantVectorStore implements IVectorStore {
	private readonly vectorSize!: number
	private readonly DISTANCE_METRIC = "Cosine"

	private client: QdrantClient
	private readonly collectionName: string
	private readonly qdrantUrl: string = "http://localhost:6333"
	private readonly workspacePath: string

	/**
	 * Creates a new Qdrant vector store
	 * @param workspacePath Path to the workspace
	 * @param url Optional URL to the Qdrant server
	 */
	constructor(workspacePath: string, url: string, vectorSize: number, apiKey?: string) {
		// Parse the URL to determine the appropriate QdrantClient configuration
		const parsedUrl = this.parseQdrantUrl(url)

		// Store the resolved URL for our property
		this.qdrantUrl = parsedUrl
		this.workspacePath = workspacePath

		try {
			const urlObj = new URL(parsedUrl)

			// Always use host-based configuration with explicit ports to avoid QdrantClient defaults
			let port: number
			let useHttps: boolean

			if (urlObj.port) {
				// Explicit port specified - use it and determine protocol
				port = Number(urlObj.port)
				useHttps = urlObj.protocol === "https:"
			} else {
				// No explicit port - use protocol defaults
				if (urlObj.protocol === "https:") {
					port = 443
					useHttps = true
				} else {
					// http: or other protocols default to port 80
					port = 80
					useHttps = false
				}
			}

			this.client = new QdrantClient({
				host: urlObj.hostname,
				https: useHttps,
				port: port,
				prefix: urlObj.pathname === "/" ? undefined : urlObj.pathname.replace(/\/+$/, ""),
				apiKey,
				headers: {
					"User-Agent": "Roo-Code",
				},
			})
		} catch (urlError) {
			// If URL parsing fails, fall back to URL-based config
			// Note: This fallback won't correctly handle prefixes, but it's a last resort for malformed URLs.
			this.client = new QdrantClient({
				url: parsedUrl,
				apiKey,
				headers: {
					"User-Agent": "Roo-Code",
				},
			})
		}

		// Generate collection name from workspace path
		const hash = createHash("sha256").update(workspacePath).digest("hex")
		this.vectorSize = vectorSize
		this.collectionName = `ws-${hash.substring(0, 16)}`
	}

	/**
	 * Parses and normalizes Qdrant server URLs to handle various input formats
	 * @param url Raw URL input from user
	 * @returns Properly formatted URL for QdrantClient
	 */
	private parseQdrantUrl(url: string | undefined): string {
		// Handle undefined/null/empty cases
		if (!url || url.trim() === "") {
			return "http://localhost:6333"
		}

		const trimmedUrl = url.trim()

		// Check if it starts with a protocol
		if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://") && !trimmedUrl.includes("://")) {
			// No protocol - treat as hostname
			return this.parseHostname(trimmedUrl)
		}

		try {
			// Attempt to parse as complete URL - return as-is, let constructor handle ports
			const parsedUrl = new URL(trimmedUrl)
			return trimmedUrl
		} catch {
			// Failed to parse as URL - treat as hostname
			return this.parseHostname(trimmedUrl)
		}
	}

	/**
	 * Handles hostname-only inputs
	 * @param hostname Raw hostname input
	 * @returns Properly formatted URL with http:// prefix
	 */
	private parseHostname(hostname: string): string {
		if (hostname.includes(":")) {
			// Has port - add http:// prefix if missing
			return hostname.startsWith("http") ? hostname : `http://${hostname}`
		} else {
			// No port - add http:// prefix without port (let constructor handle port assignment)
			return `http://${hostname}`
		}
	}

	/**
	 * Checks if an error indicates the collection was not found (HTTP 404 or equivalent).
	 * Returns true only for definitive "not found" responses; returns false for
	 * transient errors like network failures, timeouts, or server errors.
	 */
	private _isCollectionNotFoundError(error: unknown): boolean {
		if (error && typeof error === "object") {
			const err = error as Record<string, unknown>
			// Check HTTP status codes that definitively mean "not found"
			const status = err.status ?? (err.response as Record<string, unknown>)?.status ?? err.statusCode
			if (status === 404) {
				return true
			}
			// Check error message patterns from Qdrant client
			const message = (err.message as string) ?? ""
			const lowerMessage = message.toLowerCase()
			if (
				lowerMessage.includes("not found") ||
				lowerMessage.includes("doesn't exist") ||
				lowerMessage.includes("does not exist")
			) {
				return true
			}
		}
		return false
	}

	/**
	 * Retrieves collection info from Qdrant.
	 * Returns the collection info if it exists, null if the collection does not exist,
	 * or throws QdrantTransientError for transient connectivity issues.
	 *
	 * @throws {QdrantTransientError} When the error is transient (network, timeout, server error)
	 */
	private async getCollectionInfo(): Promise<Schemas["CollectionInfo"] | null> {
		try {
			const collectionInfo = await this.client.getCollection(this.collectionName)
			return collectionInfo
		} catch (error: unknown) {
			// Distinguish "collection not found" from transient errors
			if (this._isCollectionNotFoundError(error)) {
				console.log(`[QdrantVectorStore] Collection "${this.collectionName}" does not exist (not found).`)
				return null
			}

			// Transient error - throw so callers can handle appropriately
			// instead of assuming collection doesn't exist
			const message = error instanceof Error ? error.message : String(error)
			console.warn(
				`[QdrantVectorStore] Transient error during getCollectionInfo for "${this.collectionName}":`,
				message,
			)
			throw new QdrantTransientError(
				`Transient error checking collection "${this.collectionName}": ${message}`,
				error,
			)
		}
	}

	/**
	 * Initializes the vector store.
	 *
	 * Returns true if a new collection was created (caller should do full scan),
	 * false if collection already existed with correct dimensions (caller should check hasIndexedData).
	 *
	 * @throws {QdrantTransientError} When Qdrant is temporarily unreachable.
	 *   The caller should NOT treat this as "collection missing" — it should retry or set error state
	 *   without clearing the cache or collection.
	 */
	async initialize(): Promise<boolean> {
		let created = false
		try {
			const collectionInfo = await this.getCollectionInfo()

			if (collectionInfo === null) {
				// Collection definitively does not exist — create it
				console.log(
					`[QdrantVectorStore] Collection "${this.collectionName}" not found. Creating new collection.`,
				)
				await this.client.createCollection(this.collectionName, {
					vectors: {
						size: this.vectorSize,
						distance: this.DISTANCE_METRIC,
						on_disk: true,
					},
					hnsw_config: {
						m: 64,
						ef_construct: 512,
						on_disk: true,
					},
				})
				created = true
			} else {
				// Collection exists, check vector size
				const vectorsConfig = collectionInfo.config?.params?.vectors
				let existingVectorSize: number

				if (typeof vectorsConfig === "number") {
					existingVectorSize = vectorsConfig
				} else if (
					vectorsConfig &&
					typeof vectorsConfig === "object" &&
					"size" in vectorsConfig &&
					typeof vectorsConfig.size === "number"
				) {
					existingVectorSize = vectorsConfig.size
				} else {
					existingVectorSize = 0 // Fallback for unknown configuration
				}

				if (existingVectorSize === this.vectorSize) {
					created = false // Exists and correct
				} else {
					// Exists but wrong vector size, recreate with enhanced error handling
					created = await this._recreateCollectionWithNewDimension(existingVectorSize)
				}
			}

			// Create payload indexes
			await this._createPayloadIndexes()
			return created
		} catch (error: any) {
			// Re-throw transient errors as-is so callers can distinguish them
			if (error instanceof QdrantTransientError) {
				throw error
			}

			const errorMessage = error?.message || error
			console.error(
				`[QdrantVectorStore] Failed to initialize Qdrant collection "${this.collectionName}":`,
				errorMessage,
			)

			// If this is already a vector dimension mismatch error (identified by cause), re-throw it as-is
			if (error instanceof Error && error.cause !== undefined) {
				throw error
			}

			// Otherwise, provide a more user-friendly error message that includes the original error
			throw new Error(
				t("embeddings:vectorStore.qdrantConnectionFailed", { qdrantUrl: this.qdrantUrl, errorMessage }),
			)
		}
	}

	/**
	 * Recreates the collection with a new vector dimension, handling failures gracefully.
	 * @param existingVectorSize The current vector size of the existing collection
	 * @returns Promise resolving to boolean indicating if a new collection was created
	 */
	private async _recreateCollectionWithNewDimension(existingVectorSize: number): Promise<boolean> {
		console.warn(
			`[QdrantVectorStore] Collection ${this.collectionName} exists with vector size ${existingVectorSize}, but expected ${this.vectorSize}. Recreating collection.`,
		)

		let deletionSucceeded = false
		let recreationAttempted = false

		try {
			// Step 1: Attempt to delete the existing collection
			console.log(`[QdrantVectorStore] Deleting existing collection ${this.collectionName}...`)
			await this.client.deleteCollection(this.collectionName)
			deletionSucceeded = true
			console.log(`[QdrantVectorStore] Successfully deleted collection ${this.collectionName}`)

			// Step 2: Wait a brief moment to ensure deletion is processed
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Step 3: Verify the collection is actually deleted
			const verificationInfo = await this.getCollectionInfo()
			if (verificationInfo !== null) {
				throw new Error("Collection still exists after deletion attempt")
			}

			// Step 4: Create the new collection with correct dimensions
			console.log(
				`[QdrantVectorStore] Creating new collection ${this.collectionName} with vector size ${this.vectorSize}...`,
			)
			recreationAttempted = true
			await this.client.createCollection(this.collectionName, {
				vectors: {
					size: this.vectorSize,
					distance: this.DISTANCE_METRIC,
					on_disk: true,
				},
				hnsw_config: {
					m: 64,
					ef_construct: 512,
					on_disk: true,
				},
			})
			console.log(`[QdrantVectorStore] Successfully created new collection ${this.collectionName}`)
			return true
		} catch (recreationError) {
			const errorMessage = recreationError instanceof Error ? recreationError.message : String(recreationError)

			// Provide detailed error context based on what stage failed
			let contextualErrorMessage: string
			if (!deletionSucceeded) {
				contextualErrorMessage = `Failed to delete existing collection with vector size ${existingVectorSize}. ${errorMessage}`
			} else if (!recreationAttempted) {
				contextualErrorMessage = `Deleted existing collection but failed verification step. ${errorMessage}`
			} else {
				contextualErrorMessage = `Deleted existing collection but failed to create new collection with vector size ${this.vectorSize}. ${errorMessage}`
			}

			console.error(
				`[QdrantVectorStore] CRITICAL: Failed to recreate collection ${this.collectionName} for dimension change (${existingVectorSize} -> ${this.vectorSize}). ${contextualErrorMessage}`,
			)

			// Create a comprehensive error message for the user
			const dimensionMismatchError = new Error(
				t("embeddings:vectorStore.vectorDimensionMismatch", {
					errorMessage: contextualErrorMessage,
				}),
			)

			// Preserve the original error context
			dimensionMismatchError.cause = recreationError
			throw dimensionMismatchError
		}
	}

	/**
	 * Creates payload indexes for the collection, handling errors gracefully.
	 */
	private async _createPayloadIndexes(): Promise<void> {
		// Create index for the 'type' field to enable metadata filtering
		try {
			await this.client.createPayloadIndex(this.collectionName, {
				field_name: "type",
				field_schema: "keyword",
			})
		} catch (indexError: any) {
			const errorMessage = (indexError?.message || "").toLowerCase()
			if (!errorMessage.includes("already exists")) {
				console.warn(
					`[QdrantVectorStore] Could not create payload index for type on ${this.collectionName}. Details:`,
					indexError?.message || indexError,
				)
			}
		}

		// Create indexes for pathSegments fields
		for (let i = 0; i <= 4; i++) {
			try {
				await this.client.createPayloadIndex(this.collectionName, {
					field_name: `pathSegments.${i}`,
					field_schema: "keyword",
				})
			} catch (indexError: any) {
				const errorMessage = (indexError?.message || "").toLowerCase()
				if (!errorMessage.includes("already exists")) {
					console.warn(
						`[QdrantVectorStore] Could not create payload index for pathSegments.${i} on ${this.collectionName}. Details:`,
						indexError?.message || indexError,
					)
				}
			}
		}
	}

	/**
	 * Upserts points into the vector store
	 * @param points Array of points to upsert
	 */
	async upsertPoints(
		points: Array<{
			id: string
			vector: number[]
			payload: Record<string, any>
		}>,
	): Promise<void> {
		try {
			const processedPoints = points.map((point) => {
				if (point.payload?.filePath) {
					const segments = point.payload.filePath.split(path.sep).filter(Boolean)
					const pathSegments = segments.reduce(
						(acc: Record<string, string>, segment: string, index: number) => {
							acc[index.toString()] = segment
							return acc
						},
						{},
					)
					return {
						...point,
						payload: {
							...point.payload,
							pathSegments,
						},
					}
				}
				return point
			})

			await this.client.upsert(this.collectionName, {
				points: processedPoints,
				wait: true,
			})
		} catch (error) {
			console.error("Failed to upsert points:", error)
			throw error
		}
	}

	/**
	 * Checks if a payload is valid
	 * @param payload Payload to check
	 * @returns Boolean indicating if the payload is valid
	 */
	private isPayloadValid(payload: Record<string, unknown> | null | undefined): payload is Payload {
		if (!payload) {
			return false
		}
		const validKeys = ["filePath", "codeChunk", "startLine", "endLine"]
		const hasValidKeys = validKeys.every((key) => key in payload)
		return hasValidKeys
	}

	/**
	 * Searches for similar vectors
	 * @param queryVector Vector to search for
	 * @param directoryPrefix Optional directory prefix to filter results
	 * @param minScore Optional minimum score threshold
	 * @param maxResults Optional maximum number of results to return
	 * @returns Promise resolving to search results
	 */
	async search(
		queryVector: number[],
		directoryPrefix?: string,
		minScore?: number,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]> {
		try {
			let filter:
				| {
						must: Array<{ key: string; match: { value: string } }>
						must_not?: Array<{ key: string; match: { value: string } }>
				  }
				| undefined = undefined

			if (directoryPrefix) {
				// Check if the path represents current directory
				const normalizedPrefix = path.posix.normalize(directoryPrefix.replace(/\\/g, "/"))
				// Note: path.posix.normalize("") returns ".", and normalize("./") returns "./"
				if (normalizedPrefix === "." || normalizedPrefix === "./") {
					// Don't create a filter - search entire workspace
					filter = undefined
				} else {
					// Remove leading "./" from paths like "./src" to normalize them
					const cleanedPrefix = path.posix.normalize(
						normalizedPrefix.startsWith("./") ? normalizedPrefix.slice(2) : normalizedPrefix,
					)
					const segments = cleanedPrefix.split("/").filter(Boolean)
					if (segments.length > 0) {
						filter = {
							must: segments.map((segment, index) => ({
								key: `pathSegments.${index}`,
								match: { value: segment },
							})),
						}
					}
				}
			}

			// Always exclude metadata points at query-time to avoid wasting top-k
			const metadataExclusion = {
				must_not: [{ key: "type", match: { value: "metadata" } }],
			}

			const mergedFilter = filter
				? { ...filter, must_not: [...(filter.must_not || []), ...metadataExclusion.must_not] }
				: metadataExclusion

			const searchRequest = {
				query: queryVector,
				filter: mergedFilter,
				score_threshold: minScore ?? DEFAULT_SEARCH_MIN_SCORE,
				limit: maxResults ?? DEFAULT_MAX_SEARCH_RESULTS,
				params: {
					hnsw_ef: 128,
					exact: false,
				},
				with_payload: {
					include: ["filePath", "codeChunk", "startLine", "endLine", "pathSegments"],
				},
			}

			const operationResult = await this.client.query(this.collectionName, searchRequest)
			const filteredPoints = operationResult.points.filter((p) => this.isPayloadValid(p.payload))

			return filteredPoints as VectorStoreSearchResult[]
		} catch (error) {
			console.error("Failed to search points:", error)
			throw error
		}
	}

	/**
	 * Deletes points by file path
	 * @param filePath Path of the file to delete points for
	 */
	async deletePointsByFilePath(filePath: string): Promise<void> {
		return this.deletePointsByMultipleFilePaths([filePath])
	}

	async deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) {
			return
		}

		try {
			// First check if the collection exists
			const collectionExists = await this.collectionExists()
			if (!collectionExists) {
				console.warn(
					`[QdrantVectorStore] Skipping deletion - collection "${this.collectionName}" does not exist`,
				)
				return
			}

			const workspaceRoot = this.workspacePath

			// Build filters using pathSegments to match the indexed fields
			const filters = filePaths.map((filePath) => {
				// IMPORTANT: Use the relative path to match what's stored in upsertPoints
				// upsertPoints stores the relative filePath, not the absolute path
				const relativePath = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath

				// Normalize the relative path
				const normalizedRelativePath = path.normalize(relativePath)

				// Split the path into segments like we do in upsertPoints
				const segments = normalizedRelativePath.split(path.sep).filter(Boolean)

				// Create a filter that matches all segments of the path
				// This ensures we only delete points that match the exact file path
				const mustConditions = segments.map((segment, index) => ({
					key: `pathSegments.${index}`,
					match: { value: segment },
				}))

				return { must: mustConditions }
			})

			// Use 'should' to match any of the file paths (OR condition)
			const filter = filters.length === 1 ? filters[0] : { should: filters }

			await this.client.delete(this.collectionName, {
				filter,
				wait: true,
			})
		} catch (error: any) {
			// Extract more detailed error information
			const errorMessage = error?.message || String(error)
			const errorStatus = error?.status || error?.response?.status || error?.statusCode
			const errorDetails = error?.response?.data || error?.data || ""

			console.error(`[QdrantVectorStore] Failed to delete points by file paths:`, {
				error: errorMessage,
				status: errorStatus,
				details: errorDetails,
				collection: this.collectionName,
				fileCount: filePaths.length,
				// Include first few file paths for debugging (avoid logging too many)
				samplePaths: filePaths.slice(0, 3),
			})
		}
	}

	/**
	 * Deletes the entire collection.
	 */
	async deleteCollection(): Promise<void> {
		try {
			// Check if collection exists before attempting deletion to avoid errors
			if (await this.collectionExists()) {
				await this.client.deleteCollection(this.collectionName)
			}
		} catch (error) {
			console.error(`[QdrantVectorStore] Failed to delete collection ${this.collectionName}:`, error)
			throw error // Re-throw to allow calling code to handle it
		}
	}

	/**
	 * Clears all points from the collection
	 */
	async clearCollection(): Promise<void> {
		try {
			await this.client.delete(this.collectionName, {
				filter: {
					must: [],
				},
				wait: true,
			})
		} catch (error) {
			console.error("Failed to clear collection:", error)
			throw error
		}
	}

	/**
	 * Checks if the collection exists.
	 * Returns false for both "not found" and transient errors (safe for non-critical checks).
	 */
	async collectionExists(): Promise<boolean> {
		try {
			const collectionInfo = await this.getCollectionInfo()
			return collectionInfo !== null
		} catch (error) {
			// Transient error — can't confirm existence, return false
			return false
		}
	}

	/**
	 * Checks if the collection exists and has indexed points.
	 *
	 * IMPORTANT: This method is resilient to transient errors. If Qdrant is temporarily
	 * unreachable, it returns true (optimistic) to prevent unnecessary full re-indexes.
	 * The rationale is: if we previously had data and can't reach Qdrant now, we should
	 * assume data is still there and attempt an incremental scan rather than a destructive full scan.
	 *
	 * Returns false only when we can definitively confirm the collection is empty or doesn't exist.
	 */
	async hasIndexedData(): Promise<boolean> {
		const MAX_RETRIES = 2
		const RETRY_DELAY_MS = 1000

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const collectionInfo = await this.getCollectionInfo()
				if (!collectionInfo) {
					// Collection definitively does not exist
					return false
				}
				// Check if the collection has any points indexed
				const pointsCount = collectionInfo.points_count ?? 0
				if (pointsCount === 0) {
					return false
				}

				// Check if the indexing completion marker exists
				// Use a deterministic UUID generated from a constant string
				const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)
				const metadataPoints = await this.client.retrieve(this.collectionName, {
					ids: [metadataId],
				})

				// If marker exists, use it to determine completion status
				if (metadataPoints.length > 0) {
					const isComplete = metadataPoints[0].payload?.indexing_complete === true
					if (!isComplete) {
						// Index was marked incomplete (e.g., previous scan failed partway through).
						// If we have a significant number of points, treat as having data
						// so we do an incremental scan instead of full re-index.
						console.log(
							`[QdrantVectorStore] Index marked incomplete but has ${pointsCount} points. ` +
								`Treating as having data to allow incremental scan.`,
						)
						return pointsCount > 1 // >1 because the metadata point itself counts
					}
					return true
				}

				// Backward compatibility: No marker exists (old index or pre-marker version)
				// Fall back to old logic - assume complete if collection has points
				console.log(
					"[QdrantVectorStore] No indexing metadata marker found. Using backward compatibility mode (checking points_count > 0).",
				)
				return pointsCount > 0
			} catch (error) {
				if (error instanceof QdrantTransientError) {
					if (attempt < MAX_RETRIES) {
						console.warn(
							`[QdrantVectorStore] Transient error in hasIndexedData (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS}ms...`,
						)
						await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
						continue
					}
					// All retries exhausted — return true (optimistic) to prevent unnecessary full re-index.
					// The incremental scan will fail quickly if Qdrant is truly down, and
					// the error handler will set an appropriate error state without destroying data.
					console.warn(
						`[QdrantVectorStore] Transient error in hasIndexedData after ${MAX_RETRIES + 1} attempts. ` +
							`Returning true (optimistic) to prevent unnecessary full re-index.`,
					)
					return true
				}

				// Non-transient error — log and return false as before
				console.warn("[QdrantVectorStore] Failed to check if collection has data:", error)
				return false
			}
		}

		// Should not reach here, but return true to be safe
		return true
	}

	/**
	 * Marks the indexing process as complete by storing metadata
	 * Should be called after a successful full workspace scan or incremental scan
	 */
	async markIndexingComplete(): Promise<void> {
		try {
			// Create a metadata point with a deterministic UUID to mark indexing as complete
			// Use uuidv5 to generate a consistent UUID from a constant string
			const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							indexing_complete: true,
							completed_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			console.log("[QdrantVectorStore] Marked indexing as complete")
		} catch (error) {
			console.error("[QdrantVectorStore] Failed to mark indexing as complete:", error)
			throw error
		}
	}

	/**
	 * Marks the indexing process as incomplete by storing metadata
	 * Should be called at the start of indexing to indicate work in progress
	 */
	async markIndexingIncomplete(): Promise<void> {
		try {
			// Create a metadata point with a deterministic UUID to mark indexing as incomplete
			// Use uuidv5 to generate a consistent UUID from a constant string
			const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							indexing_complete: false,
							started_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			console.log("[QdrantVectorStore] Marked indexing as incomplete (in progress)")
		} catch (error) {
			console.error("[QdrantVectorStore] Failed to mark indexing as incomplete:", error)
			throw error
		}
	}

	/**
	 * Returns the number of indexed points (blocks) in the collection,
	 * excluding the metadata marker point.
	 * Returns 0 if the collection doesn't exist or on any error.
	 */
	async getPointCount(): Promise<number> {
		try {
			const collectionInfo = await this.getCollectionInfo()
			if (!collectionInfo) {
				return 0
			}
			const rawCount = collectionInfo.points_count ?? 0
			// Subtract 1 for the metadata marker point (if it exists)
			return Math.max(0, rawCount > 0 ? rawCount - 1 : 0)
		} catch (error) {
			console.warn("[QdrantVectorStore] Failed to get point count:", error)
			return 0
		}
	}
}
