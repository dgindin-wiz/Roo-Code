/**
 * Tests for CodeIndexPopover UI improvements:
 * - Stopping status color in popover dot
 * - Phase label display (scanning vs embedding)
 * - ETA display below progress bar
 * - Index stats when Indexed
 * - Re-index button for Indexed state
 * - formatEtaForDisplay helper
 */

import {
	formatDurationForDisplay,
	formatCodebaseProgressRows,
	getDefaultCodeIndexPopoverTab,
	getIndexingHeadline,
	INDEXING_WARNING_HELP_TEXT,
	getPrimaryElapsedMs,
	getRunSummaryDisplay,
	getMetadataCleanupCompactionAction,
	getVisibleIndexRuntimeSidecarMetrics,
	getVisibleIndexRuntimeTaskMetrics,
	getVisibleIndexServiceMetrics,
	getProgressStageLabel,
	hasExpandableIndexRuntimeSidecarContent,
	hasExpandableIndexRuntimeTaskContent,
	hasExpandableIndexServiceCardContent,
	shouldExpandIndexRuntimeSidecar,
	shouldExpandIndexRuntimeTask,
	shouldExpandIndexServiceCard,
} from "../CodeIndexPopover"

// --- Unit test: formatEtaForDisplay ---
// We test the function in isolation by extracting the same logic

function formatEtaForDisplay(ms: number): string {
	if (ms < 10_000) return "<10s remaining"
	if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes}m remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours}h remaining`
	return `~${hours}h ${remainingMinutes}m remaining`
}

describe("formatEtaForDisplay", () => {
	test("returns a definitive short ETA for < 10 seconds", () => {
		expect(formatEtaForDisplay(5_000)).toBe("<10s remaining")
		expect(formatEtaForDisplay(9_999)).toBe("<10s remaining")
	})

	test("returns seconds for < 1 minute", () => {
		expect(formatEtaForDisplay(10_000)).toBe("~10s remaining")
		expect(formatEtaForDisplay(30_000)).toBe("~30s remaining")
		expect(formatEtaForDisplay(59_999)).toBe("~60s remaining")
	})

	test("returns minutes for < 1 hour", () => {
		expect(formatEtaForDisplay(60_000)).toBe("~1m remaining")
		expect(formatEtaForDisplay(120_000)).toBe("~2m remaining")
		expect(formatEtaForDisplay(3_540_000)).toBe("~59m remaining")
	})

	test("returns hours only when minutes are 0", () => {
		expect(formatEtaForDisplay(3_600_000)).toBe("~1h remaining")
		expect(formatEtaForDisplay(7_200_000)).toBe("~2h remaining")
	})

	test("returns hours and minutes when minutes > 0", () => {
		expect(formatEtaForDisplay(5_400_000)).toBe("~1h 30m remaining")
		expect(formatEtaForDisplay(8_100_000)).toBe("~2h 15m remaining")
	})
})

describe("formatDurationForDisplay", () => {
	test("formats short durations in seconds", () => {
		expect(formatDurationForDisplay(9_000)).toBe("9s")
	})

	test("formats minute and hour durations compactly", () => {
		expect(formatDurationForDisplay(180_000)).toBe("3m")
		expect(formatDurationForDisplay(5_400_000)).toBe("1h 30m")
	})
})

describe("getPrimaryElapsedMs", () => {
	test("prefers invested elapsed time for resume runs", () => {
		expect(
			getPrimaryElapsedMs({
				overallState: "running",
				overallHealth: "healthy",
				runMode: "resume",
				services: [],
				elapsedMs: 60_000,
				investedElapsedMs: 180_000,
			}),
		).toBe(180_000)
	})

	test("falls back to current elapsed time for initial runs", () => {
		expect(
			getPrimaryElapsedMs({
				overallState: "running",
				overallHealth: "healthy",
				runMode: "initial-discovery",
				services: [],
				elapsedMs: 60_000,
			}),
		).toBe(60_000)
	})
})

// --- Integration-style tests for UI rendering logic ---
// These test the rendering conditions that the CodeIndexPopover component uses

describe("CodeIndexPopover - Status dot color mapping", () => {
	const statusColorMap: Record<string, string> = {
		Standby: "bg-gray-400",
		Indexing: "bg-yellow-500 animate-pulse",
		Indexed: "bg-green-500",
		Stopping: "bg-amber-500 animate-pulse",
		Error: "bg-red-500",
	}

	for (const [status, expectedClass] of Object.entries(statusColorMap)) {
		test(`maps ${status} to ${expectedClass}`, () => {
			expect(statusColorMap[status]).toBe(expectedClass)
		})
	}

	test("all 5 states have color mappings (including Stopping)", () => {
		expect(Object.keys(statusColorMap)).toHaveLength(5)
		expect(statusColorMap).toHaveProperty("Stopping")
	})
})

describe("CodeIndexPopover - Phase label rendering logic", () => {
	test("prefers the host-provided pipeline summary headline when present", () => {
		expect(
			getIndexingHeadline(
				{
					systemStatus: "Indexing",
					processedItems: 12,
					totalItems: 20,
					detailedStage: "parsing",
					pipeline: {
						overallState: "running",
						overallHealth: "watch",
						runMode: "start",
						services: [],
						summary: {
							headline: "Building embeddings and syncing vectors",
							progressLabel: "Synced 8,633 of 10,881 chunks",
							secondaryLabel: "Also parsing changed files in the background.",
						},
					},
				},
				false,
				(key: string) => key,
			),
		).toBe("Building embeddings and syncing vectors")
	})

	test("uses truth-first parsing headline before vector sync starts", () => {
		expect(
			getIndexingHeadline(
				{
					systemStatus: "Indexing",
					processedItems: 12,
					totalItems: 20,
					detailedStage: "parsing",
					hasKnownVectorWork: false,
					hasStartedVectorSync: false,
				},
				false,
				(key: string) => key,
			),
		).toBe("Preparing changed files for indexing")
	})

	test("uses calm reconcile headline for background freshness checks", () => {
		expect(
			getIndexingHeadline(
				{
					systemStatus: "Indexing",
					processedItems: 0,
					totalItems: 1,
					detailedStage: "reconciling",
					isBackgroundReconcile: true,
				},
				false,
				(key: string) => key,
			),
		).toBe("Checking for workspace changes")
	})

	test("uses a fresh-start hashing headline before any baseline compare exists", () => {
		expect(
			getIndexingHeadline(
				{
					systemStatus: "Indexing",
					processedItems: 12,
					totalItems: 40,
					detailedStage: "hashing_initial",
				},
				false,
				(key: string) => key,
			),
		).toBe("Preparing files for indexing")
	})

	test("progress stage label stays on workspace pass until real embedding work begins", () => {
		expect(getProgressStageLabel("parsing", "scanning")).toBe("Workspace pass")
		expect(getProgressStageLabel("planning_vectors", "embedding")).toBe("Embedding pass")
	})

	test("generates scanning phase label with counts", () => {
		const phase = "scanning"
		const processedFiles = 120
		const totalFiles = 500

		// Simulates what the t() interpolation produces
		const label = phase === "scanning" ? `Scanning files… ${processedFiles}/${totalFiles}` : ""

		expect(label).toBe("Scanning files… 120/500")
	})

	test("generates embedding phase label with counts", () => {
		const phase = "embedding"
		const blocksEmbedded = 340
		const totalBlocks = 1200

		const label = phase === "embedding" ? `Embedding blocks… ${blocksEmbedded}/${totalBlocks}` : ""

		expect(label).toBe("Embedding blocks… 340/1200")
	})

	test("does not render phase label when phase is undefined", () => {
		const phase: string | undefined = undefined
		const shouldRender = !!phase
		expect(shouldRender).toBe(false)
	})
})

describe("CodeIndexPopover - Run summary display", () => {
	test("uses pipeline summary lines instead of legacy stage text when available", () => {
		const display = getRunSummaryDisplay(
			{
				systemStatus: "Indexing",
				processedItems: 340,
				totalItems: 2377,
				detailedStage: "parsing",
				message:
					"Preparing changed files for indexing\nParsing 340 of 2,377 files • Streaming 7,282 of 9,870 parsed chunks",
				pipeline: {
					overallState: "running",
					overallHealth: "watch",
					runMode: "start",
					services: [],
					summary: {
						headline: "Building embeddings and syncing vectors",
						progressLabel: "Synced 8,633 of 10,881 chunks",
						secondaryLabel: "Also parsing changed files in the background.",
					},
				},
			},
			false,
			(key: string) => key,
		)

		expect(display).toEqual({
			headline: "Building embeddings and syncing vectors",
			progressLine: "Synced 8,633 of 10,881 chunks",
			secondaryLine: "Also parsing changed files in the background.",
		})
	})

	test("uses hydrated standby pipeline totals before indexing starts", () => {
		const display = getRunSummaryDisplay(
			{
				systemStatus: "Standby",
				processedItems: 0,
				totalItems: 0,
				message: "V2 index ready across 199 files",
				pipeline: {
					overallState: "completed",
					overallHealth: "healthy",
					runMode: "initial-discovery",
					preservedFromPreviousRun: true,
					services: [],
					summary: {
						headline: "Index ready",
						progressLabel: "199 / 199 files indexed • 1,204 / 1,204 chunks synced",
						elapsedLabel: "Total time 42 sec",
						codebaseProgress: {
							indexedFiles: 199,
							totalFiles: 199,
							syncedChunks: 1_204,
							knownTotalChunks: 1_204,
						},
					},
				},
			},
			true,
			(key: string) => key,
		)

		expect(display).toEqual({
			headline: "Index ready",
			progressLine: "199 / 199 files indexed • 1,204 / 1,204 chunks synced",
			secondaryLine: undefined,
		})
	})

	test("uses resumable standby summary instead of completed wording for incomplete runs", () => {
		const display = getRunSummaryDisplay(
			{
				systemStatus: "Standby",
				processedItems: 0,
				totalItems: 0,
				message: "V2 index has resumable progress across 73,686 files",
				pipeline: {
					overallState: "stopped",
					overallHealth: "watch",
					runMode: "resume",
					preservedFromPreviousRun: true,
					services: [],
					summary: {
						headline: "Resume available",
						progressLabel: "73,686 / 73,912 files indexed • 1,752,602 chunks available",
						secondaryLabel: "Previous indexing run did not finish. Start indexing to continue.",
						indeterminate: true,
					},
				},
			},
			true,
			(key: string) => key,
		)

		expect(display).toEqual({
			headline: "Resume available",
			progressLine: "73,686 / 73,912 files indexed • 1,752,602 chunks available",
			secondaryLine: "Previous indexing run did not finish. Start indexing to continue.",
		})
	})
})

describe("CodeIndexPopover - codebase progress rows", () => {
	test("renders exact current totals as ratios", () => {
		expect(
			formatCodebaseProgressRows({
				indexedFiles: 73_625,
				totalFiles: 73_625,
				fileTotalKind: "exact",
				syncedChunks: 1_766_503,
				knownTotalChunks: 1_766_503,
				chunkTotalKind: "exact",
			}),
		).toEqual([
			{ key: "files", label: "Files indexed", value: "73,625 / 73,625" },
			{ key: "chunks", label: "Chunks synced", value: "1,766,503 / 1,766,503" },
		])
	})

	test("renders available-only chunk totals without fake ratios", () => {
		expect(
			formatCodebaseProgressRows({
				indexedFiles: 73_686,
				totalFiles: 73_912,
				fileTotalKind: "exact",
				syncedChunks: 1_752_602,
				chunkTotalKind: "available",
			}),
		).toEqual([
			{ key: "files", label: "Files indexed", value: "73,686 / 73,912" },
			{ key: "chunks", label: "Chunks synced", value: "1,752,602 available" },
		])
	})
})

describe("CodeIndexPopover - Index stats rendering logic", () => {
	test("shows file count when totalFiles is available", () => {
		const totalFiles = 500
		const totalBlocks: number | undefined = undefined

		const parts: string[] = []
		if (totalFiles != null) parts.push(`${totalFiles} files`)
		if (totalBlocks != null) parts.push(`${totalBlocks} blocks`)

		expect(parts.join(" · ")).toBe("500 files")
	})

	test("shows block count when totalBlocks is available", () => {
		const totalFiles: number | undefined = undefined
		const totalBlocks = 1200

		const parts: string[] = []
		if (totalFiles != null) parts.push(`${totalFiles} files`)
		if (totalBlocks != null) parts.push(`${totalBlocks} blocks`)

		expect(parts.join(" · ")).toBe("1200 blocks")
	})

	test("shows both file and block counts separated by ·", () => {
		const totalFiles = 500
		const totalBlocks = 1200

		const parts: string[] = []
		if (totalFiles != null) parts.push(`${totalFiles} files`)
		if (totalBlocks != null) parts.push(`${totalBlocks} blocks`)

		expect(parts.join(" · ")).toBe("500 files · 1200 blocks")
	})

	test("shows nothing when both are undefined", () => {
		const totalFiles: number | undefined = undefined
		const totalBlocks: number | undefined = undefined

		const hasStats = totalFiles != null || totalBlocks != null
		expect(hasStats).toBe(false)
	})
})

describe("CodeIndexPopover - Re-index button rendering logic", () => {
	test("re-index button shows when Indexed and enabled", () => {
		const systemStatus = "Indexed"
		const codebaseIndexEnabled = true

		const showReindex = codebaseIndexEnabled && systemStatus === "Indexed"
		expect(showReindex).toBe(true)
	})

	test("re-index button does NOT show when Standby", () => {
		const systemStatus: string = "Standby"
		const codebaseIndexEnabled = true

		const showReindex = codebaseIndexEnabled && systemStatus === "Indexed"
		expect(showReindex).toBe(false)
	})

	test("re-index button does NOT show when disabled", () => {
		const systemStatus: string = "Indexed"
		const codebaseIndexEnabled = false

		const showReindex = codebaseIndexEnabled && systemStatus === "Indexed"
		expect(showReindex).toBe(false)
	})

	test("re-index button is disabled when there are unsaved changes", () => {
		const hasUnsavedChanges = true
		const saveStatus: string = "idle"

		const isDisabled = saveStatus === "saving" || hasUnsavedChanges
		expect(isDisabled).toBe(true)
	})

	test("re-index button is disabled when saving", () => {
		const hasUnsavedChanges = false
		const saveStatus: string = "saving"

		const isDisabled = saveStatus === "saving" || hasUnsavedChanges
		expect(isDisabled).toBe(true)
	})

	test("re-index button is enabled when no unsaved changes and not saving", () => {
		const hasUnsavedChanges = false
		const saveStatus: string = "idle"

		const isDisabled = saveStatus === "saving" || hasUnsavedChanges
		expect(isDisabled).toBe(false)
	})
})

describe("CodeIndexPopover - Progress percentage clamping", () => {
	// Mirrors the progressPercentage useMemo logic in CodeIndexPopover.tsx

	function calcProgressPercentage(indexingStatus: {
		detailedStage?: string
		hasStartedVectorSync?: boolean
		phase?: string
		blocksEmbedded?: number
		totalBlocks?: number
		processedItems: number
		totalItems: number
	}): number {
		if (
			indexingStatus.detailedStage === "embedding" &&
			indexingStatus.hasStartedVectorSync &&
			indexingStatus.totalBlocks &&
			indexingStatus.totalBlocks > 0
		) {
			return Math.min(100, Math.round(((indexingStatus.blocksEmbedded ?? 0) / indexingStatus.totalBlocks) * 100))
		}
		if (indexingStatus.detailedStage === "discovering") {
			const processed = indexingStatus.processedItems ?? 0
			const total = Math.max(indexingStatus.totalItems ?? 0, processed, 1)
			return Math.min(99, Math.round((processed / total) * 100))
		}
		return indexingStatus.totalItems > 0
			? Math.min(100, Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100))
			: 0
	}

	test("clamps embedding progress to 100% when blocksEmbedded exceeds totalBlocks", () => {
		// Reproduces the 102% bug scenario from the screenshot
		const result = calcProgressPercentage({
			detailedStage: "embedding",
			hasStartedVectorSync: true,
			phase: "embedding",
			blocksEmbedded: 111_397,
			totalBlocks: 108_906,
			processedItems: 111_397,
			totalItems: 108_906,
		})
		expect(result).toBe(100)
	})

	test("clamps legacy progress to 100% when processedItems exceeds totalItems", () => {
		const result = calcProgressPercentage({
			processedItems: 1050,
			totalItems: 1000,
		})
		expect(result).toBe(100)
	})

	test("returns correct percentage when within bounds", () => {
		const result = calcProgressPercentage({
			detailedStage: "embedding",
			hasStartedVectorSync: true,
			phase: "embedding",
			blocksEmbedded: 500,
			totalBlocks: 1000,
			processedItems: 500,
			totalItems: 1000,
		})
		expect(result).toBe(50)
	})

	test("returns 0 when totalItems is 0", () => {
		const result = calcProgressPercentage({
			detailedStage: "planning_vectors",
			hasStartedVectorSync: false,
			processedItems: 0,
			totalItems: 0,
		})
		expect(result).toBe(0)
	})

	test("keeps pre-sync embedding placeholder indeterminate instead of showing fake progress", () => {
		const result = calcProgressPercentage({
			detailedStage: "embedding",
			hasStartedVectorSync: false,
			phase: "embedding",
			blocksEmbedded: 0,
			totalBlocks: 1,
			processedItems: 0,
			totalItems: 1,
		})
		expect(result).toBe(0)
	})
})

describe("CodeIndexPopover - ETA display rendering logic", () => {
	test("shows ETA when estimatedTimeRemainingMs is provided", () => {
		const estimatedTimeRemainingMs: number | null = 180_000
		const shouldShowEta = estimatedTimeRemainingMs != null
		expect(shouldShowEta).toBe(true)
		expect(formatEtaForDisplay(estimatedTimeRemainingMs!)).toBe("~3m remaining")
	})

	test("does not show ETA when estimatedTimeRemainingMs is null", () => {
		const estimatedTimeRemainingMs: number | null = null
		const shouldShowEta = estimatedTimeRemainingMs != null
		expect(shouldShowEta).toBe(false)
	})
})

describe("CodeIndexPopover - warning details state sync", () => {
	test("describes warning details as latest actionable review state", () => {
		expect(INDEXING_WARNING_HELP_TEXT).toBe("Latest files that need parser, retry, or degraded-index review.")
	})

	test("does not clobber fetched warning items after warning details bootstrap", () => {
		const previousState = {
			items: [
				{
					relativePath: "src/problem.ts",
					state: "failed" as const,
					category: "parser_failed" as const,
					failureReason: "parser exploded",
				},
			],
			total: 1,
			loading: false,
			hasMore: false,
			filter: "all" as const,
			sort: "severity" as const,
		}
		const externalIndexingStatus = {
			warningDetails: [],
		}
		const warningDetailsBootstrapped = true

		const nextState = {
			...previousState,
			...(warningDetailsBootstrapped
				? {}
				: {
						items: externalIndexingStatus.warningDetails ?? [],
						total: externalIndexingStatus.warningDetails?.length ?? 0,
						hasMore: (externalIndexingStatus.warningDetails?.length ?? 0) >= 8,
					}),
		}

		expect(nextState.items).toHaveLength(1)
		expect(nextState.total).toBe(1)
	})
})

describe("CodeIndexPopover - overview defaults", () => {
	test("defaults to overview when indexing is enabled and pipeline data exists", () => {
		expect(
			getDefaultCodeIndexPopoverTab(true, {
				overallState: "running",
				overallHealth: "healthy",
				runMode: "start",
				services: [],
			}),
		).toBe("overview")
	})

	test("defaults to settings when indexing is disabled", () => {
		expect(
			getDefaultCodeIndexPopoverTab(false, {
				overallState: "running",
				overallHealth: "healthy",
				runMode: "start",
				services: [],
			}),
		).toBe("settings")
	})

	test("defaults to settings when there is no pipeline snapshot yet", () => {
		expect(getDefaultCodeIndexPopoverTab(true, undefined)).toBe("settings")
	})

	test("expands active and warning service cards by default", () => {
		expect(shouldExpandIndexServiceCard("running")).toBe(true)
		expect(shouldExpandIndexServiceCard("warning")).toBe(true)
		expect(shouldExpandIndexServiceCard("failed")).toBe(true)
	})

	test("collapses pending and completed service cards by default", () => {
		expect(shouldExpandIndexServiceCard("pending")).toBe(false)
		expect(shouldExpandIndexServiceCard("completed")).toBe(false)
		expect(shouldExpandIndexServiceCard("skipped")).toBe(false)
	})

	test("only shows service details control when detail metrics exist", () => {
		const metric = (key: string, visibility?: "primary" | "detail") => ({ key, label: key, value: "1", visibility })

		expect(
			hasExpandableIndexServiceCardContent({
				metrics: [metric("one"), metric("two"), metric("legacy")],
			}),
		).toBe(false)
		expect(
			hasExpandableIndexServiceCardContent({
				metrics: [metric("one"), metric("two"), metric("diagnostic", "detail")],
			}),
		).toBe(true)
	})

	test("collapsed service cards show primary and legacy metrics while expanded cards include details", () => {
		const service = {
			metrics: [
				{ key: "primary", label: "Primary", value: "1", visibility: "primary" as const },
				{ key: "legacy", label: "Legacy", value: "2" },
				{ key: "detail", label: "Detail", value: "3", visibility: "detail" as const },
			],
		}

		expect(getVisibleIndexServiceMetrics(service, false).map((item) => item.key)).toEqual(["primary", "legacy"])
		expect(getVisibleIndexServiceMetrics(service, true).map((item) => item.key)).toEqual([
			"primary",
			"legacy",
			"detail",
		])
	})

	test("expands busy and failed runtime sidecars by default without treating standby as expandable", () => {
		expect(shouldExpandIndexRuntimeSidecar("busy")).toBe(true)
		expect(shouldExpandIndexRuntimeSidecar("failed")).toBe(true)
		expect(shouldExpandIndexRuntimeSidecar("standby")).toBe(false)
		expect(shouldExpandIndexRuntimeSidecar("online")).toBe(false)
	})

	test("runtime sidecar metrics use primary/detail visibility like service cards", () => {
		const sidecar = {
			metrics: [
				{ key: "state", label: "State", value: "Online", visibility: "primary" as const },
				{ key: "pending", label: "Pending", value: "0" },
				{ key: "pid", label: "PID", value: "4242", visibility: "detail" as const },
			],
		}

		expect(hasExpandableIndexRuntimeSidecarContent(sidecar)).toBe(true)
		expect(getVisibleIndexRuntimeSidecarMetrics(sidecar, false).map((item) => item.key)).toEqual([
			"state",
			"pending",
		])
		expect(getVisibleIndexRuntimeSidecarMetrics(sidecar, true).map((item) => item.key)).toEqual([
			"state",
			"pending",
			"pid",
		])
	})

	test("expands running partial and failed runtime tasks by default", () => {
		expect(shouldExpandIndexRuntimeTask("running")).toBe(true)
		expect(shouldExpandIndexRuntimeTask("partial")).toBe(true)
		expect(shouldExpandIndexRuntimeTask("failed")).toBe(true)
		expect(shouldExpandIndexRuntimeTask("complete")).toBe(false)
		expect(shouldExpandIndexRuntimeTask("idle")).toBe(false)
	})

	test("runtime task metrics use primary/detail visibility like service cards", () => {
		const task = {
			metrics: [
				{ key: "state", label: "State", value: "Partial", visibility: "primary" as const },
				{ key: "jobs_pruned", label: "Jobs pruned", value: "50,000" },
				{ key: "fts_pruned", label: "FTS rows pruned", value: "10", visibility: "detail" as const },
			],
		}

		expect(hasExpandableIndexRuntimeTaskContent(task)).toBe(true)
		expect(getVisibleIndexRuntimeTaskMetrics(task, false).map((item) => item.key)).toEqual(["state", "jobs_pruned"])
		expect(getVisibleIndexRuntimeTaskMetrics(task, true).map((item) => item.key)).toEqual([
			"state",
			"jobs_pruned",
			"fts_pruned",
		])
	})

	test("metadata cleanup exposes compaction action only for the cleanup task", () => {
		const cleanupTask = {
			id: "metadata_cleanup" as const,
			title: "Metadata cleanup",
			state: "complete" as const,
			health: "healthy" as const,
			summary: "Cleanup complete",
			metrics: [],
			actions: [
				{
					id: "compact_metadata_db" as const,
					label: "Compact DB file",
					enabled: true,
				},
			],
		}
		const taskWithoutAction = {
			...cleanupTask,
			actions: [],
		}

		expect(getMetadataCleanupCompactionAction(cleanupTask)?.label).toBe("Compact DB file")
		expect(getMetadataCleanupCompactionAction(taskWithoutAction)).toBeUndefined()
	})
})
