import * as vscode from "vscode"
import path from "path"

import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { VectorStoreSearchResult } from "../../services/code-index/interfaces"
import type { ToolUse } from "../../shared/tools"
import {
	buildSymbolSignatureFallback,
	extractDeclarationSignature,
} from "../../services/code-index-v2/shared/chunkSurfaces"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchParams {
	query: string
	path?: string
}

type SearchResultContextRole = "primary" | "parent" | "sibling"

const PRIMARY_SNIPPET_MAX_LINES = 80
const PRIMARY_SNIPPET_HEAD_LINES = 30
const PRIMARY_SNIPPET_TAIL_LINES = 10
const SCORE_CLIFF_RATIO = 0.5

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

function getContextRole(matchReasons?: string[]): SearchResultContextRole {
	if (matchReasons?.includes("expanded parent context")) {
		return "parent"
	}
	if (matchReasons?.includes("expanded sibling context")) {
		return "sibling"
	}
	return "primary"
}

function groupSearchResults(results: VectorStoreSearchResult[]) {
	const groups: Array<{ primary: VectorStoreSearchResult; context: VectorStoreSearchResult[] }> = []

	for (const result of results) {
		const role = getContextRole(result.matchReasons)
		if (role !== "primary" && groups.length > 0) {
			groups[groups.length - 1]?.context.push(result)
			continue
		}

		groups.push({
			primary: result,
			context: [],
		})
	}

	return groups
}

function truncateResultGroups(groups: Array<{ primary: VectorStoreSearchResult; context: VectorStoreSearchResult[] }>) {
	if (groups.length <= 1) {
		return groups
	}

	const topScore = getResultScore(groups[0]?.primary)
	if (topScore <= 0) {
		return groups
	}

	let keepCount = groups.length
	for (let index = 1; index < groups.length; index++) {
		if (getResultScore(groups[index]?.primary) < topScore * SCORE_CLIFF_RATIO) {
			keepCount = index
			break
		}
	}

	return groups.slice(0, Math.max(1, keepCount))
}

function getResultScore(result: VectorStoreSearchResult | undefined): number {
	if (!result) {
		return 0
	}

	return result.rerankScore ?? result.score
}

function buildSnippetForResult(result: VectorStoreSearchResult): string {
	const codeChunk = typeof result.payload?.codeChunk === "string" ? result.payload.codeChunk.trim() : ""
	if (!codeChunk) {
		return ""
	}

	const role = getContextRole(result.matchReasons)
	if (role !== "primary") {
		return buildContextSnippet(result, codeChunk)
	}

	const lines = codeChunk.split(/\r?\n/)
	if ((result.payload?.chunkKind === "file" || lines.length > PRIMARY_SNIPPET_MAX_LINES) && lines.length > 40) {
		return buildHeadTailSnippet(lines)
	}

	return codeChunk
}

function buildContextSnippet(result: VectorStoreSearchResult, codeChunk: string): string {
	const lines = codeChunk.split(/\r?\n/)
	const signature =
		extractDeclarationSignature(codeChunk) ??
		buildSymbolSignatureFallback({
			relativePath: typeof result.payload?.filePath === "string" ? result.payload.filePath : "",
			language: typeof result.payload?.language === "string" ? result.payload.language : undefined,
			chunkKind: typeof result.payload?.chunkKind === "string" ? result.payload.chunkKind : undefined,
			symbolName: typeof result.payload?.symbolName === "string" ? result.payload.symbolName : undefined,
			symbolQualifiedName:
				typeof result.payload?.symbolQualifiedName === "string"
					? result.payload.symbolQualifiedName
					: undefined,
			parentSymbolName:
				typeof result.payload?.parentSymbolName === "string" ? result.payload.parentSymbolName : undefined,
			startLine: typeof result.payload?.startLine === "number" ? result.payload.startLine : 0,
			endLine: typeof result.payload?.endLine === "number" ? result.payload.endLine : 0,
		}) ??
		lines[0]?.trim() ??
		codeChunk

	const omittedLines = Math.max(lines.length - 1, 0)
	return omittedLines > 0 ? `${signature}\n${buildOmittedLinesComment(omittedLines)}` : signature
}

function buildHeadTailSnippet(lines: string[]): string {
	const head = lines.slice(0, PRIMARY_SNIPPET_HEAD_LINES)
	const tail = lines.slice(-PRIMARY_SNIPPET_TAIL_LINES)
	const omittedLines = Math.max(lines.length - head.length - tail.length, 0)

	if (omittedLines <= 0) {
		return lines.join("\n").trim()
	}

	return [...head, buildOmittedLinesComment(omittedLines), ...tail].join("\n").trim()
}

function buildOmittedLinesComment(omittedLines: number): string {
	return `// ... ${omittedLines} more line${omittedLines === 1 ? "" : "s"} ...`
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

			const manager = CodeIndexManager.getInstance(context, workspacePath)

			if (!manager) {
				throw new Error("CodeIndexManager is not available.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Code Indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error("Code Indexing is not configured (Missing OpenAI Key or Qdrant URL).")
			}

			const searchResults: VectorStoreSearchResult[] = await manager.searchIndex(query, {
				directoryPrefix,
			})

			if (!searchResults || searchResults.length === 0) {
				pushToolResult(`No relevant code snippets found for the query: "${query}"`)
				return
			}

			const retainedResults = truncateResultGroups(groupSearchResults(searchResults)).flatMap((group) => [
				group.primary,
				...group.context,
			])

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

			retainedResults.forEach((result) => {
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
					codeChunk: buildSnippetForResult(result),
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
