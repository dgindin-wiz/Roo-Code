import { createHash, randomUUID } from "crypto"
import { ParserAdapter } from "../adapters/ParserAdapter"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { buildChunkVariants, ParsedChunkUpsertInput } from "./ParseExecution"

interface ParseExecutor {
	parseRevision(input: {
		runId: string
		revisionId: string
		normalizedPath: string
		relativePath: string
		maxFileSizeBytes?: number
		laneId?: number
		signal?: AbortSignal
	}): Promise<{ chunks: ParsedChunkUpsertInput[]; parseLatencyMs: number }>
	dispose?(): Promise<void>
}

export interface ParseChunkSummary {
	runId: string
	attemptedRevisions: number
	parsedRevisions: number
	parsedChunks: number
	parsedRevisionIds: string[]
	retryingRevisions: number
	terminalFailedRevisions: number
}

export class ParseChunkService {
	private static readonly MAX_PARSE_ATTEMPTS = 3
	private static readonly RETRY_DELAY_BASE_MS = 250
	private static readonly RETRY_DELAY_MAX_MS = 2_000
	private static readonly PARSE_CONCURRENCY = 4

	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
		private readonly parserAdapter: ParserAdapter,
		private readonly resolveMaxFileSizeBytes?: (relativePath: string) => number,
		private readonly parseExecutor?: ParseExecutor,
	) {}

	async dispose(): Promise<void> {
		await this.parseExecutor?.dispose?.()
	}

	async run(
		runId: string,
		signal?: AbortSignal,
		onProgress?: (progress: { parsedRevisions: number; parsedChunks: number }) => void,
		options?: { limit?: number; concurrency?: number },
	): Promise<ParseChunkSummary> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const revisions = await this.metadataStore.getRevisionsByState(workspaceId, "hashed", {
			runId,
			limit: options?.limit,
		})

		let parsedRevisions = 0
		let parsedChunks = 0
		let retryingRevisions = 0
		let terminalFailedRevisions = 0
		const parsedRevisionIds: string[] = []

		let nextRevisionIndex = 0
		const configuredConcurrency = Math.max(
			1,
			Math.trunc(options?.concurrency ?? ParseChunkService.PARSE_CONCURRENCY),
		)
		const workerCount = Math.min(configuredConcurrency, revisions.length || 1)
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (nextRevisionIndex < revisions.length) {
					const revision = revisions[nextRevisionIndex++]
					if (!revision) {
						return
					}

					if (signal?.aborted) {
						throw new Error("Parse/chunk stage aborted")
					}

					const result = await this.parseRevisionWithRetries(revision, signal, nextRevisionIndex)
					retryingRevisions += result.retriesScheduled
					if (result.status === "terminal_failed") {
						terminalFailedRevisions++
						continue
					}
					if (result.status === "missing") {
						continue
					}

					parsedRevisions++
					parsedChunks += result.parsedChunks
					parsedRevisionIds.push(revision.revisionId)

					onProgress?.({ parsedRevisions, parsedChunks })

					if (parsedRevisions === 1 || parsedRevisions % 100 === 0) {
						IndexDebugLoggerV2.log("basic", "ParseChunkService", "parse-chunk-progress", {
							component: "ParseChunkService",
							workspacePath: this.workspaceAdapter.getWorkspacePath(),
							runId,
							jobId: `${parsedRevisions}:${parsedChunks}:${terminalFailedRevisions}`,
						})
					}
				}
			}),
		)

		IndexDebugLoggerV2.log("basic", "ParseChunkService", "parse-chunk-complete", {
			component: "ParseChunkService",
			workspacePath: this.workspaceAdapter.getWorkspacePath(),
			runId,
			jobId: `${parsedRevisions}:${parsedChunks}`,
		})

		return {
			runId,
			attemptedRevisions: revisions.length,
			parsedRevisions,
			parsedChunks,
			parsedRevisionIds,
			retryingRevisions,
			terminalFailedRevisions,
		}
	}

	private async parseRevisionWithRetries(
		revision: Awaited<ReturnType<MetadataStore["getRevisionsByState"]>>[number],
		signal?: AbortSignal,
		laneId = 1,
	): Promise<
		| {
				status: "parsed"
				parsedChunks: number
				retriesScheduled: number
		  }
		| {
				status: "missing"
				parsedChunks: 0
				retriesScheduled: 0
		  }
		| {
				status: "terminal_failed"
				parsedChunks: 0
				retriesScheduled: number
		  }
	> {
		let retriesScheduled = 0
		let lastError: unknown

		for (let attempt = 1; attempt <= ParseChunkService.MAX_PARSE_ATTEMPTS; attempt++) {
			if (signal?.aborted) {
				throw new Error("Parse/chunk stage aborted")
			}

			try {
				const maxFileSizeBytes = this.resolveMaxFileSizeBytes?.(revision.relativePath)
				const chunks = this.parseExecutor
					? (
							await this.parseExecutor.parseRevision({
								runId: revision.runId,
								revisionId: revision.revisionId,
								normalizedPath: revision.normalizedPath,
								relativePath: revision.relativePath,
								maxFileSizeBytes,
								laneId,
								signal,
							})
						).chunks
					: await (async () => {
							const content = await this.workspaceAdapter.readFile(revision.normalizedPath)
							return this.parserAdapter.parseFile({
								filePath: revision.normalizedPath,
								relativePath: revision.relativePath,
								content,
								maxFileSizeBytes,
							})
						})()

				const preparedChunks = chunks.map((chunk) => {
					const chunkId = randomUUID()
					const contentHash = createHash("sha256").update(chunk.content).digest("hex")
					const chunkRecord = {
						chunkId,
						chunkFingerprint: chunk.chunkFingerprint,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						language: chunk.language ?? null,
						chunkKind: chunk.chunkKind ?? null,
						symbolName: chunk.symbolName ?? null,
						symbolQualifiedName: chunk.symbolQualifiedName ?? null,
						parentSymbolName: chunk.parentSymbolName ?? null,
						parentChunkFingerprint: chunk.parentChunkFingerprint ?? null,
						summary: chunk.summary ?? null,
						searchText: chunk.searchText ?? chunk.content,
						content: chunk.content,
						contentHash,
						state: "parsed" as const,
					}
					const variants = buildChunkVariants(chunkRecord, revision.relativePath).map(
						({ chunkId: _chunkId, ...variant }) => variant,
					)

					return {
						...chunkRecord,
						variants,
					}
				})
				const persistence = await this.metadataStore.persistParsedRevision({
					revisionId: revision.revisionId,
					relativePath: revision.relativePath,
					chunks: preparedChunks,
				})

				IndexDebugLoggerV2.log("basic", "ParseChunkService", "parse-chunk-revision-stored", {
					component: "ParseChunkService",
					workspacePath: this.workspaceAdapter.getWorkspacePath(),
					runId: revision.runId,
					revisionId: revision.revisionId,
					relativePath: revision.relativePath,
					insertedChunkCount: persistence.insertedChunks.length,
					insertedVariantCount: persistence.insertedVariantCount,
					chunkInsertLatencyMs: persistence.chunkInsertLatencyMs,
					chunkVariantInsertLatencyMs: persistence.chunkVariantInsertLatencyMs,
					revisionStateUpdateLatencyMs: persistence.revisionStateUpdateLatencyMs,
					transactionLatencyMs: persistence.transactionLatencyMs,
					metadataWriteLatencyMs: persistence.metadataWriteLatencyMs,
				})

				return {
					status: "parsed",
					parsedChunks: persistence.insertedChunks.length,
					retriesScheduled,
				}
			} catch (error) {
				if (this.isMissingFileError(error)) {
					await this.metadataStore.markRevisionState(revision.revisionId, "superseded")
					IndexDebugLoggerV2.log("basic", "ParseChunkService", "parse-chunk-missing-file", {
						component: "ParseChunkService",
						workspacePath: this.workspaceAdapter.getWorkspacePath(),
						runId: revision.runId,
						jobId: revision.normalizedPath,
					})
					return {
						status: "missing",
						parsedChunks: 0,
						retriesScheduled: 0,
					}
				}
				lastError = error
				if (attempt >= ParseChunkService.MAX_PARSE_ATTEMPTS) {
					await this.metadataStore.markRevisionTerminalFailure(
						revision.revisionId,
						error instanceof Error ? error.message : String(error),
					)
					return {
						status: "terminal_failed",
						parsedChunks: 0,
						retriesScheduled,
					}
				}

				retriesScheduled++
				await this.waitForRetry(attempt, signal)
			}
		}

		await this.metadataStore.markRevisionTerminalFailure(
			revision.revisionId,
			lastError instanceof Error ? lastError.message : String(lastError),
		)
		return {
			status: "terminal_failed",
			parsedChunks: 0,
			retriesScheduled,
		}
	}

	private isMissingFileError(error: unknown): boolean {
		const errorCode =
			typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined
		const message = error instanceof Error ? error.message : String(error)
		return errorCode === "ENOENT" || /no such file or directory/i.test(message)
	}

	private async waitForRetry(attempt: number, signal?: AbortSignal): Promise<void> {
		const delayMs = Math.min(
			ParseChunkService.RETRY_DELAY_MAX_MS,
			ParseChunkService.RETRY_DELAY_BASE_MS * 2 ** Math.max(0, attempt - 1),
		)

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, delayMs)

			const onAbort = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				reject(new Error("Parse/chunk stage aborted"))
			}

			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}
}
