import * as path from "path"
import { codeParser } from "../../code-index/processors/parser"
import { ParserAdapter, ParsedChunk } from "./ParserAdapter"
import { buildChunkRetrievalSurfaces, buildQualifiedName, CODE_INDEX_V2_PARSER_VERSION } from "../shared/chunkSurfaces"

export class CodeIndexParserAdapter implements ParserAdapter {
	readonly parserVersion = CODE_INDEX_V2_PARSER_VERSION

	async parseFile(input: {
		filePath: string
		relativePath: string
		content: string
		maxFileSizeBytes?: number
	}): Promise<ParsedChunk[]> {
		const language = this.getLanguageFromPath(input.filePath)
		const blocks = await codeParser.parseFile(input.filePath, {
			content: input.content,
			maxFileSizeBytes: input.maxFileSizeBytes,
		})
		const relativePath = input.relativePath.replace(/\\/g, "/")

		return blocks.map((block) => {
			const chunkKind = this.normalizeChunkKind(block.type)
			const symbolQualifiedName = buildQualifiedName(block.parentIdentifier ?? null, block.identifier)
			const surfaces = buildChunkRetrievalSurfaces({
				relativePath,
				content: block.content,
				language,
				chunkKind,
				symbolName: block.identifier,
				symbolQualifiedName,
				parentSymbolName: block.parentIdentifier ?? null,
				startLine: block.start_line,
				endLine: block.end_line,
			})

			return {
				chunkFingerprint: block.segmentHash,
				content: block.content,
				searchText: surfaces.searchText,
				summary: surfaces.summary,
				startLine: block.start_line,
				endLine: block.end_line,
				language,
				chunkKind,
				symbolName: block.identifier,
				symbolQualifiedName,
				parentSymbolName: block.parentIdentifier ?? null,
				parentChunkFingerprint: block.parentChunkFingerprint ?? null,
			}
		})
	}

	private getLanguageFromPath(filePath: string): string {
		return path.extname(filePath).replace(/^\./, "").toLowerCase() || "unknown"
	}

	private normalizeChunkKind(type: string): string {
		const normalized = type.toLowerCase()
		const exactKindMap: Record<string, string> = {
			class: "class",
			method: "method",
			function: "function",
			interface: "type",
			type: "type",
			enum: "enum",
			module: "module",
			namespace: "module",
			const: "constant",
			markdown_header: "section",
			markdown: "document_section",
			fallback: "fallback",
		}
		if (exactKindMap[normalized]) {
			return exactKindMap[normalized]
		}
		const compositeKinds = normalized.split(/[^a-z0-9]+/).filter(Boolean)
		if (compositeKinds.includes("method")) return "method"
		if (compositeKinds.includes("function")) return "function"
		if (compositeKinds.includes("class")) return "class"
		if (compositeKinds.includes("interface")) return "type"
		if (compositeKinds.includes("type")) return "type"
		if (compositeKinds.includes("enum")) return "enum"
		if (compositeKinds.includes("module") || compositeKinds.includes("namespace")) return "module"
		if (compositeKinds.includes("const")) return "constant"
		if (compositeKinds.includes("markdown") && compositeKinds.includes("header")) return "section"
		if (compositeKinds.includes("markdown")) return "document_section"
		if (compositeKinds.includes("fallback")) return "fallback"
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
}
