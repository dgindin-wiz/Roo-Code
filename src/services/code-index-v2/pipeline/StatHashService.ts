import { createHash } from "crypto"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"

export interface StatHashSummary {
	runId: string
	checkedFiles: number
	skippedFiles: number
	changedFiles: number
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
			onProgress?: (progress: { checkedFiles: number; changedFiles: number; skippedFiles: number }) => void
		},
	): Promise<StatHashSummary> {
		const workspaceId = this.metadataStore.getWorkspaceId()
		const files = relativePaths?.length
			? await this.metadataStore.getDiscoveredFilesByRelativePaths(workspaceId, relativePaths)
			: await this.metadataStore.getDiscoveredFilesForWorkspace(workspaceId)

		let checkedFiles = 0
		let skippedFiles = 0
		let changedFiles = 0

		for (const file of files) {
			if (signal?.aborted) {
				throw new Error("Stat/hash stage aborted")
			}

			const fastFingerprint = `${file.lastSeenSize ?? 0}:${file.lastSeenMtimeMs ?? 0}`
			checkedFiles++

			if (
				!options?.forceReindex &&
				file.latestRevisionState === "committed" &&
				file.latestRevisionFastFingerprint === fastFingerprint &&
				file.latestRevisionContentHash
			) {
				skippedFiles++
				if (checkedFiles === 1 || checkedFiles % 500 === 0) {
					options?.onProgress?.({ checkedFiles, changedFiles, skippedFiles })
				}
				continue
			}

			const content = await this.workspaceAdapter.readFile(file.normalizedPath)
			const contentHash = createHash("sha256").update(content).digest("hex")

			if (
				!options?.forceReindex &&
				file.latestRevisionState === "committed" &&
				file.latestRevisionContentHash === contentHash
			) {
				skippedFiles++
				if (checkedFiles === 1 || checkedFiles % 500 === 0) {
					options?.onProgress?.({ checkedFiles, changedFiles, skippedFiles })
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
					changedFiles++
					if (checkedFiles === 1 || checkedFiles % 250 === 0) {
						options?.onProgress?.({ checkedFiles, changedFiles, skippedFiles })
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
				options?.onProgress?.({ checkedFiles, changedFiles, skippedFiles })
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
		}
	}
}
