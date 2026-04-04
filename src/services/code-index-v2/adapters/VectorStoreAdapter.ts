import { VectorStoreSearchResult } from "../../code-index/interfaces"

export interface VectorPointPayload {
	workspaceId: string
	fileId: string
	relativePath: string
	revisionId: string
	chunkFingerprint: string
	startLine: number
	endLine: number
	language?: string
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
