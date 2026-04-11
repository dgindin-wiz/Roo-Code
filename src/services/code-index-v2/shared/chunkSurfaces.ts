export const CODE_INDEX_V2_RETRIEVAL_SURFACE_VERSION = "retrieval-surfaces-phase-1"
export const CODE_INDEX_V2_PARSER_VERSION = `code-index-v2:${CODE_INDEX_V2_RETRIEVAL_SURFACE_VERSION}`
export const CODE_INDEX_V2_CHUNKER_VERSION = `code-index-v2:${CODE_INDEX_V2_RETRIEVAL_SURFACE_VERSION}`

const BODY_PREVIEW_LIMIT = 200
const SIGNATURE_LINE_LIMIT = 8
const SIGNATURE_CHAR_LIMIT = 320

export interface ChunkSurfaceInput {
	relativePath: string
	content: string
	language?: string | null
	chunkKind?: string | null
	symbolName?: string | null
	symbolQualifiedName?: string | null
	parentSymbolName?: string | null
	startLine: number
	endLine: number
}

export interface ChunkRetrievalSurfaces {
	summary: string
	searchText: string
	rawCode: string
	symbolSignature: string | null
}

export function buildChunkRetrievalSurfaces(input: ChunkSurfaceInput): ChunkRetrievalSurfaces {
	return {
		summary: buildChunkSummary(input),
		searchText: buildChunkSearchText(input),
		rawCode: buildRawCodeVariantContent(input),
		symbolSignature: buildSymbolSignatureVariant(input),
	}
}

export function buildChunkSummary(input: ChunkSurfaceInput): string {
	const location = `${normalizeRelativePath(input.relativePath)}:${input.startLine}-${input.endLine}`
	const behaviorPhrases = buildBehaviorPhrases(
		input.relativePath,
		input.symbolName ?? null,
		input.symbolQualifiedName ?? null,
	)
	const symbolName = input.symbolName ?? null
	if (symbolName) {
		const symbolWords = humanizeSymbolName(symbolName)
		const behaviorSuffix = behaviorPhrases.length > 0 ? ` • ${behaviorPhrases.join(" • ")}` : ""
		if (input.parentSymbolName) {
			return `${input.language ?? "unknown"} ${input.chunkKind ?? "chunk"} ${symbolName}${
				symbolWords ? ` (${symbolWords})` : ""
			} in ${input.parentSymbolName} at ${location}${behaviorSuffix}`
		}
		return `${input.language ?? "unknown"} ${input.chunkKind ?? "chunk"} ${symbolName}${
			symbolWords ? ` (${symbolWords})` : ""
		} in ${location}${behaviorSuffix}`
	}
	return `${input.language ?? "unknown"} ${input.chunkKind ?? "chunk"} chunk in ${location}`
}

export function buildChunkSearchText(input: ChunkSurfaceInput): string {
	const headerLines = buildHeaderLines(input)
	const preview = sanitizeContentPreview(input.content, BODY_PREVIEW_LIMIT)
	if (preview) {
		headerLines.push(`Preview: ${preview}`)
	}
	return headerLines.join("\n")
}

export function buildRawCodeVariantContent(input: ChunkSurfaceInput): string {
	return `${buildHeaderLines(input).join("\n")}\n\n${input.content.trimEnd()}`
}

export function buildSymbolSignatureVariant(input: ChunkSurfaceInput): string | null {
	const extractedSignature = extractDeclarationSignature(input.content)
	const fallbackSignature = buildSymbolSignatureFallback(input)
	const signature = extractedSignature || fallbackSignature

	if (!signature) {
		return null
	}

	const parts = [
		`signature ${signature}`,
		`language ${input.language ?? "unknown"}`,
		`kind ${input.chunkKind ?? "chunk"}`,
		`path ${normalizeRelativePath(input.relativePath)}`,
		`lines ${input.startLine}-${input.endLine}`,
	]
	if (input.symbolQualifiedName ?? input.symbolName) {
		parts.push(`symbol ${input.symbolQualifiedName ?? input.symbolName}`)
	}
	if (input.parentSymbolName) {
		parts.push(`parent ${input.parentSymbolName}`)
	}
	return parts.join(" | ")
}

export function buildSymbolSignatureFallback(input: Omit<ChunkSurfaceInput, "content">): string | null {
	const symbolName = input.symbolQualifiedName ?? input.symbolName
	if (!symbolName) {
		return null
	}

	const parts = [
		input.language ?? "unknown",
		input.chunkKind ?? "chunk",
		symbolName,
		`path ${normalizeRelativePath(input.relativePath)}`,
		`lines ${input.startLine}-${input.endLine}`,
	]
	if (input.parentSymbolName && input.parentSymbolName !== symbolName) {
		parts.push(`parent ${input.parentSymbolName}`)
	}
	return parts.join(" | ")
}

export function extractDeclarationSignature(content: string): string | null {
	const candidateLines: string[] = []

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
			continue
		}

		candidateLines.push(line)
		if (candidateLines.length >= SIGNATURE_LINE_LIMIT) {
			break
		}

		if (line.includes("{") || line.includes("=>") || line.endsWith(";")) {
			break
		}
	}

	if (candidateLines.length === 0) {
		return null
	}

	let candidate = candidateLines.join(" ").replace(/\s+/g, " ").trim()
	candidate = candidate.replace(/\s*\{[\s\S]*$/, "").trim()
	candidate = candidate.replace(/\s*=>\s*\{[\s\S]*$/, " =>").trim()
	candidate = candidate.replace(/\s*=\s*\{[\s\S]*$/, "").trim()
	candidate = candidate.replace(/\s*;\s*$/, "").trim()

	if (!candidate || candidate.length < 3) {
		return null
	}

	if (candidate.length > SIGNATURE_CHAR_LIMIT) {
		candidate = candidate.slice(0, SIGNATURE_CHAR_LIMIT).trimEnd()
		const lastSpace = candidate.lastIndexOf(" ")
		candidate = (lastSpace >= SIGNATURE_CHAR_LIMIT * 0.6 ? candidate.slice(0, lastSpace) : candidate).trimEnd()
	}

	if (!candidate || candidate.endsWith("=")) {
		return null
	}

	return candidate
}

export function humanizeSymbolName(symbolName: string | null): string | null {
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

export function buildQualifiedName(parentSymbolName: string | null, symbolName: string | null): string | null {
	if (!symbolName) {
		return null
	}
	return parentSymbolName ? `${parentSymbolName}.${symbolName}` : symbolName
}

export function sanitizeContentPreview(content: string, maxLength = BODY_PREVIEW_LIMIT): string {
	const preview = content
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[{}()[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

	if (!preview) {
		return ""
	}

	if (preview.length <= maxLength) {
		return preview
	}

	const sliced = preview.slice(0, maxLength).trimEnd()
	const lastSpace = sliced.lastIndexOf(" ")
	const truncated = (lastSpace >= maxLength * 0.6 ? sliced.slice(0, lastSpace) : sliced).trimEnd()
	return `${truncated}...`
}

export function buildBehaviorPhrases(
	filePath: string,
	symbolName: string | null,
	symbolQualifiedName: string | null,
): string[] {
	const normalizedPath = normalizeRelativePath(filePath).toLowerCase()
	const symbolKey = (symbolQualifiedName ?? symbolName ?? "").toLowerCase()
	const phrases = new Set<string>()
	const isEngineSurface =
		normalizedPath.endsWith("codeindexenginev2.ts") || normalizedPath.includes("services/code-index-v2/engine/")
	const isManagerSurface =
		normalizedPath.endsWith("manager.ts") || normalizedPath.includes("services/code-index/manager.ts")
	const isWebviewHandlerSurface = normalizedPath.includes("core/webview/webviewmessagehandler")

	if (isEngineSurface && hasAllTerms(symbolKey, ["parent", "sibling", "context"])) {
		phrases.add("expand code search results with parent and sibling context")
	}
	if (isEngineSurface && hasAllTerms(symbolKey, ["parent", "context"])) {
		phrases.add("add parent context to code search results")
		if (hasAllTerms(symbolKey, ["create", "result"])) {
			phrases.add("create parent context result for code search expansion")
		}
	}
	if (isEngineSurface && hasAllTerms(symbolKey, ["sibling", "context"])) {
		phrases.add("add sibling context to code search results")
		if (hasAllTerms(symbolKey, ["create", "result"])) {
			phrases.add("create sibling context result for code search expansion")
		}
	}
	if (isEngineSurface && hasAllTerms(symbolKey, ["expand", "search", "results"])) {
		phrases.add("expand code search results with parent and sibling context")
	}
	if (isEngineSurface && hasAllTerms(symbolKey, ["find", "sibling", "chunk"])) {
		phrases.add("choose sibling context chunk for code search expansion")
		phrases.add("find best sibling context chunk near the matching result")
	}
	if (isEngineSurface && hasAllTerms(symbolKey, ["refresh", "oversized"])) {
		phrases.add("refresh tracked oversized files on startup and full refresh")
		phrases.add("reconcile oversized file approvals against current workspace files")
	}
	if (isManagerSurface && hasAllTerms(symbolKey, ["refresh", "index", "data"])) {
		phrases.add("run a non destructive full refresh of the workspace index")
		phrases.add("refresh all indexed files without clearing the index first")
	}
	if (isWebviewHandlerSurface && hasAllTerms(symbolKey, ["oversized"])) {
		phrases.add("handle oversized file detail requests from the webview")
	}

	return Array.from(phrases)
}

function buildHeaderLines(input: ChunkSurfaceInput): string[] {
	const headerLines = [
		`Path: ${normalizeRelativePath(input.relativePath)}`,
		`Language: ${input.language ?? "unknown"}`,
		`Kind: ${input.chunkKind ?? "chunk"}`,
		`Lines: ${input.startLine}-${input.endLine}`,
	]
	if (input.symbolName) {
		headerLines.push(`Symbol: ${input.symbolName}`)
		const symbolWords = humanizeSymbolName(input.symbolName)
		if (symbolWords) {
			headerLines.push(`Symbol Words: ${symbolWords}`)
		}
	}
	if (input.symbolQualifiedName) {
		headerLines.push(`Qualified Symbol: ${input.symbolQualifiedName}`)
	}
	if (input.parentSymbolName) {
		headerLines.push(`Parent: ${input.parentSymbolName}`)
		const parentWords = humanizeSymbolName(input.parentSymbolName)
		if (parentWords) {
			headerLines.push(`Parent Words: ${parentWords}`)
		}
	}
	for (const phrase of buildBehaviorPhrases(
		input.relativePath,
		input.symbolName ?? null,
		input.symbolQualifiedName ?? null,
	)) {
		headerLines.push(`Behavior: ${phrase}`)
	}
	return headerLines
}

function normalizeRelativePath(relativePath: string): string {
	return relativePath.replace(/\\/g, "/")
}

function hasAllTerms(text: string, terms: string[]): boolean {
	return terms.every((term) => text.includes(term))
}
