import * as vscode from "vscode"
import { generateRelativeFilePath } from "../../code-index/shared/get-relative-path"
import { scannerExtensions } from "../../code-index/shared/supported-extensions"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { WorkspaceAdapter } from "../adapters/WorkspaceAdapter"
import { MetadataStore } from "../store/MetadataStore"

export class WatcherCoordinator implements vscode.Disposable {
	private watcher: vscode.FileSystemWatcher | undefined
	private debounceTimer: NodeJS.Timeout | undefined
	private readonly pendingEvents = new Map<string, { path: string; eventType: "create" | "change" | "delete" }>()

	constructor(
		private readonly workspacePath: string,
		private readonly metadataStore: MetadataStore,
		private readonly workspaceAdapter: WorkspaceAdapter,
		private readonly onPathsChanged: (paths: string[], reason: "watcher") => Promise<void>,
	) {}

	async initialize(): Promise<void> {
		const pattern = new vscode.RelativePattern(
			this.workspacePath,
			`**/*{${scannerExtensions.map((extension) => extension.slice(1)).join(",")}}`,
		)
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern)
		this.watcher.onDidCreate((uri) => void this.enqueue(uri.fsPath, "create"))
		this.watcher.onDidChange((uri) => void this.enqueue(uri.fsPath, "change"))
		this.watcher.onDidDelete((uri) => void this.enqueue(uri.fsPath, "delete"))
	}

	dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}
		this.pendingEvents.clear()
		this.watcher?.dispose()
	}

	private async enqueue(filePath: string, eventType: "create" | "change" | "delete"): Promise<void> {
		const relativePath = generateRelativeFilePath(filePath, this.workspacePath)
		if (eventType !== "delete" && !this.workspaceAdapter.isCandidateFile(filePath)) {
			IndexDebugLoggerV2.log("basic", "WatcherCoordinator", "watch-event-ignored", {
				component: "WatcherCoordinator",
				workspacePath: this.workspacePath,
				jobId: `${eventType}:${relativePath}`,
			})
			return
		}

		await this.metadataStore.recordWatchEvent(relativePath, eventType)
		this.pendingEvents.set(filePath, { path: filePath, eventType })
		IndexDebugLoggerV2.log("basic", "WatcherCoordinator", "watch-event-recorded", {
			component: "WatcherCoordinator",
			workspacePath: this.workspacePath,
			jobId: `${eventType}:${relativePath}`,
		})

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}

		this.debounceTimer = setTimeout(() => {
			void this.flush()
		}, 500)
	}

	private async flush(): Promise<void> {
		const paths = Array.from(this.pendingEvents.values()).map((event) => event.path)
		this.pendingEvents.clear()

		if (paths.length === 0) {
			return
		}

		IndexDebugLoggerV2.log("basic", "WatcherCoordinator", "watch-batch-flush", {
			component: "WatcherCoordinator",
			workspacePath: this.workspacePath,
			jobId: `${paths.length}`,
		})

		await this.onPathsChanged(paths, "watcher")
	}
}
