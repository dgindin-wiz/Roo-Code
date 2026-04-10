import { IEmbedder } from "../../code-index/interfaces"
import { EmbeddingAdapter } from "./EmbeddingAdapter"

export class ExistingEmbedderAdapter implements EmbeddingAdapter {
	public readonly provider: string
	public readonly modelId: string
	public readonly runtimeKind: "local" | "remote"
	public readonly runtimeLabel: string
	public readonly deviceHint: string | undefined

	constructor(
		private readonly embedder: IEmbedder,
		options?: {
			modelId?: string
			runtimeKind?: "local" | "remote"
			runtimeLabel?: string
			deviceHint?: string
		},
	) {
		this.provider = embedder.embedderInfo.name
		this.modelId = options?.modelId ?? "unknown-configured-model"
		this.runtimeKind = options?.runtimeKind ?? "remote"
		this.runtimeLabel =
			options?.runtimeLabel ?? (this.runtimeKind === "local" ? "Local embedder" : "Remote embedder")
		this.deviceHint = options?.deviceHint
	}

	async createEmbeddings(
		texts: string[],
		options?: {
			isQuery?: boolean
			signal?: AbortSignal
			debugContext?: {
				runId?: string
				batchId?: string
				outerBatchSize?: number
			}
		},
	): Promise<{ embeddings: number[][]; usage?: { promptTokens: number; totalTokens: number } }> {
		if (options?.signal?.aborted) {
			throw new Error("Embedding request aborted")
		}

		const response = await this.embedder.createEmbeddings(texts, undefined, {
			isQuery: options?.isQuery,
			signal: options?.signal,
			debugContext: options?.debugContext,
		})

		if (options?.signal?.aborted) {
			throw new Error("Embedding request aborted")
		}

		return {
			embeddings: response.embeddings,
			usage: response.usage,
		}
	}

	async recycleClient(): Promise<void> {
		await this.embedder.recycleClient?.()
	}
}
