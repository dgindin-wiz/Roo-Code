import { createHash } from "crypto"

export type AdaptiveProviderAdjustmentReason = "hard_latency" | "soft_latency" | "recovered_latency" | "steady_latency"

export interface AdaptiveEmbeddingControllerState {
	preferredRequestItemCap?: number
	stableRequestItemCap?: number
	ewmaLatencyMs?: number
	cooldownObservationsRemaining?: number
	fastObservationStreak?: number
	lastAdjustmentReason?: AdaptiveProviderAdjustmentReason
	lastObservedAt?: number
}

export interface AdaptiveProviderObservation {
	batchSize: number
	tokenCount?: number
	latencyMs: number
	observedAt?: number
	isQuery?: boolean
}

export interface AdaptiveProviderObservationResult {
	state: AdaptiveEmbeddingControllerState
	changed: boolean
	adjustmentReason?: AdaptiveProviderAdjustmentReason
}

const HARD_LATENCY_MS = 7_000
const SOFT_LATENCY_MS = 4_000
const FAST_LATENCY_MS = 1_500
const MIN_ITEM_CAP = 32
const HARD_REDUCTION_FACTOR = 0.6
const SOFT_REDUCTION_FACTOR = 0.8
const EWMA_WEIGHT = 0.25
const GROWTH_FAST_STREAK = 4
const GROWTH_COOLDOWN = 3

function sanitizeCap(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) {
		return undefined
	}
	return Math.max(MIN_ITEM_CAP, Math.floor(value))
}

function getAdditiveGrowthStep(cap: number): number {
	return Math.max(8, Math.ceil(cap * 0.08))
}

export function cloneAdaptiveEmbeddingControllerState(
	state?: AdaptiveEmbeddingControllerState,
): AdaptiveEmbeddingControllerState | undefined {
	return state ? { ...state } : undefined
}

export function getAdaptiveEmbeddingRecommendedBatchSize(state?: AdaptiveEmbeddingControllerState): number | undefined {
	return sanitizeCap(state?.preferredRequestItemCap)
}

export function applyAdaptiveProviderObservation(
	currentState: AdaptiveEmbeddingControllerState | undefined,
	observation: AdaptiveProviderObservation,
): AdaptiveProviderObservationResult {
	if (observation.isQuery || observation.batchSize <= 0 || !Number.isFinite(observation.latencyMs)) {
		return {
			state: cloneAdaptiveEmbeddingControllerState(currentState) ?? {},
			changed: false,
		}
	}

	const previous = cloneAdaptiveEmbeddingControllerState(currentState) ?? {}
	const next: AdaptiveEmbeddingControllerState = { ...previous }
	const observedAt = observation.observedAt ?? Date.now()
	const previousCap = sanitizeCap(previous.preferredRequestItemCap)
	const batchSize = Math.max(observation.batchSize, MIN_ITEM_CAP)
	const previousCooldown = Math.max(0, Math.trunc(previous.cooldownObservationsRemaining ?? 0))
	const previousStableCap = sanitizeCap(previous.stableRequestItemCap)
	const ewmaLatencyMs =
		previous.ewmaLatencyMs == null
			? observation.latencyMs
			: previous.ewmaLatencyMs * (1 - EWMA_WEIGHT) + observation.latencyMs * EWMA_WEIGHT
	const hardLatency = observation.latencyMs >= HARD_LATENCY_MS || ewmaLatencyMs >= HARD_LATENCY_MS
	const softLatency = !hardLatency && (observation.latencyMs >= SOFT_LATENCY_MS || ewmaLatencyMs >= SOFT_LATENCY_MS)
	const fastLatency = observation.latencyMs <= FAST_LATENCY_MS && ewmaLatencyMs <= SOFT_LATENCY_MS * 0.55
	let nextCap = previousCap
	let fastObservationStreak = Math.max(0, Math.trunc(previous.fastObservationStreak ?? 0))
	let cooldownObservationsRemaining = previousCooldown
	let stableRequestItemCap = previousStableCap
	let adjustmentReason: AdaptiveProviderAdjustmentReason | undefined

	if (hardLatency) {
		nextCap = sanitizeCap(Math.floor((previousCap ?? batchSize) * HARD_REDUCTION_FACTOR))
		stableRequestItemCap = nextCap
		fastObservationStreak = 0
		cooldownObservationsRemaining = GROWTH_COOLDOWN
		adjustmentReason = "hard_latency"
	} else if (softLatency) {
		nextCap = sanitizeCap(Math.floor((previousCap ?? batchSize) * SOFT_REDUCTION_FACTOR))
		stableRequestItemCap = nextCap
		fastObservationStreak = 0
		cooldownObservationsRemaining = GROWTH_COOLDOWN
		adjustmentReason = "soft_latency"
	} else {
		if (previousCap != null) {
			stableRequestItemCap = Math.max(previousStableCap ?? previousCap, previousCap)
		}

		if (cooldownObservationsRemaining > 0) {
			cooldownObservationsRemaining -= 1
			fastObservationStreak = 0
		} else if (fastLatency && previousCap != null) {
			fastObservationStreak += 1
			if (fastObservationStreak >= GROWTH_FAST_STREAK) {
				nextCap = sanitizeCap(previousCap + getAdditiveGrowthStep(previousCap))
				fastObservationStreak = 0
				adjustmentReason = "recovered_latency"
			}
		} else {
			fastObservationStreak = 0
			adjustmentReason = "steady_latency"
		}
	}

	next.preferredRequestItemCap = nextCap
	next.stableRequestItemCap = stableRequestItemCap
	next.ewmaLatencyMs = Number(ewmaLatencyMs.toFixed(1))
	next.cooldownObservationsRemaining = cooldownObservationsRemaining
	next.fastObservationStreak = fastObservationStreak
	next.lastAdjustmentReason = adjustmentReason
	next.lastObservedAt = observedAt

	const changed = JSON.stringify(previous) !== JSON.stringify(next)
	return {
		state: next,
		changed,
		adjustmentReason,
	}
}

export function normalizeEmbeddingEndpointFingerprint(endpoint: string | undefined): string | undefined {
	if (!endpoint) {
		return undefined
	}

	try {
		const parsed = new URL(endpoint)
		const normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "") || "/"}`
		return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
	} catch {
		return createHash("sha256").update(endpoint.trim().toLowerCase()).digest("hex").slice(0, 16)
	}
}

export function buildEmbeddingRuntimeProfileKey(input: {
	provider: string
	modelId: string
	runtimeKind: "local" | "remote"
	deviceHint?: string
	endpointFingerprint?: string
}): string {
	return [
		input.provider,
		input.modelId,
		input.runtimeKind,
		input.deviceHint ?? "unknown-device",
		input.endpointFingerprint ?? "no-endpoint",
	].join("::")
}
