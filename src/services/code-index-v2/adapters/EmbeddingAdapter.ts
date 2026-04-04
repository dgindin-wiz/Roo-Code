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
			}
		},
	): Promise<{ embeddings: number[][] }>

	recycleClient?(): Promise<void>
}
