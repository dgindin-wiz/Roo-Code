import { codeParser } from "../../code-index/processors"
import { ParserAdapter, ParsedChunk } from "./ParserAdapter"

export class CodeIndexParserAdapter implements ParserAdapter {
	readonly parserVersion = "legacy-code-parser-v2-structured"

	async parseFile(input: { filePath: string; content: string; maxFileSizeBytes?: number }): Promise<ParsedChunk[]> {
		const language = this.getLanguageFromPath(input.filePath)
		const blocks = await codeParser.parseFile(input.filePath, {
			content: input.content,
			maxFileSizeBytes: input.maxFileSizeBytes,
		})

		return blocks.map((block) => ({
			chunkFingerprint: block.segmentHash,
			content: block.content,
			searchText: this.buildSearchText({
				filePath: input.filePath,
				language,
				chunkKind: this.normalizeChunkKind(block.type),
				symbolName: block.identifier,
				parentSymbolName: block.parentIdentifier ?? null,
				startLine: block.start_line,
				endLine: block.end_line,
				content: block.content,
			}),
			summary: this.buildSummary({
				filePath: input.filePath,
				language,
				chunkKind: this.normalizeChunkKind(block.type),
				symbolName: block.identifier,
				parentSymbolName: block.parentIdentifier ?? null,
				startLine: block.start_line,
				endLine: block.end_line,
			}),
			startLine: block.start_line,
			endLine: block.end_line,
			language,
			chunkKind: this.normalizeChunkKind(block.type),
			symbolName: block.identifier,
			symbolQualifiedName: this.buildQualifiedName(block.parentIdentifier ?? null, block.identifier),
			parentSymbolName: block.parentIdentifier ?? null,
			parentChunkFingerprint: block.parentChunkFingerprint ?? null,
		}))
	}

	private getLanguageFromPath(filePath: string): string {
		return filePath.split(".").pop()?.toLowerCase() || "unknown"
	}

	private normalizeChunkKind(type: string): string {
		const normalized = type.toLowerCase()
		if (normalized.includes("class")) return "class"
		if (normalized.includes("method")) return "method"
		if (normalized.includes("function")) return "function"
		if (normalized.includes("interface")) return "type"
		if (normalized.includes("type")) return "type"
		if (normalized.includes("enum")) return "enum"
		if (normalized.includes("module")) return "module"
		if (normalized.includes("namespace")) return "module"
		if (normalized.includes("const")) return "constant"
		if (normalized.includes("markdown_header")) return "section"
		if (normalized.includes("markdown")) return "document_section"
		if (normalized.includes("fallback")) return "fallback"
		return normalized
	}

	private buildSummary(input: {
		filePath: string
		language: string
		chunkKind: string
		symbolName: string | null
		parentSymbolName: string | null
		startLine: number
		endLine: number
	}): string {
		const location = `${input.filePath}:${input.startLine}-${input.endLine}`
		if (input.symbolName) {
			if (input.parentSymbolName) {
				return `${input.language} ${input.chunkKind} ${input.symbolName} in ${input.parentSymbolName} at ${location}`
			}
			return `${input.language} ${input.chunkKind} ${input.symbolName} in ${location}`
		}
		return `${input.language} ${input.chunkKind} chunk in ${location}`
	}

	private buildSearchText(input: {
		filePath: string
		language: string
		chunkKind: string
		symbolName: string | null
		parentSymbolName: string | null
		startLine: number
		endLine: number
		content: string
	}): string {
		const headerLines = [
			`Path: ${input.filePath}`,
			`Language: ${input.language}`,
			`Kind: ${input.chunkKind}`,
			`Lines: ${input.startLine}-${input.endLine}`,
		]
		if (input.symbolName) {
			headerLines.push(`Symbol: ${input.symbolName}`)
		}
		if (input.parentSymbolName) {
			headerLines.push(`Parent: ${input.parentSymbolName}`)
		}
		return `${headerLines.join("\n")}\n\n${input.content}`
	}

	private buildQualifiedName(parentSymbolName: string | null, symbolName: string | null): string | null {
		if (!symbolName) {
			return null
		}
		return parentSymbolName ? `${parentSymbolName}.${symbolName}` : symbolName
	}
}
