import { describe, expect, it, vi } from "vitest"
import { ExistingEmbedderAdapter } from "../adapters/ExistingEmbedderAdapter"

describe("ExistingEmbedderAdapter", () => {
	it("preserves usage metadata from the underlying embedder", async () => {
		const embedder = {
			embedderInfo: { name: "openai" as const },
			createEmbeddings: vi.fn().mockResolvedValue({
				embeddings: [[0.1, 0.2]],
				usage: {
					promptTokens: 12,
					totalTokens: 12,
				},
			}),
		}

		const adapter = new ExistingEmbedderAdapter(embedder as any, {
			modelId: "text-embedding-3-small",
		})

		const response = await adapter.createEmbeddings(["hello world"])

		expect(response.embeddings).toEqual([[0.1, 0.2]])
		expect(response.usage).toEqual({ promptTokens: 12, totalTokens: 12 })
	})

	it("uses a truthful fallback model id when no model id is provided", () => {
		const embedder = {
			embedderInfo: { name: "ollama" as const },
			createEmbeddings: vi.fn(),
		}

		const adapter = new ExistingEmbedderAdapter(embedder as any)

		expect(adapter.modelId).toBe("unknown-configured-model")
	})
})
