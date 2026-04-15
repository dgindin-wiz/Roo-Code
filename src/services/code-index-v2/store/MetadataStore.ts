import * as vscode from "vscode"
import { resolveMetadataStorePaths, type ResolvedMetadataStorePaths } from "./MetadataPathResolver"
import { SqliteMetadataRepository } from "./SqliteMetadataRepository"

export { SqliteMetadataRepository }
export type { ResolvedMetadataStorePaths }

export class MetadataStore extends SqliteMetadataRepository {
	constructor(context: vscode.ExtensionContext, workspacePath: string) {
		super(resolveMetadataStorePaths(context, workspacePath))
	}
}
