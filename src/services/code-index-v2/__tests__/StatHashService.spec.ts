import { beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_FILE_SIZE_BYTES } from "../../code-index/constants"
import { StatHashService } from "../pipeline/StatHashService"
import { CODE_INDEX_V2_CHUNKER_VERSION, CODE_INDEX_V2_PARSER_VERSION } from "../shared/chunkSurfaces"

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
				relativePath: "src/example.ts",
				normalizedPath: "/workspace/src/example.ts",
				lastSeenSize: 10,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
				latestRevisionParserVersion: null,
				latestRevisionChunkerVersion: null,
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

	it("does not treat matching committed revisions as unchanged when retrieval surface versions differ", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-1",
				relativePath: "src/example.ts",
				normalizedPath: "/workspace/src/example.ts",
				lastSeenSize: 21,
				lastSeenMtimeMs: 42,
				latestRevisionState: "committed",
				latestRevisionFastFingerprint: "21:42",
				latestRevisionContentHash: "content-hash-1",
				latestRevisionParserVersion: "code-index-v2:older-surfaces",
				latestRevisionChunkerVersion: CODE_INDEX_V2_CHUNKER_VERSION,
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const example = true")
		metadataStore.findReusableRevision.mockResolvedValue(undefined)

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(workspaceAdapter.readFile).toHaveBeenCalledWith("/workspace/src/example.ts")
		expect(metadataStore.createFileRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				fileId: "file-1",
				parserVersion: CODE_INDEX_V2_PARSER_VERSION,
				chunkerVersion: CODE_INDEX_V2_CHUNKER_VERSION,
				state: "hashed",
			}),
		)
		expect(summary.changedFiles).toBe(1)
		expect(summary.unchangedFiles).toBe(0)
	})

	it("only reuses parsed revisions that match the current retrieval surface version", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-1",
				relativePath: "src/example.ts",
				normalizedPath: "/workspace/src/example.ts",
				lastSeenSize: 10,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
				latestRevisionParserVersion: null,
				latestRevisionChunkerVersion: null,
			},
		])
		workspaceAdapter.readFile.mockResolvedValue("const resumed = true")
		metadataStore.findReusableRevision.mockResolvedValue({
			revisionId: "revision-stale",
			state: "parsed",
		})

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(metadataStore.findReusableRevision).toHaveBeenCalledWith(
			"file-1",
			expect.any(String),
			"10:20",
			CODE_INDEX_V2_PARSER_VERSION,
			CODE_INDEX_V2_CHUNKER_VERSION,
		)
		expect(metadataStore.adoptRevisionToRun).toHaveBeenCalledWith("revision-stale", "run-1")
		expect(summary.reusedParsedRevisionIds).toEqual(["revision-stale"])
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

	it("prioritizes likely useful and reapproval-needed oversized files ahead of noisy files", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue([
			{
				fileId: "file-noise",
				relativePath: "dist/app.bundle.js",
				normalizedPath: "/workspace/dist/app.bundle.js",
				lastSeenSize: MAX_FILE_SIZE_BYTES + 500,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
			{
				fileId: "file-useful",
				relativePath: "config/openapi.yaml",
				normalizedPath: "/workspace/config/openapi.yaml",
				lastSeenSize: MAX_FILE_SIZE_BYTES + 800,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
			{
				fileId: "file-review",
				relativePath: "src/huge-service.ts",
				normalizedPath: "/workspace/src/huge-service.ts",
				lastSeenSize: MAX_FILE_SIZE_BYTES + 200,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
			{
				fileId: "file-approved",
				relativePath: "src/schema.ts",
				normalizedPath: "/workspace/src/schema.ts",
				lastSeenSize: MAX_FILE_SIZE_BYTES + 900,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			},
		])

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1", undefined, undefined, {
			resolveApprovedMaxBytes: (relativePath) =>
				relativePath === "src/schema.ts" ? MAX_FILE_SIZE_BYTES + 100 : undefined,
		})

		expect(summary.oversizedDetails.map((detail) => detail.relativePath)).toEqual([
			"src/schema.ts",
			"config/openapi.yaml",
			"src/huge-service.ts",
			"dist/app.bundle.js",
		])
		expect(summary.oversizedDetails[0]).toMatchObject({
			relativePath: "src/schema.ts",
			needsReapproval: true,
		})
	})

	it("keeps only the top 20 prioritized oversized files", async () => {
		const { metadataStore, workspaceAdapter } = createDeps()
		metadataStore.getDiscoveredFilesForWorkspace.mockResolvedValue(
			Array.from({ length: 25 }, (_, index) => ({
				fileId: `file-${index}`,
				relativePath: index === 24 ? "config/high-priority.yaml" : `dist/generated-${index}.bundle.js`,
				normalizedPath:
					index === 24
						? "/workspace/config/high-priority.yaml"
						: `/workspace/dist/generated-${index}.bundle.js`,
				lastSeenSize: MAX_FILE_SIZE_BYTES + 1000 + index,
				lastSeenMtimeMs: 20,
				latestRevisionState: null,
				latestRevisionFastFingerprint: null,
				latestRevisionContentHash: null,
			})),
		)

		const service = new StatHashService(metadataStore as any, workspaceAdapter as any)
		const summary = await service.run("run-1")

		expect(summary.oversizedDetails).toHaveLength(20)
		expect(summary.oversizedDetails[0]?.relativePath).toBe("config/high-priority.yaml")
		expect(summary.oversizedDetails.some((detail) => detail.relativePath === "dist/generated-24.bundle.js")).toBe(
			false,
		)
	})
})
