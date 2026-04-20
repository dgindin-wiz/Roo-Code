import type {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
	EmbeddingResponse,
} from "../../code-index/interfaces/embedder"

export interface EmbeddingAdapter {
	readonly provider: string
	readonly modelId: string
	readonly runtimeKind: "local" | "remote"
	readonly runtimeLabel: string
	readonly deviceHint?: string

	createEmbeddings(
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
	): Promise<EmbeddingResponse>

	seedAdaptiveControllerState?(state?: AdaptiveEmbeddingControllerState): void

	getAdaptiveControllerState?(): AdaptiveEmbeddingControllerState | undefined

	drainAdaptiveControllerObservations?(): AdaptiveProviderObservation[]

	getRecommendedDocumentBatchSize?(): number | undefined

	recycleClient?(): Promise<void>
}
