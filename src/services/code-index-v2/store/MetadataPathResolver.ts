import { createHash } from "crypto"
import * as path from "path"
import type * as vscode from "vscode"
import {
	CODE_INDEX_V2_DB_BASENAME,
	CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME,
	CODE_INDEX_V2_PERSISTENT_DIR_BASENAME,
	CODE_INDEX_V2_TELEMETRY_DB_BASENAME,
} from "../shared/constants"

export interface ResolvedMetadataStorePaths {
	workspaceHash: string
	workspacePath: string
	rootDir: string
	persistentRootDir: string
	diagnosticsRootDir: string
	legacyDiagnosticsRootDir: string
	dbPath: string
	telemetryDbPath: string
	bootstrapPath: string
}

export function resolveMetadataStorePaths(
	context: vscode.ExtensionContext,
	workspacePath: string,
): ResolvedMetadataStorePaths {
	const workspaceHash = createHash("sha256").update(workspacePath).digest("hex")
	const codeIndexRootDir = path.join(context.globalStorageUri.fsPath, "code-index-v2")
	const rootDir = path.join(codeIndexRootDir, workspaceHash)
	const persistentRootDir = path.join(codeIndexRootDir, CODE_INDEX_V2_PERSISTENT_DIR_BASENAME, workspaceHash)
	const diagnosticsRootDir = path.join(persistentRootDir, CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME)

	return {
		workspaceHash,
		workspacePath,
		rootDir,
		persistentRootDir,
		diagnosticsRootDir,
		legacyDiagnosticsRootDir: rootDir,
		dbPath: path.join(persistentRootDir, CODE_INDEX_V2_DB_BASENAME),
		telemetryDbPath: path.join(persistentRootDir, CODE_INDEX_V2_TELEMETRY_DB_BASENAME),
		bootstrapPath: path.join(rootDir, "bootstrap.json"),
	}
}
