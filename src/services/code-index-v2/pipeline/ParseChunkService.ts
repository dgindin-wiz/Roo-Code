import { createHash } from "crypto"
import { ParserAdapter } from "../adapters/ParserAdapter"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"

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

	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
		private readonly parserAdapter: ParserAdapter,
	) {}

	async run(
		runId: string,
		signal?: AbortSignal,
		onProgress?: (progress: { parsedRevisions: number; parsedChunks: number }) => void,
		options?: { limit?: number },
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

		for (const revision of revisions) {
			if (revision.runId !== runId) {
				continue
			}

			if (signal?.aborted) {
				throw new Error("Parse/chunk stage aborted")
			}

			const result = await this.parseRevisionWithRetries(revision, signal)
			retryingRevisions += result.retriesScheduled
			if (result.status === "terminal_failed") {
				terminalFailedRevisions++
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
	): Promise<
		| {
				status: "parsed"
				parsedChunks: number
				retriesScheduled: number
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
				const content = await this.workspaceAdapter.readFile(revision.normalizedPath)
				const chunks = await this.parserAdapter.parseFile({
					filePath: revision.normalizedPath,
					content,
				})

				await this.metadataStore.upsertChunks(
					chunks.map((chunk) => ({
						revisionId: revision.revisionId,
						chunkFingerprint: chunk.chunkFingerprint,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						content: chunk.content,
						contentHash: createHash("sha256").update(chunk.content).digest("hex"),
						state: "parsed",
					})),
				)
				await this.metadataStore.markRevisionState(revision.revisionId, "parsed")

				return {
					status: "parsed",
					parsedChunks: chunks.length,
					retriesScheduled,
				}
			} catch (error) {
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
