import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => {
	return {
		workspace: {
			getConfiguration: vi.fn().mockReturnValue({
				get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
			}),
			fs: {
				createDirectory: vi.fn(async (uri: { fsPath: string }) => {
					await fs.mkdir(uri.fsPath, { recursive: true })
				}),
			},
		},
		window: {
			createOutputChannel: vi.fn().mockReturnValue({
				appendLine: vi.fn(),
			}),
		},
		Uri: {
			joinPath: (...parts: Array<{ fsPath?: string } | string>) => ({
				fsPath: path.join(...parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? "")))),
			}),
		},
	}
})

import { MetadataStore } from "../store/MetadataStore"

describe("MetadataStore integration", () => {
	let tempRoot: string

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-store-"))
	})

	afterEach(async () => {
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("preserves retryable stale jobs and adopts them into the next run", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const staleRunId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/example.ts",
			normalizedPath: path.join(workspacePath, "src/example.ts"),
			lastSeenMtimeMs: 123,
			lastSeenSize: 456,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId: staleRunId,
			contentHash: "content-hash",
			fastFingerprint: "456:123",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "planned",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "chunk-fp",
				startLine: 1,
				endLine: 5,
				content: "const value = 1",
				contentHash: "chunk-hash",
				state: "parsed",
			},
		])
		const [chunk] = await store.getChunksForRevision(revision.revisionId)
		await store.enqueueJobs([
			{
				workspaceId,
				runId: staleRunId,
				jobType: "upsert",
				entityId: chunk.chunkId,
				state: "running",
			},
		])

		const cleanup = await store.cleanupStaleRuns()
		expect(cleanup.staleRunIds).toEqual([staleRunId])
		expect(cleanup.staleJobsPreservedForResume).toBe(1)
		expect(cleanup.staleJobsAbandoned).toBe(0)
		expect(cleanup.expiredRunsDeleted).toBe(0)

		const preservedRevision = await store.getFileRevision(revision.revisionId)
		expect(preservedRevision.state).toBe("planned")
		expect((await store.getChunksForRevision(revision.revisionId))[0]?.state).toBe("parsed")

		const resumedRunId = await store.beginRun("initial-discovery")
		const adoptedJobs = await store.adoptRetryableJobsFromStaleRuns(resumedRunId, cleanup.staleRunIds)
		expect(adoptedJobs).toBe(1)

		const claimedJobs = await store.claimJobs("upsert", 10, resumedRunId)
		expect(claimedJobs).toHaveLength(1)
		expect(claimedJobs[0]?.entityId).toBe(chunk.chunkId)

		const adoptedRevision = await store.getFileRevision(revision.revisionId)
		expect(adoptedRevision.runId).toBe(resumedRunId)

		await store.dispose()
	})

	it("preserves parsed stale revisions and chunks so they can be reused later", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-2") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-2")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const staleRunId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/reuse.ts",
			normalizedPath: path.join(workspacePath, "src/reuse.ts"),
			lastSeenMtimeMs: 55,
			lastSeenSize: 99,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId: staleRunId,
			contentHash: "reuse-content-hash",
			fastFingerprint: "99:55",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "hashed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "reuse-fp",
				startLine: 1,
				endLine: 3,
				content: "const reuse = true",
				contentHash: "reuse-chunk-hash",
				state: "parsed",
			},
		])
		await store.markRevisionState(revision.revisionId, "parsed")

		const cleanup = await store.cleanupStaleRuns()
		expect(cleanup.staleRunIds).toEqual([staleRunId])
		expect(cleanup.expiredRunsDeleted).toBe(0)

		const preservedRevision = await store.getFileRevision(revision.revisionId)
		expect(preservedRevision.state).toBe("parsed")
		expect((await store.getChunksForRevision(revision.revisionId))[0]?.state).toBe("parsed")

		const reusableRevision = await store.findReusableRevision(file.fileId, "reuse-content-hash", "99:55")
		expect(reusableRevision?.revisionId).toBe(revision.revisionId)

		await store.dispose()
	})

	it("adopts queued retry jobs from prior failed runs on a later restart", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-3") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-3")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const staleRunId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/later-retry.ts",
			normalizedPath: path.join(workspacePath, "src/later-retry.ts"),
			lastSeenMtimeMs: 77,
			lastSeenSize: 101,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId: staleRunId,
			contentHash: "later-content-hash",
			fastFingerprint: "101:77",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "planned",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "later-fp",
				startLine: 1,
				endLine: 2,
				content: "export const later = true",
				contentHash: "later-chunk-hash",
				state: "parsed",
			},
		])
		const [chunk] = await store.getChunksForRevision(revision.revisionId)
		await store.enqueueJobs([
			{
				workspaceId,
				runId: staleRunId,
				jobType: "upsert",
				entityId: chunk.chunkId,
				state: "queued",
			},
		])

		await store.cleanupStaleRuns()

		const resumedRunId = await store.beginRun("initial-discovery")
		const adoptedJobs = await store.adoptRetryableJobsFromStaleRuns(resumedRunId, [])
		expect(adoptedJobs).toBe(1)

		const claimedJobs = await store.claimJobs("upsert", 10, resumedRunId)
		expect(claimedJobs).toHaveLength(1)
		expect(claimedJobs[0]?.entityId).toBe(chunk.chunkId)

		await store.dispose()
	})

	it("garbage-collects expired failed runs with preserved pending revisions and retry jobs", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-4") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-4")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const oldRunId = await store.beginRun("initial-discovery")
		const oldFile = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/old-pending.ts",
			normalizedPath: path.join(workspacePath, "src/old-pending.ts"),
			lastSeenMtimeMs: 88,
			lastSeenSize: 144,
			ignoreState: "included",
		})
		const oldRevision = await store.createFileRevision({
			fileId: oldFile.fileId,
			runId: oldRunId,
			contentHash: "old-content-hash",
			fastFingerprint: "144:88",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "planned",
		})
		await store.upsertChunks([
			{
				revisionId: oldRevision.revisionId,
				chunkFingerprint: "old-fp",
				startLine: 1,
				endLine: 2,
				content: "export const oldPending = true",
				contentHash: "old-chunk-hash",
				state: "parsed",
			},
		])
		const [oldChunk] = await store.getChunksForRevision(oldRevision.revisionId)
		await store.enqueueJobs([
			{
				workspaceId,
				runId: oldRunId,
				jobType: "upsert",
				entityId: oldChunk.chunkId,
				state: "queued",
			},
		])
		await store.markRunFailed(oldRunId, "old failure")
		const expiredCompletedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
		;(store as any)
			.db()
			.prepare(`UPDATE index_runs SET completed_at = ? WHERE run_id = ?`)
			.run(expiredCompletedAt, oldRunId)

		const cleanup = await store.cleanupStaleRuns()
		expect(cleanup.expiredJobsGarbageCollected).toBe(1)
		expect(cleanup.expiredRevisionsGarbageCollected).toBe(1)
		expect(cleanup.expiredChunksGarbageCollected).toBe(1)
		expect(cleanup.expiredRunsDeleted).toBe(1)

		const reusableRevision = await store.findReusableRevision(oldFile.fileId, "old-content-hash", "144:88")
		expect(reusableRevision).toBeUndefined()

		await store.dispose()
	})

	it("returns paginated warning details with a total count", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-5") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-5")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")

		const warningStates = ["terminal_failed", "degraded", "failed"] as const
		for (const [index, state] of warningStates.entries()) {
			const file = await store.upsertFileRecord({
				workspaceId,
				relativePath: `src/warning-${index}.ts`,
				normalizedPath: path.join(workspacePath, `src/warning-${index}.ts`),
				lastSeenMtimeMs: 100 + index,
				lastSeenSize: 200 + index,
				ignoreState: "included",
			})
			const revision = await store.createFileRevision({
				fileId: file.fileId,
				runId,
				contentHash: `warning-hash-${index}`,
				fastFingerprint: `${200 + index}:${100 + index}`,
				parserVersion: "parser-v1",
				chunkerVersion: "chunker-v1",
				state: "hashed",
			})
			if (state === "terminal_failed") {
				await store.markRevisionTerminalFailure(revision.revisionId, "terminal fail")
			} else if (state === "degraded") {
				await store.markRevisionDegraded(revision.revisionId, "partial fail")
			} else {
				await store.markRevisionFailed(revision.revisionId, "generic fail")
			}
		}

		const page = await store.listRevisionWarnings(workspaceId, 2, 0)
		expect(page.total).toBe(3)
		expect(page.items).toHaveLength(2)
		expect(page.items[0]?.category).toBe("parser_failed")
		expect(page.items[1]?.category).toBe("failed")

		const degradedOnly = await store.listRevisionWarnings(workspaceId, 10, 0, "degraded")
		expect(degradedOnly.total).toBe(1)
		expect(degradedOnly.items[0]?.state).toBe("degraded")

		const parserOnly = await store.listRevisionWarnings(workspaceId, 10, 0, "parser_failed")
		expect(parserOnly.total).toBe(1)
		expect(parserOnly.items[0]?.category).toBe("parser_failed")

		const pathSorted = await store.listRevisionWarnings(workspaceId, 10, 0, "all", "path")
		expect(pathSorted.items.map((item) => item.relativePath)).toEqual([
			"src/warning-0.ts",
			"src/warning-1.ts",
			"src/warning-2.ts",
		])

		const warningPaths = await store.listWarningRelativePaths(workspaceId, "all")
		expect(warningPaths).toEqual(["src/warning-0.ts", "src/warning-1.ts", "src/warning-2.ts"])

		await store.dispose()
	})
})
