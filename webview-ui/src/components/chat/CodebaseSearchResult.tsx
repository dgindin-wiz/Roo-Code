import React from "react"
import { useTranslation } from "react-i18next"
import { vscode } from "@src/utils/vscode"
import { StandardTooltip } from "@/components/ui"

interface CodebaseSearchResultProps {
	filePath: string
	score: number
	rerankScore?: number
	startLine: number
	endLine: number
	snippet: string
	language: string
	chunkKind?: string
	symbolName?: string
	symbolQualifiedName?: string
	parentSymbolName?: string
	summary?: string
	matchLabel?: string
	matchReasons?: string[]
	contextRole?: "primary" | "parent" | "sibling"
}

const CodebaseSearchResult: React.FC<CodebaseSearchResultProps> = ({
	filePath,
	score,
	rerankScore,
	startLine,
	endLine,
	chunkKind,
	symbolName,
	symbolQualifiedName,
	parentSymbolName,
	summary,
	matchLabel,
	matchReasons,
	contextRole = "primary",
}) => {
	const { t } = useTranslation("chat")

	const handleClick = () => {
		console.log(filePath)
		vscode.postMessage({
			type: "openFile",
			text: "./" + filePath,
			values: {
				line: startLine,
			},
		})
	}

	return (
		<StandardTooltip
			content={[
				t("codebaseSearch.resultTooltip", { score: score.toFixed(3) }),
				rerankScore !== undefined ? `Rerank: ${rerankScore.toFixed(3)}` : null,
				matchReasons?.length ? `Matches: ${matchReasons.join(", ")}` : null,
			]
				.filter(Boolean)
				.join("\n")}>
			<div
				onClick={handleClick}
				className={`p-2 border cursor-pointer hover:bg-secondary hover:text-white ${
					contextRole === "primary"
						? "border-[var(--vscode-editorGroup-border)]"
						: "border-[var(--vscode-textLink-foreground)]/25 bg-[var(--vscode-textBlockQuote-background)]/40"
				}`}>
				<div className="flex gap-2 items-center overflow-hidden">
					<span className="text-primary-300 whitespace-nowrap flex-shrink-0">
						{filePath.split("/").at(-1)}:{startLine === endLine ? startLine : `${startLine}-${endLine}`}
					</span>
					<span className="text-gray-500 truncate min-w-0 flex-1">
						{filePath.split("/").slice(0, -1).join("/")}
					</span>
					<span className="text-xs text-vscode-descriptionForeground whitespace-nowrap ml-auto opacity-60">
						{score.toFixed(3)}
					</span>
				</div>
				{contextRole !== "primary" && (
					<div className="mt-1 text-[11px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)] opacity-80">
						{contextRole === "parent" ? "Parent Context" : "Sibling Context"}
					</div>
				)}
				{matchLabel && (
					<div className="mt-1 text-[11px] uppercase tracking-wide text-[var(--vscode-textLink-foreground)]">
						{matchLabel}
					</div>
				)}
				{(symbolQualifiedName || chunkKind || summary) && (
					<div className="mt-1 flex flex-col gap-0.5 overflow-hidden">
						{(symbolQualifiedName || symbolName) && (
							<div className="text-xs truncate">
								<span className="text-[var(--vscode-descriptionForeground)]">
									{symbolQualifiedName ?? symbolName}
								</span>
								{chunkKind ? (
									<span className="opacity-60">
										{" "}
										{"·"} {chunkKind}
									</span>
								) : null}
							</div>
						)}
						{!symbolQualifiedName && parentSymbolName && (
							<div className="text-xs truncate text-[var(--vscode-descriptionForeground)]">
								Parent: {parentSymbolName}
							</div>
						)}
						{summary && (
							<div className="text-xs truncate text-[var(--vscode-descriptionForeground)] opacity-80">
								{summary}
							</div>
						)}
					</div>
				)}
			</div>
		</StandardTooltip>
	)
}

export default CodebaseSearchResult
