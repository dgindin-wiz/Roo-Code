import { generateRelativeFilePath } from "../../code-index/shared/get-relative-path"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { MetadataStore } from "../store/MetadataStore"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"
import { DiscoverySummary } from "../discovery/DiscoveryService"

export interface ReconciliationSummary extends DiscoverySummary {
	missingFiles: string[]
}

export class ReconciliationService {
	constructor(
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
	) {}

	async findMissingFiles(summary: DiscoverySummary): Promise<ReconciliationSummary> {
		if (summary.isPartial) {
			IndexDebugLoggerV2.log("basic", "ReconciliationService", "reconciliation-skipped-partial-discovery", {
				component: "ReconciliationService",
				runId: summary.runId,
			})
			return {
				...summary,
				missingFiles: [],
			}
		}

		const trackedFiles = await this.metadataStore.getTrackedFilesForWorkspace(this.metadataStore.getWorkspaceId())
		const discovered = new Set<string>()
		await this.workspaceAdapter.enumerateCandidateFiles((filePath) => {
			discovered.add(generateRelativeFilePath(filePath, this.workspaceAdapter.getWorkspacePath()))
		})

		const missingFiles = trackedFiles
			.filter((file) => {
				if (file.tombstoned) {
					return false
				}

				// Retire tracked files that are now excluded by current ignore rules,
				// even if they were indexed before those rules were enforced correctly.
				if (!this.workspaceAdapter.isCandidateFile(file.normalizedPath)) {
					return true
				}

				return !discovered.has(file.relativePath)
			})
			.map((file) => file.relativePath)

		IndexDebugLoggerV2.log("basic", "ReconciliationService", "reconciliation-diff-complete", {
			component: "ReconciliationService",
			runId: summary.runId,
			jobId: `${missingFiles.length}`,
		})

		return {
			...summary,
			missingFiles,
		}
	}
}
