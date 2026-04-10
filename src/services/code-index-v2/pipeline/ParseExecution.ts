import { createHash } from "crypto"
import { ParsedChunk } from "../adapters/ParserAdapter"

export interface ParsedChunkUpsertInput {
	chunkFingerprint: string
	startLine: number
	endLine: number
	content: string
	language?: string | null
	chunkKind?: string | null
	symbolName?: string | null
	symbolQualifiedName?: string | null
	parentSymbolName?: string | null
	parentChunkFingerprint?: string | null
	summary?: string | null
	searchText?: string | null
}

export function toParsedChunkUpsertInputs(chunks: ParsedChunk[]): ParsedChunkUpsertInput[] {
	return chunks.map((chunk) => ({
		chunkFingerprint: chunk.chunkFingerprint,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
		content: chunk.content,
		language: chunk.language ?? null,
		chunkKind: chunk.chunkKind ?? null,
		symbolName: chunk.symbolName ?? null,
		symbolQualifiedName: chunk.symbolQualifiedName ?? null,
		parentSymbolName: chunk.parentSymbolName ?? null,
		parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
		summary: chunk.summary ?? null,
		searchText: chunk.searchText ?? chunk.content,
	}))
}

export function buildChunkVariants(
	chunk: {
		chunkId: string
		content: string
		searchText?: string | null
		tokenEstimate?: number | null
		symbolQualifiedName?: string | null
		symbolName?: string | null
		language?: string | null
		chunkKind?: string | null
		parentSymbolName?: string | null
		startLine: number
		endLine: number
	},
	relativePath: string,
): Array<{
	chunkId: string
	variantType: "raw_code" | "symbol_signature"
	content: string
	contentHash: string
	tokenEstimate?: number | null
	state: "parsed"
}> {
	const variants: Array<{
		chunkId: string
		variantType: "raw_code" | "symbol_signature"
		content: string
		contentHash: string
		tokenEstimate?: number | null
		state: "parsed"
	}> = [
		{
			chunkId: chunk.chunkId,
			variantType: "raw_code",
			content: chunk.searchText ?? chunk.content,
			contentHash: createHash("sha256")
				.update(chunk.searchText ?? chunk.content)
				.digest("hex"),
			tokenEstimate: chunk.tokenEstimate ?? null,
			state: "parsed",
		},
	]

	const signature = buildSymbolSignatureVariant(chunk, relativePath)
	if (signature) {
		variants.push({
			chunkId: chunk.chunkId,
			variantType: "symbol_signature",
			content: signature,
			contentHash: createHash("sha256").update(signature).digest("hex"),
			state: "parsed",
		})
	}

	return variants
}

export function buildSymbolSignatureVariant(
	chunk: {
		symbolQualifiedName?: string | null
		symbolName?: string | null
		language?: string | null
		chunkKind?: string | null
		parentSymbolName?: string | null
		startLine: number
		endLine: number
	},
	relativePath: string,
): string | null {
	const symbolName = chunk.symbolQualifiedName ?? chunk.symbolName
	if (!symbolName) {
		return null
	}

	const parts = [
		chunk.language ?? "unknown",
		chunk.chunkKind ?? "chunk",
		symbolName,
		`path ${relativePath}`,
		`lines ${chunk.startLine}-${chunk.endLine}`,
	]
	if (chunk.parentSymbolName && chunk.parentSymbolName !== symbolName) {
		parts.push(`parent ${chunk.parentSymbolName}`)
	}
	return parts.join(" | ")
}
