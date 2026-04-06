import { beforeEach, describe, expect, it, vi } from "vitest"
import { QdrantRestVectorStoreAdapter } from "../adapters/QdrantRestVectorStoreAdapter"

const mocks = vi.hoisted(() => {
	return {
		fetch: vi.fn(),
		destroy: vi.fn().mockResolvedValue(undefined),
	}
})

vi.mock("../../code-index/utils/isolated-fetch", () => ({
	createIsolatedFetch: () => ({
		fetch: mocks.fetch,
		destroy: mocks.destroy,
	}),
}))

describe("QdrantRestVectorStoreAdapter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("passes AbortSignal through initialize requests", async () => {
		mocks.fetch
			.mockResolvedValueOnce({
				status: 404,
				ok: false,
				text: vi.fn().mockResolvedValue(""),
			} as any)
			.mockResolvedValue({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: {} }),
			} as any)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)
		const controller = new AbortController()

		await adapter.initialize(controller.signal)

		expect(mocks.fetch).toHaveBeenCalled()
		for (const call of mocks.fetch.mock.calls) {
			expect(call[1]?.signal).toBe(controller.signal)
		}
	})

	it("formats fetch failures as actionable connection errors", async () => {
		const transportError = Object.assign(new Error("fetch failed"), {
			cause: { code: "ECONNREFUSED" },
		})
		mocks.fetch.mockRejectedValueOnce(transportError)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)

		await expect(adapter.initialize()).rejects.toThrow(
			"Could not connect to Qdrant at http://localhost:6333 (connection refused)",
		)
	})
})
