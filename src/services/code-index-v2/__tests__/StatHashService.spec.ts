import { beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_FILE_SIZE_BYTES } from "../../code-index/constants"
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
		expect(summary.unchangedFiles).toBe(0)
		expect(summary.oversizedFiles).toBe(0)
		expect(summary.missingFiles).toBe(0)
	})

	it("skips missing files without crashing the run", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-1",
				relativePath: "src/missing.ts",
				normalizedPath: "/workspace/src/missing.ts",
				lastSeenSize: 10,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
		])
		const error = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		workspaceAdapter.readFile.mockRejectedValue(error)

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.createFileRevision).not.toHaveBeenCalled()
		expect(summary.checkedFiles).toBe(1)
		expect(summary.changedFiles).toBe(0)
		expect(summary.skippedFiles).toBe(1)
		expect(summary.unchangedFiles).toBe(0)
		expect(summary.oversizedFiles).toBe(0)
		expect(summary.missingFiles).toBe(1)
	})

	it("skips oversized files before reading content", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-large",
				relativePath: "src/large.pb.go",
				normalizedPath: "/workspace/src/large.pb.go",
				lastSeenSize: MAX_FILE_SIZE_BYTES + 1,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
		])

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(workspaceAdapter.readFile).not.toHaveBeenCalled()
		expect(metadataStore.createFileRevision).not.toHaveBeenCalled()
		expect(summary.checkedFiles).toBe(1)
		expect(summary.changedFiles).toBe(0)
		expect(summary.skippedFiles).toBe(1)
		expect(summary.unchangedFiles).toBe(0)
		expect(summary.oversizedFiles).toBe(1)
		expect(summary.missingFiles).toBe(0)
	})
})
