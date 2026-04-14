import { createHash } from "crypto"
import { EmbeddingAdapter } from "../adapters/EmbeddingAdapter"
import { VectorPoint, VectorStoreAdapter } from "../adapters/VectorStoreAdapter"
import { buildRawCodeVariantContent } from "../shared/chunkSurfaces"
import type {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
} from "../../code-index/interfaces/embedder"

export interface EmbedUpsertChunkInput {
	chunkId: string
	revisionId: string
	chunkFingerprint: string
	startLine: number
	endLine: number
	content: string
	fileId: string
	workspaceId: string
	relativePath: string
	parserVersion: string
	chunkerVersion: string
	language?: string | null
	chunkKind?: string | null
	symbolName?: string | null
	symbolQualifiedName?: string | null
	parentSymbolName?: string | null
	parentChunkFingerprint?: string | null
	summary?: string | null
	searchText?: string | null
}

export interface EmbedUpsertVariantInput {
	variantId: string
	chunkId: string
	variantType: "raw_code" | "summary" | "symbol_signature"
	content: string
	vectorEligible?: boolean
	vectorPriority?: number
	vectorEligibilityReason?: string | null
	noveltyScore?: number | null
}

export interface EmbedUpsertBatchItem {
	chunk: EmbedUpsertChunkInput
	variants: EmbedUpsertVariantInput[]
}

export interface EmbedUpsertExecutionResult {
	embeddingCount: number
	embedLatencyMs: number
	upsertLatencyMs: number
	pointIds: string[]
	variantTelemetry: {
		storedVariantCount: number
		embeddedVariantCount: number
		storedVariantCountsByType: Partial<Record<EmbedUpsertVariantInput["variantType"], number>>
		embeddedVariantCountsByType: Partial<Record<EmbedUpsertVariantInput["variantType"], number>>
		skippedVectorizationReasons: Record<string, number>
	}
	adaptiveControllerState?: AdaptiveEmbeddingControllerState
	adaptiveControllerObservations?: AdaptiveProviderObservation[]
}

export function getChunkVariantsForEmbedding(
	chunk: EmbedUpsertChunkInput,
	variants: EmbedUpsertVariantInput[],
): EmbedUpsertVariantInput[] {
	if (variants.length > 0) {
		const vectorEligible = variants
			.filter((variant) => variant.vectorEligible !== false)
			.sort((left, right) => (right.vectorPriority ?? 0) - (left.vectorPriority ?? 0))
		if (vectorEligible.length > 0) {
			return vectorEligible
		}
	}

	const rawCode = buildRawCodeVariantContent({
		relativePath: chunk.relativePath,
		content: chunk.content,
		language: chunk.language ?? null,
		chunkKind: chunk.chunkKind ?? null,
		symbolName: chunk.symbolName ?? null,
		symbolQualifiedName: chunk.symbolQualifiedName ?? null,
		parentSymbolName: chunk.parentSymbolName ?? null,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
	})

	return [
		{
			variantId: `legacy:${chunk.chunkId}`,
			chunkId: chunk.chunkId,
			variantType: "raw_code",
			content: rawCode,
			vectorEligible: true,
			vectorPriority: 1000,
			vectorEligibilityReason: "legacy_fallback_raw_code",
			noveltyScore: 1,
		},
	]
}

function countVariantTypes(
	variants: EmbedUpsertVariantInput[],
): Partial<Record<EmbedUpsertVariantInput["variantType"], number>> {
	return variants.reduce<Partial<Record<EmbedUpsertVariantInput["variantType"], number>>>((acc, variant) => {
		acc[variant.variantType] = (acc[variant.variantType] ?? 0) + 1
		return acc
	}, {})
}

function countSkippedVectorizationReasons(variants: EmbedUpsertVariantInput[]): Record<string, number> {
	return variants.reduce<Record<string, number>>((acc, variant) => {
		if (variant.vectorEligible !== false) {
			return acc
		}
		const reason = variant.vectorEligibilityReason ?? "lexical_only:unspecified"
		acc[reason] = (acc[reason] ?? 0) + 1
		return acc
	}, {})
}

export function createPointId(
	chunk: EmbedUpsertChunkInput,
	variantType: EmbedUpsertVariantInput["variantType"],
): string {
	const seed = [
		chunk.workspaceId,
		chunk.relativePath,
		chunk.revisionId,
		chunk.parserVersion,
		chunk.chunkFingerprint,
		variantType,
	].join(":")
	const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("")
	hex[12] = "5"
	hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
	const uuid = hex.join("")
	return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`
}

export function createPoint(
	chunk: EmbedUpsertChunkInput,
	variant: EmbedUpsertVariantInput,
	vector: number[],
	modelId: string,
): VectorPoint {
	return {
		id: createPointId(chunk, variant.variantType),
		vector,
		payload: {
			workspaceId: chunk.workspaceId,
			fileId: chunk.fileId,
			relativePath: chunk.relativePath,
			revisionId: chunk.revisionId,
			chunkFingerprint: chunk.chunkFingerprint,
			variantType: variant.variantType,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			language: chunk.language ?? undefined,
			chunkKind: chunk.chunkKind ?? undefined,
			symbolName: chunk.symbolName ?? undefined,
			symbolQualifiedName: chunk.symbolQualifiedName ?? undefined,
			parentSymbolName: chunk.parentSymbolName ?? undefined,
			parentChunkFingerprint: chunk.parentChunkFingerprint ?? undefined,
			summary: chunk.summary ?? undefined,
			modelId,
			parserVersion: chunk.parserVersion,
			chunkerVersion: chunk.chunkerVersion,
			codeChunk: chunk.content,
			searchText: chunk.searchText ?? undefined,
			filePath: chunk.relativePath,
			pathSegments: chunk.relativePath
				.split(/[\\/]/)
				.filter(Boolean)
				.reduce<Record<string, string>>((acc, segment, index) => {
					acc[index.toString()] = segment
					return acc
				}, {}),
		},
	}
}

export async function executeUpsertBatch(
	items: EmbedUpsertBatchItem[],
	embeddingAdapter: EmbeddingAdapter,
	vectorStore: VectorStoreAdapter,
	options?: {
		signal?: AbortSignal
		debugContext?: {
			runId?: string
			batchId?: string
			outerBatchSize?: number
			workspacePath?: string
		}
	},
): Promise<EmbedUpsertExecutionResult> {
	const variantPairs = items.flatMap(({ chunk, variants }) =>
		getChunkVariantsForEmbedding(chunk, variants).map((variant) => ({
			chunk,
			variant,
		})),
	)
	const storedVariants = items.flatMap(({ variants }) => variants)
	const embeddedVariants = variantPairs.map(({ variant }) => variant)
	const variantTelemetry = {
		storedVariantCount: storedVariants.length,
		embeddedVariantCount: embeddedVariants.length,
		storedVariantCountsByType: countVariantTypes(storedVariants),
		embeddedVariantCountsByType: countVariantTypes(embeddedVariants),
		skippedVectorizationReasons: countSkippedVectorizationReasons(storedVariants),
	}

	if (variantPairs.length === 0) {
		return {
			embeddingCount: 0,
			embedLatencyMs: 0,
			upsertLatencyMs: 0,
			pointIds: [],
			variantTelemetry,
		}
	}

	const embedStartedAt = Date.now()
	const embeddingResponse = await embeddingAdapter.createEmbeddings(
		variantPairs.map(({ variant }) => variant.content),
		{
			signal: options?.signal,
			debugContext: options?.debugContext,
		},
	)
	const embedLatencyMs = Date.now() - embedStartedAt

	const points = variantPairs.map(({ chunk, variant }, index) =>
		createPoint(chunk, variant, embeddingResponse.embeddings[index] ?? [], embeddingAdapter.modelId),
	)
	const upsertStartedAt = Date.now()
	await vectorStore.upsertPoints(points)
	const upsertLatencyMs = Date.now() - upsertStartedAt

	return {
		embeddingCount: embeddingResponse.embeddings.length,
		embedLatencyMs,
		upsertLatencyMs,
		pointIds: points.map((point) => point.id),
		variantTelemetry,
		adaptiveControllerState: embeddingResponse.adaptiveControllerState,
		adaptiveControllerObservations: embeddingResponse.adaptiveControllerObservations,
	}
}
