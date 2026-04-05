import * as vscode from "vscode"
import { Package } from "../../shared/package"
import { BATCH_SEGMENT_THRESHOLD } from "../code-index/constants"
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

export function getConfiguredEmbeddingBatchSize(): number {
	try {
		return vscode.workspace
			.getConfiguration(Package.name)
			.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
	} catch {
		return BATCH_SEGMENT_THRESHOLD
	}
}

export function getConfiguredEmbeddingLaneConcurrency(): number {
	try {
		const configured = vscode.workspace
			.getConfiguration(Package.name)
			.get<number>("codeIndex.embeddingLaneConcurrency", 2)
		return Math.max(1, Math.min(3, Math.trunc(configured || 2)))
	} catch {
		return 2
	}
}
