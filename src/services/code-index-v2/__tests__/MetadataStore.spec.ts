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

	it("adds last_modified_mtime_ms to legacy oversized tracking tables during initialization", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		const dbPath = store.getDatabasePath()

		await fs.mkdir(path.dirname(dbPath), { recursive: true })

		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (path: string) => {
				exec(sql: string): void
				close(): void
			}
		}
		const legacyDb = new DatabaseSync(dbPath)
		legacyDb.exec(`
			CREATE TABLE IF NOT EXISTS schema_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS oversized_file_tracking (
				workspace_id TEXT NOT NULL,
				relative_path TEXT NOT NULL,
				normalized_path TEXT NOT NULL,
				status TEXT NOT NULL,
				size_bytes INTEGER NOT NULL,
				recommendation TEXT NOT NULL,
				reason TEXT NOT NULL,
				approved_max_bytes INTEGER,
				source_run_id TEXT,
				last_evaluated_at INTEGER NOT NULL,
				PRIMARY KEY(workspace_id, relative_path)
			);
		`)
		legacyDb.close()

		await store.initialize()

		await store.replaceTrackedOversizedFiles(store.getWorkspaceId(), [
			{
				workspaceId: store.getWorkspaceId(),
				relativePath: "dist/bundle.js",
				normalizedPath: path.join(workspacePath, "dist/bundle.js"),
				status: "skipped",
				sizeBytes: 2_000_000,
				lastModifiedMtimeMs: 123456789,
				recommendation: "probably_skip",
				reason: "Looks generated.",
				approvedMaxBytes: undefined,
				sourceRunId: "run-1",
			},
		])

		const records = await store.listTrackedOversizedFiles(store.getWorkspaceId(), 10, 0)
		expect(records.items).toHaveLength(1)
		expect(records.items[0]?.lastModifiedMtimeMs).toBe(123456789)

		await store.dispose()
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
				language: "ts",
				chunkKind: "function",
				symbolName: "doWork",
				symbolQualifiedName: "ExampleService.doWork",
				parentSymbolName: "ExampleService",
				parentChunkFingerprint: "parent-fp",
				summary: "ts function doWork in ExampleService",
				searchText: "Path: src/example.ts\nSymbol: doWork\nParent: ExampleService\n\nconst value = 1",
				content: "const value = 1",
				contentHash: "chunk-hash",
				state: "parsed",
			},
		])
		const [chunk] = await store.getChunksForRevision(revision.revisionId)
		expect(chunk?.language).toBe("ts")
		expect(chunk?.chunkKind).toBe("function")
		expect(chunk?.symbolName).toBe("doWork")
		expect(chunk?.symbolQualifiedName).toBe("ExampleService.doWork")
		expect(chunk?.parentSymbolName).toBe("ExampleService")
		expect(chunk?.parentChunkFingerprint).toBe("parent-fp")
		expect(chunk?.summary).toContain("doWork")
		expect(chunk?.searchText).toContain("Parent: ExampleService")
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

	it("finds active chunks by relative path and chunk fingerprint", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")
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
			runId,
			contentHash: "content-hash",
			fastFingerprint: "456:123",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "parent-fp",
				startLine: 1,
				endLine: 20,
				language: "ts",
				chunkKind: "class",
				symbolName: "ExampleService",
				symbolQualifiedName: "ExampleService",
				content: "class ExampleService {}",
				contentHash: "parent-content-hash",
				state: "upserted",
			},
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "child-fp",
				startLine: 5,
				endLine: 10,
				language: "ts",
				chunkKind: "method",
				symbolName: "run",
				symbolQualifiedName: "ExampleService.run",
				parentSymbolName: "ExampleService",
				parentChunkFingerprint: "parent-fp",
				content: "run() {}",
				contentHash: "child-content-hash",
				state: "upserted",
			},
		])
		await store.markRevisionCommitted(revision.revisionId)

		const results = await store.getActiveChunksByFingerprints([
			{
				relativePath: "src/example.ts",
				chunkFingerprint: "parent-fp",
			},
		])

		expect(results).toHaveLength(1)
		expect(results[0]?.relativePath).toBe("src/example.ts")
		expect(results[0]?.chunkFingerprint).toBe("parent-fp")
		expect(results[0]?.symbolQualifiedName).toBe("ExampleService")

		await store.dispose()
	})

	it("searches active chunks lexically across path and symbol metadata", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/auth/validate.ts",
			normalizedPath: path.join(workspacePath, "src/auth/validate.ts"),
			lastSeenMtimeMs: 123,
			lastSeenSize: 456,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "content-hash",
			fastFingerprint: "456:123",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "chunk-fp",
				startLine: 10,
				endLine: 20,
				language: "ts",
				chunkKind: "function",
				symbolName: "validateToken",
				symbolQualifiedName: "Auth.validateToken",
				parentSymbolName: "Auth",
				summary: "ts function validateToken in Auth at src/auth/validate.ts:10-20",
				searchText: "Path: src/auth/validate.ts\nSymbol: validateToken\nParent: Auth",
				content: "export function validateToken() {}",
				contentHash: "chunk-content-hash",
				state: "upserted",
			},
		])
		await store.markRevisionCommitted(revision.revisionId)

		const results = await store.searchActiveChunksLexically("validateToken", 5)

		expect(results).toHaveLength(1)
		expect(results[0]?.relativePath).toBe("src/auth/validate.ts")
		expect(results[0]?.symbolQualifiedName).toBe("Auth.validateToken")
		expect(results[0]?.lexicalScore).toBeGreaterThan(0)

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

	it("boosts lexical matches for exact filename-style queries", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-filename-query") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-filename-query")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("filename-query")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/services/code-index-v2/store/schema.ts",
			normalizedPath: path.join(workspacePath, "src/services/code-index-v2/store/schema.ts"),
			lastSeenMtimeMs: 321,
			lastSeenSize: 654,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "schema-content-hash",
			fastFingerprint: "654:321",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "schema-fp",
				startLine: 1,
				endLine: 10,
				language: "ts",
				chunkKind: "module",
				summary: "schema definitions for code index tables",
				searchText: "CREATE TABLE chunk_variants",
				content: "CREATE TABLE IF NOT EXISTS chunk_variants (...)",
				contentHash: "schema-chunk-content-hash",
				state: "upserted",
			},
		])
		await store.markRevisionCommitted(revision.revisionId)

		const results = await store.searchActiveChunksLexically("schema.ts CREATE TABLE chunk_variants", 5)

		expect(results[0]?.relativePath).toBe("src/services/code-index-v2/store/schema.ts")
		expect(results[0]?.lexicalScore).toBeGreaterThan(0)

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

	it("does not treat intentionally stopped runs as stale recovery candidates", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-stopped") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-stopped")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const stoppedRunId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/stopped.ts",
			normalizedPath: path.join(workspacePath, "src/stopped.ts"),
			lastSeenMtimeMs: 10,
			lastSeenSize: 20,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId: stoppedRunId,
			contentHash: "stopped-content-hash",
			fastFingerprint: "20:10",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "stopped-fp",
				startLine: 1,
				endLine: 2,
				content: "export const stopped = true",
				contentHash: "stopped-chunk-hash",
				state: "parsed",
			},
		])
		const [chunk] = await store.getChunksForRevision(revision.revisionId)
		await store.enqueueJobs([
			{
				workspaceId,
				runId: stoppedRunId,
				jobType: "upsert",
				entityId: chunk.chunkId,
				state: "queued",
			},
		])

		await store.markRunStopped(stoppedRunId)

		const cleanup = await store.cleanupStaleRuns()
		expect(cleanup.staleRunIds).toEqual([])

		const reusableRevision = await store.findReusableRevision(file.fileId, "stopped-content-hash", "20:10")
		expect(reusableRevision?.revisionId).toBe(revision.revisionId)

		const resumedRunId = await store.beginRun("initial-discovery")
		const adoptedJobs = await store.adoptRetryableJobsFromStaleRuns(resumedRunId, [])
		expect(adoptedJobs).toBe(0)

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

	it("persists and paginates tracked oversized files", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-6") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-6")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		await store.replaceTrackedOversizedFiles(workspaceId, [
			{
				workspaceId,
				relativePath: "src/huge-schema.sql",
				normalizedPath: path.join(workspacePath, "src/huge-schema.sql"),
				status: "skipped",
				sizeBytes: 1_600_000,
				lastModifiedMtimeMs: 1_700_000_000_000,
				recommendation: "likely_useful",
				reason: "Looks like schema, config, policy, or structured source data.",
				sourceRunId: "run-1",
			},
			{
				workspaceId,
				relativePath: "dist/bundle.js",
				normalizedPath: path.join(workspacePath, "dist/bundle.js"),
				status: "approved",
				sizeBytes: 1_300_000,
				lastModifiedMtimeMs: 1_700_000_100_000,
				recommendation: "probably_skip",
				reason: "Looks like generated, bundled, or repetitive output.",
				approvedMaxBytes: 1_600_000,
				sourceRunId: "run-1",
			},
			{
				workspaceId,
				relativePath: "src/missing.proto",
				normalizedPath: path.join(workspacePath, "src/missing.proto"),
				status: "missing",
				sizeBytes: 0,
				lastModifiedMtimeMs: null,
				recommendation: "likely_useful",
				reason: "This tracked file is no longer present in the workspace.",
				sourceRunId: "run-1",
			},
		])

		const page = await store.listTrackedOversizedFiles(workspaceId, 2, 0)
		expect(page.total).toBe(3)
		expect(page.actionable).toBe(1)
		expect(page.items).toHaveLength(2)
		expect(page.items[0]?.relativePath).toBe("src/huge-schema.sql")
		expect(page.items[1]?.status).toBe("approved")

		const trackedPaths = await store.listTrackedOversizedRelativePaths(workspaceId)
		expect(trackedPaths).toEqual(["dist/bundle.js", "src/huge-schema.sql", "src/missing.proto"])

		await store.replaceTrackedOversizedFiles(workspaceId, [
			{
				workspaceId,
				relativePath: "src/huge-schema.sql",
				normalizedPath: path.join(workspacePath, "src/huge-schema.sql"),
				status: "eligible",
				sizeBytes: 800_000,
				lastModifiedMtimeMs: 1_700_000_200_000,
				recommendation: "likely_useful",
				reason: "This file is now within the current size limit and can be indexed without an oversized override.",
				sourceRunId: "run-2",
			},
		])

		const refreshed = await store.listTrackedOversizedFiles(workspaceId, 10, 0)
		expect(refreshed.total).toBe(1)
		expect(refreshed.actionable).toBe(0)
		expect(refreshed.items[0]?.status).toBe("eligible")

		await store.dispose()
	})
})
