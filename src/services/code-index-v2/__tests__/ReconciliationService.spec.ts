import { describe, expect, it, vi } from "vitest"
import { MAX_FILE_SIZE_BYTES } from "../../code-index/constants"
import { ReconciliationService } from "../reconciliation/ReconciliationService"

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		log: vi.fn(),
	},
}))

describe("ReconciliationService", () => {
	it("does not finalize missing files when discovery is partial", async () => {
		const metadataStore = {
			getTrackedFilesForWorkspace: vi.fn(),
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		} as any

		const workspaceAdapter = {
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
			enumerateCandidateFiles: vi.fn(),
		} as any

		const service = new ReconciliationService(metadataStore, workspaceAdapter)

		const result = await service.findMissingFiles({
			runId: "run-1",
			discoveredFiles: 10,
			isPartial: true,
		})

		expect(result.missingFiles).toEqual([])
		expect(metadataStore.getTrackedFilesForWorkspace).not.toHaveBeenCalled()
		expect(workspaceAdapter.enumerateCandidateFiles).not.toHaveBeenCalled()
	})

	it("returns tracked files that are absent from a complete reconciliation scan", async () => {
		const metadataStore = {
			getTrackedFilesForWorkspace: vi.fn().mockResolvedValue([
				{
					fileId: "a",
					relativePath: "src/a.ts",
					tombstoned: false,
				},
				{
					fileId: "b",
					relativePath: "src/b.ts",
					tombstoned: false,
				},
				{
					fileId: "c",
					relativePath: "src/c.ts",
					tombstoned: true,
				},
			]),
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		} as any

		const workspaceAdapter = {
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
			isCandidateFile: vi.fn().mockReturnValue(true),
			enumerateCandidateFiles: vi.fn(async (onFile: (filePath: string) => void) => {
				onFile("/workspace/src/a.ts")
				return { discoveredFiles: 1, isPartial: false }
			}),
		} as any

		const service = new ReconciliationService(metadataStore, workspaceAdapter)

		const result = await service.findMissingFiles({
			runId: "run-2",
			discoveredFiles: 1,
			isPartial: false,
		})

		expect(result.missingFiles).toEqual(["src/b.ts"])
		expect(metadataStore.getTrackedFilesForWorkspace).toHaveBeenCalledWith("workspace-1")
		expect(workspaceAdapter.enumerateCandidateFiles).toHaveBeenCalledTimes(1)
	})

	it("retires tracked files that are no longer candidates under current ignore rules", async () => {
		const metadataStore = {
			getTrackedFilesForWorkspace: vi.fn().mockResolvedValue([
				{
					fileId: "build-1",
					relativePath: "src/webview-ui/build/assets/index.js",
					normalizedPath: "/workspace/src/webview-ui/build/assets/index.js",
					tombstoned: false,
				},
				{
					fileId: "src-1",
					relativePath: "src/app.ts",
					normalizedPath: "/workspace/src/app.ts",
					tombstoned: false,
				},
			]),
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		} as any

		const workspaceAdapter = {
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
			isCandidateFile: vi.fn((filePath: string) => !filePath.includes("/build/")),
			enumerateCandidateFiles: vi.fn(async (onFile: (filePath: string) => void) => {
				onFile("/workspace/src/app.ts")
				return { discoveredFiles: 1, isPartial: false }
			}),
		} as any

		const service = new ReconciliationService(metadataStore, workspaceAdapter)

		const result = await service.findMissingFiles({
			runId: "run-3",
			discoveredFiles: 1,
			isPartial: false,
		})

		expect(result.missingFiles).toEqual(["src/webview-ui/build/assets/index.js"])
		expect(workspaceAdapter.isCandidateFile).toHaveBeenCalledWith("/workspace/src/webview-ui/build/assets/index.js")
	})

	it("retires tracked files that now exceed the indexing size limit", async () => {
		const metadataStore = {
			getTrackedFilesForWorkspace: vi.fn().mockResolvedValue([
				{
					fileId: "large-1",
					relativePath: "autogenlib/types/benchmark/benchmark.pb.go",
					normalizedPath: "/workspace/autogenlib/types/benchmark/benchmark.pb.go",
					lastSeenSize: MAX_FILE_SIZE_BYTES + 1,
					tombstoned: false,
				},
				{
					fileId: "small-1",
					relativePath: "src/app.ts",
					normalizedPath: "/workspace/src/app.ts",
					lastSeenSize: 128,
					tombstoned: false,
				},
			]),
			getWorkspaceId: vi.fn().mockReturnValue("workspace-1"),
		} as any

		const workspaceAdapter = {
			getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
			isCandidateFile: vi.fn().mockReturnValue(true),
			enumerateCandidateFiles: vi.fn(async (onFile: (filePath: string) => void) => {
				onFile("/workspace/autogenlib/types/benchmark/benchmark.pb.go")
				onFile("/workspace/src/app.ts")
				return { discoveredFiles: 2, isPartial: false }
			}),
		} as any

		const service = new ReconciliationService(metadataStore, workspaceAdapter)

		const result = await service.findMissingFiles({
			runId: "run-4",
			discoveredFiles: 2,
			isPartial: false,
		})

		expect(result.missingFiles).toEqual(["autogenlib/types/benchmark/benchmark.pb.go"])
	})
})
