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
		mocks.fetch.mockRejectedValue(transportError)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)

		await expect(adapter.initialize()).rejects.toThrow(
			"Could not connect to Qdrant at http://localhost:6333 (connection refused)",
		)
	})

	it("retries transient transport failures before succeeding", async () => {
		const transientError = Object.assign(new Error("connect ECONNREFUSED"), {
			cause: { code: "ECONNREFUSED" },
		})

		mocks.fetch
			.mockRejectedValueOnce(transientError)
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: { status: "green" } }),
			} as any)
			.mockResolvedValue({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: {} }),
			} as any)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)

		await expect(adapter.initialize()).resolves.toBeUndefined()
		expect(mocks.fetch).toHaveBeenCalled()
		expect(mocks.fetch.mock.calls.length).toBeGreaterThan(1)
	})

	it("retries transient HTTP 408 responses when fetching collection info", async () => {
		mocks.fetch
			.mockResolvedValueOnce({
				status: 408,
				ok: false,
				statusText: "Request Timeout",
				text: vi.fn().mockResolvedValue(""),
			} as any)
			.mockResolvedValueOnce({
				status: 404,
				ok: false,
				statusText: "Not Found",
				text: vi.fn().mockResolvedValue(""),
			} as any)
			.mockResolvedValue({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: {} }),
			} as any)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)

		await expect(adapter.initialize()).resolves.toBeUndefined()
		expect(mocks.fetch).toHaveBeenCalled()
		expect(mocks.fetch.mock.calls.length).toBeGreaterThan(2)
	})

	it("retries transient HTTP 503 responses for payload index creation", async () => {
		mocks.fetch
			.mockResolvedValueOnce({
				status: 404,
				ok: false,
				statusText: "Not Found",
				text: vi.fn().mockResolvedValue(""),
			} as any)
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: {} }),
			} as any)
			.mockResolvedValueOnce({
				status: 503,
				ok: false,
				statusText: "Service Unavailable",
				text: vi.fn().mockResolvedValue("busy"),
			} as any)
			.mockResolvedValue({
				status: 200,
				ok: true,
				json: vi.fn().mockResolvedValue({ result: {} }),
			} as any)

		const adapter = new QdrantRestVectorStoreAdapter("/workspace", "http://localhost:6333", 768)

		await expect(adapter.initialize()).resolves.toBeUndefined()
		expect(mocks.fetch).toHaveBeenCalled()
		expect(mocks.fetch.mock.calls.length).toBeGreaterThanOrEqual(6)
	})
})
