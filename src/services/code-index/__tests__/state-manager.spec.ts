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

	describe("resetIndexingState", () => {
		it("fully clears progress, detailed state, and warning stats", () => {
			stateManager.reportScanProgress(10, 100)
			stateManager.startEmbedPhase(5000, true, 100, 250)
			stateManager.reportEmbedProgress(400, 5200, 25, false, {
				detailedStage: "embedding",
				hasKnownVectorWork: true,
				hasStartedVectorSync: true,
				isBackgroundReconcile: true,
			})
			stateManager.setResilienceStats({
				resumedRetryJobs: 4,
				resumedPendingJobs: 2,
				retryingParseRevisions: 1,
				terminalFailedParseRevisions: 3,
				degradedRevisions: 2,
				terminalFailedRevisions: 1,
				terminallyFailedChunks: 6,
				retryingChunks: 5,
				warningDetails: [
					{
						relativePath: "src/example.ts",
						state: "failed",
						category: "failed",
						failureReason: "boom",
					},
				],
			})

			stateManager.resetIndexingState("Index data cleared successfully.")
			const status = stateManager.getCurrentStatus()

			expect(status.systemStatus).toBe("Standby")
			expect(status.message).toBe("Index data cleared successfully.")
			expect(status.phase).toBeUndefined()
			expect(status.detailedStage).toBeUndefined()
			expect(status.processedItems).toBe(0)
			expect(status.totalItems).toBe(0)
			expect(status.totalFiles).toBe(0)
			expect(status.processedFiles).toBe(0)
			expect(status.totalBlocks).toBe(0)
			expect(status.blocksEmbedded).toBe(0)
			expect(status.estimatedTimeRemainingMs).toBeNull()
			expect(status.hasKnownVectorWork).toBe(false)
			expect(status.hasStartedVectorSync).toBe(false)
			expect(status.isBackgroundReconcile).toBe(false)
			expect(status.resumedRetryJobs).toBe(0)
			expect(status.resumedPendingJobs).toBe(0)
			expect(status.retryingParseRevisions).toBe(0)
			expect(status.terminalFailedParseRevisions).toBe(0)
			expect(status.degradedRevisions).toBe(0)
			expect(status.terminalFailedRevisions).toBe(0)
			expect(status.terminallyFailedChunks).toBe(0)
			expect(status.retryingChunks).toBe(0)
			expect(status.warningDetails).toEqual([])
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
			expect(status.detailedStage).toBe("discovering")
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
			expect(status.detailedStage).toBe("embedding")
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

		it("should track vector planning separately from active vector sync", () => {
			stateManager.startEmbedPhase(42, true, 3, 0, {
				detailedStage: "planning_vectors",
				hasKnownVectorWork: true,
				hasStartedVectorSync: false,
				isBackgroundReconcile: true,
			})

			const status = stateManager.getCurrentStatus()
			expect(status.phase).toBe("embedding")
			expect(status.detailedStage).toBe("planning_vectors")
			expect(status.hasKnownVectorWork).toBe(true)
			expect(status.hasStartedVectorSync).toBe(false)
			expect(status.isBackgroundReconcile).toBe(true)
		})
	})

	describe("reportEmbedProgress", () => {
		it("should update blocks embedded and total", () => {
			stateManager.reportScanProgress(0, 25) // totalFiles = filesParsed (no extrapolation)
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
			stateManager.reportScanProgress(0, 20) // set totalFiles = filesParsed (no extrapolation)
			stateManager.startEmbedPhase(500, true)
			stateManager.reportEmbedProgress(10, 100, 20)
			const status = stateManager.getCurrentStatus()
			// Block-centric format: "Embedded 10 of ~100 total blocks" (~ because isEstimate=true)
			expect(status.message).toContain("10 of ~100 total blocks")
			// Also verify filesParsed is tracked internally
			expect(status.processedFiles).toBe(20)
		})

		it("should show block progress in embed progress message", () => {
			stateManager.reportScanProgress(0, 500) // totalFiles = filesParsed (no extrapolation)
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
			stateManager.reportScanProgress(0, 50) // totalFiles = filesParsed (no extrapolation)
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

		it("should auto-revise totalBlocks upward when effectiveEmbedded exceeds estimate", () => {
			// Simulate: cache-based estimate is 1000, but startingBlockCount from Qdrant is 800
			// and we embed 300 new blocks → effectiveEmbedded = 800 + 300 = 1100 > 1000
			stateManager.startEmbedPhase(1000, true, undefined, 800)
			stateManager.reportEmbedProgress(300, 1000)
			const status = stateManager.getCurrentStatus()

			// totalBlocks should have been auto-revised to effectiveEmbedded (1100)
			expect(status.totalBlocks).toBe(1100)
			expect(status.blocksEmbedded).toBe(1100) // 800 + 300
			// processedItems should never exceed totalItems
			expect(status.processedItems).toBeLessThanOrEqual(status.totalItems)
		})

		it("should expose explicit sync metadata when embedding really begins", () => {
			stateManager.startEmbedPhase(100, true, undefined, 0, {
				detailedStage: "planning_vectors",
				hasKnownVectorWork: true,
				hasStartedVectorSync: false,
			})
			stateManager.reportEmbedProgress(5, 100, 2, false, {
				detailedStage: "embedding",
				hasKnownVectorWork: true,
				hasStartedVectorSync: true,
				isBackgroundReconcile: false,
			})

			const status = stateManager.getCurrentStatus()
			expect(status.detailedStage).toBe("embedding")
			expect(status.hasKnownVectorWork).toBe(true)
			expect(status.hasStartedVectorSync).toBe(true)
			expect(status.isBackgroundReconcile).toBe(false)
		})

		it("should not revise totalBlocks when effectiveEmbedded is within estimate", () => {
			stateManager.startEmbedPhase(5000, true, undefined, 1000)
			stateManager.reportEmbedProgress(500, 5000)
			const status = stateManager.getCurrentStatus()

			// effectiveEmbedded = 1000 + 500 = 1500 < 5000, no revision needed
			expect(status.totalBlocks).toBe(5000)
			expect(status.blocksEmbedded).toBe(1500)
		})

		it("should not override Stopping state", () => {
			stateManager.startEmbedPhase(1000, true)
			stateManager.setSystemState("Stopping", "Stop...")
			stateManager.reportEmbedProgress(100)
			expect(stateManager.state).toBe("Stopping")
		})

		describe("backpressure hint in file line", () => {
			it("should NOT show backpressure hint when files are still advancing", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true)

				// Advance both blocks and files
				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(100, 5000, 200)

				const status = stateManager.getCurrentStatus()
				expect(status.message).toContain("200 of 1,000 files checked")
				expect(status.message).not.toContain("waiting for embeddings")

				vi.restoreAllMocks()
			})

			it("should show backpressure hint when files stalled for >2s but blocks advancing", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true)

				// First: some file progress
				stateManager.reportEmbedProgress(50, 5000, 200)

				// 3s later: blocks advance but files stay at 200
				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(200, 5000, 200)

				const status = stateManager.getCurrentStatus()
				expect(status.message).toContain("200 of 1,000 files checked (waiting for embeddings)")

				vi.restoreAllMocks()
			})

			it("should NOT show backpressure hint when all files are parsed", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true)
				stateManager.reportEmbedProgress(50, 5000, 1000) // all files parsed

				// 3s later: blocks advance, all files already parsed
				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(200, 5000, 1000)

				const status = stateManager.getCurrentStatus()
				expect(status.message).toContain("1,000 of 1,000 files checked")
				expect(status.message).not.toContain("waiting for embeddings")

				vi.restoreAllMocks()
			})

			it("should clear backpressure hint when files advance again", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true)
				stateManager.reportEmbedProgress(50, 5000, 200)

				// 3s later: stalled — hint should appear
				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(200, 5000, 200)
				expect(stateManager.getCurrentStatus().message).toContain("waiting for embeddings")

				// Now files advance again — hint should disappear
				vi.spyOn(Date, "now").mockReturnValue(now + 3100)
				stateManager.reportEmbedProgress(210, 5000, 250)
				expect(stateManager.getCurrentStatus().message).toContain("250 of 1,000 files checked")
				expect(stateManager.getCurrentStatus().message).not.toContain("waiting for embeddings")

				vi.restoreAllMocks()
			})

			it("should NOT show backpressure hint within the 2s threshold", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true)
				stateManager.reportEmbedProgress(50, 5000, 200)

				// Only 1.5s later: files stalled but under threshold
				vi.spyOn(Date, "now").mockReturnValue(now + 1500)
				stateManager.reportEmbedProgress(100, 5000, 200)

				const status = stateManager.getCurrentStatus()
				expect(status.message).toContain("200 of 1,000 files checked")
				expect(status.message).not.toContain("waiting for embeddings")

				vi.restoreAllMocks()
			})
		})

		describe("estimation confidence", () => {
			it("should allow estimated runs to reach medium confidence once parsing coverage and throughput stabilize", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true, undefined, undefined, { runtimeKind: "local" })

				vi.spyOn(Date, "now").mockReturnValue(now + 1000)
				stateManager.reportEmbedProgress(500, 5000, 250)

				vi.spyOn(Date, "now").mockReturnValue(now + 2000)
				stateManager.reportEmbedProgress(1000, 5000, 300)

				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(1500, 5000, 360)

				const status = stateManager.getCurrentStatus()
				expect(status.estimationConfidence).toBe("medium")
				expect(status.isBackpressured).toBe(false)

				vi.restoreAllMocks()
			})

			it("should keep confidence low when backpressured before the estimate has enough coverage", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true, undefined, undefined, { runtimeKind: "local" })
				stateManager.reportEmbedProgress(100, 5000, 50)

				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(200, 5000, 50)

				const status = stateManager.getCurrentStatus()
				expect(status.estimationConfidence).toBe("low")
				expect(status.isBackpressured).toBe(true)

				vi.restoreAllMocks()
			})

			it("should not force stable estimated runs back to low confidence solely because of backpressure", () => {
				const now = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(now)

				stateManager.reportScanProgress(0, 1000)
				stateManager.startEmbedPhase(5000, true, undefined, undefined, { runtimeKind: "local" })

				vi.spyOn(Date, "now").mockReturnValue(now + 1000)
				stateManager.reportEmbedProgress(500, 5000, 300)

				vi.spyOn(Date, "now").mockReturnValue(now + 2000)
				stateManager.reportEmbedProgress(1000, 5000, 450)

				vi.spyOn(Date, "now").mockReturnValue(now + 3000)
				stateManager.reportEmbedProgress(1500, 5000, 550)

				vi.spyOn(Date, "now").mockReturnValue(now + 6000)
				stateManager.reportEmbedProgress(2000, 5000, 550)

				const status = stateManager.getCurrentStatus()
				expect(status.estimationConfidence).toBe("medium")
				expect(status.isBackpressured).toBe(true)
				expect(status.message).toContain("waiting for embeddings")

				vi.restoreAllMocks()
			})
		})
	})

	describe("reportCustomProgress", () => {
		it("should preserve truth-first stage metadata for reconcile status", () => {
			stateManager.reportCustomProgress("Reconciling", 0, 1, {
				currentItemUnit: "phases",
				phase: "scanning",
				detailedStage: "reconciling",
				isBackgroundReconcile: true,
				hasKnownVectorWork: false,
				hasStartedVectorSync: false,
			})

			const status = stateManager.getCurrentStatus()
			expect(status.phase).toBe("scanning")
			expect(status.detailedStage).toBe("reconciling")
			expect(status.isBackgroundReconcile).toBe(true)
			expect(status.hasKnownVectorWork).toBe(false)
			expect(status.hasStartedVectorSync).toBe(false)
		})
	})

	describe("ETA extrapolation (from-scratch index)", () => {
		it("should extrapolate total blocks when parsing is incomplete", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			// 65K files total, only 1000 parsed so far with 20,000 blocks found
			// Extrapolated: (20000 / 1000) * 65000 = 1,300,000
			stateManager.reportScanProgress(0, 65000)
			stateManager.startEmbedPhase(20000, true)

			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(5000, 20000, 1000)

			const status = stateManager.getCurrentStatus()
			// Display total should be extrapolated (~1,300,000), not raw 20,000
			expect(status.message).toContain("1,300,000 total blocks")
			// totalItems (progress bar denominator) should also be extrapolated
			expect(status.totalItems).toBe(1300000)

			vi.restoreAllMocks()
		})

		it("should use extrapolated total for ETA (not raw partial total)", () => {
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)

			// 1000 files total, 100 parsed with 500 blocks → 5 blocks/file → extrapolated = 5000
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(500, true)

			// 100 blocks embedded in 10s → 10 blocks/s
			// Remaining = 5000 - 100 = 4900 blocks → ETA = 490s = 490000ms
			vi.spyOn(Date, "now").mockReturnValue(now + 10000)
			stateManager.reportEmbedProgress(100, 500, 100)

			const status = stateManager.getCurrentStatus()
			expect(status.estimatedTimeRemainingMs).toBe(490000)

			vi.restoreAllMocks()
		})

		it("should NOT extrapolate when all files are parsed", () => {
			stateManager.reportScanProgress(0, 100) // totalFiles = 100
			stateManager.startEmbedPhase(500, true)
			stateManager.reportEmbedProgress(100, 500, 100) // filesParsed = totalFiles

			const status = stateManager.getCurrentStatus()
			// No extrapolation — raw total used
			expect(status.message).toContain("~500 total blocks")
			expect(status.totalItems).toBe(500)
		})

		it("should NOT extrapolate when isEstimatedTotal is false", () => {
			stateManager.reportScanProgress(0, 1000)
			stateManager.startEmbedPhase(500, false) // exact total
			stateManager.reportEmbedProgress(100, 500, 200)

			const status = stateManager.getCurrentStatus()
			// isEstimatedTotal = false → no extrapolation even though filesParsed < totalFiles
			expect(status.message).toContain("500 total blocks")
			expect(status.totalItems).toBe(500)
		})

		it("should converge extrapolation as more files are parsed", () => {
			stateManager.reportScanProgress(0, 1000) // 1000 files total

			stateManager.startEmbedPhase(500, true)
			stateManager.reportEmbedProgress(100, 500, 100) // 100/1000 parsed
			// Extrapolated: (500/100) * 1000 = 5000
			expect(stateManager.getCurrentStatus().totalItems).toBe(5000)

			stateManager.reportEmbedProgress(400, 2000, 500) // 500/1000 parsed
			// Extrapolated: (2000/500) * 1000 = 4000
			expect(stateManager.getCurrentStatus().totalItems).toBe(4000)

			stateManager.reportEmbedProgress(800, 3000, 1000) // 1000/1000 parsed — all done
			// No extrapolation — exact total
			expect(stateManager.getCurrentStatus().totalItems).toBe(3000)
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
			stateManager.reportScanProgress(0, 20) // totalFiles = filesParsed (no extrapolation)
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
			stateManager.reportScanProgress(0, 20) // totalFiles = filesParsed (no extrapolation)
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
			stateManager.reportScanProgress(0, 100) // totalFiles = filesParsed (no extrapolation)
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
