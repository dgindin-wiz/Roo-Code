export interface WorkspaceFileStat {
	path: string
	mtimeMs: number
	size: number
}

export interface WorkspaceCandidateFilesResult {
	discoveredFiles: number
	isPartial: boolean
}

export interface WorkspaceDiscoveryProgress {
	discoveredFiles: number
	processedDirectories: number
	pendingDirectories: number
}

export interface WorkspaceAdapter {
	getWorkspacePath(): string
	enumerateCandidateFiles(
		onFile: (filePath: string) => Promise<void> | void,
		signal?: AbortSignal,
		onProgress?: (progress: WorkspaceDiscoveryProgress) => void,
	): Promise<WorkspaceCandidateFilesResult>
	isCandidateFile(filePath: string): boolean
	statFile(path: string): Promise<WorkspaceFileStat>
	readFile(path: string): Promise<string>
}
