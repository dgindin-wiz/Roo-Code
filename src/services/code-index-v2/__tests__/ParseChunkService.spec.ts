import { beforeEach, describe, expect, it, vi } from "vitest"
import { ParseChunkService } from "../pipeline/ParseChunkService"

describe("ParseChunkService", () => {
	const createDeps = () => {
		const metadataStore = {
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
			getRevisionsByState: vi.fn(),
			upsertChunks: vi.fn().mockResolvedValue(undefined),
			markRevisionState: vi.fn().mockResolvedValue(undefined),
			markRevisionTerminalFailure: vi.fn().mockResolvedValue(undefined),
		}

		const workspaceAdapter = {
			readFile: vi.fn(),
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
		}

		const parserAdapter = {
			parseFile: vi.fn(),
		}

		return { metadataStore, workspaceAdapter, parserAdapter }
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("retries a transient parse failure and succeeds within the same run", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-1",
				fileId: "file-1",
				runId: "run-1",
				normalizedPath: "/workspace/src/a.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const value = 1")
		parserAdapter.parseFile.mockRejectedValueOnce(new Error("Canceled")).mockResolvedValueOnce([
			{
				chunkFingerprint: "fp-1",
				startLine: 1,
				endLine: 1,
				content: "const value = 1",
			},
		])

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(parserAdapter.parseFile).toHaveBeenCalledTimes(2)
		expect(metadataStore.markRevisionState).toHaveBeenCalledWith("revision-1", "parsed")
		expect(metadataStore.markRevisionTerminalFailure).not.toHaveBeenCalled()
		expect(summary.parsedRevisions).toBe(1)
		expect(summary.parsedChunks).toBe(1)
		expect(summary.retryingRevisions).toBe(1)
		expect(summary.terminalFailedRevisions).toBe(0)
	})

	it("marks a revision terminal_failed after bounded parse retries and continues", async () => {
		const { metadataStore, workspaceAdapter, parserAdapter } = createDeps()
		metadataStore.getRevisionsByState.mockResolvedValue([
			{
				revisionId: "revision-bad",
				fileId: "file-bad",
				runId: "run-1",
				normalizedPath: "/workspace/src/bad.ts",
			},
			{
				revisionId: "revision-good",
				fileId: "file-good",
				runId: "run-1",
				normalizedPath: "/workspace/src/good.ts",
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("content")
		parserAdapter.parseFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
			if (filePath.endsWith("bad.ts")) {
				throw new Error("memory access out of bounds")
			}
			return [
				{
					chunkFingerprint: "fp-good",
					startLine: 1,
					endLine: 1,
					content: "good",
				},
			]
		})

		const service = new ParseChunkService(metadataStore as any, workspaceAdapter as any, parserAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.markRevisionTerminalFailure).toHaveBeenCalledWith(
			"revision-bad",
			"memory access out of bounds",
		)
		expect(metadataStore.markRevisionState).toHaveBeenCalledWith("revision-good", "parsed")
		expect(summary.parsedRevisions).toBe(1)
		expect(summary.retryingRevisions).toBe(2)
		expect(summary.terminalFailedRevisions).toBe(1)
		expect(summary.parsedRevisionIds).toEqual(["revision-good"])
	})
})
