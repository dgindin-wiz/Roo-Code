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

	async initialize(): Promise<void> {
		const collection = await this.getCollection()
		if (!collection) {
			await this.request(`/collections/${this.collectionName}`, {
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
			})
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

		await this.ensurePayloadIndex("filePath")
		await this.ensurePayloadIndex("revisionId")
		await this.ensurePayloadIndex("fileId")
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

	private async getCollection(): Promise<Record<string, unknown> | undefined> {
		const response = await this.transport.fetch(`${this.baseUrl}/collections/${this.collectionName}`, {
			method: "GET",
			headers: this.buildHeaders(),
		})

		if (response.status === 404) {
			return undefined
		}

		if (!response.ok) {
			throw new Error(`Failed to fetch Qdrant collection info: ${response.status} ${response.statusText}`)
		}

		const body = (await response.json()) as QdrantEnvelope<Record<string, unknown>>
		return body.result
	}

	private async ensurePayloadIndex(fieldName: string): Promise<void> {
		try {
			await this.request(`/collections/${this.collectionName}/index`, {
				method: "PUT",
				body: {
					field_name: fieldName,
					field_schema: "keyword",
				},
			})
		} catch (error) {
			IndexDebugLoggerV2.log("basic", "QdrantRestVectorStoreAdapter", "payload-index-create-failed", {
				component: "QdrantRestVectorStoreAdapter",
				workspacePath: this.workspacePath,
				jobId: fieldName,
				errorMessage: error instanceof Error ? error.message : String(error),
			})
		}
	}

	private async request<T>(resourcePath: string, init: { method: string; body?: unknown }): Promise<T> {
		const response = await this.transport.fetch(`${this.baseUrl}${resourcePath}`, {
			method: init.method,
			headers: this.buildHeaders(),
			body: init.body ? JSON.stringify(init.body) : undefined,
		})

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
