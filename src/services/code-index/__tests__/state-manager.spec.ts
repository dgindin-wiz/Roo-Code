import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexStateManager, formatEta } from "../state-manager"

// Mock vscode EventEmitter
vi.mock("vscode", () => ({
	EventEmitter: class MockEventEmitter {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
}))

describe("formatEta", () => {
	it("should return 'almost done' for less than 10 seconds", () => {
		expect(formatEta(5000)).toBe("almost done")
		expect(formatEta(9999)).toBe("almost done")
	})

	it("should return seconds for less than 1 minute", () => {
		expect(formatEta(10000)).toBe("~10 sec remaining")
		expect(formatEta(30000)).toBe("~30 sec remaining")
		expect(formatEta(59000)).toBe("~59 sec remaining")
	})

	it("should return minutes for less than 1 hour", () => {
		expect(formatEta(60000)).toBe("~1 min remaining")
		expect(formatEta(300000)).toBe("~5 min remaining")
		expect(formatEta(3540000)).toBe("~59 min remaining")
	})

	it("should return hours and minutes for 1+ hours", () => {
		expect(formatEta(3600000)).toBe("~1 hr remaining")
		expect(formatEta(5400000)).toBe("~1 hr 30 min remaining")
		expect(formatEta(7200000)).toBe("~2 hr remaining")
		expect(formatEta(7320000)).toBe("~2 hr 2 min remaining")
	})
})

describe("CodeIndexStateManager", () => {
	let stateManager: CodeIndexStateManager

	beforeEach(() => {
		stateManager = new CodeIndexStateManager()
	})

	describe("initial state", () => {
		it("should start in Standby state", () => {
			expect(stateManager.state).toBe("Standby")
		})

		it("should have zero progress counters", () => {
			const status = stateManager.getCurrentStatus()
			expect(status.processedItems).toBe(0)
			expect(status.totalItems).toBe(0)
			expect(status.phase).toBeUndefined()
			expect(status.estimatedTimeRemainingMs).toBeNull()
		})
	})

	describe("setSystemState", () => {
		it("should update state and message", () => {
			stateManager.setSystemState("Indexing", "Starting scan...")
			expect(stateManager.state).toBe("Indexing")
			expect(stateManager.getCurrentStatus().message).toBe("Starting scan...")
		})

		it("should reset progress counters when moving to non-Indexing state", () => {
			stateManager.setSystemState("Indexing", "test")
			stateManager.reportBlockIndexingProgress(50, 100)
			stateManager.setSystemState("Indexed", "Done")

			const status = stateManager.getCurrentStatus()
			expect(status.processedItems).toBe(0)
			expect(status.totalItems).toBe(0)
		})

		it("should set phase to complete when moving to Indexed", () => {
			stateManager.setSystemState("Indexed", "Done")
			expect(stateManager.getCurrentStatus().phase).toBe("complete")
		})

		it("should not override Stopping state with setSystemState if same", () => {
			stateManager.setSystemState("Stopping", "Stopping...")
			// Same state again should not fire
			const status1 = stateManager.getCurrentStatus()
			expect(status1.systemStatus).toBe("Stopping")
		})
	})

	describe("startIndexingTimer", () => {
		it("should reset rate samples and ETA", () => {
			stateManager.startIndexingTimer()
			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).toBeNull()
		})
	})

	describe("reportScanProgress", () => {
		it("should set phase to scanning and update file counts", () => {
			stateManager.reportScanProgress(50, 1000)
			const status = stateManager.getCurrentStatus()

			expect(status.phase).toBe("scanning")
			expect(status.totalFiles).toBe(1000)
			expect(status.processedFiles).toBe(50)
			expect(status.processedItems).toBe(50)
			expect(status.totalItems).toBe(1000)
			expect(status.currentItemUnit).toBe("files")
			expect(status.systemStatus).toBe("Indexing")
		})

		it("should not override Stopping state", () => {
			stateManager.setSystemState("Stopping", "Stopping...")
			stateManager.reportScanProgress(50, 1000)
			expect(stateManager.state).toBe("Stopping")
		})
	})

	describe("startEmbedPhase", () => {
		it("should transition to embedding phase with block totals", () => {
			stateManager.startEmbedPhase(5000, true, 200)
			const status = stateManager.getCurrentStatus()

			expect(status.phase).toBe("embedding")
			expect(status.totalBlocks).toBe(5000)
			expect(status.blocksEmbedded).toBe(0)
			expect(status.isEstimatedTotal).toBe(true)
			expect(status.processedItems).toBe(0)
			expect(status.totalItems).toBe(5000)
			expect(status.currentItemUnit).toBe("blocks")
		})

		it("should include changed file count in message when provided", () => {
			stateManager.startEmbedPhase(1000, false, 50)
			const status = stateManager.getCurrentStatus()
			expect(status.message).toContain("1,000 blocks")
			expect(status.message).toContain("50 files")
		})

		it("should show tilde prefix when estimated", () => {
			stateManager.startEmbedPhase(1000, true)
			const status = stateManager.getCurrentStatus()
			expect(status.message).toMatch(/^~/)
		})

		it("should not show tilde prefix when exact", () => {
			stateManager.startEmbedPhase(1000, false)
			const status = stateManager.getCurrentStatus()
			expect(status.message).not.toMatch(/^~/)
		})

		it("should accept startingBlockCount for resume progress", () => {
			stateManager.startEmbedPhase(50000, true, undefined, 10000)
			const status = stateManager.getCurrentStatus()

			// blocksEmbedded includes the starting offset
			expect(status.blocksEmbedded).toBe(10000)
			// processedItems also includes offset for progress bar
			expect(status.processedItems).toBe(10000)
			expect(status.totalBlocks).toBe(50000)
		})

		it("should default startingBlockCount to 0 when not provided", () => {
			stateManager.startEmbedPhase(1000, true)
			const status = stateManager.getCurrentStatus()
			expect(status.blocksEmbedded).toBe(0)
			expect(status.processedItems).toBe(0)
		})
	})

	describe("reportEmbedProgress", () => {
		it("should update blocks embedded and total", () => {
			stateManager.reportScanProgress(0, 100) // set totalFiles
			stateManager.startEmbedPhase(5000, true)
			stateManager.reportEmbedProgress(500, 5000, 25)
			const status = stateManager.getCurrentStatus()

			expect(status.blocksEmbedded).toBe(500)
			expect(status.totalBlocks).toBe(5000)
			// processedItems tracks block-level progress for progress bar
			expect(status.processedItems).toBe(500)
			expect(status.processedFiles).toBe(25)
		})

		it("should update revised total but keep estimated flag until reportComplete", () => {
			stateManager.startEmbedPhase(5000, true)
			stateManager.reportEmbedProgress(500, 5500)
			const status = stateManager.getCurrentStatus()

			expect(status.totalBlocks).toBe(5500)
			// _isEstimatedTotal is NOT cleared in reportEmbedProgress — only reportComplete finalizes it
			expect(status.isEstimatedTotal).toBe(true)
		})

		it("should track filesParsed when provided", () => {
			stateManager.reportScanProgress(0, 100) // set totalFiles
			stateManager.startEmbedPhase(500, true)
			stateManager.reportEmbedProgress(10, 100, 20)
			const status = stateManager.getCurrentStatus()
			// Block-centric format: "Embedded 10 of ~100 total blocks" (~ because isEstimate=true)
			expect(status.message).toContain("10 of ~100 total blocks")
			// Also verify filesParsed is tracked internally
			expect(status.processedFiles).toBe(20)
		})

		it("should show block progress in embed progress message", () => {
			stateManager.reportScanProgress(0, 2500)
			stateManager.startEmbedPhase(3000, true)
			stateManager.reportEmbedProgress(100, 3000, 500)
			const status = stateManager.getCurrentStatus()
			// Block-centric format: "Embedded 100 of ~3,000 total blocks"
			expect(status.message).toContain("100 of ~3,000 total blocks")
		})

		it("should show block-centric message with estimated total", () => {
			stateManager.reportScanProgress(0, 2500)
			stateManager.startEmbedPhase(3000, true)
			stateManager.reportEmbedProgress(100, 3000)
			const status = stateManager.getCurrentStatus()
			// Block-centric format: "Embedded 100 of ~3,000 total blocks" (~ because isEstimate=true)
			expect(status.message).toContain("100 of ~3,000 total blocks")
		})

		it("should show 'files checked' wording in file line", () => {
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(5000, true)
			stateManager.reportEmbedProgress(100, 5000, 200)
			const status = stateManager.getCurrentStatus()
			expect(status.message).toContain("files checked")
			expect(status.message).toContain("200 of 1,000 files checked")
		})

		it("should include startingBlockCount offset in effective embedded display", () => {
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(50000, true, undefined, 10000)
			stateManager.reportEmbedProgress(500, 50000, 50)
			const status = stateManager.getCurrentStatus()

			// Effective embedded = 10000 + 500 = 10500
			expect(status.blocksEmbedded).toBe(10500)
			expect(status.processedItems).toBe(10500)
			// Message should show the effective count
			expect(status.message).toContain("10,500 of ~50,000 total blocks")
		})

		it("should not fire when nothing changed", () => {
			stateManager.setSystemState("Indexing", "test")
			stateManager.startEmbedPhase(1000, true)
			stateManager.reportEmbedProgress(100, undefined, 10)
			const fireSpy = vi.spyOn((stateManager as any)._progressEmitter, "fire")
			stateManager.reportEmbedProgress(100, undefined, 10) // same blocksEmbedded AND same filesParsed
			expect(fireSpy).not.toHaveBeenCalled()
		})

		it("should fire when only filesParsed changes (blocks unchanged)", () => {
			stateManager.reportScanProgress(0, 1000) // set totalFiles
			stateManager.startEmbedPhase(5000, true)
			stateManager.reportEmbedProgress(100, 5000, 10)
			const fireSpy = vi.spyOn((stateManager as any)._progressEmitter, "fire")
			// Same blocksEmbedded and totalBlocks, but filesParsed increased (skipped files)
			stateManager.reportEmbedProgress(100, 5000, 50)
			expect(fireSpy).toHaveBeenCalled()
			const status = stateManager.getCurrentStatus()
			expect(status.processedFiles).toBe(50)
			expect(status.message).toContain("50 of 1,000 files checked")
		})

		it("should not override Stopping state", () => {
			stateManager.startEmbedPhase(1000, true)
			stateManager.setSystemState("Stopping", "Stop...")
			stateManager.reportEmbedProgress(100)
			expect(stateManager.state).toBe("Stopping")
		})
	})

	describe("reportComplete", () => {
		it("should set phase to complete with final stats", () => {
			stateManager.reportComplete(5000, 200)
			const status = stateManager.getCurrentStatus()

			expect(status.phase).toBe("complete")
			expect(status.totalBlocks).toBe(5000)
			expect(status.blocksEmbedded).toBe(5000)
			expect(status.totalFiles).toBe(200)
			expect(status.isEstimatedTotal).toBe(false)
			expect(status.estimatedTimeRemainingMs).toBeNull()
			expect(status.systemStatus).toBe("Indexed")
			expect(status.message).toContain("5,000 blocks")
			expect(status.message).toContain("200 files")
		})

		it("should show file-only message when totalBlocks is 0 but files exist", () => {
			stateManager.reportComplete(0, 2288)
			const status = stateManager.getCurrentStatus()

			expect(status.systemStatus).toBe("Indexed")
			expect(status.phase).toBe("complete")
			expect(status.message).toContain("2,288 files")
			expect(status.message).not.toContain("0 blocks")
			expect(status.message).toContain("Index up-to-date")
		})

		it("should show generic message when both totalBlocks and totalFiles are 0", () => {
			stateManager.reportComplete(0, 0)
			const status = stateManager.getCurrentStatus()

			expect(status.systemStatus).toBe("Indexed")
			expect(status.message).toBe("Index up-to-date")
		})

		it("should reset startingBlockCount so blocksEmbedded equals totalBlocks", () => {
			// Simulate resume scenario
			stateManager.startEmbedPhase(50000, true, undefined, 10000)
			stateManager.reportEmbedProgress(500, 50000, 50)
			// Before reportComplete, blocksEmbedded = 10000 + 500 = 10500
			expect(stateManager.getCurrentStatus().blocksEmbedded).toBe(10500)

			// After completion, startingBlockCount resets; blocksEmbedded = totalBlocks
			stateManager.reportComplete(50000, 1000)
			const status = stateManager.getCurrentStatus()
			expect(status.blocksEmbedded).toBe(50000)
			expect(status.processedItems).toBe(50000)
			expect(status.totalBlocks).toBe(50000)
			expect(status.message).toContain("50,000 blocks")
			expect(status.message).toContain("1,000 files")
		})
	})

	describe("ETA calculation", () => {
		it("should not show ETA before 1% block progress", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 10000)
			stateManager.startEmbedPhase(50000, true)

			// 0.4% block progress (200 of 50000 blocks) — below 1% threshold
			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(200, 50000, 50)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).toBeNull()

			vi.restoreAllMocks()
		})

		it("should show ETA after 1% block progress", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(5000, true)

			// 2% block progress (100 of 5000 blocks) in 10s — above 1% threshold
			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(100, 5000, 20)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).not.toBeNull()
			expect(status.estimatedTimeRemainingMs).toBeGreaterThan(0)

			vi.restoreAllMocks()
		})

		it("should include ETA in status message", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 100)
			stateManager.startEmbedPhase(1000, true)

			// 20% block progress (200 of 1000 blocks) in 60s
			vi.spyOn(Date, "now").mockReturnValue(now + 60000)
			stateManager.reportEmbedProgress(200, 1000, 20)

			const status = stateManager.getCurrentStatus()
			expect(status.message).toContain("remaining")

			vi.restoreAllMocks()
		})

		it("should show estimating... when blocks embedded below 1% threshold", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(5000, true)

			// 0.2% block progress (10 of 5000) — below 1% → no ETA, shows estimating
			vi.spyOn(Date, "now").mockReturnValue(now + 1000)
			stateManager.reportEmbedProgress(10, 5000)

			const status = stateManager.getCurrentStatus()
			expect(status.message).toContain("estimating")

			vi.restoreAllMocks()
		})

		it("should use block-level throughput for ETA calculation", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 100)
			stateManager.startEmbedPhase(100, true)

			// 20 blocks of 100 = 20% block progress in 10s
			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(20, 100, 20)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).not.toBeNull()
			// 20% done in 10s → total ~50s → remaining ~40s = 40000ms
			expect(status.estimatedTimeRemainingMs).toBe(40000)

			vi.restoreAllMocks()
		})

		it("should produce no ETA when blocksEmbedded is 0", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 100)
			stateManager.startEmbedPhase(500, true)

			// Force a change to trigger the update (0 blocks → can't compute ETA)
			vi.spyOn(Date, "now").mockReturnValue(now + 5000)
			stateManager.reportEmbedProgress(0, 100)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).toBeNull()

			vi.restoreAllMocks()
		})

		it("should calculate ETA using session-only throughput on resume with startingBlockCount", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 1000)
			// Resume scenario: 8000 blocks already in Qdrant, 10000 total
			stateManager.startEmbedPhase(10000, true, undefined, 8000)

			// 500 new blocks embedded in 5s → throughput = 100 blocks/s
			// Remaining = 10000 - 8000 - 500 = 1500 blocks
			// ETA = 1500 / 0.1 blocks/ms = 15000ms
			vi.spyOn(Date, "now").mockReturnValue(now + 5000)
			stateManager.reportEmbedProgress(500, 10000, 100)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).not.toBeNull()
			expect(status.estimatedTimeRemainingMs).toBe(15000)

			vi.restoreAllMocks()
		})

		it("should not use startingBlockCount in throughput calculation", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			stateManager.startIndexingTimer()
			stateManager.reportScanProgress(0, 1000)
			// 9000 pre-existing, 10000 total → only 1000 remaining to embed
			stateManager.startEmbedPhase(10000, false, undefined, 9000)

			// 200 new blocks in 10s → session throughput = 20 blocks/s
			// Remaining = 10000 - 9000 - 200 = 800
			// ETA = 800 / 0.02 blocks/ms = 40000ms
			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(200, 10000, 50)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).toBe(40000)

			vi.restoreAllMocks()
		})
	})

	describe("legacy methods", () => {
		describe("reportBlockIndexingProgress", () => {
			it("should update legacy progress fields", () => {
				stateManager.reportBlockIndexingProgress(50, 200)
				const status = stateManager.getCurrentStatus()

				expect(status.processedItems).toBe(50)
				expect(status.totalItems).toBe(200)
				expect(status.currentItemUnit).toBe("blocks")
				expect(status.systemStatus).toBe("Indexing")
			})

			it("should include file context in message", () => {
				stateManager.reportBlockIndexingProgress(50, 200, { totalFiles: 1000, skippedFiles: 800 })
				const status = stateManager.getCurrentStatus()

				expect(status.message).toContain("1,000 files")
				expect(status.message).toContain("800 unchanged")
			})

			it("should not override Stopping state", () => {
				stateManager.setSystemState("Stopping", "test")
				stateManager.reportBlockIndexingProgress(50, 200)
				expect(stateManager.state).toBe("Stopping")
			})
		})

		describe("reportFileQueueProgress", () => {
			it("should update progress for file queue", () => {
				stateManager.reportFileQueueProgress(3, 10, "test.ts")
				const status = stateManager.getCurrentStatus()

				expect(status.processedItems).toBe(3)
				expect(status.totalItems).toBe(10)
				expect(status.currentItemUnit).toBe("files")
				expect(status.message).toContain("test.ts")
			})

			it("should show finished message when done", () => {
				stateManager.reportFileQueueProgress(10, 10)
				expect(stateManager.getCurrentStatus().message).toContain("Finished")
			})

			it("should not override Stopping state", () => {
				stateManager.setSystemState("Stopping", "test")
				stateManager.reportFileQueueProgress(3, 10)
				expect(stateManager.state).toBe("Stopping")
			})
		})
	})
})
