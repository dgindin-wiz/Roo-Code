import * as vscode from "vscode"
import { Package } from "../../shared/package"
import { CODE_INDEX_LEGACY_ENGINE_ID, CODE_INDEX_V2_ENGINE_ID, type CodeIndexEngineKind } from "./shared/constants"

export function getConfiguredCodeIndexEngine(): CodeIndexEngineKind {
	try {
		const configured = vscode.workspace
			.getConfiguration(Package.name)
			.get<CodeIndexEngineKind>("codeIndex.engine", CODE_INDEX_LEGACY_ENGINE_ID)

		return configured === CODE_INDEX_V2_ENGINE_ID ? CODE_INDEX_V2_ENGINE_ID : CODE_INDEX_LEGACY_ENGINE_ID
	} catch {
		return CODE_INDEX_LEGACY_ENGINE_ID
	}
}
