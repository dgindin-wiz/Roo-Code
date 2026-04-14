import { createHash } from "crypto"
import pLimit from "p-limit"
import { generateRelativeFilePath } from "../../code-index/shared/get-relative-path"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter, WorkspaceDiscoveryProgress } from "../adapters/WorkspaceAdapter"
import { FileRecordInput } from "../store/types"

export interface DiscoverySummary {
	runId: string
	discoveredFiles: number
	isPartial: boolean
}

export class DiscoveryService {
	private static readonly DISCOVERY_STAT_CONCURRENCY = 16
	private static readonly DISCOVERY_WRITE_BATCH_SIZE = 256

	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
	) {}

	async runInitialDiscovery(signal?: AbortSignal): Promise<DiscoverySummary> {
		return this.runWorkspaceDiscovery("initial-discovery", signal)
	}

	async runReconciliationDiscovery(signal?: AbortSignal): Promise<DiscoverySummary> {
		return this.runWorkspaceDiscovery("reconcile", signal)
	}

	async runTargetedDiscovery(
		paths: string[],
		triggerType: "watcher" | "manual",
		signal?: AbortSignal,
	): Promise<DiscoverySummary> {
		const runId = await this.metadataStore.beginRun(triggerType)

		try {
			const workspace = await this.metadataStore.ensureWorkspaceRecord()
			let discoveredFiles = 0
			const includedPaths = paths.filter((filePath) => this.workspaceAdapter.isCandidateFile(filePath))
			discoveredFiles = includedPaths.length
			await this.processDiscoveredPaths(workspace.workspaceId, includedPaths, signal)

			await this.metadataStore.markRunDiscoveryComplete(runId)

			IndexDebugLoggerV2.log("basic", "DiscoveryService", "targeted-discovery-complete", {
				component: "DiscoveryService",
				workspacePath: this.workspaceAdapter.getWorkspacePath(),
				runId,
				jobId: createHash("sha1")
					.update(`${runId}:${discoveredFiles}:${triggerType}`)
					.digest("hex")
					.slice(0, 12),
			})

			return {
				runId,
				discoveredFiles,
				isPartial: false,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (signal?.aborted && /aborted/i.test(message)) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, message)
			}
			throw error
		}
	}

	private async runWorkspaceDiscovery(triggerType: string, signal?: AbortSignal): Promise<DiscoverySummary> {
		return this.runWorkspaceDiscoveryWithProgress(triggerType, signal)
	}

	async runWorkspaceDiscoveryWithProgress(
		triggerType: string,
		signal?: AbortSignal,
		onProgress?: (progress: WorkspaceDiscoveryProgress) => void,
	): Promise<DiscoverySummary> {
		const runId = await this.metadataStore.beginRun(triggerType)

		try {
			const workspace = await this.metadataStore.ensureWorkspaceRecord()
			let progressDiscoveredFiles = 0
			const candidatePaths: string[] = []
			const { discoveredFiles, isPartial } = await this.workspaceAdapter.enumerateCandidateFiles(
				async (filePath) => {
					if (signal?.aborted) {
						throw new Error("Discovery aborted")
					}

					candidatePaths.push(filePath)
					progressDiscoveredFiles++
				},
				signal,
				(progress) => {
					onProgress?.({
						...progress,
						discoveredFiles: Math.max(progress.discoveredFiles, progressDiscoveredFiles),
					})
				},
			)
			await this.processDiscoveredPaths(workspace.workspaceId, candidatePaths, signal)

			await this.metadataStore.markRunDiscoveryComplete(runId)

			IndexDebugLoggerV2.log("basic", "DiscoveryService", `${triggerType}-discovery-complete`, {
				component: "DiscoveryService",
				workspacePath: this.workspaceAdapter.getWorkspacePath(),
				runId,
				jobId: createHash("sha1").update(`${runId}:${discoveredFiles}`).digest("hex").slice(0, 12),
			})

			return {
				runId,
				discoveredFiles,
				isPartial,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (signal?.aborted && /aborted/i.test(message)) {
				await this.metadataStore.markRunStopped(runId, "Stopped by user.")
			} else {
				await this.metadataStore.markRunFailed(runId, message)
			}
			throw error
		}
	}

	private async processDiscoveredPaths(
		workspaceId: string,
		filePaths: string[],
		signal?: AbortSignal,
	): Promise<void> {
		if (filePaths.length === 0) {
			return
		}

		const statLimiter = pLimit(DiscoveryService.DISCOVERY_STAT_CONCURRENCY)
		const writeLimiter = pLimit(1)
		const pendingBatch: FileRecordInput[] = []
		const flushBatch = async (force = false) => {
			await writeLimiter(async () => {
				while (
					pendingBatch.length >= DiscoveryService.DISCOVERY_WRITE_BATCH_SIZE ||
					(force && pendingBatch.length > 0)
				) {
					const batchSize = force ? pendingBatch.length : DiscoveryService.DISCOVERY_WRITE_BATCH_SIZE
					const batch = pendingBatch.splice(0, batchSize)
					await this.metadataStore.upsertFileRecords(batch)
				}
			})
		}

		await Promise.all(
			filePaths.map((filePath) =>
				statLimiter(async () => {
					if (signal?.aborted) {
						throw new Error("Discovery aborted")
					}

					const stat = await this.workspaceAdapter.statFile(filePath)
					const relativePath = generateRelativeFilePath(filePath, this.workspaceAdapter.getWorkspacePath())
					await writeLimiter(async () => {
						pendingBatch.push({
							workspaceId,
							relativePath,
							normalizedPath: filePath,
							lastSeenMtimeMs: stat.mtimeMs,
							lastSeenSize: stat.size,
							ignoreState: "included",
							tombstoned: false,
						})
						if (pendingBatch.length >= DiscoveryService.DISCOVERY_WRITE_BATCH_SIZE) {
							const batch = pendingBatch.splice(0, DiscoveryService.DISCOVERY_WRITE_BATCH_SIZE)
							await this.metadataStore.upsertFileRecords(batch)
						}
					})
				}),
			),
		)

		await flushBatch(true)
	}
}
