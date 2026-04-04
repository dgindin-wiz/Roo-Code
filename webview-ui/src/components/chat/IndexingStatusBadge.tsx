import React, { useState, useEffect, useMemo } from "react"
import { Database } from "lucide-react"

import type { IndexingStatus, IndexingStatusUpdateMessage } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { PopoverTrigger, StandardTooltip, Button } from "@src/components/ui"

import { CodeIndexPopover } from "./CodeIndexPopover"

interface IndexingStatusBadgeProps {
	className?: string
}

/**
 * Formats milliseconds into a human-readable ETA string for display.
 * Mirrors the server-side formatEta() in state-manager.ts.
 */
function formatEtaForDisplay(ms: number): string {
	if (ms < 10_000) return "almost done"
	if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes}m remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours}h remaining`
	return `~${hours}h ${remainingMinutes}m remaining`
}

function formatCountLabel(count: number, singular: string, plural: string): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

export const IndexingStatusBadge: React.FC<IndexingStatusBadgeProps> = ({ className }) => {
	const { t } = useAppTranslation()
	const { cwd } = useExtensionState()

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>({
		systemStatus: "Standby",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "items",
	})

	useEffect(() => {
		// Request initial indexing status.
		vscode.postMessage({ type: "requestIndexingStatus" })

		// Set up message listener for status updates.
		const handleMessage = (event: MessageEvent<IndexingStatusUpdateMessage>) => {
			if (event.data.type === "indexingStatusUpdate") {
				const status = event.data.values
				if (!status.workspacePath || status.workspacePath === cwd) {
					setIndexingStatus(status)
				}
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [cwd])

	const progressPercentage = useMemo(() => {
		// Use block-level progress during embedding (uniform cost per block → accurate ETA)
		if (indexingStatus.phase === "embedding" && indexingStatus.totalBlocks && indexingStatus.totalBlocks > 0) {
			return Math.round(((indexingStatus.blocksEmbedded ?? 0) / indexingStatus.totalBlocks) * 100)
		}
		// Fall back to legacy fields
		return indexingStatus.totalItems > 0
			? Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100)
			: 0
	}, [
		indexingStatus.phase,
		indexingStatus.blocksEmbedded,
		indexingStatus.totalBlocks,
		indexingStatus.processedItems,
		indexingStatus.totalItems,
	])
	const isCurrentStandby = useMemo(
		() =>
			(indexingStatus.systemStatus === "Standby" &&
				/^(?:V2 is current(?: across| after a partial scan of)|V2 mapped )/.test(
					indexingStatus.message ?? "",
				)) ||
			(indexingStatus.systemStatus === "Indexed" &&
				/^Index up-to-date(?:\.| —|$)/.test(indexingStatus.message ?? "")),
		[indexingStatus.message, indexingStatus.systemStatus],
	)

	const tooltipText = useMemo(() => {
		const extraParts: string[] = []
		if ((indexingStatus.resumedPendingJobs ?? 0) > 0) {
			extraParts.push(
				`resuming ${formatCountLabel(indexingStatus.resumedPendingJobs ?? 0, "unfinished job", "unfinished jobs")} from the previous run`,
			)
		}
		if ((indexingStatus.terminalFailedParseRevisions ?? 0) > 0) {
			extraParts.push(
				formatCountLabel(
					indexingStatus.terminalFailedParseRevisions ?? 0,
					"parser-failed file",
					"parser-failed files",
				),
			)
		}
		if ((indexingStatus.degradedRevisions ?? 0) > 0) {
			extraParts.push(formatCountLabel(indexingStatus.degradedRevisions ?? 0, "degraded file", "degraded files"))
		}
		if ((indexingStatus.terminalFailedRevisions ?? 0) > 0) {
			extraParts.push(
				formatCountLabel(indexingStatus.terminalFailedRevisions ?? 0, "failed file", "failed files"),
			)
		}
		const extraText = extraParts.length > 0 ? ` — ${extraParts.join(", ")}` : ""

		switch (indexingStatus.systemStatus) {
			case "Standby":
				return isCurrentStandby
					? `Index ready — watching for changes${extraText}`
					: `${t("chat:indexingStatus.ready")}${extraText}`
			case "Indexing": {
				const etaText =
					indexingStatus.estimatedTimeRemainingMs != null
						? ` — ${formatEtaForDisplay(indexingStatus.estimatedTimeRemainingMs)}`
						: ""
				const confidenceText = indexingStatus.estimationConfidence
					? ` (${indexingStatus.estimationConfidence} confidence)`
					: ""
				const backpressureText = indexingStatus.isBackpressured ? " — waiting on embedding throughput" : ""
				if (indexingStatus.phase === "scanning") {
					const processed = indexingStatus.processedItems ?? indexingStatus.processedFiles ?? 0
					const total = indexingStatus.totalItems ?? indexingStatus.totalFiles ?? processed
					return `Scanning workspace — ${processed.toLocaleString()} of ${total.toLocaleString()} files${etaText}${confidenceText}${extraText}`
				}
				if (indexingStatus.phase === "embedding") {
					const embedded = indexingStatus.blocksEmbedded ?? 0
					const totalBlocks = indexingStatus.totalBlocks ?? embedded
					return `Embedding vectors — ${embedded.toLocaleString()} of ${totalBlocks.toLocaleString()} blocks${etaText}${confidenceText}${backpressureText}${extraText}`
				}
				return `${t("chat:indexingStatus.indexing", { percentage: progressPercentage })}${etaText}${confidenceText}${extraText}`
			}
			case "Indexed":
				return isCurrentStandby
					? `Index ready — watching for changes${extraText}`
					: `${t("chat:indexingStatus.indexed")}${extraText}`
			case "Stopping":
				return t("chat:indexingStatus.stopping")
			case "Error":
				return `${t("chat:indexingStatus.error")}${extraText}`
			default:
				return `${t("chat:indexingStatus.status")}${extraText}`
		}
	}, [
		indexingStatus.degradedRevisions,
		indexingStatus.blocksEmbedded,
		indexingStatus.estimationConfidence,
		indexingStatus.estimatedTimeRemainingMs,
		indexingStatus.isBackpressured,
		indexingStatus.phase,
		indexingStatus.processedFiles,
		indexingStatus.processedItems,
		indexingStatus.resumedPendingJobs,
		indexingStatus.systemStatus,
		indexingStatus.terminalFailedParseRevisions,
		indexingStatus.terminalFailedRevisions,
		indexingStatus.totalBlocks,
		indexingStatus.totalFiles,
		indexingStatus.totalItems,
		isCurrentStandby,
		progressPercentage,
		t,
	])

	const statusColorClass = useMemo(() => {
		const statusColors = {
			Standby: "bg-vscode-descriptionForeground/60",
			Indexing: "bg-yellow-500 animate-pulse",
			Indexed: "bg-green-500",
			Stopping: "bg-amber-500 animate-pulse",
			Error: "bg-red-500",
		}

		if (isCurrentStandby) {
			return statusColors.Indexed
		}
		return statusColors[indexingStatus.systemStatus as keyof typeof statusColors] || statusColors.Standby
	}, [indexingStatus.systemStatus, isCurrentStandby])

	return (
		<CodeIndexPopover indexingStatus={indexingStatus}>
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						aria-label={tooltipText}
						className={cn(
							"relative h-5 w-5 p-0",
							"text-vscode-foreground opacity-85",
							"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)]",
							"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
							className,
						)}>
						<Database className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</CodeIndexPopover>
	)
}
