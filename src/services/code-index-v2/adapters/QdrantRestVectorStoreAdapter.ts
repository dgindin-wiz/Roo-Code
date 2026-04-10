import { createHash } from "crypto"
import { Payload, VectorStoreSearchResult } from "../../code-index/interfaces"
import { createIsolatedFetch, IsolatedFetch } from "../../code-index/utils/isolated-fetch"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { VectorPoint, VectorStoreAdapter } from "./VectorStoreAdapter"

interface QdrantEnvelope<T> {
	status?: string
	result?: T
}

interface QdrantSearchPoint {
	id: string | number
	score: number
	payload?: Payload | null
}

export class QdrantRestVectorStoreAdapter implements VectorStoreAdapter {
	private static readonly MAX_TRANSPORT_ATTEMPTS = 3
	private static readonly TRANSPORT_RETRY_DELAY_MS = 150
	private static readonly MAX_HTTP_ATTEMPTS = 3
	private static readonly HTTP_RETRY_DELAY_MS = 250
	private readonly collectionName: string
	private readonly baseUrl: string
	private transport: IsolatedFetch

	constructor(
		private readonly workspacePath: string,
		qdrantUrl: string,
		private readonly vectorSize: number,
		private readonly apiKey?: string,
	) {
		const hash = createHash("sha256").update(workspacePath).digest("hex")
		this.collectionName = `ws-${hash.substring(0, 16)}`
		this.baseUrl = this.normalizeBaseUrl(qdrantUrl)
		this.transport = createIsolatedFetch()
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		const collection = await this.getCollection(signal)
		if (!collection) {
			await this.request(
				`/collections/${this.collectionName}`,
				{
					method: "PUT",
					body: {
						vectors: {
							size: this.vectorSize,
							distance: "Cosine",
							on_disk: true,
						},
						hnsw_config: {
							m: 64,
							ef_construct: 512,
							on_disk: true,
						},
					},
				},
				signal,
			)
			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "collection-created", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId: this.collectionName,
			})
		} else {
			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "collection-ready", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId: this.collectionName,
			})
		}

		await this.ensurePayloadIndex("filePath", signal)
		await this.ensurePayloadIndex("revisionId", signal)
		await this.ensurePayloadIndex("fileId", signal)
	}

	async upsertPoints(points: VectorPoint[]): Promise<void> {
		if (points.length === 0) {
			return
		}

		await this.request(`/collections/${this.collectionName}/points?wait=true`, {
			method: "PUT",
			body: {
				points: points.map((point) => ({
					...point,
					payload: point.payload.filePath
						? {
								...point.payload,
								pathSegments: this.toPathSegments(point.payload.filePath),
							}
						: point.payload,
				})),
			},
		})
	}

	async hasIndexedPoints(): Promise<boolean> {
		const result = await this.request<{ count?: number }>(`/collections/${this.collectionName}/points/count`, {
			method: "POST",
			body: {
				exact: false,
			},
		})
		const count = result.count ?? 0
		IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "collection-count-checked", {
			component: "QdrantRestVectorStoreAdapter",
			workspacePath: this.workspacePath,
			jobId: `${this.collectionName}:${count}`,
		})
		return count > 0
	}

	async deletePointsByIds(pointIds: string[]): Promise<void> {
		if (pointIds.length === 0) {
			return
		}

		await this.request(`/collections/${this.collectionName}/points/delete?wait=true`, {
			method: "POST",
			body: {
				points: pointIds,
			},
		})
	}

	async search(vector: number[], limit: number, minScore?: number): Promise<VectorStoreSearchResult[]> {
		const result = await this.request<{ points?: QdrantSearchPoint[] }>(
			`/collections/${this.collectionName}/points/query`,
			{
				method: "POST",
				body: {
					query: vector,
					limit,
					score_threshold: minScore,
					params: {
						hnsw_ef: 128,
						exact: false,
					},
					with_payload: {
						include: [
							"filePath",
							"chunkFingerprint",
							"variantType",
							"codeChunk",
							"startLine",
							"endLine",
							"pathSegments",
							"language",
							"chunkKind",
							"symbolName",
							"symbolQualifiedName",
							"parentSymbolName",
							"parentChunkFingerprint",
							"summary",
							"searchText",
						],
					},
				},
			},
		)

		return (result.points ?? []).filter((point) => this.isPayloadValid(point.payload))
	}

	async recycleClient(): Promise<void> {
		await this.transport.destroy()
		this.transport = createIsolatedFetch()
	}

	async deleteCollection(): Promise<void> {
		const response = await this.transport.fetch(`${this.baseUrl}/collections/${this.collectionName}`, {
			method: "DELETE",
			headers: this.buildHeaders(),
		})

		if (response.status === 404) {
			return
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new Error(
				`Failed to delete Qdrant collection: ${response.status} ${response.statusText} ${body}`.trim(),
			)
		}
	}

	private async getCollection(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
		const resourcePath = `/collections/${this.collectionName}`
		const response = await this.fetchWithRetryableHttpStatuses(
			resourcePath,
			{
				method: "GET",
				headers: this.buildHeaders(),
				signal,
			},
			`GET ${resourcePath}`,
		)

		if (response.status === 404) {
			return undefined
		}

		if (!response.ok) {
			throw new Error(`Failed to fetch Qdrant collection info: ${response.status} ${response.statusText}`)
		}

		const body = (await response.json()) as QdrantEnvelope<Record<string, unknown>>
		return body.result
	}

	private async ensurePayloadIndex(fieldName: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.request(
				`/collections/${this.collectionName}/index`,
				{
					method: "PUT",
					body: {
						field_name: fieldName,
						field_schema: "keyword",
					},
				},
				signal,
			)
		} catch (error) {
			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "payload-index-create-failed", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId: fieldName,
				errorMessage: error instanceof Error ? error.message : String(error),
			})
		}
	}

	private async request<T>(
		resourcePath: string,
		init: { method: string; body?: unknown },
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.fetchWithRetryableHttpStatuses(
			resourcePath,
			{
				method: init.method,
				headers: this.buildHeaders(),
				body: init.body ? JSON.stringify(init.body) : undefined,
				signal,
			},
			`${init.method} ${resourcePath}`,
		)

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "qdrant-request-failed", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId: `${init.method} ${resourcePath}`,
				errorMessage: `status=${response.status} statusText=${response.statusText || "n/a"} body=${body}`,
			})
			throw new Error(
				`Qdrant request failed (${init.method} ${resourcePath}): ${response.status} ${response.statusText} ${body}`.trim(),
			)
		}

		const body = (await response.json()) as QdrantEnvelope<T>
		return body.result as T
	}

	private async fetchWithRetryableHttpStatuses(
		resourcePath: string,
		init: Parameters<IsolatedFetch["fetch"]>[1],
		jobId: string,
	): Promise<Awaited<ReturnType<IsolatedFetch["fetch"]>>> {
		for (let attempt = 1; attempt <= QdrantRestVectorStoreAdapter.MAX_HTTP_ATTEMPTS; attempt++) {
			let response: Awaited<ReturnType<IsolatedFetch["fetch"]>>
			try {
				response = await this.executeTransportRequest(`${this.baseUrl}${resourcePath}`, init, jobId)
			} catch (error) {
				const formattedError = this.formatTransportError(error)
				IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "qdrant-transport-failed", {
					component: "QdrantRestVectorStoreAdapter",
					workspacePath: this.workspacePath,
					jobId,
					errorMessage: formattedError.message,
					rawErrorMessage: this.getRawTransportErrorMessage(error),
					rawErrorCode: this.getTransportErrorCode(error),
					rawCauseCode: this.getTransportCauseCode(error),
				})
				throw formattedError
			}

			if (
				!this.isRetryableHttpStatus(response.status) ||
				attempt >= QdrantRestVectorStoreAdapter.MAX_HTTP_ATTEMPTS
			) {
				return response
			}

			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "qdrant-http-retry", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId,
				attempt,
				maxAttempts: QdrantRestVectorStoreAdapter.MAX_HTTP_ATTEMPTS,
				statusCode: response.status,
				statusText: response.statusText || "n/a",
			})
			await this.delay(QdrantRestVectorStoreAdapter.HTTP_RETRY_DELAY_MS * attempt)
		}

		throw new Error(`Qdrant request exhausted retries (${jobId})`)
	}

	private isPayloadValid(payload: Record<string, unknown> | null | undefined): payload is Payload {
		if (!payload) {
			return false
		}

		return ["filePath", "codeChunk", "startLine", "endLine"].every((key) => key in payload)
	}

	private toPathSegments(filePath: string): Record<string, string> {
		const segments = filePath.split(/[\\/]/).filter(Boolean)
		return segments.reduce<Record<string, string>>((acc, segment, index) => {
			acc[index.toString()] = segment
			return acc
		}, {})
	}

	private buildHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"User-Agent": "Roo-Code",
			...(this.apiKey ? { "api-key": this.apiKey } : {}),
		}
	}

	private async executeTransportRequest(
		url: string,
		init: Parameters<IsolatedFetch["fetch"]>[1],
		jobId: string,
	): Promise<Awaited<ReturnType<IsolatedFetch["fetch"]>>> {
		let lastError: unknown
		for (let attempt = 1; attempt <= QdrantRestVectorStoreAdapter.MAX_TRANSPORT_ATTEMPTS; attempt++) {
			try {
				return await this.transport.fetch(url, init)
			} catch (error) {
				lastError = error
				if (
					!this.isRetryableTransportError(error) ||
					attempt >= QdrantRestVectorStoreAdapter.MAX_TRANSPORT_ATTEMPTS
				) {
					break
				}

				IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "qdrant-transport-retry", {
					component: "QdrantRestVectorStoreAdapter",
					workspacePath: this.workspacePath,
					jobId,
					attempt,
					maxAttempts: QdrantRestVectorStoreAdapter.MAX_TRANSPORT_ATTEMPTS,
					rawErrorMessage: this.getRawTransportErrorMessage(error),
					rawErrorCode: this.getTransportErrorCode(error),
					rawCauseCode: this.getTransportCauseCode(error),
				})
				await this.delay(QdrantRestVectorStoreAdapter.TRANSPORT_RETRY_DELAY_MS * attempt)
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError))
	}

	private isRetryableTransportError(error: unknown): boolean {
		if (error instanceof Error && error.name === "AbortError") {
			return false
		}

		const combined = [
			this.getRawTransportErrorMessage(error),
			this.getTransportErrorCode(error),
			this.getTransportCauseCode(error),
		]
			.join(" ")
			.toUpperCase()

		return (
			combined.includes("ECONNREFUSED") ||
			combined.includes("ECONNRESET") ||
			combined.includes("EPIPE") ||
			combined.includes("ETIMEDOUT") ||
			combined.includes("UND_ERR_CONNECT") ||
			combined.includes("UND_ERR_SOCKET")
		)
	}

	private isRetryableHttpStatus(status: number): boolean {
		return status === 408 || status === 429 || (status >= 500 && status <= 599)
	}

	private getRawTransportErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}

	private getTransportErrorCode(error: unknown): string {
		return typeof error === "object" && error && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: ""
	}

	private getTransportCauseCode(error: unknown): string {
		return typeof error === "object" &&
			error &&
			"cause" in error &&
			(error as { cause?: unknown }).cause &&
			typeof (error as { cause?: unknown }).cause === "object" &&
			"code" in ((error as { cause?: unknown }).cause as object)
			? String(((error as { cause?: unknown }).cause as { code?: unknown }).code ?? "")
			: ""
	}

	private async delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms))
	}

	private formatTransportError(error: unknown): Error {
		const message = this.getRawTransportErrorMessage(error)
		const code = this.getTransportErrorCode(error)
		const causeCode = this.getTransportCauseCode(error)
		const combined = `${message} ${code} ${causeCode}`.toUpperCase()

		if (error instanceof Error && error.name === "AbortError") {
			return new Error(`Request to Qdrant at ${this.baseUrl} was aborted`)
		}
		if (combined.includes("ECONNREFUSED")) {
			return new Error(`Could not connect to Qdrant at ${this.baseUrl} (connection refused)`)
		}
		if (combined.includes("ENOTFOUND") || combined.includes("EAI_AGAIN")) {
			return new Error(`Could not resolve the Qdrant host at ${this.baseUrl}`)
		}
		if (combined.includes("ETIMEDOUT") || combined.includes("TIMEOUT")) {
			return new Error(`Request to Qdrant at ${this.baseUrl} timed out`)
		}

		return new Error(`Qdrant request failed at ${this.baseUrl}: ${message}`)
	}

	private normalizeBaseUrl(url: string): string {
		const trimmed = url.trim()
		if (!trimmed) {
			return "http://localhost:6333"
		}

		if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
			return trimmed.replace(/\/+$/, "")
		}

		return `http://${trimmed.replace(/\/+$/, "")}`
	}
}
