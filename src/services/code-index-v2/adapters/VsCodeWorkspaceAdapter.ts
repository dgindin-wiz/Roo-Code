import type { Dir } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import ignore, { Ignore } from "ignore"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { Package } from "../../../shared/package"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { scannerExtensions } from "../../code-index/shared/supported-extensions"
import { generateRelativeFilePath } from "../../code-index/shared/get-relative-path"
import { shouldSkipLowValueFile } from "../../code-index/shared/low-value-files"
import {
	WorkspaceAdapter,
	WorkspaceCandidateFilesResult,
	WorkspaceDiscoveryProgress,
	WorkspaceFileStat,
} from "./WorkspaceAdapter"

export class VsCodeWorkspaceAdapter implements WorkspaceAdapter {
	private readonly ignoreController: RooIgnoreController
	private readonly ignoreInstance: Ignore

	constructor(
		private readonly workspacePath: string,
		private readonly options: { respectGitIgnore?: boolean } = {},
	) {
		this.ignoreController = new RooIgnoreController(workspacePath)
		this.ignoreInstance = ignore()
	}

	async initialize(): Promise<void> {
		await this.ignoreController.initialize()

		if (this.options.respectGitIgnore === false) {
			return
		}

		try {
			const gitignorePath = path.join(this.workspacePath, ".gitignore")
			const content = await fs.readFile(gitignorePath, "utf8")
			this.ignoreInstance.add(content)
			this.ignoreInstance.add(".gitignore")
		} catch {
			// No .gitignore is fine.
		}
	}

	getWorkspacePath(): string {
		return this.workspacePath
	}

	async enumerateCandidateFiles(
		onFile: (filePath: string) => Promise<void> | void,
		signal?: AbortSignal,
		onProgress?: (progress: WorkspaceDiscoveryProgress) => void,
	): Promise<WorkspaceCandidateFilesResult> {
		const maxFiles = this.getConfiguredMaxFiles()
		let discoveredFiles = 0
		let isPartial = false
		let processedDirectories = 0
		const directoryStack: string[] = [this.workspacePath]
		const emitProgress = () =>
			onProgress?.({
				discoveredFiles,
				processedDirectories,
				pendingDirectories: directoryStack.length,
			})

		while (directoryStack.length > 0) {
			if (signal?.aborted) {
				isPartial = true
				break
			}

			const currentDir = directoryStack.pop()!
			let dir: Dir | undefined

			try {
				dir = await fs.opendir(currentDir)

				for await (const entry of dir) {
					if (signal?.aborted) {
						isPartial = true
						break
					}

					const fullPath = path.join(currentDir, entry.name)
					const normalizedPath = path.normalize(fullPath)
					const relativePath = generateRelativeFilePath(normalizedPath, this.workspacePath)

					if (entry.isSymbolicLink()) {
						continue
					}

					if (entry.isDirectory()) {
						if (this.shouldDescendIntoDirectory(relativePath, normalizedPath)) {
							directoryStack.push(normalizedPath)
						}
						continue
					}

					if (!entry.isFile()) {
						continue
					}

					if (!this.isCandidateFilePath(relativePath, normalizedPath)) {
						continue
					}

					await onFile(normalizedPath)
					discoveredFiles++
					if (discoveredFiles === 1 || discoveredFiles % 500 === 0) {
						emitProgress()
					}

					if (discoveredFiles >= maxFiles) {
						isPartial = true
						break
					}
				}
			} catch {
				// Skip unreadable directories or transient fs errors.
			} finally {
				await dir?.close().catch(() => undefined)
			}

			processedDirectories++
			emitProgress()

			if (isPartial) {
				break
			}
		}

		return {
			discoveredFiles,
			isPartial,
		}
	}

	async statFile(filePath: string): Promise<WorkspaceFileStat> {
		const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
		return {
			path: filePath,
			mtimeMs: stat.mtime,
			size: stat.size,
		}
	}

	async readFile(filePath: string): Promise<string> {
		const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
		return Buffer.from(content).toString("utf-8")
	}

	isCandidateFile(filePath: string): boolean {
		const normalizedPath = path.normalize(filePath)
		const relativePath = generateRelativeFilePath(normalizedPath, this.workspacePath)
		return this.isCandidateFilePath(relativePath, normalizedPath)
	}

	private getConfiguredMaxFiles(): number {
		try {
			return vscode.workspace.getConfiguration(Package.name).get<number>("codeIndex.maxFiles", 100_000)
		} catch {
			return 100_000
		}
	}

	private shouldDescendIntoDirectory(relativePath: string, absolutePath: string): boolean {
		const ignorePath = this.normalizeForIgnore(relativePath)

		if (!this.ignoreController.validateAccess(absolutePath)) {
			return false
		}

		if (isPathInIgnoredDirectory(relativePath)) {
			return false
		}

		if (this.ignoreInstance.ignores(ignorePath)) {
			return false
		}

		return true
	}

	private isCandidateFilePath(relativePath: string, absolutePath: string): boolean {
		const ignorePath = this.normalizeForIgnore(relativePath)
		const extension = path.extname(absolutePath).toLowerCase()

		if (!scannerExtensions.includes(extension)) {
			return false
		}

		if (shouldSkipLowValueFile(relativePath)) {
			return false
		}

		if (isPathInIgnoredDirectory(relativePath)) {
			return false
		}

		if (!this.ignoreController.validateAccess(absolutePath)) {
			return false
		}

		if (this.ignoreInstance.ignores(ignorePath)) {
			return false
		}

		return true
	}

	private normalizeForIgnore(relativePath: string): string {
		return relativePath.replace(/\\/g, "/")
	}
}
