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

type GitIgnoreMatcher = {
	baseDir: string
	ignore: Ignore
}

type DirectoryTraversalEntry = {
	dirPath: string
	gitIgnoreMatchers: GitIgnoreMatcher[]
}

export class VsCodeWorkspaceAdapter implements WorkspaceAdapter {
	private static readonly DEFAULT_IGNORED_GENERATED_DIRECTORY_SEGMENTS = new Set([
		"dist",
		"out",
		"bin",
		".turbo",
		"build",
		"coverage",
	])
	private static readonly OVERRIDABLE_SHARED_IGNORED_DIRECTORY_SEGMENTS = new Set(["dist", "out"])
	private static readonly NON_OVERRIDABLE_SHARED_IGNORED_DIRECTORY_SEGMENTS = new Set([
		"node_modules",
		"__pycache__",
		"env",
		"venv",
		"bundle",
		"vendor",
		"tmp",
		"temp",
		"deps",
		"pkg",
		"Pods",
		".git",
	])

	private readonly ignoreController: RooIgnoreController
	private rootGitIgnoreMatcher?: GitIgnoreMatcher

	constructor(
		private readonly workspacePath: string,
		private readonly options: {
			respectGitIgnore?: boolean
			includeDefaultIgnoredGeneratedPaths?: boolean
		} = {},
	) {
		this.ignoreController = new RooIgnoreController(workspacePath)
	}

	async initialize(): Promise<void> {
		await this.ignoreController.initialize()

		if (this.options.respectGitIgnore === false) {
			return
		}

		const rootGitIgnoreMatcher = await this.loadGitIgnoreMatcher(this.workspacePath)
		if (rootGitIgnoreMatcher) {
			this.rootGitIgnoreMatcher = rootGitIgnoreMatcher
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
		const rootMatchers = this.rootGitIgnoreMatcher ? [this.rootGitIgnoreMatcher] : []
		const directoryStack: DirectoryTraversalEntry[] = [
			{ dirPath: this.workspacePath, gitIgnoreMatchers: rootMatchers },
		]
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

			const { dirPath: currentDir, gitIgnoreMatchers } = directoryStack.pop()!
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
						if (this.shouldDescendIntoDirectory(relativePath, normalizedPath, gitIgnoreMatchers)) {
							const childGitIgnoreMatchers = await this.extendGitIgnoreMatchers(
								normalizedPath,
								gitIgnoreMatchers,
							)
							directoryStack.push({ dirPath: normalizedPath, gitIgnoreMatchers: childGitIgnoreMatchers })
						}
						continue
					}

					if (!entry.isFile()) {
						continue
					}

					if (!this.isCandidateFilePath(relativePath, normalizedPath, gitIgnoreMatchers)) {
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
		const gitIgnoreMatchers = this.rootGitIgnoreMatcher ? [this.rootGitIgnoreMatcher] : []
		return this.isCandidateFilePath(relativePath, normalizedPath, gitIgnoreMatchers)
	}

	private getConfiguredMaxFiles(): number {
		try {
			return vscode.workspace.getConfiguration(Package.name).get<number>("codeIndex.maxFiles", 100_000)
		} catch {
			return 100_000
		}
	}

	private shouldDescendIntoDirectory(
		relativePath: string,
		absolutePath: string,
		gitIgnoreMatchers: GitIgnoreMatcher[],
	): boolean {
		if (!this.ignoreController.validateAccess(absolutePath)) {
			return false
		}

		if (this.isDefaultIgnoredGeneratedPath(relativePath)) {
			return false
		}

		if (this.isIgnoredBySharedDirectoryRules(relativePath)) {
			return false
		}

		if (this.isIgnoredByGitIgnore(absolutePath, gitIgnoreMatchers)) {
			return false
		}

		return true
	}

	private isCandidateFilePath(
		relativePath: string,
		absolutePath: string,
		gitIgnoreMatchers: GitIgnoreMatcher[],
	): boolean {
		const extension = path.extname(absolutePath).toLowerCase()

		if (!scannerExtensions.includes(extension)) {
			return false
		}

		if (shouldSkipLowValueFile(relativePath)) {
			return false
		}

		if (this.isDefaultIgnoredGeneratedPath(relativePath)) {
			return false
		}

		if (this.isIgnoredBySharedDirectoryRules(relativePath)) {
			return false
		}

		if (!this.ignoreController.validateAccess(absolutePath)) {
			return false
		}

		if (this.isIgnoredByGitIgnore(absolutePath, gitIgnoreMatchers)) {
			return false
		}

		return true
	}

	private async extendGitIgnoreMatchers(
		directoryPath: string,
		parentMatchers: GitIgnoreMatcher[],
	): Promise<GitIgnoreMatcher[]> {
		if (this.options.respectGitIgnore === false) {
			return parentMatchers
		}

		const matcher = await this.loadGitIgnoreMatcher(directoryPath)
		if (!matcher) {
			return parentMatchers
		}

		return [...parentMatchers, matcher]
	}

	private async loadGitIgnoreMatcher(directoryPath: string): Promise<GitIgnoreMatcher | undefined> {
		try {
			const gitignorePath = path.join(directoryPath, ".gitignore")
			const content = await fs.readFile(gitignorePath, "utf8")
			const matcher = ignore()
			matcher.add(content)
			matcher.add(".gitignore")
			return {
				baseDir: path.normalize(directoryPath),
				ignore: matcher,
			}
		} catch {
			return undefined
		}
	}

	private isIgnoredByGitIgnore(absolutePath: string, matchers: GitIgnoreMatcher[]): boolean {
		if (this.options.respectGitIgnore === false || matchers.length === 0) {
			return false
		}

		let ignored = false
		for (const matcher of matchers) {
			const relativeToMatcher = path.relative(matcher.baseDir, absolutePath)
			if (!relativeToMatcher || relativeToMatcher.startsWith("..")) {
				continue
			}

			const testResult = matcher.ignore.test(this.normalizeForIgnore(relativeToMatcher))
			if (testResult.ignored) {
				ignored = true
			}
			if (testResult.unignored) {
				ignored = false
			}
		}

		return ignored
	}

	private isDefaultIgnoredGeneratedPath(relativePath: string): boolean {
		if (this.options.includeDefaultIgnoredGeneratedPaths) {
			return false
		}

		const segments = this.normalizeForIgnore(relativePath)
			.split("/")
			.filter((segment) => segment.length > 0)

		return segments.some((segment) =>
			VsCodeWorkspaceAdapter.DEFAULT_IGNORED_GENERATED_DIRECTORY_SEGMENTS.has(segment),
		)
	}

	private isIgnoredBySharedDirectoryRules(relativePath: string): boolean {
		if (!isPathInIgnoredDirectory(relativePath)) {
			return false
		}

		if (!this.options.includeDefaultIgnoredGeneratedPaths) {
			return true
		}

		const segments = this.normalizeForIgnore(relativePath)
			.split("/")
			.filter((segment) => segment.length > 0)

		const hasNonOverridableIgnoredSegment = segments.some(
			(segment) =>
				segment.startsWith(".") ||
				VsCodeWorkspaceAdapter.NON_OVERRIDABLE_SHARED_IGNORED_DIRECTORY_SEGMENTS.has(segment),
		)
		if (hasNonOverridableIgnoredSegment) {
			return true
		}

		return !segments.some((segment) =>
			VsCodeWorkspaceAdapter.OVERRIDABLE_SHARED_IGNORED_DIRECTORY_SEGMENTS.has(segment),
		)
	}

	private normalizeForIgnore(relativePath: string): string {
		return relativePath.replace(/\\/g, "/")
	}
}
