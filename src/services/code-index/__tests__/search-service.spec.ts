// npx vitest run services/code-index/__tests__/search-service.spec.ts

import { CodeIndexSearchService } from "../search-service"
import { SEARCH_EMBEDDING_TIMEOUT_MS } from "../constants"

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("@roo-code/types", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@roo-code/types")>()
	return {
		...actual,
		TelemetryEventName: {
			CODE_INDEX_ERROR: "CODE_INDEX_ERROR",
		},
	}
})

describe("CodeIndexSearchService", () => {
	let service: CodeIndexSearchService
	let mockConfigManager: any
	let mockStateManager: any
	let mockEmbedder: any
	let mockVectorStore: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockConfigManager = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			currentSearchMinScore: 0.4,
			currentSearchMaxResults: 50,
		}

		mockStateManager = {
			getCurrentStatus: vi.fn().mockReturnValue({ systemStatus: "Indexed" }),
			setSystemState: vi.fn(),
		}

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({
				embeddings: [[0.1, 0.2, 0.3]],
			}),
		}

		mockVectorStore = {
			search: vi.fn().mockResolvedValue([
				{
					id: "test-id",
					score: 0.85,
					payload: {
						filePath: "src/test.ts",
						codeChunk: "test code",
						startLine: 1,
						endLine: 5,
					},
				},
			]),
		}

		service = new CodeIndexSearchService(mockConfigManager, mockStateManager, mockEmbedder, mockVectorStore)
	})

	describe("searchIndex — basic functionality", () => {
		it("should return search results for a valid query", async () => {
			const results = await service.searchIndex("find button component")

			expect(mockEmbedder.createEmbeddings).toHaveBeenCalledWith(["find button component"], undefined, {
				isQuery: true,
			})
			expect(mockVectorStore.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], undefined, 0.4, 50)
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("test-id")
		})

		it("should pass normalized directory prefix to vector store", async () => {
			await service.searchIndex("query", "src/components")

			expect(mockVectorStore.search).toHaveBeenCalledWith(
				[0.1, 0.2, 0.3],
				expect.any(String), // normalized path
				0.4,
				50,
			)
		})

		it("should throw when feature is disabled", async () => {
			mockConfigManager.isFeatureEnabled = false

			await expect(service.searchIndex("query")).rejects.toThrow(
				"Code index feature is disabled or not configured.",
			)
		})

		it("should throw when feature is not configured", async () => {
			mockConfigManager.isFeatureConfigured = false

			await expect(service.searchIndex("query")).rejects.toThrow(
				"Code index feature is disabled or not configured.",
			)
		})

		it("should throw when system is not in Indexed or Indexing state", async () => {
			mockStateManager.getCurrentStatus.mockReturnValue({ systemStatus: "Standby" })

			await expect(service.searchIndex("query")).rejects.toThrow("Code index is not ready for search")
		})

		it("should allow search during Indexing state", async () => {
			mockStateManager.getCurrentStatus.mockReturnValue({ systemStatus: "Indexing" })

			const results = await service.searchIndex("query")

			expect(results).toHaveLength(1)
		})

		it("should throw when embedding response has no vectors", async () => {
			mockEmbedder.createEmbeddings.mockResolvedValue({ embeddings: [] })

			await expect(service.searchIndex("query")).rejects.toThrow("Failed to generate embedding for query.")
		})

		it("should throw when embedding response is null", async () => {
			mockEmbedder.createEmbeddings.mockResolvedValue(null)

			await expect(service.searchIndex("query")).rejects.toThrow()
		})
	})

	describe("searchIndex — search failure does NOT kill active indexing", () => {
		it("should NOT set Error state when search fails during Indexing", async () => {
			// System is actively indexing
			mockStateManager.getCurrentStatus.mockReturnValue({ systemStatus: "Indexing" })
			mockEmbedder.createEmbeddings.mockRejectedValue(new Error("API rate limited"))

			await expect(service.searchIndex("query")).rejects.toThrow("API rate limited")

			// Error state must NOT be set — indexing should continue undisturbed
			expect(mockStateManager.setSystemState).not.toHaveBeenCalled()
		})

		it("should set Error state when search fails in Indexed (idle) state", async () => {
			mockStateManager.getCurrentStatus.mockReturnValue({ systemStatus: "Indexed" })
			mockEmbedder.createEmbeddings.mockRejectedValue(new Error("Connection refused"))

			await expect(service.searchIndex("query")).rejects.toThrow("Connection refused")

			// Error state SHOULD be set when system is idle
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Error", "Search failed: Connection refused")
		})

		it("should NOT set Error state when Qdrant search fails during Indexing", async () => {
			mockStateManager.getCurrentStatus.mockReturnValue({ systemStatus: "Indexing" })
			mockVectorStore.search.mockRejectedValue(new Error("Qdrant temporarily unavailable"))

			await expect(service.searchIndex("query")).rejects.toThrow("Qdrant temporarily unavailable")

			// Error state must NOT be set — indexing should continue
			expect(mockStateManager.setSystemState).not.toHaveBeenCalled()
		})
	})

	describe("searchIndex — timeout protection", () => {
		it("should timeout if embedding generation takes too long", async () => {
			// Create a promise that never resolves
			mockEmbedder.createEmbeddings.mockImplementation(
				() => new Promise(() => {}), // Never resolves
			)

			// Use a shorter timeout for testing by accessing the private method
			const timeoutPromise = (service as any)._withTimeout(
				new Promise(() => {}),
				50, // 50ms timeout for fast test
				"Test embedding",
			)

			await expect(timeoutPromise).rejects.toThrow("Test embedding timed out after 50ms")
		})

		it("should resolve normally when embedding completes before timeout", async () => {
			const result = await (service as any)._withTimeout(Promise.resolve("ok"), 1000, "Test")

			expect(result).toBe("ok")
		})

		it("should propagate the original error when embedding rejects before timeout", async () => {
			const result = (service as any)._withTimeout(Promise.reject(new Error("API error")), 1000, "Test")

			await expect(result).rejects.toThrow("API error")
		})
	})

	describe("searchIndex — telemetry", () => {
		it("should capture telemetry on search failure", async () => {
			const { TelemetryService } = await import("@roo-code/telemetry")
			mockEmbedder.createEmbeddings.mockRejectedValue(new Error("API failure"))

			await expect(service.searchIndex("query")).rejects.toThrow("API failure")

			expect(TelemetryService.instance.captureEvent).toHaveBeenCalledWith("CODE_INDEX_ERROR", {
				error: "API failure",
				stack: expect.any(String),
				location: "searchIndex",
			})
		})
	})
})
