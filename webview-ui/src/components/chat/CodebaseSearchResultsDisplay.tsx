import React, { useState } from "react"
import CodebaseSearchResult from "./CodebaseSearchResult"
import { Trans } from "react-i18next"

type SearchResultItem = {
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
}

interface CodebaseSearchResultsDisplayProps {
	results: SearchResultItem[]
}

function getContextRole(result: SearchResultItem): "primary" | "parent" | "sibling" {
	if (result.matchReasons?.includes("expanded parent context")) {
		return "parent"
	}
	if (result.matchReasons?.includes("expanded sibling context")) {
		return "sibling"
	}
	return "primary"
}

function groupResults(results: SearchResultItem[]) {
	const groups: Array<{ primary: SearchResultItem; context: SearchResultItem[] }> = []

	for (const result of results) {
		const role = getContextRole(result)
		if (role !== "primary" && groups.length > 0) {
			groups[groups.length - 1].context.push(result)
			continue
		}

		groups.push({
			primary: result,
			context: [],
		})
	}

	return groups
}

const CodebaseSearchResultsDisplay: React.FC<CodebaseSearchResultsDisplayProps> = ({ results }) => {
	const [codebaseSearchResultsExpanded, setCodebaseSearchResultsExpanded] = useState(false)
	const groupedResults = groupResults(results)

	return (
		<div className="flex flex-col -mt-4 gap-1">
			<div
				onClick={() => setCodebaseSearchResultsExpanded(!codebaseSearchResultsExpanded)}
				className="cursor-pointer flex items-center justify-between px-2 py-2 border bg-[var(--vscode-editor-background)] border-[var(--vscode-editorGroup-border)]">
				<span>
					<Trans
						i18nKey="chat:codebaseSearch.didSearch"
						count={results.length}
						values={{ count: results.length }}
					/>
				</span>
				<span className={`codicon codicon-chevron-${codebaseSearchResultsExpanded ? "up" : "down"}`}></span>
			</div>

			{codebaseSearchResultsExpanded && (
				<div className="flex flex-col gap-1">
					{groupedResults.map((group, idx) => (
						<div
							key={`${group.primary.filePath}:${group.primary.startLine}:${idx}`}
							className="flex flex-col gap-1">
							<CodebaseSearchResult
								filePath={group.primary.filePath}
								score={group.primary.score}
								rerankScore={group.primary.rerankScore}
								startLine={group.primary.startLine}
								endLine={group.primary.endLine}
								language={group.primary.language ?? "plaintext"}
								chunkKind={group.primary.chunkKind}
								symbolName={group.primary.symbolName}
								symbolQualifiedName={group.primary.symbolQualifiedName}
								parentSymbolName={group.primary.parentSymbolName}
								summary={group.primary.summary}
								matchLabel={group.primary.matchLabel}
								matchReasons={group.primary.matchReasons}
								snippet={group.primary.codeChunk}
								contextRole="primary"
							/>
							{group.context.length > 0 && (
								<div className="ml-4 flex flex-col gap-1 border-l border-[var(--vscode-textLink-foreground)]/20 pl-2">
									{group.context.map((result, contextIdx) => (
										<CodebaseSearchResult
											key={`${result.filePath}:${result.startLine}:${contextIdx}`}
											filePath={result.filePath}
											score={result.score}
											rerankScore={result.rerankScore}
											startLine={result.startLine}
											endLine={result.endLine}
											language={result.language ?? "plaintext"}
											chunkKind={result.chunkKind}
											symbolName={result.symbolName}
											symbolQualifiedName={result.symbolQualifiedName}
											parentSymbolName={result.parentSymbolName}
											summary={result.summary}
											matchLabel={result.matchLabel}
											matchReasons={result.matchReasons}
											snippet={result.codeChunk}
											contextRole={getContextRole(result)}
										/>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

export default CodebaseSearchResultsDisplay
