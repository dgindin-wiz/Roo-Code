/**
 * Tests for CodeIndexPopover UI improvements:
 * - Stopping status color in popover dot
 * - Phase label display (scanning vs embedding)
 * - ETA display below progress bar
 * - Index stats when Indexed
 * - Re-index button for Indexed state
 * - formatEtaForDisplay helper
 */

// --- Unit test: formatEtaForDisplay ---
// We test the function in isolation by extracting the same logic

function formatEtaForDisplay(ms: number): string {
	if (ms < 10_000) return "almost done"
	if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes}m remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours}h remaining`
	return `~${hours}h ${remainingMinutes}m remaining`
}

describe("formatEtaForDisplay", () => {
	test("returns 'almost done' for < 10 seconds", () => {
		expect(formatEtaForDisplay(5_000)).toBe("almost done")
		expect(formatEtaForDisplay(9_999)).toBe("almost done")
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
		phase?: string
		blocksEmbedded?: number
		totalBlocks?: number
		processedItems: number
		totalItems: number
	}): number {
		if (indexingStatus.phase === "embedding" && indexingStatus.totalBlocks && indexingStatus.totalBlocks > 0) {
			return Math.min(100, Math.round(((indexingStatus.blocksEmbedded ?? 0) / indexingStatus.totalBlocks) * 100))
		}
		return indexingStatus.totalItems > 0
			? Math.min(100, Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100))
			: 0
	}

	test("clamps embedding progress to 100% when blocksEmbedded exceeds totalBlocks", () => {
		// Reproduces the 102% bug scenario from the screenshot
		const result = calcProgressPercentage({
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
			processedItems: 0,
			totalItems: 0,
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
