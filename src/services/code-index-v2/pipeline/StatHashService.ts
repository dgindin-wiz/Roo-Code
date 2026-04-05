import { createHash } from "crypto"
import { MAX_FILE_SIZE_BYTES } from "../../code-index/constants"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"

export interface StatHashSummary {
	runId: string
	checkedFiles: number
	skippedFiles: number
	changedFiles: number
	unchangedFiles: number
	oversizedFiles: number
	missingFiles: number
	reusedParsedRevisionIds: string[]
}

export class StatHashService {
	private static readonly PARSER_VERSION = "v2-placeholder"
	private static readonly CHUNKER_VERSION = "v2-placeholder"

	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
	) {}

	async run(
		runId: string,
		signal?: AbortSignal,
		relativePaths?: string[],
		options?: {
			forceReindex?: boolean
			onProgress?: (progress: {
				checkedFiles: number
				changedFiles: number
				skippedFiles: number
				unchangedFiles: number
				oversizedFiles: number
				missingFiles: number
			}) => void
		},
	): Promise<StatHashSummary> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const files = relativePaths?.length
			? await this.metadataStore.getDiscoveredFilesByRelativePaths(workspaceId, relativePaths)
			: await this.metadataStore.getDiscoveredFilesForWorkspace(workspaceId)

		let checkedFiles = 0
		let skippedFiles = 0
		let changedFiles = 0
		let unchangedFiles = 0
		let oversizedFiles = 0
		let missingFiles = 0
		const reusedParsedRevisionIds: string[] = []

		for (const file of files) {
			if (signal?.aborted) {
				throw new Error("Stat/hash stage aborted")
			}

			const fastFingerprint = `${file.lastSeenSize ?? 0}:${file.lastSeenMtimeMs ?? 0}`
			checkedFiles++

			if ((file.lastSeenSize ?? 0) > MAX_FILE_SIZE_BYTES) {
				skippedFiles++
				oversizedFiles++
				IndexDebugLoggerV2.log("basic", "StatHashService", "stat-hash-oversized-file-skipped", {
					component: "StatHashService",
					workspacePath: this.workspaceAdapter.getWorkspacePath(),
					runId,
					jobId: file.relativePath,
				})
				if (checkedFiles === 1 || checkedFiles % 250 === 0) {
					options?.onProgress?.({
						checkedFiles,
						changedFiles,
						skippedFiles,
						unchangedFiles,
						oversizedFiles,
						missingFiles,
					})
				}
				continue
			}

			if (
				!options?.forceReindex &&
				file.latestRevisionState === "committed" &&
				file.latestRevisionFastFingerprint === fastFingerprint &&
				file.latestRevisionContentHash
			) {
				skippedFiles++
				unchangedFiles++
				if (checkedFiles === 1 || checkedFiles % 500 === 0) {
					options?.onProgress?.({
						checkedFiles,
						changedFiles,
						skippedFiles,
						unchangedFiles,
						oversizedFiles,
						missingFiles,
					})
				}
				continue
			}

			let content: string
			try {
				content = await this.workspaceAdapter.readFile(file.normalizedPath)
			} catch (error) {
				if (this.isMissingFileError(error)) {
					skippedFiles++
					missingFiles++
					IndexDebugLoggerV2.log("basic", "StatHashService", "stat-hash-missing-file", {
						component: "StatHashService",
						workspacePath: this.workspaceAdapter.getWorkspacePath(),
						runId,
						jobId: file.relativePath,
					})
					if (checkedFiles === 1 || checkedFiles % 250 === 0) {
						options?.onProgress?.({
							checkedFiles,
							changedFiles,
							skippedFiles,
							unchangedFiles,
							oversizedFiles,
							missingFiles,
						})
					}
					continue
				}
				throw error
			}
			const contentHash = createHash("sha256").update(content).digest("hex")

			if (
				!options?.forceReindex &&
				file.latestRevisionState === "committed" &&
				file.latestRevisionContentHash === contentHash
			) {
				skippedFiles++
				unchangedFiles++
				if (checkedFiles === 1 || checkedFiles % 500 === 0) {
					options?.onProgress?.({
						checkedFiles,
						changedFiles,
						skippedFiles,
						unchangedFiles,
						oversizedFiles,
						missingFiles,
					})
				}
				continue
			}

			if (!options?.forceReindex) {
				const reusableRevision = await this.metadataStore.findReusableRevision(
					file.fileId,
					contentHash,
					fastFingerprint,
				)
				if (reusableRevision) {
					await this.metadataStore.adoptRevisionToRun(reusableRevision.revisionId, runId)
					if (reusableRevision.state === "parsed") {
						reusedParsedRevisionIds.push(reusableRevision.revisionId)
					}
					changedFiles++
					if (checkedFiles === 1 || checkedFiles % 250 === 0) {
						options?.onProgress?.({
							checkedFiles,
							changedFiles,
							skippedFiles,
							unchangedFiles,
							oversizedFiles,
							missingFiles,
						})
					}
					continue
				}
			}

			await this.metadataStore.createFileRevision({
				fileId: file.fileId,
				runId,
				contentHash,
				fastFingerprint,
				parserVersion: StatHashService.PARSER_VERSION,
				chunkerVersion: StatHashService.CHUNKER_VERSION,
				state: "hashed",
			})
			changedFiles++
			if (checkedFiles === 1 || checkedFiles % 250 === 0) {
				options?.onProgress?.({
					checkedFiles,
					changedFiles,
					skippedFiles,
					unchangedFiles,
					oversizedFiles,
					missingFiles,
				})
			}
		}

		IndexDebugLoggerV2.log("basic", "StatHashService", "stat-hash-complete", {
			component: "StatHashService",
			workspacePath: this.workspaceAdapter.getWorkspacePath(),
			runId,
			jobId: `${checkedFiles}:${changedFiles}`,
		})

		return {
			runId,
			checkedFiles,
			skippedFiles,
			changedFiles,
			unchangedFiles,
			oversizedFiles,
			missingFiles,
			reusedParsedRevisionIds,
		}
	}

	private isMissingFileError(error: unknown): boolean {
		const errorCode =
			typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined
		const message = error instanceof Error ? error.message : String(error)
		return errorCode === "ENOENT" || /no such file or directory/i.test(message)
	}
}
