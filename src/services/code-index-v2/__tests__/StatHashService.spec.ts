import { beforeEach, describe, expect, it, vi } from "vitest"
import { StatHashService } from "../pipeline/StatHashService"

describe("StatHashService", () => {
	const createDeps = () => {
		const metadataStore = {
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
			getDiscoveredFilesForWorkspace: vi.fn(),
			getDiscoveredFilesByRelativePaths: vi.fn(),
			findReusableRevision: vi.fn(),
			adoptRevisionToRun: vi.fn().mockResolvedValue(undefined),
			createFileRevision: vi.fn().mockResolvedValue(undefined),
		}

		const workspaceAdapter = {
			readFile: vi.fn(),
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
		}

		return { metadataStore, workspaceAdapter }
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reuses a stale pending revision with matching fingerprint and content", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-1",
				normalizedPath: "/workspace/src/example.ts",
				lastSeenSize: 10,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const resumed = true")
		metadataStore.findReusableRevision.mockResolvedValue({
			revisionId: "revision-stale",
		})

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.adoptRevisionToRun).toHaveBeenCalledWith("revision-stale", "run-1")
		expect(metadataStore.createFileRevision).not.toHaveBeenCalled()
		expect(summary.changedFiles).toBe(1)
		expect(summary.skippedFiles).toBe(0)
	})
})
