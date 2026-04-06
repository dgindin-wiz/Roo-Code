import * as vscode from "vscode"
import path from "path"

import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { VectorStoreSearchResult } from "../../services/code-index/interfaces"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchParams {
	query: string
	path?: string
}

function summarizeMatchReasons(matchReasons?: string[]): string | undefined {
	if (!matchReasons || matchReasons.length === 0) {
		return undefined
	}

	if (matchReasons.includes("exact hinted symbol match") || matchReasons.includes("exact qualified symbol match")) {
		return "Exact symbol hit"
	}
	if (matchReasons.includes("exact hinted path match")) {
		return "Exact file-path hit"
	}
	if (matchReasons.includes("hinted symbol match") || matchReasons.includes("symbol name match")) {
		return "Symbol match"
	}
	if (matchReasons.includes("hinted path match") || matchReasons.includes("path match")) {
		return "Path match"
	}
	if (matchReasons.includes("expanded parent context")) {
		return "Parent context"
	}
	if (matchReasons.includes("expanded sibling context")) {
		return "Sibling context"
	}
	if (matchReasons.includes("lexical match")) {
		return "Keyword match"
	}
	if (matchReasons.includes("chunk kind match")) {
		return "Kind-aware match"
	}
	return "Related match"
}

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, path: directoryPrefix } = params

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("codebase_search", new Error("Could not determine workspace path."))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("codebase_search", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = CodeIndexManager.getInstance(context)

			if (!manager) {
				throw new Error("CodeIndexManager is not available.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Code Indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error("Code Indexing is not configured (Missing OpenAI Key or Qdrant URL).")
			}

			const searchResults: VectorStoreSearchResult[] = await manager.searchIndex(query, directoryPrefix)

			if (!searchResults || searchResults.length === 0) {
				pushToolResult(`No relevant code snippets found for the query: "${query}"`)
				return
			}

			const jsonResult = {
				query,
				results: [],
			} as {
				query: string
				results: Array<{
					filePath: string
					score: number
					rerankScore?: number
					startLine: number
					endLine: number
					language?: string
					chunkKind?: string
					symbolName?: string
					symbolQualifiedName?: string
					parentSymbolName?: string
					summary?: string
					matchLabel?: string
					matchReasons?: string[]
					codeChunk: string
				}>
			}

			searchResults.forEach((result) => {
				if (!result.payload) return
				if (!("filePath" in result.payload)) return

				const relativePath = vscode.workspace.asRelativePath(result.payload.filePath, false)

				jsonResult.results.push({
					filePath: relativePath,
					score: result.score,
					rerankScore: result.rerankScore,
					startLine: result.payload.startLine,
					endLine: result.payload.endLine,
					language: typeof result.payload.language === "string" ? result.payload.language : undefined,
					chunkKind: typeof result.payload.chunkKind === "string" ? result.payload.chunkKind : undefined,
					symbolName: typeof result.payload.symbolName === "string" ? result.payload.symbolName : undefined,
					symbolQualifiedName:
						typeof result.payload.symbolQualifiedName === "string"
							? result.payload.symbolQualifiedName
							: undefined,
					parentSymbolName:
						typeof result.payload.parentSymbolName === "string"
							? result.payload.parentSymbolName
							: undefined,
					summary: typeof result.payload.summary === "string" ? result.payload.summary : undefined,
					matchLabel: summarizeMatchReasons(result.matchReasons),
					matchReasons: Array.isArray(result.matchReasons) ? result.matchReasons : undefined,
					codeChunk: result.payload.codeChunk.trim(),
				})
			})

			const payload = { tool: "codebaseSearch", content: jsonResult }
			await task.say("codebase_search_result", JSON.stringify(payload))

			const output = `Query: ${query}
Results:

${jsonResult.results
	.map(
		(result) => `${result.symbolQualifiedName ? `Symbol: ${result.symbolQualifiedName}\n` : ""}${
			result.chunkKind ? `Kind: ${result.chunkKind}\n` : ""
		}${result.matchLabel ? `Match: ${result.matchLabel}\n` : ""}${
			result.matchReasons?.length ? `Match Reasons: ${result.matchReasons.join(", ")}\n` : ""
		}File path: ${result.filePath}
Score: ${result.score}
${result.rerankScore !== undefined ? `Rerank Score: ${result.rerankScore}\n` : ""}Lines: ${result.startLine}-${result.endLine}
Code Chunk: ${result.codeChunk}
`,
	)
	.join("\n")}`

			pushToolResult(output)
		} catch (error: any) {
			await handleError("codebase_search", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"codebase_search">): Promise<void> {
		const query: string | undefined = block.params.query
		const directoryPrefix: string | undefined = block.params.path

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const codebaseSearchTool = new CodebaseSearchTool()
