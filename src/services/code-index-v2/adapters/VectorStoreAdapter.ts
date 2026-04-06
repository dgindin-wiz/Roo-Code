import { VectorStoreSearchResult } from "../../code-index/interfaces"

export interface VectorPointPayload {
	workspaceId: string
	fileId: string
	relativePath: string
	revisionId: string
	chunkFingerprint: string
	variantType?: string
	startLine: number
	endLine: number
	language?: string
	chunkKind?: string
	symbolName?: string
	symbolQualifiedName?: string
	parentSymbolName?: string
	parentChunkFingerprint?: string
	summary?: string
	searchText?: string
	modelId?: string
	parserVersion?: string
	chunkerVersion?: string
	codeChunk?: string
	filePath?: string
	pathSegments?: Record<string, string>
}

export interface VectorPoint {
	id: string
	vector: number[]
	payload: VectorPointPayload
}

export interface VectorStoreAdapter {
	initialize(): Promise<void>
	hasIndexedPoints(): Promise<boolean>
	upsertPoints(points: VectorPoint[]): Promise<void>
	deletePointsByIds(pointIds: string[]): Promise<void>
	search(vector: number[], limit: number, minScore?: number): Promise<VectorStoreSearchResult[]>
	recycleClient?(): Promise<void>
}
