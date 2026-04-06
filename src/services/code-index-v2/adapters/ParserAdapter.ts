export interface ParsedChunk {
	chunkFingerprint: string
	content: string
	searchText?: string
	summary?: string
	startLine: number
	endLine: number
	language?: string
	chunkKind?: string
	symbolName?: string | null
	symbolQualifiedName?: string | null
	parentSymbolName?: string | null
	parentChunkFingerprint?: string | null
}

export interface ParserAdapter {
	readonly parserVersion: string
	parseFile(input: { filePath: string; content: string; maxFileSizeBytes?: number }): Promise<ParsedChunk[]>
}
