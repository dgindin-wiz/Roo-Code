import { createHash } from "crypto"
import { ParsedChunk } from "../adapters/ParserAdapter"
import {
	buildRawCodeVariantContent,
	buildSymbolSignatureVariant,
	ChunkSurfaceInput,
	extractDeclarationSignature,
} from "../shared/chunkSurfaces"

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
		summary?: string | null
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
	variantType: "raw_code" | "summary" | "symbol_signature"
	content: string
	contentHash: string
	tokenEstimate?: number | null
	vectorEligible: boolean
	vectorPriority: number
	vectorEligibilityReason: string
	noveltyScore: number
	state: "parsed"
}> {
	const rawCode = buildRawCodeVariantContent({
		relativePath,
		content: chunk.content,
		language: chunk.language ?? null,
		chunkKind: chunk.chunkKind ?? null,
		symbolName: chunk.symbolName ?? null,
		symbolQualifiedName: chunk.symbolQualifiedName ?? null,
		parentSymbolName: chunk.parentSymbolName ?? null,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
	})

	const summary = chunk.summary?.trim()
	const signature = buildSymbolSignatureVariant({
		relativePath,
		content: chunk.content,
		language: chunk.language ?? null,
		chunkKind: chunk.chunkKind ?? null,
		symbolName: chunk.symbolName ?? null,
		symbolQualifiedName: chunk.symbolQualifiedName ?? null,
		parentSymbolName: chunk.parentSymbolName ?? null,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
	} satisfies ChunkSurfaceInput)
	const summaryEligibility = scoreSummaryVariant(summary, rawCode, chunk.searchText ?? null, chunk.symbolName ?? null)
	const signatureEligibility = scoreSignatureVariant(
		signature,
		rawCode,
		summary,
		Boolean(chunk.symbolQualifiedName ?? chunk.symbolName),
		Boolean(extractDeclarationSignature(chunk.content)),
		chunk.chunkKind ?? null,
	)
	const auxiliarySelection = selectVectorEligibleAuxiliaries(summaryEligibility, signatureEligibility)

	const variants: Array<{
		chunkId: string
		variantType: "raw_code" | "summary" | "symbol_signature"
		content: string
		contentHash: string
		tokenEstimate?: number | null
		vectorEligible: boolean
		vectorPriority: number
		vectorEligibilityReason: string
		noveltyScore: number
		state: "parsed"
	}> = [
		{
			chunkId: chunk.chunkId,
			variantType: "raw_code",
			content: rawCode,
			contentHash: createHash("sha256").update(rawCode).digest("hex"),
			tokenEstimate: chunk.tokenEstimate ?? null,
			vectorEligible: true,
			vectorPriority: 1000,
			vectorEligibilityReason: "canonical_grounding_surface",
			noveltyScore: 1,
			state: "parsed",
		},
	]

	if (summary) {
		variants.push({
			chunkId: chunk.chunkId,
			variantType: "summary",
			content: summary,
			contentHash: createHash("sha256").update(summary).digest("hex"),
			vectorEligible: auxiliarySelection.summary,
			vectorPriority: auxiliarySelection.summary ? 700 : 0,
			vectorEligibilityReason: auxiliarySelection.summary
				? summaryEligibility.reason
				: `lexical_only:${summaryEligibility.reason}`,
			noveltyScore: summaryEligibility.noveltyScore,
			state: "parsed",
		})
	}

	if (signature) {
		variants.push({
			chunkId: chunk.chunkId,
			variantType: "symbol_signature",
			content: signature,
			contentHash: createHash("sha256").update(signature).digest("hex"),
			vectorEligible: auxiliarySelection.symbolSignature,
			vectorPriority: auxiliarySelection.symbolSignature ? 800 : 0,
			vectorEligibilityReason: auxiliarySelection.symbolSignature
				? signatureEligibility.reason
				: `lexical_only:${signatureEligibility.reason}`,
			noveltyScore: signatureEligibility.noveltyScore,
			state: "parsed",
		})
	}

	return variants
}

interface VariantEligibilityScore {
	variantType: "summary" | "symbol_signature"
	eligible: boolean
	score: number
	noveltyScore: number
	reason: string
	allowDualIntent?: boolean
}

const TOKEN_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"at",
	"by",
	"chunk",
	"for",
	"in",
	"kind",
	"language",
	"lines",
	"of",
	"on",
	"or",
	"path",
	"symbol",
	"the",
	"to",
	"unknown",
])

function scoreSummaryVariant(
	summary: string | null | undefined,
	rawCode: string,
	searchText: string | null,
	symbolName: string | null,
): VariantEligibilityScore {
	if (!summary) {
		return {
			variantType: "summary",
			eligible: false,
			score: 0,
			noveltyScore: 0,
			reason: "missing_summary",
		}
	}

	const noveltyScore = computeNoveltyScore(summary, [rawCode, searchText])
	const behaviorPhraseCount = summary.split("•").length - 1
	const hasHumanizedSymbolWords = Boolean(symbolName && summary.includes("(") && summary.includes(")"))
	const isBoilerplateLocationSummary = !symbolName && !summary.includes("•")
	const summaryScore =
		noveltyScore +
		(behaviorPhraseCount > 0 ? 0.45 : 0) +
		(hasHumanizedSymbolWords ? 0.12 : 0) -
		(isBoilerplateLocationSummary ? 0.2 : 0)
	const eligible = behaviorPhraseCount > 0 || (summaryScore >= 0.35 && countSignalTokens(summary) >= 5)

	return {
		variantType: "summary",
		eligible,
		score: Number(summaryScore.toFixed(3)),
		noveltyScore,
		reason:
			behaviorPhraseCount > 0
				? "behavioral_summary"
				: eligible
					? "novel_language_summary"
					: "boilerplate_summary",
		allowDualIntent: behaviorPhraseCount > 0,
	}
}

function scoreSignatureVariant(
	signature: string | null | undefined,
	rawCode: string,
	summary: string | null | undefined,
	hasSymbol: boolean,
	hasExtractedSignature: boolean,
	chunkKind: string | null,
): VariantEligibilityScore {
	if (!signature) {
		return {
			variantType: "symbol_signature",
			eligible: false,
			score: 0,
			noveltyScore: 0,
			reason: "missing_signature",
		}
	}

	const noveltyScore = computeNoveltyScore(signature, [rawCode, summary])
	const symbolKindBonus =
		chunkKind && ["function", "method", "class", "interface", "type", "enum"].includes(chunkKind) ? 0.15 : 0
	const signatureScore =
		noveltyScore + (hasExtractedSignature ? 0.45 : 0.25) + (hasSymbol ? 0.2 : -0.35) + symbolKindBonus
	const eligible = hasSymbol && signatureScore >= 0.45

	return {
		variantType: "symbol_signature",
		eligible,
		score: Number(signatureScore.toFixed(3)),
		noveltyScore,
		reason: hasExtractedSignature
			? eligible
				? "extracted_symbol_signature"
				: "weak_extracted_signature"
			: eligible
				? "fallback_symbol_signature"
				: "weak_fallback_signature",
		allowDualIntent: hasExtractedSignature,
	}
}

function selectVectorEligibleAuxiliaries(
	summary: VariantEligibilityScore,
	signature: VariantEligibilityScore,
): { summary: boolean; symbolSignature: boolean } {
	const eligible = [summary, signature]
		.filter((candidate) => candidate.eligible)
		.sort((left, right) => right.score - left.score)
	if (eligible.length === 0) {
		return { summary: false, symbolSignature: false }
	}

	if (
		eligible.length > 1 &&
		summary.eligible &&
		signature.eligible &&
		summary.allowDualIntent &&
		signature.allowDualIntent &&
		summary.score >= 0.55 &&
		signature.score >= 0.55
	) {
		return { summary: true, symbolSignature: true }
	}

	return {
		summary: eligible[0]?.variantType === "summary",
		symbolSignature: eligible[0]?.variantType === "symbol_signature",
	}
}

function computeNoveltyScore(candidate: string, references: Array<string | null | undefined>): number {
	const candidateTokens = tokenizeSignalText(candidate)
	if (candidateTokens.size === 0) {
		return 0
	}

	const referenceTokens = new Set<string>()
	for (const reference of references) {
		for (const token of tokenizeSignalText(reference ?? "")) {
			referenceTokens.add(token)
		}
	}

	let novelTokenCount = 0
	for (const token of candidateTokens) {
		if (!referenceTokens.has(token)) {
			novelTokenCount++
		}
	}

	return Number((novelTokenCount / candidateTokens.size).toFixed(3))
}

function countSignalTokens(text: string): number {
	return tokenizeSignalText(text).size
}

function tokenizeSignalText(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.map((token) => token.trim())
			.filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)),
	)
}
