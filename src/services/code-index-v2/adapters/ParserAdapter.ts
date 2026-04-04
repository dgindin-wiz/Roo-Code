export interface ParsedChunk {
	chunkFingerprint: string
	content: string
	startLine: number
	endLine: number
	language?: string
}

export interface ParserAdapter {
	readonly parserVersion: string
	parseFile(input: { filePath: string; content: string }): Promise<ParsedChunk[]>
}
