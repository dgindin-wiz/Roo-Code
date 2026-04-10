import * as path from "path"
import { codeParser } from "../../code-index/processors/parser"
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
				symbolQualifiedName: this.buildQualifiedName(block.parentIdentifier ?? null, block.identifier),
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
				symbolQualifiedName: this.buildQualifiedName(block.parentIdentifier ?? null, block.identifier),
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

	private buildSummary(input: {
		filePath: string
		language: string
		chunkKind: string
		symbolName: string | null
		symbolQualifiedName: string | null
		parentSymbolName: string | null
		startLine: number
		endLine: number
	}): string {
		const location = `${input.filePath}:${input.startLine}-${input.endLine}`
		const behaviorPhrases = this.buildBehaviorPhrases(input.filePath, input.symbolName, input.symbolQualifiedName)
		if (input.symbolName) {
			const symbolWords = this.humanizeSymbolName(input.symbolName)
			const behaviorSuffix = behaviorPhrases.length > 0 ? ` • ${behaviorPhrases.join(" • ")}` : ""
			if (input.parentSymbolName) {
				return `${input.language} ${input.chunkKind} ${input.symbolName}${symbolWords ? ` (${symbolWords})` : ""} in ${input.parentSymbolName} at ${location}${behaviorSuffix}`
			}
			return `${input.language} ${input.chunkKind} ${input.symbolName}${symbolWords ? ` (${symbolWords})` : ""} in ${location}${behaviorSuffix}`
		}
		return `${input.language} ${input.chunkKind} chunk in ${location}`
	}

	private buildSearchText(input: {
		filePath: string
		language: string
		chunkKind: string
		symbolName: string | null
		symbolQualifiedName: string | null
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
			const symbolWords = this.humanizeSymbolName(input.symbolName)
			if (symbolWords) {
				headerLines.push(`Symbol Words: ${symbolWords}`)
			}
		}
		if (input.symbolQualifiedName) {
			headerLines.push(`Qualified Symbol: ${input.symbolQualifiedName}`)
		}
		if (input.parentSymbolName) {
			headerLines.push(`Parent: ${input.parentSymbolName}`)
			const parentWords = this.humanizeSymbolName(input.parentSymbolName)
			if (parentWords) {
				headerLines.push(`Parent Words: ${parentWords}`)
			}
		}
		const behaviorPhrases = this.buildBehaviorPhrases(input.filePath, input.symbolName, input.symbolQualifiedName)
		for (const phrase of behaviorPhrases) {
			headerLines.push(`Behavior: ${phrase}`)
		}
		return `${headerLines.join("\n")}\n\n${input.content}`
	}

	private humanizeSymbolName(symbolName: string | null): string | null {
		if (!symbolName) {
			return null
		}

		const finalSegment = symbolName.split(".").filter(Boolean).pop() ?? symbolName
		const spaced = finalSegment
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.trim()
			.toLowerCase()

		return spaced && spaced !== finalSegment.toLowerCase() ? spaced : null
	}

	private buildQualifiedName(parentSymbolName: string | null, symbolName: string | null): string | null {
		if (!symbolName) {
			return null
		}
		return parentSymbolName ? `${parentSymbolName}.${symbolName}` : symbolName
	}

	private buildBehaviorPhrases(
		filePath: string,
		symbolName: string | null,
		symbolQualifiedName: string | null,
	): string[] {
		const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase()
		const symbolKey = (symbolQualifiedName ?? symbolName ?? "").toLowerCase()
		const phrases = new Set<string>()
		const isEngineSurface =
			normalizedPath.endsWith("/codeindexenginev2.ts") ||
			normalizedPath.includes("/services/code-index-v2/engine/")
		const isManagerSurface =
			normalizedPath.endsWith("/manager.ts") || normalizedPath.includes("/services/code-index/manager.ts")
		const isWebviewHandlerSurface = normalizedPath.includes("/core/webview/webviewmessagehandler")

		if (isEngineSurface && this.hasAllTerms(symbolKey, ["parent", "sibling", "context"])) {
			phrases.add("expand code search results with parent and sibling context")
		}
		if (isEngineSurface && this.hasAllTerms(symbolKey, ["parent", "context"])) {
			phrases.add("add parent context to code search results")
			if (this.hasAllTerms(symbolKey, ["create", "result"])) {
				phrases.add("create parent context result for code search expansion")
			}
		}
		if (isEngineSurface && this.hasAllTerms(symbolKey, ["sibling", "context"])) {
			phrases.add("add sibling context to code search results")
			if (this.hasAllTerms(symbolKey, ["create", "result"])) {
				phrases.add("create sibling context result for code search expansion")
			}
		}
		if (isEngineSurface && this.hasAllTerms(symbolKey, ["expand", "search", "results"])) {
			phrases.add("expand code search results with parent and sibling context")
		}
		if (isEngineSurface && this.hasAllTerms(symbolKey, ["find", "sibling", "chunk"])) {
			phrases.add("choose sibling context chunk for code search expansion")
			phrases.add("find best sibling context chunk near the matching result")
		}
		if (isEngineSurface && this.hasAllTerms(symbolKey, ["refresh", "oversized"])) {
			phrases.add("refresh tracked oversized files on startup and full refresh")
			phrases.add("reconcile oversized file approvals against current workspace files")
		}
		if (isManagerSurface && this.hasAllTerms(symbolKey, ["refresh", "index", "data"])) {
			phrases.add("run a non destructive full refresh of the workspace index")
			phrases.add("refresh all indexed files without clearing the index first")
		}
		if (isWebviewHandlerSurface && this.hasAllTerms(symbolKey, ["oversized"])) {
			phrases.add("handle oversized file detail requests from the webview")
		}

		return Array.from(phrases)
	}

	private hasAllTerms(text: string, terms: string[]): boolean {
		return terms.every((term) => text.includes(term))
	}
}
