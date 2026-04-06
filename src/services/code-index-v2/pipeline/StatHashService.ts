import { createHash } from "crypto"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"

export interface OversizedFileDetail {
	relativePath: string
	sizeBytes: number
	recommendation: "likely_useful" | "review_manually" | "probably_skip"
	reason: string
	needsReapproval?: boolean
	approvedMaxBytes?: number
}

export interface StatHashSummary {
	runId: string
	checkedFiles: number
	skippedFiles: number
	changedFiles: number
	unchangedFiles: number
	oversizedFiles: number
	oversizedDetails: OversizedFileDetail[]
	missingFiles: number
	reusedParsedRevisionIds: string[]
}

export function describeOversizedFile(
	relativePath: string,
	sizeBytes: number,
	approvedMaxBytes?: number,
): OversizedFileDetail {
	const normalizedPath = relativePath.toLowerCase()
	const basename = normalizedPath.split("/").pop() ?? normalizedPath
	const isLikelyNoise =
		/min\.js$|bundle\.js$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.snap$|__snapshots__\//.test(
			normalizedPath,
		) || /vendor|dist|build|coverage|generated/.test(normalizedPath)
	const isLikelyUseful =
		/\.(sql|yaml|yml|toml|json|tf|proto)$/.test(normalizedPath) ||
		/(schema|policy|config|routes|resource|openapi|swagger)/.test(basename)
	const recommendation = isLikelyNoise ? "probably_skip" : isLikelyUseful ? "likely_useful" : "review_manually"
	const reason = isLikelyNoise
		? "Looks like generated, bundled, or repetitive output."
		: isLikelyUseful
			? "Looks like schema, config, policy, or structured source data."
			: "Large source file; review whether it contains important hand-written logic."

	return {
		relativePath,
		sizeBytes,
		recommendation,
		reason:
			approvedMaxBytes && sizeBytes > approvedMaxBytes
				? `${reason} It has grown beyond its approved size limit.`
				: reason,
		needsReapproval: approvedMaxBytes ? sizeBytes > approvedMaxBytes : false,
		approvedMaxBytes,
	}
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
			maxFileSizeBytes?: number
			resolveApprovedMaxBytes?: (relativePath: string) => number | undefined
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
		const defaultMaxFileSizeBytes = options?.maxFileSizeBytes ?? 1024 * 1024
		const files = relativePaths?.length
			? await this.metadataStore.getDiscoveredFilesByRelativePaths(workspaceId, relativePaths)
			: await this.metadataStore.getDiscoveredFilesForWorkspace(workspaceId)

		let checkedFiles = 0
		let skippedFiles = 0
		let changedFiles = 0
		let unchangedFiles = 0
		let oversizedFiles = 0
		const oversizedDetails: OversizedFileDetail[] = []
		let missingFiles = 0
		const reusedParsedRevisionIds: string[] = []

		for (const file of files) {
			if (signal?.aborted) {
				throw new Error("Stat/hash stage aborted")
			}

			const fastFingerprint = `${file.lastSeenSize ?? 0}:${file.lastSeenMtimeMs ?? 0}`
			checkedFiles++

			const approvedMaxBytes = options?.resolveApprovedMaxBytes?.(file.relativePath)
			const effectiveMaxFileSizeBytes = Math.max(defaultMaxFileSizeBytes, approvedMaxBytes ?? 0)
			if ((file.lastSeenSize ?? 0) > effectiveMaxFileSizeBytes) {
				skippedFiles++
				oversizedFiles++
				this.insertOversizedDetail(
					oversizedDetails,
					this.buildOversizedDetail(file.relativePath, file.lastSeenSize ?? 0, approvedMaxBytes),
				)
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
			oversizedDetails,
			missingFiles,
			reusedParsedRevisionIds,
		}
	}

	private insertOversizedDetail(details: OversizedFileDetail[], detail: OversizedFileDetail): void {
		details.push(detail)
		details.sort((a, b) => this.compareOversizedDetails(a, b))
		if (details.length > 20) {
			details.length = 20
		}
	}

	private compareOversizedDetails(a: OversizedFileDetail, b: OversizedFileDetail): number {
		const scoreDelta = this.getOversizedPriorityScore(b) - this.getOversizedPriorityScore(a)
		if (scoreDelta !== 0) {
			return scoreDelta
		}

		if (a.sizeBytes !== b.sizeBytes) {
			return a.sizeBytes - b.sizeBytes
		}

		return a.relativePath.localeCompare(b.relativePath)
	}

	private getOversizedPriorityScore(detail: OversizedFileDetail): number {
		const normalizedPath = detail.relativePath.toLowerCase()
		const basename = normalizedPath.split("/").pop() ?? normalizedPath
		let score = 0

		if (detail.needsReapproval) {
			score += 100
		}

		if (detail.recommendation === "likely_useful") {
			score += 60
		} else if (detail.recommendation === "review_manually") {
			score += 25
		}

		if (/\.(sql|yaml|yml|toml|json|tf|proto)$/.test(normalizedPath)) {
			score += 10
		}

		if (/(schema|policy|config|routes|resource|openapi|swagger)/.test(basename)) {
			score += 20
		}

		if (/^src\//.test(normalizedPath)) {
			score += 8
		}

		if (
			/min\.js$|bundle\.js$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.snap$|__snapshots__\//.test(
				normalizedPath,
			) ||
			/vendor|dist|build|coverage|generated/.test(normalizedPath)
		) {
			score -= 40
		}

		return score
	}

	private buildOversizedDetail(
		relativePath: string,
		sizeBytes: number,
		approvedMaxBytes?: number,
	): OversizedFileDetail {
		return describeOversizedFile(relativePath, sizeBytes, approvedMaxBytes)
	}

	private isMissingFileError(error: unknown): boolean {
		const errorCode =
			typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined
		const message = error instanceof Error ? error.message : String(error)
		return errorCode === "ENOENT" || /no such file or directory/i.test(message)
	}
}
