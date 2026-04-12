import * as vscode from "vscode"
import type { CodebaseIndexConfig } from "@roo-code/types"
import { arePathsEqual } from "../../utils/path"

const WORKSPACE_CODE_INDEX_CONFIG_KEY_PREFIX = "codebaseIndexConfig:"

export function getCodeIndexWorkspaceFolderUri(workspacePath?: string): vscode.Uri | undefined {
	if (!workspacePath) {
		return undefined
	}

	const normalizedWorkspacePath = workspacePath.trim()
	if (!normalizedWorkspacePath) {
		return undefined
	}

	const exactFolder = vscode.workspace.workspaceFolders?.find((folder) =>
		arePathsEqual(folder.uri.fsPath, normalizedWorkspacePath),
	)
	if (exactFolder) {
		return exactFolder.uri
	}

	try {
		return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(normalizedWorkspacePath))?.uri
	} catch {
		return undefined
	}
}

export function getWorkspaceCodeIndexConfigKey(workspacePath: string, folderUri?: vscode.Uri): string {
	const resolvedFolderUri =
		folderUri ?? getCodeIndexWorkspaceFolderUri(workspacePath) ?? vscode.Uri.file(workspacePath)
	return `${WORKSPACE_CODE_INDEX_CONFIG_KEY_PREFIX}${resolvedFolderUri.toString(true)}`
}

export function getWorkspaceCodeIndexConfig(
	context: vscode.ExtensionContext,
	workspacePath: string,
	legacyConfig?: CodebaseIndexConfig,
	folderUri?: vscode.Uri,
): CodebaseIndexConfig | undefined {
	return context.workspaceState.get<CodebaseIndexConfig | undefined>(
		getWorkspaceCodeIndexConfigKey(workspacePath, folderUri),
		legacyConfig,
	)
}

export async function ensureWorkspaceCodeIndexConfig(
	context: vscode.ExtensionContext,
	workspacePath: string,
	legacyConfig?: CodebaseIndexConfig,
	folderUri?: vscode.Uri,
): Promise<CodebaseIndexConfig | undefined> {
	const key = getWorkspaceCodeIndexConfigKey(workspacePath, folderUri)
	const existing = context.workspaceState.get<CodebaseIndexConfig | undefined>(key, undefined)
	if (existing !== undefined || !legacyConfig) {
		return existing
	}

	await context.workspaceState.update(key, legacyConfig)
	return legacyConfig
}

export async function setWorkspaceCodeIndexConfig(
	context: vscode.ExtensionContext,
	workspacePath: string,
	config: CodebaseIndexConfig,
	folderUri?: vscode.Uri,
): Promise<void> {
	await context.workspaceState.update(getWorkspaceCodeIndexConfigKey(workspacePath, folderUri), config)
}
