import { IEmbedder } from "../../code-index/interfaces"
import { EmbeddingAdapter } from "./EmbeddingAdapter"
import type {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
	EmbeddingResponse,
} from "../../code-index/interfaces/embedder"

export class ExistingEmbedderAdapter implements EmbeddingAdapter {
	public readonly provider: string
	public readonly modelId: string
	public readonly runtimeKind: "local" | "remote"
	public readonly runtimeLabel: string
	public readonly deviceHint: string | undefined
	public readonly workspacePath: string | undefined

	constructor(
		private readonly embedder: IEmbedder,
		options?: {
			modelId?: string
			runtimeKind?: "local" | "remote"
			runtimeLabel?: string
			deviceHint?: string
			workspacePath?: string
		},
	) {
		this.provider = embedder.embedderInfo.name
		this.modelId = options?.modelId ?? "unknown-configured-model"
		this.runtimeKind = options?.runtimeKind ?? "remote"
		this.runtimeLabel =
			options?.runtimeLabel ?? (this.runtimeKind === "local" ? "Local embedder" : "Remote embedder")
		this.deviceHint = options?.deviceHint
		this.workspacePath = options?.workspacePath
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
				workspacePath?: string
			}
		},
	): Promise<EmbeddingResponse> {
		if (options?.signal?.aborted) {
			throw new Error("Embedding request aborted")
		}

		const hasDebugContext = Boolean(options?.debugContext || this.workspacePath)
		const debugContext = hasDebugContext
			? {
					...options?.debugContext,
					workspacePath: options?.debugContext?.workspacePath ?? this.workspacePath,
				}
			: undefined

		const response = await this.embedder.createEmbeddings(texts, undefined, {
			isQuery: options?.isQuery,
			signal: options?.signal,
			debugContext,
		})

		if (options?.signal?.aborted) {
			throw new Error("Embedding request aborted")
		}

		return {
			embeddings: response.embeddings,
			usage: response.usage,
			adaptiveControllerState: response.adaptiveControllerState ?? this.embedder.getAdaptiveControllerState?.(),
			adaptiveControllerObservations:
				response.adaptiveControllerObservations ?? this.embedder.drainAdaptiveControllerObservations?.(),
		}
	}

	seedAdaptiveControllerState(state?: AdaptiveEmbeddingControllerState): void {
		this.embedder.seedAdaptiveControllerState?.(state)
	}

	getAdaptiveControllerState(): AdaptiveEmbeddingControllerState | undefined {
		return this.embedder.getAdaptiveControllerState?.()
	}

	drainAdaptiveControllerObservations(): AdaptiveProviderObservation[] {
		return this.embedder.drainAdaptiveControllerObservations?.() ?? []
	}

	getRecommendedDocumentBatchSize(): number | undefined {
		return this.embedder.getRecommendedDocumentBatchSize?.()
	}

	async recycleClient(): Promise<void> {
		await this.embedder.recycleClient?.()
	}
}
