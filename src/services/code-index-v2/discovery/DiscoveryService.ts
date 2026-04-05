import { createHash } from "crypto"
import { generateRelativeFilePath } from "../../code-index/shared/get-relative-path"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter, WorkspaceDiscoveryProgress } from "../adapters/WorkspaceAdapter"

export interface DiscoverySummary {
	runId: string
	discoveredFiles: number
	isPartial: boolean
}

export class DiscoveryService {
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

			for (const filePath of paths) {
				if (signal?.aborted) {
					throw new Error("Targeted discovery aborted")
				}

				if (!this.workspaceAdapter.isCandidateFile(filePath)) {
					continue
				}

				const stat = await this.workspaceAdapter.statFile(filePath)
				const relativePath = generateRelativeFilePath(filePath, this.workspaceAdapter.getWorkspacePath())

				await this.metadataStore.upsertFileRecord({
					workspaceId: workspace.workspaceId,
					relativePath,
					normalizedPath: filePath,
					lastSeenMtimeMs: stat.mtimeMs,
					lastSeenSize: stat.size,
					ignoreState: "included",
					tombstoned: false,
				})
				discoveredFiles++
			}

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
			const { discoveredFiles, isPartial } = await this.workspaceAdapter.enumerateCandidateFiles(
				async (filePath) => {
					if (signal?.aborted) {
						throw new Error("Discovery aborted")
					}

					const stat = await this.workspaceAdapter.statFile(filePath)
					const relativePath = generateRelativeFilePath(filePath, this.workspaceAdapter.getWorkspacePath())

					await this.metadataStore.upsertFileRecord({
						workspaceId: workspace.workspaceId,
						relativePath,
						normalizedPath: filePath,
						lastSeenMtimeMs: stat.mtimeMs,
						lastSeenSize: stat.size,
						ignoreState: "included",
						tombstoned: false,
					})
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
}
