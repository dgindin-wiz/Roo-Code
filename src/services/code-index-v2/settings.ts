import * as vscode from "vscode"
import { Package } from "../../shared/package"
import { BATCH_SEGMENT_THRESHOLD } from "../code-index/constants"
import { CODE_INDEX_LEGACY_ENGINE_ID, CODE_INDEX_V2_ENGINE_ID, type CodeIndexEngineKind } from "./shared/constants"

function getCodeIndexConfiguration() {
	return vscode.workspace.getConfiguration(Package.name)
}

function hasExplicitSetting(key: string): boolean {
	try {
		const inspected = getCodeIndexConfiguration().inspect(key)
		return Boolean(
			inspected?.workspaceFolderValue ??
				inspected?.workspaceValue ??
				inspected?.globalValue ??
				inspected?.defaultLanguageValue ??
				inspected?.globalLanguageValue ??
				inspected?.workspaceLanguageValue ??
				inspected?.workspaceFolderLanguageValue,
		)
	} catch {
		return false
	}
}

export function getConfiguredCodeIndexEngine(): CodeIndexEngineKind {
	try {
		const configured = getCodeIndexConfiguration().get<CodeIndexEngineKind>(
			"codeIndex.engine",
			CODE_INDEX_LEGACY_ENGINE_ID,
		)

		return configured === CODE_INDEX_V2_ENGINE_ID ? CODE_INDEX_V2_ENGINE_ID : CODE_INDEX_LEGACY_ENGINE_ID
	} catch {
		return CODE_INDEX_LEGACY_ENGINE_ID
	}
}

export function getConfiguredEmbeddingBatchSize(): number {
	try {
		return getCodeIndexConfiguration().get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
	} catch {
		return BATCH_SEGMENT_THRESHOLD
	}
}

export function hasExplicitConfiguredEmbeddingBatchSize(): boolean {
	return hasExplicitSetting("codeIndex.embeddingBatchSize")
}

export function getConfiguredEmbeddingLaneConcurrency(): number {
	try {
		const configured = getCodeIndexConfiguration().get<number>("codeIndex.embeddingLaneConcurrency", 2)
		return Math.max(1, Math.min(3, Math.trunc(configured || 2)))
	} catch {
		return 2
	}
}

export function hasExplicitConfiguredEmbeddingLaneConcurrency(): boolean {
	return hasExplicitSetting("codeIndex.embeddingLaneConcurrency")
}
