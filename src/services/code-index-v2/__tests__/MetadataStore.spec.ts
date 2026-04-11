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
import { CODE_INDEX_V2_CHUNKER_VERSION, CODE_INDEX_V2_PARSER_VERSION } from "../shared/chunkSurfaces"

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

	it("opens with WAL-oriented SQLite settings and remains usable", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const db = (store as any).db() as {
			prepare(sql: string): { get(): Record<string, unknown> | undefined }
		}
		const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode
		const synchronous = db.prepare("PRAGMA synchronous").get()?.synchronous
		const busyTimeout = db.prepare("PRAGMA busy_timeout").get()?.timeout
		const tempStore = db.prepare("PRAGMA temp_store").get()?.temp_store
		const foreignKeys = db.prepare("PRAGMA foreign_keys").get()?.foreign_keys

		expect(journalMode).toBe("wal")
		expect(synchronous).toBe(1)
		expect(busyTimeout).toBe(5000)
		expect(tempStore).toBe(2)
		expect(foreignKeys).toBe(1)

		const workspace = await store.ensureWorkspaceRecord()
		expect(workspace.workspaceId).toBe(store.getWorkspaceId())

		await store.dispose()
	})

	it("persists run summaries and bounded telemetry samples for later analysis", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const runId = await store.beginRun("initial-discovery")
		await store.appendRunSample({
			runId,
			workspaceId: store.getWorkspaceId(),
			recordedAt: 1,
			stage: "embed",
			eventType: "heartbeat",
			chunksPerSecond: 42,
			pressureState: "soft",
			pressureReasons: ["external"],
			hostRssMB: 900,
		})
		await store.writeRunSummary({
			runId,
			workspaceId: store.getWorkspaceId(),
			triggerType: "initial-discovery",
			state: "complete",
			startedAt: 1,
			completedAt: 2,
			totalRunMs: 1_000,
			filesChanged: 5,
			parsedChunks: 120,
			upsertedChunks: 120,
			chunksPerSecond: 84.5,
			buildTimestamp: "2026-04-10T00:00:00.000Z",
			provider: "openai-compatible",
			modelId: "embeddinggemma",
			runtimeKind: "local",
			lastBlockingReason: "staged_chunks_waiting_for_upsert",
		})

		const summary = await store.getRunSummary(runId)
		const samples = await store.listRunSamples(runId, 10)

		expect(summary?.filesChanged).toBe(5)
		expect(summary?.chunksPerSecond).toBe(84.5)
		expect(summary?.runtimeKind).toBe("local")
		expect(samples).toHaveLength(1)
		expect(samples[0]?.pressureReasons).toEqual(["external"])
		expect(samples[0]?.hostRssMB).toBe(900)
		expect(summary?.lastBlockingReason).toBe("staged_chunks_waiting_for_upsert")

		await store.dispose()
	})

	it("preserves persistent telemetry history when clearing operational index storage", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const runId = await store.beginRun("initial-discovery")
		await store.writeRunSummary({
			runId,
			workspaceId: store.getWorkspaceId(),
			triggerType: "initial-discovery",
			state: "complete",
			startedAt: 1,
			completedAt: 2,
			totalRunMs: 100,
			filesChanged: 2,
		})

		const telemetryDbPath = store.getTelemetryDatabasePath()
		expect(await store.getRunSummary(runId)).toBeDefined()

		await store.clearStorage()

		await expect(fs.stat(telemetryDbPath)).resolves.toBeDefined()
		expect(await store.getRunSummary(runId)).toBeDefined()

		await store.initialize()
		expect(await store.getRunSummary(runId)).toBeDefined()

		await store.dispose()
	})

	it("commits chunk rows and lexical FTS rows atomically", async () => {
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
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "content-hash",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "hashed",
		})

		const originalFtsUpsert = (store as any).upsertChunkLexicalFtsRows.bind(store)
		;(store as any).upsertChunkLexicalFtsRows = vi.fn(() => {
			throw new Error("fts write failed")
		})

		await expect(
			store.upsertChunks([
				{
					revisionId: revision.revisionId,
					chunkFingerprint: "chunk-fp",
					startLine: 1,
					endLine: 2,
					content: "const value = 1",
					contentHash: "chunk-content-hash",
					state: "parsed",
				},
			]),
		).rejects.toThrow("fts write failed")
		expect(await store.getChunksForRevision(revision.revisionId)).toEqual([])
		;(store as any).upsertChunkLexicalFtsRows = originalFtsUpsert
		await store.dispose()
	})

	it("commits chunk variant staging batches atomically", async () => {
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
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "content-hash",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		const [chunk] = await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "chunk-fp",
				startLine: 1,
				endLine: 2,
				content: "const value = 1",
				contentHash: "chunk-content-hash",
				state: "parsed",
			},
		])

		const db = (store as any).db()
		const originalPrepare = db.prepare.bind(db)
		db.prepare = vi.fn((sql: string) => {
			const statement = originalPrepare(sql)
			if (!sql.includes("INSERT INTO chunk_variants")) {
				return statement
			}

			return {
				...statement,
				run: (...params: unknown[]) => {
					if (params[2] === "symbol_signature") {
						throw new Error("variant staging failed")
					}
					return statement.run(...(params as []))
				},
			}
		})

		await expect(
			store.upsertChunkVariants([
				{
					chunkId: chunk.chunkId,
					variantType: "raw_code",
					content: "const value = 1",
					contentHash: "raw-hash",
					state: "parsed",
				},
				{
					chunkId: chunk.chunkId,
					variantType: "symbol_signature",
					content: "ts | function | example",
					contentHash: "sig-hash",
					state: "parsed",
				},
			]),
		).rejects.toThrow("variant staging failed")
		expect(await store.getChunkVariantsByChunkIds([chunk.chunkId])).toEqual([])

		db.prepare = originalPrepare
		await store.dispose()
	})

	it("reports run backlog metrics from staged revisions, chunks, and queued jobs", async () => {
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
			ignoreState: "included",
		})
		const parsedRevision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "parsed-content-hash",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		const plannedRevision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "planned-content-hash",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "planned",
		})
		const [stagedChunk, plannedChunk] = await store.upsertChunks([
			{
				revisionId: parsedRevision.revisionId,
				chunkFingerprint: "parsed-fp",
				startLine: 1,
				endLine: 2,
				content: "const staged = true",
				contentHash: "parsed-chunk-hash",
				state: "parsed",
			},
			{
				revisionId: plannedRevision.revisionId,
				chunkFingerprint: "planned-fp",
				startLine: 3,
				endLine: 4,
				content: "const planned = true",
				contentHash: "planned-chunk-hash",
				state: "upserted",
			},
		])
		await store.enqueueJobs([
			{
				workspaceId,
				runId,
				jobType: "upsert",
				entityId: stagedChunk.chunkId,
				state: "queued",
			},
			{
				workspaceId,
				runId,
				jobType: "upsert",
				entityId: plannedChunk.chunkId,
				state: "running",
			},
			{
				workspaceId,
				runId,
				jobType: "delete",
				entityId: stagedChunk.chunkId,
				state: "queued",
			},
			{
				workspaceId,
				runId,
				jobType: "delete",
				entityId: plannedChunk.chunkId,
				state: "running",
			},
		])

		await expect(store.getRunBacklogMetrics(runId)).resolves.toEqual({
			parsedRevisions: 1,
			plannedRevisions: 1,
			stagedChunks: 1,
			stagedChunkBytes: "const staged = true".length,
			queuedUpsertJobs: 1,
			runningUpsertJobs: 1,
			queuedDeleteJobs: 1,
			runningDeleteJobs: 1,
			terminalFailedRevisions: 0,
			degradedRevisions: 0,
			terminalFailedChunks: 0,
			retryingJobs: 0,
			blockingReason: "parsed_revisions_waiting_for_planning",
		})

		await store.dispose()
	})

	it("reclaims expired running jobs with a fresh lease owner", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")
		await store.enqueueJobs([
			{
				workspaceId,
				runId,
				jobType: "upsert",
				entityId: "chunk-1",
				state: "running",
			},
		])

		const claimedJobs = await store.claimJobsWithLease("upsert", 10, runId, {
			leaseOwner: "worker-a",
			leaseMs: 1_234,
		})

		expect(claimedJobs).toHaveLength(1)
		expect(claimedJobs[0]?.state).toBe("running")
		expect(claimedJobs[0]?.leaseOwner).toBe("worker-a")
		expect(claimedJobs[0]?.leaseExpiresAt).toBeGreaterThan(Date.now())

		await store.dispose()
	})

	it("reads back persisted run progress snapshots", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const runId = await store.beginRun("initial-discovery")
		await store.heartbeatRun(runId, "engine:test", {
			filesDiscovered: 100,
			filesHashed: 90,
			filesParsed: 50,
			filesPlanned: 45,
			filesCommitted: 40,
			stagedChunks: 25,
			stagedChunkBytes: 25_000,
			queuedUpsertJobs: 20,
			runningUpsertJobs: 5,
			queuedDeleteJobs: 0,
			runningDeleteJobs: 0,
			retryingParseRevisions: 1,
			terminalFailedParseRevisions: 2,
			retryingChunks: 3,
			terminalFailedChunks: 4,
			degradedRevisions: 5,
			terminalFailedRevisions: 6,
			parseThrottleMs: 700,
			blockingReason: "queued_upsert_jobs",
		})

		await expect(store.getRunProgressRecord(runId)).resolves.toEqual(
			expect.objectContaining({
				runId,
				heartbeatOwner: "engine:test",
				blockingReason: "queued_upsert_jobs",
				progress: expect.objectContaining({
					filesParsed: 50,
					queuedUpsertJobs: 20,
					parseThrottleMs: 700,
				}),
			}),
		)

		await expect(store.listRecentRunProgress(5)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					runId,
					progress: expect.objectContaining({
						filesCommitted: 40,
					}),
				}),
			]),
		)

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
			parserVersion: CODE_INDEX_V2_PARSER_VERSION,
			chunkerVersion: CODE_INDEX_V2_CHUNKER_VERSION,
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

		const reusableRevision = await store.findReusableRevision(
			file.fileId,
			"reuse-content-hash",
			"99:55",
			CODE_INDEX_V2_PARSER_VERSION,
			CODE_INDEX_V2_CHUNKER_VERSION,
		)
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

		const exactFallbackSpy = vi.spyOn(store as any, "fetchExactLexicalCandidates")
		const results = await store.searchActiveChunksLexically("schema.ts CREATE TABLE chunk_variants", 5)

		expect(exactFallbackSpy).toHaveBeenCalled()
		expect(results[0]?.relativePath).toBe("src/services/code-index-v2/store/schema.ts")
		expect(results[0]?.lexicalScore).toBeGreaterThan(0)

		await store.dispose()
	})

	it("backfills lexical FTS rows for existing chunks during initialization", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-fts-backfill") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-fts-backfill")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")
		const file = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/engine.ts",
			normalizedPath: path.join(workspacePath, "src/engine.ts"),
			lastSeenMtimeMs: 123,
			lastSeenSize: 456,
			ignoreState: "included",
		})
		const revision = await store.createFileRevision({
			fileId: file.fileId,
			runId,
			contentHash: "engine-content-hash",
			fastFingerprint: "456:123",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: revision.revisionId,
				chunkFingerprint: "engine-fp",
				startLine: 1,
				endLine: 8,
				language: "ts",
				chunkKind: "method",
				symbolName: "expandSearchResultsWithParents",
				symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
				summary: "Expand code search results with parent and sibling context",
				searchText: "add parent context add sibling context expand code search results",
				content: "private async expandSearchResultsWithParents() {}",
				contentHash: "engine-chunk-content-hash",
				state: "upserted",
			},
		])
		await store.markRevisionCommitted(revision.revisionId)
		await store.dispose()

		const reopenedStore = new MetadataStore(context, workspacePath)
		await reopenedStore.initialize()

		const exactFallbackSpy = vi.spyOn(reopenedStore as any, "fetchExactLexicalCandidates")
		const results = await reopenedStore.searchActiveChunksLexically(
			"How does Roo add parent and sibling context to code search results",
			5,
		)

		expect(exactFallbackSpy).not.toHaveBeenCalled()
		expect(results[0]?.relativePath).toBe("src/engine.ts")
		expect(results[0]?.symbolQualifiedName).toBe("CodeIndexEngineV2.expandSearchResultsWithParents")

		await reopenedStore.dispose()
	})

	it("lexically prefers parent and sibling expansion engine chunks over parser-like distractors", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-parent-sibling-lexical") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-parent-sibling-lexical")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const workspaceId = store.getWorkspaceId()
		const runId = await store.beginRun("initial-discovery")
		const engineFile = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/services/code-index-v2/engine/CodeIndexEngineV2.ts",
			normalizedPath: path.join(workspacePath, "src/services/code-index-v2/engine/CodeIndexEngineV2.ts"),
			lastSeenMtimeMs: 1,
			lastSeenSize: 1,
			ignoreState: "included",
		})
		const parserFile = await store.upsertFileRecord({
			workspaceId,
			relativePath: "src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts",
			normalizedPath: path.join(workspacePath, "src/services/code-index-v2/adapters/CodeIndexParserAdapter.ts"),
			lastSeenMtimeMs: 1,
			lastSeenSize: 1,
			ignoreState: "included",
		})
		const engineRevision = await store.createFileRevision({
			fileId: engineFile.fileId,
			runId,
			contentHash: "engine-parent-sibling",
			fastFingerprint: "1:1",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		const parserRevision = await store.createFileRevision({
			fileId: parserFile.fileId,
			runId,
			contentHash: "parser-parent-sibling",
			fastFingerprint: "1:1",
			parserVersion: "parser-v1",
			chunkerVersion: "chunker-v1",
			state: "parsed",
		})
		await store.upsertChunks([
			{
				revisionId: engineRevision.revisionId,
				chunkFingerprint: "engine-parent-sibling-fp",
				startLine: 1,
				endLine: 8,
				language: "ts",
				chunkKind: "method",
				symbolName: "expandSearchResultsWithParents",
				symbolQualifiedName: "CodeIndexEngineV2.expandSearchResultsWithParents",
				summary: "Expand code search results with parent and sibling context",
				searchText: "expandSearchResultsWithParents add parent context add sibling context code search results",
				content: "private async expandSearchResultsWithParents() {}",
				contentHash: "engine-parent-sibling-content",
				state: "upserted",
			},
			{
				revisionId: parserRevision.revisionId,
				chunkFingerprint: "parser-parent-sibling-fp",
				startLine: 1,
				endLine: 8,
				language: "ts",
				chunkKind: "method",
				symbolName: "buildSearchText",
				symbolQualifiedName: "CodeIndexParserAdapter.buildSearchText",
				summary: "Build search text for code index chunks",
				searchText: "build search text parent sibling context code search results",
				content: "private buildSearchText() {}",
				contentHash: "parser-parent-sibling-content",
				state: "upserted",
			},
		])
		await store.markRevisionCommitted(engineRevision.revisionId)
		await store.markRevisionCommitted(parserRevision.revisionId)

		const results = await store.searchActiveChunksLexically(
			"How does Roo add parent and sibling context to code search results",
			5,
		)

		expect(results[0]?.symbolQualifiedName).toBe("CodeIndexEngineV2.expandSearchResultsWithParents")

		await store.dispose()
	})

	it("supports FTS-only lexical search when exact fallback is disabled", async () => {
		const context = {
			globalStorageUri: { fsPath: path.join(tempRoot, "global-storage-lexical-budget") },
		} as any
		const workspacePath = path.join(tempRoot, "workspace-lexical-budget")
		const store = new MetadataStore(context, workspacePath)
		await store.initialize()

		const fetchExactLexicalCandidatesSpy = vi.spyOn(store as any, "fetchExactLexicalCandidates")

		const result = await store.searchActiveChunksLexicallyWithStatus("schema.ts CREATE TABLE chunk_variants", 5, {
			allowExactFallback: false,
		})

		expect(result.status).toBe("completed")
		expect(result.mode).toBe("fts_only")
		expect(fetchExactLexicalCandidatesSpy).not.toHaveBeenCalled()
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
			parserVersion: CODE_INDEX_V2_PARSER_VERSION,
			chunkerVersion: CODE_INDEX_V2_CHUNKER_VERSION,
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

		const reusableRevision = await store.findReusableRevision(
			file.fileId,
			"stopped-content-hash",
			"20:10",
			CODE_INDEX_V2_PARSER_VERSION,
			CODE_INDEX_V2_CHUNKER_VERSION,
		)
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
			parserVersion: CODE_INDEX_V2_PARSER_VERSION,
			chunkerVersion: CODE_INDEX_V2_CHUNKER_VERSION,
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

		const reusableRevision = await store.findReusableRevision(
			oldFile.fileId,
			"old-content-hash",
			"144:88",
			CODE_INDEX_V2_PARSER_VERSION,
			CODE_INDEX_V2_CHUNKER_VERSION,
		)
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
