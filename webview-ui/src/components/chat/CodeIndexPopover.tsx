import React, { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Trans } from "react-i18next"
import { z } from "zod"
import {
	VSCodeButton,
	VSCodeTextField,
	VSCodeDropdown,
	VSCodeOption,
	VSCodeLink,
	VSCodeCheckbox,
} from "@vscode/webview-ui-toolkit/react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { AlertTriangle } from "lucide-react"

import {
	type IndexingStatus,
	type IndexingCodebaseProgressSnapshot,
	type IndexingDetailedStage,
	type IndexingHealthState,
	type IndexingPipelineSnapshot,
	type IndexingServiceId,
	type IndexingServiceSnapshot,
	type IndexingServiceState,
	type IndexingRuntimeTaskSnapshot,
	type IndexingRuntimeTaskState,
	type IndexingSidecarSnapshot,
	type IndexingSidecarState,
	type IndexMetadataCompactionResultPayload,
	type EmbedderProvider,
	CODEBASE_INDEX_DEFAULTS,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { buildDocLink } from "@src/utils/docLinks"
import { cn } from "@src/lib/utils"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Popover,
	PopoverContent,
	Slider,
	StandardTooltip,
	Button,
} from "@src/components/ui"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"
import { useEscapeKey } from "@src/hooks/useEscapeKey"
import { useCopyToClipboard } from "@src/utils/clipboard"
import {
	useOpenRouterModelProviders,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
} from "@src/components/ui/hooks/useOpenRouterModelProviders"

// Default URLs for providers
const DEFAULT_QDRANT_URL = "http://localhost:6333"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"

export const INDEXING_WARNING_HELP_TEXT = "Latest files that need parser, retry, or degraded-index review."

/**
 * Formats milliseconds into a human-readable ETA string for display.
 * Mirrors the server-side formatEta() in state-manager.ts.
 */
function formatEtaForDisplay(ms: number): string {
	if (ms < 10_000) return "<10s remaining"
	if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes}m remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours}h remaining`
	return `~${hours}h ${remainingMinutes}m remaining`
}

export function formatDurationForDisplay(ms: number | null | undefined): string | null {
	if (ms == null || ms <= 0) return null
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
	const minutes = Math.floor(ms / 60_000)
	const remainingSeconds = Math.round((ms % 60_000) / 1000)
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function formatCountLabel(count: number, singular: string, plural: string): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	const kb = bytes / 1024
	if (kb < 1024) return `${kb.toFixed(1)} KB`
	const mb = kb / 1024
	if (mb < 1024) return `${mb.toFixed(2)} MB`
	return `${(mb / 1024).toFixed(2)} GB`
}

function formatModifiedTime(mtimeMs: number | null): string | null {
	if (mtimeMs == null) {
		return null
	}

	const diffMs = Date.now() - mtimeMs
	const minuteMs = 60_000
	const hourMs = 60 * minuteMs
	const dayMs = 24 * hourMs

	if (diffMs < hourMs) {
		const minutes = Math.max(1, Math.round(diffMs / minuteMs))
		return `Modified ${minutes}m ago`
	}
	if (diffMs < dayMs) {
		const hours = Math.max(1, Math.round(diffMs / hourMs))
		return `Modified ${hours}h ago`
	}
	if (diffMs < 7 * dayMs) {
		const days = Math.max(1, Math.round(diffMs / dayMs))
		return `Modified ${days}d ago`
	}

	return `Modified ${new Date(mtimeMs).toLocaleString()}`
}

function formatBuildTimestamp(value: string | undefined): string {
	if (!value) {
		return "Unknown build time"
	}

	const parsed = new Date(value)
	if (Number.isNaN(parsed.getTime())) {
		return value
	}

	return parsed.toLocaleString()
}

function computeApprovedMaxBytes(sizeBytes: number): number {
	return Math.max(Math.ceil(sizeBytes * 1.2), sizeBytes + 256 * 1024)
}

type CodeIndexPopoverTab = "overview" | "settings"

export function getDefaultCodeIndexPopoverTab(
	indexingEnabled: boolean,
	pipeline?: IndexingPipelineSnapshot,
): CodeIndexPopoverTab {
	return indexingEnabled && Boolean(pipeline) ? "overview" : "settings"
}

export function shouldExpandIndexServiceCard(state: IndexingServiceState): boolean {
	return state === "running" || state === "warning" || state === "failed"
}

type IndexingDisplayMetric = IndexingServiceSnapshot["metrics"][number]
type IndexingMetricOwner = { metrics: IndexingDisplayMetric[] }

export function shouldExpandIndexRuntimeSidecar(state: IndexingSidecarState): boolean {
	return state === "busy" || state === "failed"
}

export function shouldExpandIndexRuntimeTask(state: IndexingRuntimeTaskState): boolean {
	return state === "running" || state === "partial" || state === "failed"
}

export function isPrimaryIndexServiceMetric(metric: IndexingDisplayMetric): boolean {
	return metric.visibility !== "detail"
}

export function hasExpandableIndexServiceCardContent(service: IndexingMetricOwner): boolean {
	return service.metrics.some((metric) => metric.visibility === "detail")
}

export function getVisibleIndexServiceMetrics(
	service: IndexingMetricOwner,
	expanded: boolean,
): IndexingDisplayMetric[] {
	return expanded ? service.metrics : service.metrics.filter(isPrimaryIndexServiceMetric)
}

export function hasExpandableIndexRuntimeSidecarContent(sidecar: IndexingMetricOwner): boolean {
	return hasExpandableIndexServiceCardContent(sidecar)
}

export function getVisibleIndexRuntimeSidecarMetrics(
	sidecar: IndexingMetricOwner,
	expanded: boolean,
): IndexingDisplayMetric[] {
	return getVisibleIndexServiceMetrics(sidecar, expanded)
}

export function hasExpandableIndexRuntimeTaskContent(task: IndexingMetricOwner): boolean {
	return hasExpandableIndexServiceCardContent(task)
}

export function getVisibleIndexRuntimeTaskMetrics(
	task: IndexingMetricOwner,
	expanded: boolean,
): IndexingDisplayMetric[] {
	return getVisibleIndexServiceMetrics(task, expanded)
}

export function getMetadataCleanupCompactionAction(task: IndexingRuntimeTaskSnapshot) {
	return task.id === "metadata_cleanup"
		? task.actions?.find((action) => action.id === "compact_metadata_db")
		: undefined
}

function getIndexingOverallStateLabel(pipeline?: IndexingPipelineSnapshot): string {
	switch (pipeline?.overallState) {
		case "running":
			return "Running"
		case "completed":
			return pipeline.preservedFromPreviousRun ? "Last run" : "Completed"
		case "stopped":
			return "Stopped"
		case "failed":
			return "Failed"
		case "idle":
		default:
			return "Idle"
	}
}

function getIndexingRunModeLabel(pipeline?: IndexingPipelineSnapshot): string {
	switch (pipeline?.runMode) {
		case "initial-discovery":
		case "start":
			return "Initial discovery"
		case "refresh":
			return "Refresh"
		case "reconcile":
			return "Reconcile"
		case "resume":
			return "Resume"
		default:
			return "Unknown"
	}
}

function getHealthLabel(health: IndexingHealthState | undefined): string {
	switch (health) {
		case "healthy":
			return "Healthy"
		case "watch":
			return "Watch"
		case "critical":
			return "Critical"
		default:
			return "Unknown"
	}
}

function getHealthToneClass(health: IndexingHealthState | undefined): string {
	switch (health) {
		case "healthy":
			return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
		case "watch":
			return "border-amber-500/25 bg-amber-500/10 text-amber-200"
		case "critical":
			return "border-red-500/25 bg-red-500/10 text-red-200"
		default:
			return "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground"
	}
}

function getServiceStateLabel(state: IndexingServiceState): string {
	switch (state) {
		case "running":
			return "Running"
		case "completed":
			return "Completed"
		case "warning":
			return "Warning"
		case "failed":
			return "Failed"
		case "skipped":
			return "Skipped"
		default:
			return "Pending"
	}
}

function getServiceStateToneClass(state: IndexingServiceState): string {
	switch (state) {
		case "running":
			return "border-sky-500/25 bg-sky-500/10 text-sky-200"
		case "completed":
			return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
		case "warning":
			return "border-amber-500/25 bg-amber-500/10 text-amber-200"
		case "failed":
			return "border-red-500/25 bg-red-500/10 text-red-200"
		case "skipped":
			return "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] text-vscode-descriptionForeground"
		default:
			return "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] text-vscode-descriptionForeground"
	}
}

function getRuntimeSidecarStateLabel(state: IndexingSidecarState): string {
	switch (state) {
		case "standby":
			return "Standby"
		case "online":
			return "Online"
		case "busy":
			return "Busy"
		case "failed":
			return "Failed"
	}
}

function getRuntimeSidecarStateToneClass(state: IndexingSidecarState): string {
	switch (state) {
		case "online":
			return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
		case "busy":
			return "border-sky-500/25 bg-sky-500/10 text-sky-200"
		case "failed":
			return "border-red-500/25 bg-red-500/10 text-red-200"
		case "standby":
		default:
			return "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] text-vscode-descriptionForeground"
	}
}

function getRuntimeTaskStateLabel(state: IndexingRuntimeTaskState): string {
	switch (state) {
		case "scheduled":
			return "Scheduled"
		case "running":
			return "Running"
		case "partial":
			return "Partial"
		case "complete":
			return "Complete"
		case "failed":
			return "Failed"
		case "skipped":
			return "Skipped"
		case "idle":
		default:
			return "Idle"
	}
}

function getRuntimeTaskStateToneClass(state: IndexingRuntimeTaskState): string {
	switch (state) {
		case "complete":
			return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
		case "scheduled":
		case "running":
		case "partial":
			return "border-sky-500/25 bg-sky-500/10 text-sky-200"
		case "failed":
			return "border-red-500/25 bg-red-500/10 text-red-200"
		case "skipped":
			return "border-amber-500/25 bg-amber-500/10 text-amber-200"
		case "idle":
		default:
			return "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] text-vscode-descriptionForeground"
	}
}

function getHealthDotClass(health: IndexingHealthState | undefined): string {
	switch (health) {
		case "healthy":
			return "bg-emerald-400"
		case "watch":
			return "bg-amber-400"
		case "critical":
			return "bg-red-400"
		default:
			return "bg-vscode-descriptionForeground/60"
	}
}

function formatServiceProgress(service: IndexingServiceSnapshot): string | null {
	if (service.indeterminate) {
		return service.progressUnit ? `In progress • ${service.progressUnit}` : "In progress"
	}
	if (service.progressCurrent == null || service.progressTotal == null) {
		return null
	}
	const progressUnit = service.progressUnit ?? "items"
	return `${service.progressCurrent.toLocaleString()} / ${service.progressTotal.toLocaleString()} ${progressUnit}`
}

function formatRuntimeTaskProgress(task: IndexingRuntimeTaskSnapshot): string | null {
	if (task.indeterminate) {
		return task.progressUnit ? `Working • ${task.progressUnit}` : "Working"
	}
	if (task.progressCurrent == null || task.progressTotal == null) {
		return null
	}
	const progressUnit = task.progressUnit ?? "rows"
	return `${task.progressCurrent.toLocaleString()} / ${task.progressTotal.toLocaleString()} ${progressUnit}`
}

export function formatCodebaseProgressRows(progress?: IndexingCodebaseProgressSnapshot): Array<{
	key: string
	label: string
	value: string
}> {
	if (!progress) {
		return []
	}
	const rows: Array<{ key: string; label: string; value: string }> = []
	if ((progress.totalFiles ?? 0) > 0 || (progress.indexedFiles ?? 0) > 0) {
		const indexedFiles = progress.indexedFiles ?? 0
		const totalFiles = Math.max(progress.totalFiles ?? 0, indexedFiles, 0)
		const fileValue =
			progress.fileTotalKind === "available" || totalFiles <= 0
				? `${indexedFiles.toLocaleString()} indexed`
				: `${indexedFiles.toLocaleString()} / ${
						progress.fileTotalKind === "estimated"
							? `~${totalFiles.toLocaleString()}`
							: totalFiles.toLocaleString()
					}`
		rows.push({
			key: "files",
			label: "Files indexed",
			value: fileValue,
		})
	}
	if ((progress.knownTotalChunks ?? 0) > 0 || (progress.syncedChunks ?? 0) > 0) {
		const syncedChunks = progress.syncedChunks ?? 0
		const knownTotalChunks = Math.max(progress.knownTotalChunks ?? 0, syncedChunks, 0)
		const chunkValue =
			progress.chunkTotalKind === "available" || knownTotalChunks <= 0
				? `${syncedChunks.toLocaleString()} available`
				: `${syncedChunks.toLocaleString()} / ${
						progress.chunkTotalKind === "estimated"
							? `~${knownTotalChunks.toLocaleString()}`
							: knownTotalChunks.toLocaleString()
					}`
		rows.push({
			key: "chunks",
			label: "Chunks synced",
			value: chunkValue,
		})
	}
	return rows
}

export function getPrimaryElapsedMs(pipeline?: IndexingPipelineSnapshot): number | null {
	if (!pipeline) {
		return null
	}
	if (pipeline.runMode === "resume") {
		return pipeline.investedElapsedMs ?? pipeline.elapsedMs ?? null
	}
	return pipeline.elapsedMs ?? null
}

export function getIndexingHeadline(indexingStatus: IndexingStatus, isCurrentStandby: boolean, t: any): string {
	if (indexingStatus.pipeline?.summary?.headline) {
		return indexingStatus.pipeline.summary.headline
	}
	if (isCurrentStandby) {
		return t("settings:codeIndex.liveWatcherHeadline")
	}
	if (indexingStatus.systemStatus !== "Indexing") {
		return (indexingStatus.message ?? "").split("\n")[0] ?? ""
	}

	switch (indexingStatus.detailedStage) {
		case "preparing":
			return "Preparing workspace index"
		case "discovering":
			return "Discovering workspace files"
		case "hashing_initial":
			return "Preparing files for indexing"
		case "comparing_signatures":
			return "Checking for changed files"
		case "parsing":
			return "Preparing changed files for indexing"
		case "planning_vectors":
			return indexingStatus.hasKnownVectorWork ? "Preparing vector workload" : "Checking for vector work"
		case "embedding":
			return "Building embeddings and syncing vectors"
		case "deleting_vectors":
			return "Removing stale vectors"
		case "reconciling":
			return indexingStatus.isBackgroundReconcile
				? "Checking for workspace changes"
				: "Reconciling workspace state"
		case "complete":
			return (indexingStatus.message ?? "").split("\n")[0] ?? ""
		default:
			if (indexingStatus.phase === "embedding") {
				return "Building embeddings and syncing vectors"
			}
			if (indexingStatus.phase === "scanning") {
				return "Checking workspace files"
			}
			return (indexingStatus.message ?? "").split("\n")[0] ?? ""
	}
}

function getLegacyRunSummarySupplementalLines(
	indexingStatus: IndexingStatus,
	isCurrentStandby: boolean,
	t: any,
	displayedOversizedCount: number,
): string[] {
	const statusLines = (indexingStatus.message ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)

	if (isCurrentStandby) {
		return [
			getLiveWatcherCurrentLine(indexingStatus, statusLines[0], displayedOversizedCount),
			getLiveWatcherRefreshLine(indexingStatus, statusLines[0]) ?? t("settings:codeIndex.liveWatcherDetail"),
		].filter((line): line is string => Boolean(line))
	}

	if (indexingStatus.systemStatus !== "Indexing") {
		return statusLines.slice(1, 3)
	}

	const detailLines = statusLines.slice(1)
	const summaryLine =
		detailLines.find(
			(line) =>
				line.includes("Parsing ") || line.includes("Streaming ") || line.includes("candidate files found"),
		) ?? detailLines[0]
	const runtimeLine =
		detailLines.find((line) => line.includes(" MB RSS") || line.includes("chunks/sec") || line.includes("CPU ")) ??
		detailLines[1]

	return [summaryLine, runtimeLine].filter((line): line is string => Boolean(line)).slice(0, 2)
}

function getLegacyRunSummaryProgressLabel(indexingStatus: IndexingStatus): string {
	switch (indexingStatus.detailedStage) {
		case "preparing":
			return "Initializing index engine"
		case "reconciling":
			return indexingStatus.isBackgroundReconcile ? "Verifying index freshness" : "Reconciling workspace state"
		case "discovering": {
			const discoveredFiles = indexingStatus.processedItems ?? 0
			const rawEstimatedTotal = Math.max(indexingStatus.totalItems ?? 0, discoveredFiles, 1)
			const estimatedTotal =
				rawEstimatedTotal <= discoveredFiles
					? Math.max(Math.ceil(discoveredFiles * 1.1), discoveredFiles + 1)
					: rawEstimatedTotal
			return `${discoveredFiles.toLocaleString()} found • ~${estimatedTotal.toLocaleString()} estimated`
		}
		case "hashing_initial":
		case "comparing_signatures": {
			const checkedFiles = indexingStatus.processedItems ?? 0
			const totalFiles = Math.max(indexingStatus.totalItems ?? 0, checkedFiles, 1)
			return `${checkedFiles.toLocaleString()} / ${totalFiles.toLocaleString()} checked`
		}
		case "parsing": {
			const parsedFiles = indexingStatus.processedItems ?? 0
			const totalFiles = Math.max(indexingStatus.totalItems ?? 0, parsedFiles, 1)
			return `${parsedFiles.toLocaleString()} / ${totalFiles.toLocaleString()} files`
		}
		case "planning_vectors":
			return indexingStatus.hasKnownVectorWork ? "Preparing vector workload" : "Checking for vector work"
		case "embedding":
			if (!indexingStatus.hasStartedVectorSync) {
				return "Preparing vector workload"
			}
			return `${(indexingStatus.blocksEmbedded ?? 0).toLocaleString()} / ${(indexingStatus.totalBlocks ?? 0).toLocaleString()} blocks`
		case "deleting_vectors":
			return "Removing stale vectors"
		default:
			if (indexingStatus.phase === "embedding" && indexingStatus.hasStartedVectorSync) {
				return `${(indexingStatus.blocksEmbedded ?? 0).toLocaleString()} / ${(indexingStatus.totalBlocks ?? 0).toLocaleString()} blocks`
			}
			if (indexingStatus.phase === "scanning") {
				const processed = indexingStatus.processedItems ?? 0
				const total = Math.max(indexingStatus.totalItems ?? 0, processed, 1)
				return `${processed.toLocaleString()} / ${total.toLocaleString()} files`
			}
			return ""
	}
}

export function getRunSummaryDisplay(
	indexingStatus: IndexingStatus,
	isCurrentStandby: boolean,
	t: any,
	displayedOversizedCount = 0,
): {
	headline: string
	progressLine?: string
	secondaryLine?: string
} {
	const pipelineSummary = indexingStatus.pipeline?.summary
	if (pipelineSummary) {
		return {
			headline: pipelineSummary.headline,
			progressLine: pipelineSummary.progressLabel,
			secondaryLine: pipelineSummary.secondaryLabel,
		}
	}

	const headline = getIndexingHeadline(indexingStatus, isCurrentStandby, t)
	const supplementalLines = getLegacyRunSummarySupplementalLines(
		indexingStatus,
		isCurrentStandby,
		t,
		displayedOversizedCount,
	)
	const legacyProgressLabel = getLegacyRunSummaryProgressLabel(indexingStatus)
	const progressLine = legacyProgressLabel || supplementalLines[0]
	const secondaryLine = supplementalLines.find((line) => line !== progressLine)

	return {
		headline,
		progressLine,
		secondaryLine,
	}
}

function getLiveWatcherCurrentLine(
	indexingStatus: IndexingStatus,
	fallbackLine?: string,
	oversizedCount?: number,
): string | null {
	const message = indexingStatus.message ?? ""
	const firstLine = fallbackLine ?? message.split("\n")[0]?.trim() ?? ""
	const oversizedSuffix =
		oversizedCount && oversizedCount > 0 ? ` with ${oversizedCount.toLocaleString()} oversized files skipped` : ""

	const mappedMatch = firstLine.match(/^V2 mapped ([\d,]+) files/i)
	if (mappedMatch?.[1]) {
		return `V2 is current across ${mappedMatch[1]} files${oversizedSuffix}`
	}

	const refreshedMatch = firstLine.match(/^V2 refresh re-evaluated ([\d,]+) files/i)
	if (refreshedMatch?.[1]) {
		return `V2 is current across ${refreshedMatch[1]} files${oversizedSuffix}`
	}

	if (/^V2 is current across /i.test(firstLine)) {
		return firstLine.replace(/\s+with\s+[\d,]+\s+oversized files skipped/i, "") + oversizedSuffix
	}

	if (/^Index up-to-date/i.test(firstLine)) {
		return firstLine
	}

	return firstLine || null
}

function getLiveWatcherRefreshLine(indexingStatus: IndexingStatus, fallbackLine?: string): string | null {
	const message = indexingStatus.message ?? ""
	const firstLine = fallbackLine ?? message.split("\n")[0]?.trim() ?? ""

	const refreshedMatch = firstLine.match(/refreshed ([\d,]+) changed files/i)
	const syncedMatch = firstLine.match(/synced ([\d,]+) chunks/i)
	const oversizedMatch = firstLine.match(/with ([\d,]+) oversized files skipped/i)

	const parts = [
		refreshedMatch?.[1] ? `${refreshedMatch[1]} changed files` : null,
		syncedMatch?.[1] ? `${syncedMatch[1]} chunks synced` : null,
		oversizedMatch?.[1] ? `${oversizedMatch[1]} oversized files skipped` : null,
	].filter((part): part is string => Boolean(part))

	return parts.length > 0 ? `Last refresh: ${parts.join(" • ")}` : null
}

export function getProgressStageLabel(stage?: IndexingDetailedStage, phase?: IndexingStatus["phase"]): string {
	switch (stage) {
		case "embedding":
		case "planning_vectors":
			return "Embedding pass"
		case "deleting_vectors":
			return "Cleanup pass"
		default:
			return phase === "embedding" ? "Embedding pass" : "Workspace pass"
	}
}

interface CodeIndexPopoverProps {
	children: React.ReactNode
	indexingStatus: IndexingStatus
}

interface LocalCodeIndexSettings {
	// Global state settings
	codebaseIndexEnabled: boolean
	codebaseIndexQdrantUrl: string
	codebaseIndexMaxFileSizeMb?: number
	codebaseIndexEmbedderProvider: EmbedderProvider
	codebaseIndexEmbedderBaseUrl?: string
	codebaseIndexEmbedderModelId: string
	codebaseIndexEmbedderModelDimension?: number // Generic dimension for all providers
	codebaseIndexSearchMaxResults?: number
	codebaseIndexSearchMinScore?: number
	codebaseIndexMaxFiles?: number
	codebaseIndexEmbeddingBatchSize?: number
	codebaseIndexEmbeddingLaneConcurrency?: number
	codebaseIndexDebugLogging: boolean
	maximumIndexedFilesForFileSearch?: number
	codebaseIndexRespectGitIgnore: boolean

	// Bedrock-specific settings
	codebaseIndexBedrockRegion?: string
	codebaseIndexBedrockProfile?: string

	// Secret settings (start empty, will be loaded separately)
	codeIndexOpenAiKey?: string
	codeIndexQdrantApiKey?: string
	codebaseIndexOpenAiCompatibleBaseUrl?: string
	codebaseIndexOpenAiCompatibleApiKey?: string
	codebaseIndexGeminiApiKey?: string
	codebaseIndexMistralApiKey?: string
	codebaseIndexVercelAiGatewayApiKey?: string
	codebaseIndexOpenRouterApiKey?: string
	codebaseIndexOpenRouterSpecificProvider?: string
	codebaseIndexOversizedFileApprovals?: Array<{
		workspacePath: string
		relativePath: string
		sizeAtApprovalBytes: number
		approvedMaxBytes: number
		approvedAt: number
	}>
}

// Validation schema for codebase index settings
const createValidationSchema = (provider: EmbedderProvider, t: any) => {
	const baseSchema = z.object({
		codebaseIndexEnabled: z.boolean(),
		codebaseIndexQdrantUrl: z
			.string()
			.min(1, t("settings:codeIndex.validation.qdrantUrlRequired"))
			.url(t("settings:codeIndex.validation.invalidQdrantUrl")),
		codebaseIndexMaxFileSizeMb: z.number().int().min(1).max(100).optional(),
		codeIndexQdrantApiKey: z.string().optional(),
		codebaseIndexEmbeddingBatchSize: z.number().int().min(1).max(200).optional(),
		codebaseIndexEmbeddingLaneConcurrency: z.number().int().min(1).max(3).optional(),
	})

	switch (provider) {
		case "openai":
			return baseSchema.extend({
				codeIndexOpenAiKey: z.string().min(1, t("settings:codeIndex.validation.openaiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "ollama":
			return baseSchema.extend({
				codebaseIndexEmbedderBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.ollamaBaseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidOllamaUrl")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired"))
					.optional(),
			})

		case "openai-compatible":
			return baseSchema.extend({
				codebaseIndexOpenAiCompatibleBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.baseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidBaseUrl")),
				codebaseIndexOpenAiCompatibleApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.apiKeyRequired")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired")),
			})

		case "gemini":
			return baseSchema.extend({
				codebaseIndexGeminiApiKey: z.string().min(1, t("settings:codeIndex.validation.geminiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "mistral":
			return baseSchema.extend({
				codebaseIndexMistralApiKey: z.string().min(1, t("settings:codeIndex.validation.mistralApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "vercel-ai-gateway":
			return baseSchema.extend({
				codebaseIndexVercelAiGatewayApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.vercelAiGatewayApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "bedrock":
			return baseSchema.extend({
				codebaseIndexBedrockRegion: z.string().min(1, t("settings:codeIndex.validation.bedrockRegionRequired")),
				codebaseIndexBedrockProfile: z.string().optional(),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "openrouter":
			return baseSchema.extend({
				codebaseIndexOpenRouterApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.openRouterApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		default:
			return baseSchema
	}
}

export const CodeIndexPopover: React.FC<CodeIndexPopoverProps> = ({
	children,
	indexingStatus: externalIndexingStatus,
}) => {
	const SECRET_PLACEHOLDER = "••••••••••••••••"
	const { t } = useAppTranslation()
	const { codebaseIndexConfig, codebaseIndexModels, cwd, apiConfiguration, debug, renderContext } =
		useExtensionState()
	const rooVersion = process.env.PKG_VERSION ?? "unknown"
	const rooBuildTimestamp = formatBuildTimestamp(process.env.PKG_BUILD_TIMESTAMP)
	const [open, setOpen] = useState(false)
	const [activeTab, setActiveTab] = useState<CodeIndexPopoverTab>(
		getDefaultCodeIndexPopoverTab(
			codebaseIndexConfig?.codebaseIndexEnabled ?? true,
			externalIndexingStatus.pipeline,
		),
	)
	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)
	const [isSetupSettingsOpen, setIsSetupSettingsOpen] = useState(false)
	const setupSectionRef = useRef<HTMLDivElement | null>(null)
	const advancedSectionRef = useRef<HTMLDivElement | null>(null)

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>(externalIndexingStatus)

	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
	const [saveError, setSaveError] = useState<string | null>(null)
	const [warningDetailsState, setWarningDetailsState] = useState<{
		items: NonNullable<IndexingStatus["warningDetails"]>
		total: number
		loading: boolean
		hasMore: boolean
		filter: "all" | "parser_failed" | "failed" | "degraded"
		sort: "severity" | "recent" | "path"
	}>({
		items: externalIndexingStatus.warningDetails ?? [],
		total: externalIndexingStatus.warningDetails?.length ?? 0,
		loading: false,
		hasMore: false,
		filter: "all",
		sort: "severity",
	})
	const [warningDetailsBootstrapped, setWarningDetailsBootstrapped] = useState(false)
	const [oversizedDetailsState, setOversizedDetailsState] = useState<{
		items: Array<{
			relativePath: string
			normalizedPath: string
			status: "skipped" | "needs_reapproval" | "approved" | "eligible" | "missing"
			sizeBytes: number
			lastModifiedMtimeMs: number | null
			recommendation: "likely_useful" | "review_manually" | "probably_skip"
			reason: string
			approvedMaxBytes: number | null
			lastEvaluatedAt: number
		}>
		total: number
		actionable: number
		loading: boolean
		hasMore: boolean
	}>({
		items: [],
		total: 0,
		actionable: 0,
		loading: false,
		hasMore: false,
	})
	const [oversizedDetailsBootstrapped, setOversizedDetailsBootstrapped] = useState(false)
	const [isOversizedReviewOpen, setIsOversizedReviewOpen] = useState(false)
	const [warningFilter, setWarningFilter] = useState<"all" | "parser_failed" | "failed" | "degraded">("all")
	const [warningSort, setWarningSort] = useState<"severity" | "recent" | "path">("severity")
	const [retryWarningsPending, setRetryWarningsPending] = useState(false)
	const [retryingWarningPath, setRetryingWarningPath] = useState<string | null>(null)
	const [metadataCompactionPending, setMetadataCompactionPending] = useState(false)
	const [metadataCompactionMessage, setMetadataCompactionMessage] = useState<{
		tone: "good" | "critical"
		text: string
	} | null>(null)
	const [serviceExpansionOverrides, setServiceExpansionOverrides] = useState<
		Partial<Record<IndexingServiceId, boolean>>
	>({})
	const [runtimeSidecarExpansionOverrides, setRuntimeSidecarExpansionOverrides] = useState<
		Partial<Record<IndexingSidecarSnapshot["id"], boolean>>
	>({})
	const [runtimeTaskExpansionOverrides, setRuntimeTaskExpansionOverrides] = useState<
		Partial<Record<IndexingRuntimeTaskSnapshot["id"], boolean>>
	>({})
	const { copyWithFeedback, showCopyFeedback } = useCopyToClipboard()
	const saveFeedbackTimerRef = useRef<number | null>(null)
	const rooDebugInfo = useMemo(() => {
		if (typeof window === "undefined") {
			return {
				origin: "",
				webviewId: "",
			}
		}

		try {
			const url = new URL(window.location.href)
			const host = url.host
			const webviewId = url.searchParams.get("id") ?? (host && host !== "vscode-webview" ? host : "")
			return {
				origin: url.origin,
				webviewId,
			}
		} catch {
			return {
				origin: "",
				webviewId: "",
			}
		}
	}, [])

	// Form validation state
	const [formErrors, setFormErrors] = useState<Record<string, string>>({})

	// Discard changes dialog state
	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const confirmDialogHandler = useRef<(() => void) | null>(null)

	// Default settings template
	const getDefaultSettings = (): LocalCodeIndexSettings => ({
		codebaseIndexEnabled: true,
		codebaseIndexQdrantUrl: "",
		codebaseIndexMaxFileSizeMb: 1,
		codebaseIndexEmbedderProvider: "openai",
		codebaseIndexEmbedderBaseUrl: "",
		codebaseIndexEmbedderModelId: "",
		codebaseIndexEmbedderModelDimension: undefined,
		codebaseIndexSearchMaxResults: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
		codebaseIndexSearchMinScore: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
		codebaseIndexMaxFiles: 100000,
		codebaseIndexEmbeddingBatchSize: 60,
		codebaseIndexEmbeddingLaneConcurrency: 2,
		codebaseIndexDebugLogging: false,
		maximumIndexedFilesForFileSearch: 10000,
		codebaseIndexRespectGitIgnore: true,
		codebaseIndexBedrockRegion: "",
		codebaseIndexBedrockProfile: "",
		codeIndexOpenAiKey: "",
		codeIndexQdrantApiKey: "",
		codebaseIndexOpenAiCompatibleBaseUrl: "",
		codebaseIndexOpenAiCompatibleApiKey: "",
		codebaseIndexGeminiApiKey: "",
		codebaseIndexMistralApiKey: "",
		codebaseIndexVercelAiGatewayApiKey: "",
		codebaseIndexOpenRouterApiKey: "",
		codebaseIndexOpenRouterSpecificProvider: "",
		codebaseIndexOversizedFileApprovals: [],
	})

	// Initial settings state - stores the settings when popover opens
	const [initialSettings, setInitialSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Current settings state - tracks user changes
	const [currentSettings, setCurrentSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Update indexing status from parent
	useEffect(() => {
		setIndexingStatus(externalIndexingStatus)
		setWarningDetailsState((prev) => ({
			...prev,
			...(warningDetailsBootstrapped
				? {}
				: {
						items: externalIndexingStatus.warningDetails ?? [],
						total: externalIndexingStatus.warningDetails?.length ?? 0,
						hasMore: (externalIndexingStatus.warningDetails?.length ?? 0) >= 8,
					}),
		}))
	}, [externalIndexingStatus, warningDetailsBootstrapped])

	useEffect(() => {
		if (!isSetupSettingsOpen) {
			return
		}
		requestAnimationFrame(() => {
			setupSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
		})
	}, [isSetupSettingsOpen])

	useEffect(() => {
		if (!isAdvancedSettingsOpen) {
			return
		}
		requestAnimationFrame(() => {
			advancedSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
		})
	}, [isAdvancedSettingsOpen])

	// Initialize settings from global state
	useEffect(() => {
		if (codebaseIndexConfig) {
			const settings = {
				codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? true,
				codebaseIndexQdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl || "",
				codebaseIndexMaxFileSizeMb: codebaseIndexConfig.codebaseIndexMaxFileSizeMb ?? 1,
				codebaseIndexEmbedderProvider: codebaseIndexConfig.codebaseIndexEmbedderProvider || "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig.codebaseIndexEmbedderBaseUrl || "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig.codebaseIndexEmbedderModelId || "",
				codebaseIndexEmbedderModelDimension:
					codebaseIndexConfig.codebaseIndexEmbedderModelDimension || undefined,
				codebaseIndexSearchMaxResults:
					codebaseIndexConfig.codebaseIndexSearchMaxResults ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
				codebaseIndexSearchMinScore:
					codebaseIndexConfig.codebaseIndexSearchMinScore ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
				codebaseIndexMaxFiles: codebaseIndexConfig.codebaseIndexMaxFiles ?? 100000,
				codebaseIndexEmbeddingBatchSize: codebaseIndexConfig.codebaseIndexEmbeddingBatchSize ?? 60,
				codebaseIndexEmbeddingLaneConcurrency: codebaseIndexConfig.codebaseIndexEmbeddingLaneConcurrency ?? 2,
				codebaseIndexDebugLogging: codebaseIndexConfig.codebaseIndexDebugLogging ?? false,
				maximumIndexedFilesForFileSearch: codebaseIndexConfig.maximumIndexedFilesForFileSearch ?? 10000,
				codebaseIndexRespectGitIgnore: codebaseIndexConfig.codebaseIndexRespectGitIgnore ?? true,
				codebaseIndexBedrockRegion: codebaseIndexConfig.codebaseIndexBedrockRegion || "",
				codebaseIndexBedrockProfile: codebaseIndexConfig.codebaseIndexBedrockProfile || "",
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl || "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
				codebaseIndexOpenRouterSpecificProvider:
					codebaseIndexConfig.codebaseIndexOpenRouterSpecificProvider || "",
				codebaseIndexOversizedFileApprovals: codebaseIndexConfig.codebaseIndexOversizedFileApprovals ?? [],
			}
			setInitialSettings(settings)
			setCurrentSettings(settings)

			// Request secret status to check if secrets exist
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
		}
	}, [codebaseIndexConfig])

	// Request initial indexing status
	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestIndexingStatus" })
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
			setWarningDetailsBootstrapped(false)
		}
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "workspaceUpdated") {
				// When workspace changes, request updated indexing status
				if (open) {
					vscode.postMessage({ type: "requestIndexingStatus" })
					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [open])

	useEffect(() => {
		if (!currentSettings.codebaseIndexEnabled && activeTab === "overview") {
			setActiveTab("settings")
		}
	}, [activeTab, currentSettings.codebaseIndexEnabled])

	const showSaveError = useCallback(
		(message?: string) => {
			if (saveFeedbackTimerRef.current !== null) {
				window.clearTimeout(saveFeedbackTimerRef.current)
			}
			setSaveStatus("error")
			setSaveError(message || t("settings:codeIndex.saveError"))
			saveFeedbackTimerRef.current = window.setTimeout(() => {
				setSaveStatus("idle")
				setSaveError(null)
				saveFeedbackTimerRef.current = null
			}, 5000)
		},
		[t],
	)

	useEffect(() => {
		return () => {
			if (saveFeedbackTimerRef.current !== null) {
				window.clearTimeout(saveFeedbackTimerRef.current)
			}
		}
	}, [])

	const requestWarningDetails = useCallback(
		(offset: number, limit = 20, filter = warningFilter, sort = warningSort) => {
			setWarningDetailsState((prev) => ({ ...prev, loading: true, filter, sort }))
			vscode.postMessage({
				type: "requestIndexingWarningDetails",
				values: { offset, limit, filter, sort },
			})
		},
		[warningFilter, warningSort],
	)

	const requestOversizedDetails = useCallback((offset: number, limit = 20) => {
		setOversizedDetailsState((prev) => ({ ...prev, loading: true }))
		vscode.postMessage({
			type: "requestIndexingOversizedFilesDetails",
			values: { offset, limit },
		})
	}, [])

	const resetWarningDetailsState = useCallback(
		(filter = warningFilter, sort = warningSort) => {
			setWarningDetailsBootstrapped(false)
			setWarningDetailsState({
				items: [],
				total: 0,
				loading: false,
				hasMore: false,
				filter,
				sort,
			})
		},
		[warningFilter, warningSort],
	)

	const resetOversizedDetailsState = useCallback(() => {
		setOversizedDetailsBootstrapped(false)
		setOversizedDetailsState({
			items: [],
			total: 0,
			actionable: 0,
			loading: false,
			hasMore: false,
		})
	}, [])

	// Use a ref to capture current settings for the save handler
	const currentSettingsRef = useRef(currentSettings)
	currentSettingsRef.current = currentSettings

	const oversizedApprovalMap = useMemo(() => {
		const map = new Map<
			string,
			{
				workspacePath: string
				relativePath: string
				sizeAtApprovalBytes: number
				approvedMaxBytes: number
				approvedAt: number
			}
		>()
		for (const approval of currentSettings.codebaseIndexOversizedFileApprovals ?? []) {
			if (approval.workspacePath === cwd) {
				map.set(approval.relativePath, approval)
			}
		}
		return map
	}, [currentSettings.codebaseIndexOversizedFileApprovals, cwd])

	const approveOversizedFile = useCallback(
		(relativePath: string, sizeBytes: number) => {
			const nextApproval = {
				workspacePath: cwd ?? "",
				relativePath,
				sizeAtApprovalBytes: sizeBytes,
				approvedMaxBytes: computeApprovedMaxBytes(sizeBytes),
				approvedAt: Date.now(),
			}

			setCurrentSettings((prev) => ({
				...prev,
				codebaseIndexOversizedFileApprovals: [
					...(prev.codebaseIndexOversizedFileApprovals ?? []).filter(
						(entry) => !(entry.workspacePath === cwd && entry.relativePath === relativePath),
					),
					nextApproval,
				],
			}))
		},
		[cwd],
	)

	// Listen for indexing status updates and save responses
	useEffect(() => {
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "indexingStatusUpdate") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setIndexingStatus(event.data.values)
					setRetryWarningsPending(false)
					setRetryingWarningPath(null)
				}
			} else if (event.data.type === "indexCleared") {
				if (event.data.values?.success) {
					setRetryWarningsPending(false)
					setRetryingWarningPath(null)
					setMetadataCompactionPending(false)
					setMetadataCompactionMessage(null)
					setWarningFilter("all")
					setWarningSort("severity")
					resetWarningDetailsState("all", "severity")
					resetOversizedDetailsState()
					vscode.postMessage({ type: "requestIndexingStatus" })
				}
			} else if (event.data.type === "indexMetadataCompactionResult") {
				const result = event.data.values as IndexMetadataCompactionResultPayload | undefined
				setMetadataCompactionPending(false)
				if (result?.success) {
					const reclaimed =
						typeof result.reclaimedBytes === "number"
							? ` Reclaimed ${formatBytes(result.reclaimedBytes)}.`
							: ""
					setMetadataCompactionMessage({
						tone: "good",
						text: `Metadata DB compaction complete.${reclaimed}`,
					})
					vscode.postMessage({ type: "requestIndexingStatus" })
				} else {
					setMetadataCompactionMessage({
						tone: "critical",
						text: result?.error ?? "Metadata DB compaction failed.",
					})
				}
			} else if (event.data.type === "indexingWarningDetails") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setWarningDetailsState((prev) => ({
						items:
							event.data.values.offset > 0
								? [...prev.items, ...event.data.values.items]
								: event.data.values.items,
						total: event.data.values.total,
						loading: false,
						hasMore: event.data.values.hasMore,
						filter: event.data.values.filter,
						sort: event.data.values.sort,
					}))
					if (event.data.values.offset === 0) {
						setWarningDetailsBootstrapped(true)
					}
				}
			} else if (event.data.type === "indexingOversizedFilesDetails") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setOversizedDetailsState((prev) => ({
						items:
							event.data.values.offset > 0
								? [...prev.items, ...event.data.values.items]
								: event.data.values.items,
						total: event.data.values.total,
						actionable: event.data.values.actionable,
						loading: false,
						hasMore: event.data.values.hasMore,
					}))
					if (event.data.values.offset === 0) {
						setOversizedDetailsBootstrapped(true)
					}
				}
			} else if (event.data.type === "codeIndexSettingsSaved") {
				if (event.data.success) {
					setSaveStatus("saved")
					// Update initial settings to match current settings after successful save
					// This ensures hasUnsavedChanges becomes false
					const savedSettings = { ...currentSettingsRef.current }
					setInitialSettings(savedSettings)
					// Also update current settings to maintain consistency
					setCurrentSettings(savedSettings)
					// Request secret status to ensure we have the latest state
					// This is important to maintain placeholder display after save

					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })

					setSaveStatus("idle")
				} else {
					showSaveError(event.data.error)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd, resetOversizedDetailsState, resetWarningDetailsState, showSaveError])

	useEffect(() => {
		if (!open) {
			return
		}
		const warningCount =
			(indexingStatus.degradedRevisions ?? 0) +
			(indexingStatus.terminalFailedRevisions ?? 0) +
			(indexingStatus.terminalFailedParseRevisions ?? 0)
		if (warningCount === 0) {
			setWarningDetailsState({
				items: [],
				total: 0,
				loading: false,
				hasMore: false,
				filter: warningFilter,
				sort: warningSort,
			})
			setWarningDetailsBootstrapped(false)
			return
		}
		if (retryWarningsPending) {
			return
		}
		if (warningCount > 0 && !warningDetailsBootstrapped) {
			requestWarningDetails(0, 20, warningFilter, warningSort)
		}
	}, [
		indexingStatus.degradedRevisions,
		indexingStatus.terminalFailedParseRevisions,
		indexingStatus.terminalFailedRevisions,
		open,
		requestWarningDetails,
		retryWarningsPending,
		warningDetailsBootstrapped,
		warningFilter,
		warningSort,
	])

	useEffect(() => {
		if (!open || oversizedDetailsBootstrapped) {
			return
		}
		requestOversizedDetails(0, 20)
	}, [open, oversizedDetailsBootstrapped, requestOversizedDetails])

	// Listen for secret status
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "codeIndexSecretStatus") {
				// Update settings to show placeholders for existing secrets
				const secretStatus = event.data.values

				// Update both current and initial settings based on what secrets exist
				const updateWithSecrets = (prev: LocalCodeIndexSettings): LocalCodeIndexSettings => {
					const updated = { ...prev }

					// Only update to placeholder if the field is currently empty or already a placeholder
					// This preserves user input when they're actively editing
					if (!prev.codeIndexOpenAiKey || prev.codeIndexOpenAiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexOpenAiKey = secretStatus.hasOpenAiKey ? SECRET_PLACEHOLDER : ""
					}
					if (!prev.codeIndexQdrantApiKey || prev.codeIndexQdrantApiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexQdrantApiKey = secretStatus.hasQdrantApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (
						!prev.codebaseIndexOpenAiCompatibleApiKey ||
						prev.codebaseIndexOpenAiCompatibleApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenAiCompatibleApiKey = secretStatus.hasOpenAiCompatibleApiKey
							? SECRET_PLACEHOLDER
							: ""
					}
					if (!prev.codebaseIndexGeminiApiKey || prev.codebaseIndexGeminiApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexGeminiApiKey = secretStatus.hasGeminiApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (!prev.codebaseIndexMistralApiKey || prev.codebaseIndexMistralApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexMistralApiKey = secretStatus.hasMistralApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (
						!prev.codebaseIndexVercelAiGatewayApiKey ||
						prev.codebaseIndexVercelAiGatewayApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexVercelAiGatewayApiKey = secretStatus.hasVercelAiGatewayApiKey
							? SECRET_PLACEHOLDER
							: ""
					}
					if (
						!prev.codebaseIndexOpenRouterApiKey ||
						prev.codebaseIndexOpenRouterApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenRouterApiKey = secretStatus.hasOpenRouterApiKey
							? SECRET_PLACEHOLDER
							: ""
					}

					return updated
				}

				// Only update settings if we're not in the middle of saving
				// After save is complete (saved status), we still want to update to maintain consistency
				if (saveStatus === "idle" || saveStatus === "saved") {
					setCurrentSettings(updateWithSecrets)
					setInitialSettings(updateWithSecrets)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [saveStatus])

	// Generic comparison function that detects changes between initial and current settings
	const hasUnsavedChanges = useMemo(() => {
		// Get all keys from both objects to handle any field
		const allKeys = [...Object.keys(initialSettings), ...Object.keys(currentSettings)] as Array<
			keyof LocalCodeIndexSettings
		>

		// Use a Set to ensure unique keys
		const uniqueKeys = Array.from(new Set(allKeys))

		for (const key of uniqueKeys) {
			const currentValue = currentSettings[key]
			const initialValue = initialSettings[key]

			// For secret fields, check if the value has been modified from placeholder
			if (currentValue === SECRET_PLACEHOLDER) {
				// If it's still showing placeholder, no change
				continue
			}

			// Compare values - handles all types including undefined
			if (currentValue !== initialValue) {
				return true
			}
		}

		return false
	}, [currentSettings, initialSettings])

	const updateSetting = (key: keyof LocalCodeIndexSettings, value: any) => {
		setCurrentSettings((prev) => ({ ...prev, [key]: value }))
		// Clear validation error for this field when user starts typing
		if (formErrors[key]) {
			setFormErrors((prev) => {
				const newErrors = { ...prev }
				delete newErrors[key]
				return newErrors
			})
		}
	}

	// Validation function
	const validateSettings = (): boolean => {
		const schema = createValidationSchema(currentSettings.codebaseIndexEmbedderProvider, t)

		// Prepare data for validation
		const dataToValidate: any = {}
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder values, treat them as valid (they exist in backend)
			if (value === SECRET_PLACEHOLDER) {
				// Add a dummy value that will pass validation for these fields
				if (
					key === "codeIndexOpenAiKey" ||
					key === "codebaseIndexOpenAiCompatibleApiKey" ||
					key === "codebaseIndexGeminiApiKey" ||
					key === "codebaseIndexMistralApiKey" ||
					key === "codebaseIndexVercelAiGatewayApiKey" ||
					key === "codebaseIndexOpenRouterApiKey"
				) {
					dataToValidate[key] = "placeholder-valid"
				}
			} else {
				dataToValidate[key] = value
			}
		}

		try {
			// Validate using the schema
			schema.parse(dataToValidate)
			setFormErrors({})
			return true
		} catch (error) {
			if (error instanceof z.ZodError) {
				const errors: Record<string, string> = {}
				error.errors.forEach((err) => {
					if (err.path[0]) {
						errors[err.path[0] as string] = err.message
					}
				})
				setFormErrors(errors)
			}
			return false
		}
	}

	// Discard changes functionality
	const checkUnsavedChanges = useCallback(
		(then: () => void) => {
			if (hasUnsavedChanges) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[hasUnsavedChanges],
	)

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset to initial settings
				setCurrentSettings(initialSettings)
				setFormErrors({}) // Clear any validation errors
				confirmDialogHandler.current?.() // Execute the pending action (e.g., close popover)
			}
			setDiscardDialogShow(false)
		},
		[initialSettings],
	)

	// Handle popover close with unsaved changes check
	const handlePopoverClose = useCallback(() => {
		checkUnsavedChanges(() => {
			setOpen(false)
		})
	}, [checkUnsavedChanges])

	// Use the shared ESC key handler hook - respects unsaved changes logic
	useEscapeKey(open, handlePopoverClose)

	const handleSaveSettings = () => {
		// Validate settings before saving
		if (!validateSettings()) {
			setIsSetupSettingsOpen(true)
			showSaveError("Complete the required setup fields before saving.")
			return
		}

		setSaveStatus("saving")
		setSaveError(null)

		// Prepare settings to save
		const settingsToSave: any = {}

		// Iterate through all current settings
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder, don't send the placeholder
			// but also don't send an empty string - just skip the field
			// This tells the backend to keep the existing secret
			if (value === SECRET_PLACEHOLDER) {
				// Skip sending placeholder values - backend will preserve existing secrets
				continue
			}

			// Include all other fields, including empty strings (which clear secrets)
			settingsToSave[key] = value
		}

		// Always include codebaseIndexEnabled to ensure it's persisted
		settingsToSave.codebaseIndexEnabled = currentSettings.codebaseIndexEnabled

		// Save settings to backend
		vscode.postMessage({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settingsToSave,
		})
	}

	const pipelineSnapshot = indexingStatus.pipeline
	const pipelineSummary = pipelineSnapshot?.summary
	const showDebugSection = debug || currentSettings.codebaseIndexDebugLogging
	const completedAtLabel = useMemo(() => {
		if (pipelineSnapshot?.overallState !== "completed" || !pipelineSnapshot.lastCompletedAt) {
			return null
		}
		return new Date(pipelineSnapshot.lastCompletedAt).toLocaleString()
	}, [pipelineSnapshot?.lastCompletedAt, pipelineSnapshot?.overallState])
	const getIsServiceExpanded = useCallback(
		(service: IndexingServiceSnapshot) =>
			serviceExpansionOverrides[service.id] ?? shouldExpandIndexServiceCard(service.state),
		[serviceExpansionOverrides],
	)
	const getIsRuntimeSidecarExpanded = useCallback(
		(sidecar: IndexingSidecarSnapshot) =>
			runtimeSidecarExpansionOverrides[sidecar.id] ?? shouldExpandIndexRuntimeSidecar(sidecar.state),
		[runtimeSidecarExpansionOverrides],
	)
	const getIsRuntimeTaskExpanded = useCallback(
		(task: IndexingRuntimeTaskSnapshot) =>
			runtimeTaskExpansionOverrides[task.id] ?? shouldExpandIndexRuntimeTask(task.state),
		[runtimeTaskExpansionOverrides],
	)

	const detailedStage = indexingStatus.detailedStage
	const displayedOversizedCount = Math.max(indexingStatus.oversizedFiles ?? 0, oversizedDetailsState.actionable)
	const isCurrentStandby = useMemo(
		() =>
			(indexingStatus.systemStatus === "Standby" &&
				/^(?:V2 is current(?: across| after a partial scan of)|V2 mapped )/.test(
					indexingStatus.message ?? "",
				)) ||
			(indexingStatus.systemStatus === "Indexed" &&
				/^(?:Index up-to-date(?:\.| —|$)|V2 mapped |V2 refresh re-evaluated |V2 is current across )/.test(
					indexingStatus.message ?? "",
				)),
		[indexingStatus.message, indexingStatus.systemStatus],
	)
	const runSummaryDisplay = useMemo(
		() => getRunSummaryDisplay(indexingStatus, isCurrentStandby, t, displayedOversizedCount),
		[indexingStatus, isCurrentStandby, t, displayedOversizedCount],
	)
	const codebaseProgressRows = useMemo(() => {
		return formatCodebaseProgressRows(pipelineSnapshot?.codebaseProgress)
	}, [pipelineSnapshot?.codebaseProgress])
	const recoveredProgressLabel = useMemo(() => {
		if (pipelineSummary?.recoveredProgressLabel) {
			return pipelineSummary.recoveredProgressLabel
		}
		if (pipelineSnapshot?.runMode !== "resume") {
			return null
		}
		const baselineFiles = pipelineSnapshot?.baselineIndexedFiles ?? 0
		const baselineChunks = pipelineSnapshot?.baselineSyncedChunks ?? pipelineSnapshot?.baselineIndexedChunks ?? 0
		const parts: string[] = []
		if (baselineFiles > 0) {
			parts.push(`${baselineFiles.toLocaleString()} indexed files`)
		}
		if (baselineChunks > 0) {
			parts.push(`${baselineChunks.toLocaleString()} synced chunks`)
		}
		return parts.length > 0 ? `Recovered progress: ${parts.join(" • ")} already available` : null
	}, [
		pipelineSnapshot?.baselineIndexedChunks,
		pipelineSnapshot?.baselineIndexedFiles,
		pipelineSnapshot?.baselineSyncedChunks,
		pipelineSnapshot?.runMode,
		pipelineSummary?.recoveredProgressLabel,
	])
	const elapsedChipLabel = useMemo(() => {
		if (pipelineSummary?.elapsedLabel) {
			return pipelineSummary.elapsedLabel
		}
		const elapsed = formatDurationForDisplay(getPrimaryElapsedMs(pipelineSnapshot))
		if (!elapsed) {
			return null
		}
		return pipelineSnapshot?.overallState === "completed" ? `Total time ${elapsed}` : `Elapsed ${elapsed}`
	}, [pipelineSnapshot, pipelineSummary?.elapsedLabel])
	const etaChipLabel = useMemo(() => {
		if (pipelineSummary?.etaLabel) {
			return pipelineSummary.etaLabel
		}
		if (pipelineSnapshot?.overallState === "running" && indexingStatus.estimatedTimeRemainingMs != null) {
			return formatEtaForDisplay(indexingStatus.estimatedTimeRemainingMs)
		}
		return null
	}, [indexingStatus.estimatedTimeRemainingMs, pipelineSnapshot?.overallState, pipelineSummary?.etaLabel])
	const phaseTimingItems = useMemo(() => {
		const phaseTiming = pipelineSnapshot?.phaseTimingMs
		if (!phaseTiming) {
			return []
		}
		const items = [
			{ key: "discovery", label: "Discovery", ms: phaseTiming.discoveryMs },
			{ key: "fileChecks", label: "File checks", ms: phaseTiming.fileChecksMs },
			{ key: "parse", label: "Parse", ms: phaseTiming.parseMs },
			{ key: "plan", label: "Plan", ms: phaseTiming.planMs },
			{ key: "embedSync", label: "Embed/sync", ms: phaseTiming.embedSyncMs },
		]
		return items
			.map((item) => ({
				...item,
				value: formatDurationForDisplay(item.ms),
			}))
			.filter((item): item is typeof item & { value: string } => Boolean(item.value))
	}, [pipelineSnapshot?.phaseTimingMs])
	const progressPercentage = useMemo(() => {
		if (pipelineSummary?.progressPercent != null) {
			return Math.min(100, Math.max(0, Math.round(pipelineSummary.progressPercent)))
		}
		if (
			detailedStage === "embedding" &&
			indexingStatus.hasStartedVectorSync &&
			indexingStatus.totalBlocks &&
			indexingStatus.totalBlocks > 0
		) {
			return Math.min(100, Math.round(((indexingStatus.blocksEmbedded ?? 0) / indexingStatus.totalBlocks) * 100))
		}
		if (detailedStage === "discovering") {
			const processed = indexingStatus.processedItems ?? 0
			const rawTotal = Math.max(indexingStatus.totalItems ?? 0, processed, 1)
			const guardedTotal = rawTotal <= processed ? Math.max(Math.ceil(processed * 1.1), processed + 1) : rawTotal
			return Math.min(99, Math.round((processed / guardedTotal) * 100))
		}
		if (
			detailedStage === "preparing" ||
			detailedStage === "planning_vectors" ||
			(detailedStage === "embedding" && !indexingStatus.hasStartedVectorSync)
		) {
			return 0
		}
		// Fall back to legacy fields
		return indexingStatus.totalItems > 0
			? Math.min(100, Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100))
			: 0
	}, [
		detailedStage,
		indexingStatus.hasStartedVectorSync,
		indexingStatus.blocksEmbedded,
		indexingStatus.totalBlocks,
		indexingStatus.processedItems,
		indexingStatus.totalItems,
		pipelineSummary?.progressPercent,
	])

	const transformStyleString = `translateX(-${100 - progressPercentage}%)`
	const isIndeterminateEmbeddingProgress = useMemo(() => {
		if (pipelineSummary) {
			return Boolean(pipelineSummary.indeterminate)
		}
		return (
			indexingStatus.systemStatus === "Indexing" &&
			(detailedStage === "preparing" ||
				detailedStage === "reconciling" ||
				detailedStage === "planning_vectors" ||
				(detailedStage === "embedding" && !indexingStatus.hasStartedVectorSync))
		)
	}, [detailedStage, indexingStatus.hasStartedVectorSync, indexingStatus.systemStatus, pipelineSummary])
	const runProgressLabel = pipelineSummary?.progressUnit
		? `Run progress • ${pipelineSummary.progressUnit}`
		: "Run progress"
	const runProgressValueLabel = isIndeterminateEmbeddingProgress ? "Working" : `${progressPercentage}%`
	const resilienceHighlights = useMemo(() => {
		const resumedPendingJobs = indexingStatus.resumedPendingJobs ?? 0
		const warningItems = [
			indexingStatus.retryingParseRevisions
				? formatCountLabel(indexingStatus.retryingParseRevisions, "parser retry", "parser retries")
				: null,
			indexingStatus.terminalFailedParseRevisions
				? formatCountLabel(
						indexingStatus.terminalFailedParseRevisions,
						"parser-failed file",
						"parser-failed files",
					)
				: null,
			indexingStatus.retryingChunks
				? formatCountLabel(indexingStatus.retryingChunks, "retrying chunk", "retrying chunks")
				: null,
			indexingStatus.terminallyFailedChunks
				? formatCountLabel(indexingStatus.terminallyFailedChunks, "failed chunk", "failed chunks")
				: null,
			indexingStatus.degradedRevisions
				? formatCountLabel(indexingStatus.degradedRevisions, "degraded file", "degraded files")
				: null,
			indexingStatus.terminalFailedRevisions
				? formatCountLabel(indexingStatus.terminalFailedRevisions, "failed file", "failed files")
				: null,
		].filter((item): item is string => Boolean(item))

		return {
			resumedPendingJobs,
			warningItems,
		}
	}, [
		indexingStatus.degradedRevisions,
		indexingStatus.resumedPendingJobs,
		indexingStatus.retryingChunks,
		indexingStatus.retryingParseRevisions,
		indexingStatus.terminalFailedParseRevisions,
		indexingStatus.terminalFailedRevisions,
		indexingStatus.terminallyFailedChunks,
	])
	const warningDetails = useMemo(() => warningDetailsState.items, [warningDetailsState.items])
	const oversizedDetails = useMemo(() => oversizedDetailsState.items, [oversizedDetailsState.items])
	const warningFilterOptions = useMemo(
		() => [
			{ value: "all" as const, label: "All warnings" },
			{ value: "parser_failed" as const, label: "Parser failures" },
			{ value: "failed" as const, label: "Failed files" },
			{ value: "degraded" as const, label: "Degraded files" },
		],
		[],
	)
	const warningSortOptions = useMemo(
		() => [
			{ value: "severity" as const, label: "Severity" },
			{ value: "recent" as const, label: "Newest" },
			{ value: "path" as const, label: "Path" },
		],
		[],
	)
	const shouldShowRefreshAction =
		currentSettings.codebaseIndexEnabled && (indexingStatus.systemStatus === "Indexed" || isCurrentStandby)
	const shouldShowStartAction =
		currentSettings.codebaseIndexEnabled &&
		(indexingStatus.systemStatus === "Error" || (indexingStatus.systemStatus === "Standby" && !isCurrentStandby))

	const getAvailableModels = () => {
		if (!codebaseIndexModels) return []

		const models =
			codebaseIndexModels[currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels]
		return models ? Object.keys(models) : []
	}

	// Fetch OpenRouter model providers for embedding model
	const { data: openRouterEmbeddingProviders } = useOpenRouterModelProviders(
		currentSettings.codebaseIndexEmbedderProvider === "openrouter"
			? currentSettings.codebaseIndexEmbedderModelId
			: undefined,
		undefined,
		{
			enabled:
				currentSettings.codebaseIndexEmbedderProvider === "openrouter" &&
				!!currentSettings.codebaseIndexEmbedderModelId,
		},
	)

	const portalContainer = useRooPortal("roo-portal")
	const surfaceCardClass =
		"rounded-2xl border border-vscode-dropdown-border/90 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
	const disclosureButtonClass =
		"flex w-full items-center justify-between rounded-2xl border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-4 py-2.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.035)] focus:outline-none"
	const disclosurePanelClass = "mt-2"
	const sectionLabelClass =
		"text-[10px] font-semibold uppercase tracking-[0.14em] text-vscode-descriptionForeground/70"
	const fieldGroupClass =
		"grid gap-1.5 px-3 py-2.5 [&>label]:text-[11px] [&>label]:font-semibold [&>label]:uppercase [&>label]:tracking-[0.08em] [&>label]:text-vscode-descriptionForeground/78"
	const groupedListClass =
		"overflow-hidden rounded-xl border border-vscode-dropdown-border/55 bg-[rgba(255,255,255,0.012)] divide-y divide-vscode-dropdown-border/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
	const footerButtonClass =
		"h-10 w-full justify-center rounded-full px-4 text-sm font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all sm:w-auto"
	const footerSecondaryButtonClass = `${footerButtonClass} border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.04)] text-vscode-foreground hover:bg-[rgba(255,255,255,0.08)]`
	const footerDestructiveButtonClass = `${footerButtonClass} border border-red-500/25 bg-[rgba(255,120,120,0.08)] text-vscode-foreground hover:bg-[rgba(255,120,120,0.14)]`
	const footerPrimaryButtonClass = `${footerButtonClass} min-w-[96px] bg-primary text-primary-foreground hover:bg-primary/85`
	const footerDisabledButtonClass =
		"h-10 w-full min-w-[96px] rounded-full border border-vscode-dropdown-border/50 bg-[rgba(255,255,255,0.03)] px-4 text-sm font-medium text-vscode-descriptionForeground/70 shadow-none sm:w-auto"
	const numericTextClass = "[font-variant-numeric:tabular-nums] tabular-nums whitespace-nowrap text-right"
	const stableChipClass =
		"flex min-h-[34px] min-w-0 items-center rounded-xl border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-3 py-1.5 text-[11px] text-vscode-descriptionForeground/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:rounded-full"
	const clearIndexAction = (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button variant="secondary" className={footerDestructiveButtonClass}>
					{t("settings:codeIndex.clearIndexDataButton")}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("settings:codeIndex.clearDataDialog.title")}</AlertDialogTitle>
					<AlertDialogDescription>
						{t("settings:codeIndex.clearDataDialog.description")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t("settings:codeIndex.clearDataDialog.cancelButton")}</AlertDialogCancel>
					<AlertDialogAction onClick={() => vscode.postMessage({ type: "clearIndexData" })}>
						{t("settings:codeIndex.clearDataDialog.confirmButton")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
	const clearDatabaseAction = (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button variant="secondary" className={footerDestructiveButtonClass}>
					{t("settings:codeIndex.clearIndexDatabaseButton")}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("settings:codeIndex.clearDatabaseDialog.title")}</AlertDialogTitle>
					<AlertDialogDescription>
						{t("settings:codeIndex.clearDatabaseDialog.description")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t("settings:codeIndex.clearDatabaseDialog.cancelButton")}</AlertDialogCancel>
					<AlertDialogAction onClick={() => vscode.postMessage({ type: "clearIndexDatabase" })}>
						{t("settings:codeIndex.clearDatabaseDialog.confirmButton")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
	const runActionButtons = (
		<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
			{shouldShowStartAction && (
				<Button
					variant="outline"
					className={footerSecondaryButtonClass}
					onClick={() => vscode.postMessage({ type: "startIndexing" })}
					disabled={saveStatus === "saving" || hasUnsavedChanges}>
					{t("settings:codeIndex.startIndexingButton")}
				</Button>
			)}

			{shouldShowRefreshAction && (
				<Button
					variant="outline"
					className={footerSecondaryButtonClass}
					onClick={() => vscode.postMessage({ type: "fullRefreshIndexData" })}
					disabled={saveStatus === "saving" || hasUnsavedChanges}>
					{isCurrentStandby
						? t("settings:codeIndex.refreshIndexButton")
						: t("settings:codeIndex.reindexButton")}
				</Button>
			)}

			{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Indexing" && (
				<Button
					variant="destructive"
					className={footerDestructiveButtonClass}
					onClick={() => vscode.postMessage({ type: "stopIndexing" })}>
					{t("settings:codeIndex.stopIndexingButton")}
				</Button>
			)}

			{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Stopping" && (
				<Button variant="destructive" className={footerDestructiveButtonClass} disabled>
					{t("settings:codeIndex.stoppingButton")}
				</Button>
			)}

			{currentSettings.codebaseIndexEnabled &&
				indexingStatus.systemStatus !== "Indexing" &&
				indexingStatus.systemStatus !== "Stopping" && (
					<>
						{clearIndexAction}
						{clearDatabaseAction}
					</>
				)}
		</div>
	)

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(newOpen) => {
					if (!newOpen) {
						// User is trying to close the popover
						handlePopoverClose()
					} else {
						setActiveTab(
							getDefaultCodeIndexPopoverTab(
								currentSettings.codebaseIndexEnabled,
								externalIndexingStatus.pipeline,
							),
						)
						setServiceExpansionOverrides({})
						setOpen(newOpen)
					}
				}}>
				{children}
				<PopoverContent
					className="flex w-[calc(100vw-32px)] max-w-[470px] flex-col overflow-hidden border border-vscode-dropdown-border/90 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),rgba(255,255,255,0.015)_38%,rgba(0,0,0,0.06)_100%)] p-0 shadow-[0_24px_80px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
					style={{
						height: "min(88vh, var(--radix-popover-content-available-height))",
						maxHeight: "min(88vh, var(--radix-popover-content-available-height))",
					}}
					align="end"
					alignOffset={0}
					side="top"
					sideOffset={5}
					collisionPadding={16}
					avoidCollisions={true}
					container={portalContainer}>
					<div className="cursor-default flex-shrink-0 border-b border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.015)] px-5 py-4">
						<div className="mb-2 flex flex-row items-center gap-1 p-0">
							<h4 className="m-0 flex-1 text-[14px] font-semibold tracking-[-0.01em]">
								{t("settings:codeIndex.title")}
							</h4>
						</div>
						<p className="my-0 max-w-[38ch] pr-2 text-[13px] leading-5 text-vscode-descriptionForeground">
							<Trans i18nKey="settings:codeIndex.description">
								<VSCodeLink
									href={buildDocLink("features/experimental/codebase-indexing", "settings")}
									className="inline"
								/>
							</Trans>
						</p>
					</div>

					<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-5 pb-8">
						<div className="mb-4 flex items-center gap-2 rounded-xl border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.02)] p-1.5">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									"h-9 flex-1 rounded-lg text-sm",
									activeTab === "overview"
										? "bg-[rgba(80,168,255,0.14)] text-vscode-foreground"
										: "text-vscode-descriptionForeground hover:bg-[rgba(255,255,255,0.05)]",
								)}
								onClick={() => setActiveTab("overview")}>
								Overview
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									"h-9 flex-1 rounded-lg text-sm",
									activeTab === "settings"
										? "bg-[rgba(80,168,255,0.14)] text-vscode-foreground"
										: "text-vscode-descriptionForeground hover:bg-[rgba(255,255,255,0.05)]",
								)}
								onClick={() => setActiveTab("settings")}>
								Settings
							</Button>
						</div>

						{activeTab === "overview" && (
							<div className="space-y-4">
								<div className="space-y-2">
									<div className={sectionLabelClass}>Run Summary</div>
									<div className={`${surfaceCardClass} p-4`}>
										<div className="flex items-start gap-3">
											<span
												className={cn(
													"mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_rgba(245,158,11,0.35)]",
													{
														"bg-gray-400":
															indexingStatus.systemStatus === "Standby" &&
															!isCurrentStandby,
														"bg-yellow-500 animate-pulse":
															indexingStatus.systemStatus === "Indexing",
														"bg-green-500":
															indexingStatus.systemStatus === "Indexed" ||
															isCurrentStandby,
														"bg-amber-500 animate-pulse":
															indexingStatus.systemStatus === "Stopping",
														"bg-red-500": indexingStatus.systemStatus === "Error",
													},
												)}
											/>
											<div className="min-w-0 flex-1 space-y-3">
												<div>
													<div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-vscode-descriptionForeground/70">
														{pipelineSnapshot
															? getIndexingOverallStateLabel(pipelineSnapshot)
															: t("settings:codeIndex.statusTitle")}
													</div>
													<div className="mt-1 text-[16px] font-semibold leading-5 tracking-[-0.01em] text-vscode-foreground">
														{runSummaryDisplay.headline || "Code index overview"}
													</div>
													{(runSummaryDisplay.progressLine ||
														runSummaryDisplay.secondaryLine) && (
														<div className="mt-2 space-y-1 text-[12px] leading-5 text-vscode-descriptionForeground">
															{runSummaryDisplay.progressLine && (
																<div className="text-vscode-foreground/92">
																	{runSummaryDisplay.progressLine}
																</div>
															)}
															{runSummaryDisplay.secondaryLine && (
																<div>{runSummaryDisplay.secondaryLine}</div>
															)}
														</div>
													)}
												</div>

												{codebaseProgressRows.length > 0 && (
													<div className="grid gap-2 sm:grid-cols-2">
														{codebaseProgressRows.map((row) => (
															<div
																key={row.key}
																className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2.5">
																<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																	{row.label}
																</div>
																<div className="mt-2 text-[12px] leading-4 tracking-[-0.01em] text-vscode-foreground/92">
																	{row.value}
																</div>
															</div>
														))}
													</div>
												)}

												{recoveredProgressLabel && (
													<div className="text-[11px] leading-4 text-vscode-descriptionForeground/92">
														{recoveredProgressLabel}
													</div>
												)}

												<div className="flex flex-wrap gap-1.5">
													{pipelineSnapshot && (
														<>
															<span
																className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] ${getHealthToneClass(pipelineSnapshot.overallHealth)}`}>
																{getHealthLabel(pipelineSnapshot.overallHealth)}
															</span>
															<span className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-vscode-descriptionForeground">
																{getIndexingRunModeLabel(pipelineSnapshot)}
															</span>
														</>
													)}
													{elapsedChipLabel ? (
														<span
															className={cn(
																stableChipClass,
																"min-h-[30px] px-2.5 py-1 text-[10px]",
															)}>
															{elapsedChipLabel}
														</span>
													) : null}
													{etaChipLabel ? (
														<span
															className={cn(
																stableChipClass,
																"min-h-[30px] px-2.5 py-1 text-[10px]",
															)}>
															{etaChipLabel}
														</span>
													) : completedAtLabel ? (
														<span className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[10px] text-vscode-descriptionForeground">
															Completed {completedAtLabel}
														</span>
													) : null}
												</div>

												{phaseTimingItems.length > 0 && (
													<div className="flex flex-wrap gap-1.5">
														{phaseTimingItems.map((item) => (
															<span
																key={item.key}
																className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[10px] text-vscode-descriptionForeground">
																{item.label} {item.value}
															</span>
														))}
													</div>
												)}

												{indexingStatus.systemStatus === "Indexing" && (
													<div className="space-y-2">
														<div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.1em] text-vscode-descriptionForeground/70">
															<span>{runProgressLabel}</span>
															<span>{runProgressValueLabel}</span>
														</div>
														<div className="flex items-center gap-2">
															<ProgressPrimitive.Root
																className="relative h-2.5 w-full min-w-[80px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]"
																value={progressPercentage}>
																<ProgressPrimitive.Indicator
																	className={cn(
																		"h-full w-full flex-1 bg-[linear-gradient(90deg,rgba(80,168,255,0.9),rgba(128,203,255,0.92))] transition-transform duration-300 ease-in-out",
																		isIndeterminateEmbeddingProgress &&
																			"animate-pulse opacity-75",
																	)}
																	style={{
																		transform: isIndeterminateEmbeddingProgress
																			? "translateX(-72%)"
																			: transformStyleString,
																	}}
																/>
															</ProgressPrimitive.Root>
															<span
																className={cn(
																	"min-w-[3.75rem] text-xs font-medium text-vscode-descriptionForeground",
																	numericTextClass,
																)}>
																{isIndeterminateEmbeddingProgress
																	? "Working"
																	: `${progressPercentage}%`}
															</span>
														</div>
													</div>
												)}

												<div className="pt-1">{runActionButtons}</div>
											</div>
										</div>
									</div>
								</div>

								{pipelineSnapshot?.runtime?.sidecars?.length ||
								pipelineSnapshot?.runtime?.tasks?.length ? (
									<div className="space-y-2">
										<div className={sectionLabelClass}>Index runtime</div>
										{pipelineSnapshot.runtime.sidecars?.length ? (
											<div className="grid gap-3 sm:grid-cols-2">
												{pipelineSnapshot.runtime.sidecars.map((sidecar) => {
													const hasExpandableDetails =
														hasExpandableIndexRuntimeSidecarContent(sidecar)
													const expanded = getIsRuntimeSidecarExpanded(sidecar)
													const visibleMetrics = getVisibleIndexRuntimeSidecarMetrics(
														sidecar,
														expanded,
													)
													const cardHeaderClass = cn(
														"flex w-full items-start justify-between gap-3 px-4 py-4 text-left",
														hasExpandableDetails &&
															"transition-colors hover:bg-[rgba(255,255,255,0.02)]",
													)
													const toggleRuntimeSidecarDetails = () => {
														if (!hasExpandableDetails) {
															return
														}
														setRuntimeSidecarExpansionOverrides((prev) => ({
															...prev,
															[sidecar.id]: !(
																prev[sidecar.id] ??
																shouldExpandIndexRuntimeSidecar(sidecar.state)
															),
														}))
													}
													const sidecarHeaderContent = (
														<>
															<div className="min-w-0 flex-1">
																<div className="flex items-center gap-2">
																	<span
																		className={`inline-block h-2.5 w-2.5 rounded-full ${getHealthDotClass(sidecar.health)}`}
																	/>
																	<span className="text-[13px] font-semibold tracking-[-0.01em] text-vscode-foreground">
																		{sidecar.title}
																	</span>
																</div>
																<div className="mt-1 text-[12px] leading-4 text-vscode-descriptionForeground">
																	{sidecar.summary}
																</div>
															</div>
															<div className="flex shrink-0 flex-col items-end gap-1">
																<span
																	className={`rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] ${getRuntimeSidecarStateToneClass(sidecar.state)}`}>
																	{getRuntimeSidecarStateLabel(sidecar.state)}
																</span>
																{sidecar.pendingRequestCount ? (
																	<span className="text-[10px] text-vscode-descriptionForeground">
																		{sidecar.pendingRequestCount.toLocaleString()}{" "}
																		pending
																	</span>
																) : null}
															</div>
														</>
													)
													return (
														<div
															key={sidecar.id}
															className={`${surfaceCardClass} overflow-hidden`}>
															{hasExpandableDetails ? (
																<button
																	type="button"
																	onClick={toggleRuntimeSidecarDetails}
																	className={cardHeaderClass}>
																	{sidecarHeaderContent}
																</button>
															) : (
																<div className={cardHeaderClass}>
																	{sidecarHeaderContent}
																</div>
															)}
															<div className="space-y-3 px-4 pb-4">
																{expanded && sidecar.detail && (
																	<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
																		{sidecar.detail}
																	</div>
																)}
																<div className="grid gap-2 sm:grid-cols-2">
																	{visibleMetrics.map((metric) => (
																		<div
																			key={`${sidecar.id}:${metric.key}`}
																			className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2.5">
																			<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																				{metric.label}
																			</div>
																			<div
																				className={cn(
																					"mt-2 text-[12px] leading-4 tracking-[-0.01em]",
																					metric.tone === "good"
																						? "text-emerald-200"
																						: metric.tone === "warning"
																							? "text-amber-200"
																							: metric.tone === "critical"
																								? "text-red-200"
																								: "text-vscode-foreground/92",
																				)}>
																				{metric.value}
																			</div>
																		</div>
																	))}
																</div>
																{hasExpandableDetails && (
																	<button
																		type="button"
																		onClick={toggleRuntimeSidecarDetails}
																		className="text-[11px] font-medium text-vscode-descriptionForeground transition-colors hover:text-vscode-foreground">
																		{expanded ? "Hide details" : "Show details"}
																	</button>
																)}
															</div>
														</div>
													)
												})}
											</div>
										) : null}
										{pipelineSnapshot.runtime.tasks?.length ? (
											<div className="grid gap-3">
												{pipelineSnapshot.runtime.tasks.map((task) => {
													const hasExpandableDetails =
														hasExpandableIndexRuntimeTaskContent(task)
													const expanded = getIsRuntimeTaskExpanded(task)
													const visibleMetrics = getVisibleIndexRuntimeTaskMetrics(
														task,
														expanded,
													)
													const compactionAction = getMetadataCleanupCompactionAction(task)
													const progressLabel = formatRuntimeTaskProgress(task)
													const cardHeaderClass = cn(
														"flex w-full items-start justify-between gap-3 px-4 py-4 text-left",
														hasExpandableDetails &&
															"transition-colors hover:bg-[rgba(255,255,255,0.02)]",
													)
													const toggleRuntimeTaskDetails = () => {
														if (!hasExpandableDetails) {
															return
														}
														setRuntimeTaskExpansionOverrides((prev) => ({
															...prev,
															[task.id]: !(
																prev[task.id] ??
																shouldExpandIndexRuntimeTask(task.state)
															),
														}))
													}
													const taskHeaderContent = (
														<>
															<div className="min-w-0 flex-1">
																<div className="flex items-center gap-2">
																	<span
																		className={`inline-block h-2.5 w-2.5 rounded-full ${getHealthDotClass(task.health)}`}
																	/>
																	<span className="text-[13px] font-semibold tracking-[-0.01em] text-vscode-foreground">
																		{task.title}
																	</span>
																</div>
																<div className="mt-1 text-[12px] leading-4 text-vscode-descriptionForeground">
																	{task.summary}
																</div>
															</div>
															<div className="flex shrink-0 flex-col items-end gap-1">
																<span
																	className={`rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] ${getRuntimeTaskStateToneClass(task.state)}`}>
																	{getRuntimeTaskStateLabel(task.state)}
																</span>
															</div>
														</>
													)
													return (
														<div
															key={task.id}
															className={`${surfaceCardClass} overflow-hidden`}>
															{hasExpandableDetails ? (
																<button
																	type="button"
																	onClick={toggleRuntimeTaskDetails}
																	className={cardHeaderClass}>
																	{taskHeaderContent}
																</button>
															) : (
																<div className={cardHeaderClass}>
																	{taskHeaderContent}
																</div>
															)}
															<div className="space-y-3 px-4 pb-4">
																{(task.phaseLabel ||
																	task.rateLabel ||
																	task.etaLabel ||
																	progressLabel) && (
																	<div className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-3">
																		<div className="flex items-center justify-between gap-3">
																			<div>
																				<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																					{task.phaseLabel
																						? "Current step"
																						: "Progress"}
																				</div>
																				<div className="mt-1 text-[12px] leading-4 text-vscode-foreground/92">
																					{task.phaseLabel ??
																						progressLabel ??
																						"In progress"}
																				</div>
																			</div>
																			{task.rateLabel && (
																				<div className="shrink-0 rounded-full border border-vscode-dropdown-border/60 px-2 py-1 text-[10px] text-vscode-descriptionForeground">
																					{task.rateLabel}
																				</div>
																			)}
																		</div>
																		{progressLabel && (
																			<div className="mt-3 space-y-1.5">
																				<div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.1em] text-vscode-descriptionForeground/70">
																					<span>Progress</span>
																					<span>{progressLabel}</span>
																				</div>
																				<div className="h-2 overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
																					<div
																						className="h-full rounded-full bg-[rgba(147,197,253,0.78)] transition-[width] duration-300"
																						style={{
																							width: task.indeterminate
																								? "35%"
																								: `${Math.max(0, Math.min(100, task.progressPercent ?? 0))}%`,
																						}}
																					/>
																				</div>
																			</div>
																		)}
																		{task.etaLabel && (
																			<div className="mt-2 text-[11px] leading-4 text-vscode-descriptionForeground">
																				Next step: {task.etaLabel}
																			</div>
																		)}
																	</div>
																)}
																{expanded && task.detail && (
																	<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
																		{task.detail}
																	</div>
																)}
																<div className="grid gap-2 sm:grid-cols-2">
																	{visibleMetrics.map((metric) => (
																		<div
																			key={`${task.id}:${metric.key}`}
																			className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2.5">
																			<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																				{metric.label}
																			</div>
																			<div
																				className={cn(
																					"mt-2 text-[12px] leading-4 tracking-[-0.01em]",
																					metric.tone === "good"
																						? "text-emerald-200"
																						: metric.tone === "warning"
																							? "text-amber-200"
																							: metric.tone === "critical"
																								? "text-red-200"
																								: "text-vscode-foreground/92",
																				)}>
																				{metric.value}
																			</div>
																		</div>
																	))}
																</div>
																{expanded && task.id === "metadata_cleanup" && (
																	<div className="space-y-2 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-3">
																		<div>
																			<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																				Advanced action
																			</div>
																			<div className="mt-1 text-[11px] leading-4 text-vscode-descriptionForeground">
																				Compact the metadata DB file only after
																				cleanup has completed. This can take
																				minutes, temporarily needs free disk
																				space, and pauses metadata search/UI
																				reads while it runs.
																			</div>
																		</div>
																		{metadataCompactionMessage && (
																			<div
																				className={cn(
																					"rounded-lg border px-3 py-2 text-[11px] leading-4",
																					metadataCompactionMessage.tone ===
																						"good"
																						? "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"
																						: "border-red-500/25 bg-red-500/10 text-red-100",
																				)}>
																				{metadataCompactionMessage.text}
																			</div>
																		)}
																		{compactionAction ? (
																			compactionAction.enabled &&
																			!metadataCompactionPending ? (
																				<AlertDialog>
																					<AlertDialogTrigger asChild>
																						<Button
																							type="button"
																							variant="secondary"
																							className={
																								footerSecondaryButtonClass
																							}>
																							{compactionAction.label}
																						</Button>
																					</AlertDialogTrigger>
																					<AlertDialogContent>
																						<AlertDialogHeader>
																							<AlertDialogTitle>
																								Compact metadata DB
																								file?
																							</AlertDialogTitle>
																							<AlertDialogDescription>
																								This rewrites the
																								operational metadata
																								SQLite DB to reclaim
																								space after safe
																								pruning. It may take
																								several minutes, needs
																								temporary free disk
																								space, and pauses
																								metadata search/UI reads
																								until compaction
																								finishes. Run it only
																								while indexing is idle.
																							</AlertDialogDescription>
																						</AlertDialogHeader>
																						<AlertDialogFooter>
																							<AlertDialogCancel>
																								Cancel
																							</AlertDialogCancel>
																							<AlertDialogAction
																								onClick={() => {
																									setMetadataCompactionPending(
																										true,
																									)
																									setMetadataCompactionMessage(
																										null,
																									)
																									vscode.postMessage({
																										type: "compactCodeIndexMetadata",
																									})
																								}}>
																								Compact DB file
																							</AlertDialogAction>
																						</AlertDialogFooter>
																					</AlertDialogContent>
																				</AlertDialog>
																			) : (
																				<div className="space-y-1">
																					<Button
																						type="button"
																						variant="secondary"
																						className={
																							footerDisabledButtonClass
																						}
																						disabled>
																						{metadataCompactionPending
																							? "Compacting DB file..."
																							: compactionAction.label}
																					</Button>
																					{compactionAction.reason && (
																						<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
																							{compactionAction.reason}
																						</div>
																					)}
																				</div>
																			)
																		) : (
																			<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
																				Compact DB file becomes available after
																				safe cleanup reaches the completed
																				marker and reports reclaimable space.
																			</div>
																		)}
																	</div>
																)}
																{hasExpandableDetails && (
																	<button
																		type="button"
																		onClick={toggleRuntimeTaskDetails}
																		className="text-[11px] font-medium text-vscode-descriptionForeground transition-colors hover:text-vscode-foreground">
																		{expanded ? "Hide details" : "Show details"}
																	</button>
																)}
															</div>
														</div>
													)
												})}
											</div>
										) : null}
									</div>
								) : null}

								<div className="space-y-2">
									<div className={sectionLabelClass}>Services</div>
									<div className="grid gap-3 sm:grid-cols-2">
										{pipelineSnapshot?.services?.map((service) => {
											const hasExpandableDetails = hasExpandableIndexServiceCardContent(service)
											const expanded = getIsServiceExpanded(service)
											const visibleMetrics = getVisibleIndexServiceMetrics(service, expanded)
											const cardHeaderClass = cn(
												"flex w-full items-start justify-between gap-3 px-4 py-4 text-left",
												hasExpandableDetails &&
													"transition-colors hover:bg-[rgba(255,255,255,0.02)]",
											)
											const toggleServiceDetails = () => {
												if (!hasExpandableDetails) {
													return
												}
												setServiceExpansionOverrides((prev) => ({
													...prev,
													[service.id]: !(
														prev[service.id] ?? shouldExpandIndexServiceCard(service.state)
													),
												}))
											}
											const serviceHeaderContent = (
												<>
													<div className="min-w-0 flex-1">
														<div className="flex items-center gap-2">
															<span
																className={`inline-block h-2.5 w-2.5 rounded-full ${getHealthDotClass(service.health)}`}
															/>
															<span className="text-[13px] font-semibold tracking-[-0.01em] text-vscode-foreground">
																{service.title}
															</span>
														</div>
														<div className="mt-1 text-[12px] leading-4 text-vscode-descriptionForeground">
															{service.summary}
														</div>
													</div>
													<div className="flex shrink-0 flex-col items-end gap-1">
														<span
															className={`rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] ${getServiceStateToneClass(service.state)}`}>
															{getServiceStateLabel(service.state)}
														</span>
														{service.issueCount ? (
															<span className="text-[10px] text-vscode-descriptionForeground">
																{service.issueCount.toLocaleString()} issues
															</span>
														) : null}
													</div>
												</>
											)
											return (
												<div key={service.id} className={`${surfaceCardClass} overflow-hidden`}>
													{hasExpandableDetails ? (
														<button
															type="button"
															onClick={toggleServiceDetails}
															className={cardHeaderClass}>
															{serviceHeaderContent}
														</button>
													) : (
														<div className={cardHeaderClass}>{serviceHeaderContent}</div>
													)}
													<div className="space-y-3 px-4 pb-4">
														{formatServiceProgress(service) && (
															<div className="space-y-2">
																<div className="flex items-center justify-between gap-2 text-[11px] text-vscode-descriptionForeground">
																	<span>{formatServiceProgress(service)}</span>
																	{service.progressPercent != null &&
																	!service.indeterminate ? (
																		<span className={numericTextClass}>
																			{service.progressPercent}%
																		</span>
																	) : (
																		<span>
																			{service.indeterminate ? "Active" : "n/a"}
																		</span>
																	)}
																</div>
																<ProgressPrimitive.Root
																	className="relative h-2 overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]"
																	value={service.progressPercent ?? undefined}>
																	<ProgressPrimitive.Indicator
																		className={cn(
																			"h-full w-full flex-1 bg-[linear-gradient(90deg,rgba(80,168,255,0.9),rgba(128,203,255,0.92))] transition-transform duration-300 ease-in-out",
																			service.indeterminate &&
																				"animate-pulse opacity-75",
																		)}
																		style={{
																			transform:
																				service.indeterminate ||
																				service.progressPercent == null
																					? "translateX(-72%)"
																					: `translateX(-${100 - service.progressPercent}%)`,
																		}}
																	/>
																</ProgressPrimitive.Root>
															</div>
														)}
														{service.detail && (
															<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
																{service.detail}
															</div>
														)}
														<div className="grid gap-2 sm:grid-cols-2">
															{visibleMetrics.map((metric) => (
																<div
																	key={`${service.id}:${metric.key}`}
																	className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2.5">
																	<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
																		{metric.label}
																	</div>
																	<div
																		className={cn(
																			"mt-2 text-[12px] leading-4 tracking-[-0.01em]",
																			metric.tone === "good"
																				? "text-emerald-200"
																				: metric.tone === "warning"
																					? "text-amber-200"
																					: metric.tone === "critical"
																						? "text-red-200"
																						: "text-vscode-foreground/92",
																		)}>
																		{metric.value}
																	</div>
																</div>
															))}
														</div>
														{hasExpandableDetails && (
															<button
																type="button"
																onClick={toggleServiceDetails}
																className="text-[11px] font-medium text-vscode-descriptionForeground transition-colors hover:text-vscode-foreground">
																{expanded ? "Hide details" : "Show details"}
															</button>
														)}
													</div>
												</div>
											)
										}) ?? (
											<div
												className={`${surfaceCardClass} px-4 py-5 text-[12px] leading-5 text-vscode-descriptionForeground`}>
												Indexing services will appear here when a run starts.
											</div>
										)}
									</div>
								</div>

								<div className="space-y-2">
									<div className={sectionLabelClass}>Exceptions &amp; Review</div>
									<div className="space-y-3">
										{(resilienceHighlights.resumedPendingJobs > 0 ||
											resilienceHighlights.warningItems.length > 0) && (
											<div className={`${surfaceCardClass} p-3`}>
												<div className="flex items-start justify-between gap-3">
													<div>
														<div className="flex items-center gap-2 text-[12px] font-medium text-vscode-foreground">
															<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
															<span>Indexing warnings</span>
														</div>
														<div className="mt-1 text-[11px] leading-4 text-vscode-descriptionForeground">
															{INDEXING_WARNING_HELP_TEXT}
														</div>
													</div>
													{resilienceHighlights.resumedPendingJobs > 0 && (
														<span className="rounded-full border border-sky-500/25 bg-[rgba(80,168,255,0.1)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-sky-200">
															Resuming{" "}
															{resilienceHighlights.resumedPendingJobs.toLocaleString()}
														</span>
													)}
												</div>
												{resilienceHighlights.warningItems.length > 0 && (
													<div className="mt-3 flex flex-wrap gap-1.5">
														{resilienceHighlights.warningItems.map((item) => (
															<span
																key={item}
																className="rounded-full border border-amber-500/20 bg-[rgba(255,255,255,0.05)] px-2.5 py-1 text-[11px] leading-none text-vscode-descriptionForeground/96">
																{item}
															</span>
														))}
													</div>
												)}
												{(warningDetailsState.total > 0 ||
													warningDetailsState.loading ||
													warningDetailsBootstrapped) && (
													<div className="mt-3 space-y-2">
														<div className="flex items-center justify-between gap-2">
															<div>
																<div className="text-[11px] font-medium text-vscode-foreground/90">
																	Affected files
																</div>
																<div className="mt-1 text-[10px] text-vscode-descriptionForeground/85">
																	Showing {warningDetails.length.toLocaleString()} of{" "}
																	{warningDetailsState.total.toLocaleString()}{" "}
																	matching files
																</div>
															</div>
															<button
																type="button"
																onClick={() => {
																	setRetryWarningsPending(true)
																	resetWarningDetailsState(warningFilter, warningSort)
																	vscode.postMessage({
																		type: "retryIndexingWarnings",
																		values: {
																			filter: warningFilter,
																		},
																	})
																}}
																disabled={
																	retryWarningsPending ||
																	indexingStatus.systemStatus === "Indexing"
																}
																className="rounded-lg border border-amber-500/30 bg-[rgba(245,158,11,0.12)] px-3 py-1.5 text-[11px] font-medium text-vscode-foreground transition-colors hover:bg-[rgba(245,158,11,0.18)] disabled:cursor-default disabled:opacity-60">
																{retryWarningsPending
																	? "Retrying affected files..."
																	: warningFilter === "all"
																		? "Retry affected files only"
																		: "Retry filtered files only"}
															</button>
														</div>
														<div className="space-y-2">
															<div className="flex flex-wrap gap-1">
																{warningFilterOptions.map((option) => (
																	<button
																		key={option.value}
																		type="button"
																		onClick={() => {
																			setWarningFilter(option.value)
																			resetWarningDetailsState(
																				option.value,
																				warningSort,
																			)
																		}}
																		className={cn(
																			"rounded-full border px-2 py-1 text-[10px] leading-none transition-colors",
																			warningFilter === option.value
																				? "border-amber-400/40 bg-[rgba(245,158,11,0.18)] text-vscode-foreground"
																				: "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground/95 hover:bg-[rgba(255,255,255,0.08)]",
																		)}>
																		{option.label}
																	</button>
																))}
															</div>
															<div className="flex flex-wrap gap-1">
																{warningSortOptions.map((option) => (
																	<button
																		key={option.value}
																		type="button"
																		onClick={() => {
																			setWarningSort(option.value)
																			resetWarningDetailsState(
																				warningFilter,
																				option.value,
																			)
																		}}
																		className={cn(
																			"rounded-full border px-2 py-1 text-[10px] leading-none transition-colors",
																			warningSort === option.value
																				? "border-sky-400/35 bg-[rgba(80,168,255,0.16)] text-vscode-foreground"
																				: "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground/95 hover:bg-[rgba(255,255,255,0.08)]",
																		)}>
																		Sort: {option.label}
																	</button>
																))}
															</div>
														</div>
														<div className="space-y-2">
															{warningDetails.length > 0 ? (
																warningDetails.map((detail) => (
																	<div
																		key={`${detail.state}:${detail.relativePath}`}
																		className="rounded-lg border border-vscode-dropdown-border/60 bg-[rgba(0,0,0,0.08)] px-2.5 py-2 text-[11px] leading-4">
																		<div className="flex flex-wrap items-center gap-2">
																			<span className="font-medium text-vscode-foreground/95">
																				{detail.relativePath}
																			</span>
																			<span className="rounded-full border border-amber-500/20 bg-[rgba(255,255,255,0.05)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-vscode-descriptionForeground/95">
																				{detail.category === "parser_failed"
																					? "parser"
																					: detail.state === "terminal_failed"
																						? "failed"
																						: detail.state}
																			</span>
																			<div className="ml-auto flex flex-wrap gap-1">
																				<button
																					type="button"
																					onClick={() =>
																						vscode.postMessage({
																							type: "openFile",
																							text: detail.relativePath,
																						})
																					}
																					className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[10px] text-vscode-descriptionForeground/95 transition-colors hover:bg-[rgba(255,255,255,0.08)]">
																					Open
																				</button>
																				<button
																					type="button"
																					onClick={() =>
																						void copyWithFeedback(
																							detail.relativePath,
																						)
																					}
																					className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[10px] text-vscode-descriptionForeground/95 transition-colors hover:bg-[rgba(255,255,255,0.08)]">
																					{showCopyFeedback
																						? "Copied"
																						: "Copy path"}
																				</button>
																				<button
																					type="button"
																					onClick={() => {
																						setRetryingWarningPath(
																							detail.relativePath,
																						)
																						vscode.postMessage({
																							type: "retryIndexingWarnings",
																							values: {
																								filter: warningFilter,
																								relativePaths: [
																									detail.relativePath,
																								],
																							},
																						})
																					}}
																					disabled={
																						retryWarningsPending ||
																						indexingStatus.systemStatus ===
																							"Indexing" ||
																						retryingWarningPath ===
																							detail.relativePath
																					}
																					className="rounded-full border border-amber-500/30 bg-[rgba(245,158,11,0.12)] px-2 py-0.5 text-[10px] text-vscode-foreground transition-colors hover:bg-[rgba(245,158,11,0.18)] disabled:cursor-default disabled:opacity-60">
																					{retryingWarningPath ===
																					detail.relativePath
																						? "Retrying..."
																						: "Retry file"}
																				</button>
																			</div>
																		</div>
																		{detail.failureReason && (
																			<div className="mt-1 text-vscode-descriptionForeground/90">
																				{detail.failureReason}
																			</div>
																		)}
																	</div>
																))
															) : (
																<div className="rounded-lg border border-vscode-dropdown-border/60 bg-[rgba(0,0,0,0.08)] px-2.5 py-2 text-[11px] leading-4 text-vscode-descriptionForeground/90">
																	{warningDetailsState.loading
																		? "Loading affected files..."
																		: "No files match the current warning filter."}
																</div>
															)}
														</div>
														{warningDetailsState.hasMore && (
															<button
																type="button"
																onClick={() =>
																	requestWarningDetails(
																		warningDetails.length,
																		20,
																		warningFilter,
																		warningSort,
																	)
																}
																disabled={warningDetailsState.loading}
																className="w-full rounded-lg border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-3 py-2 text-[11px] font-medium text-vscode-foreground transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:cursor-default disabled:opacity-60">
																{warningDetailsState.loading
																	? "Loading affected files..."
																	: "Load more affected files"}
															</button>
														)}
													</div>
												)}
											</div>
										)}

										{(displayedOversizedCount > 0 ||
											oversizedDetailsState.total > 0 ||
											oversizedDetailsState.loading) && (
											<div className={`${surfaceCardClass} p-3`}>
												<div className="flex items-start justify-between gap-3">
													<div>
														<div className="text-[12px] font-medium text-vscode-foreground">
															Skipped oversized files
														</div>
														<div className="mt-1 text-[11px] leading-4 text-vscode-descriptionForeground">
															{displayedOversizedCount.toLocaleString()} actionable files
															are waiting for review.
														</div>
														{oversizedDetailsState.total > 0 && (
															<div className="mt-1 text-[10px] leading-4 text-vscode-descriptionForeground/85">
																{oversizedDetailsState.total.toLocaleString()} tracked
																file{oversizedDetailsState.total === 1 ? "" : "s"} in
																the persistent review list
															</div>
														)}
													</div>
													<div className="flex shrink-0 flex-col items-end gap-2">
														<div className="rounded-full border border-vscode-dropdown-border/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-vscode-descriptionForeground">
															Limit {currentSettings.codebaseIndexMaxFileSizeMb ?? 1} MB
														</div>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={() => {
																setIsOversizedReviewOpen((prev) => !prev)
																if (!oversizedDetailsBootstrapped) {
																	requestOversizedDetails(0, 20)
																}
															}}>
															{isOversizedReviewOpen
																? "Hide review list"
																: "Review skipped files"}
														</Button>
													</div>
												</div>

												{isOversizedReviewOpen && (
													<div className="mt-3 space-y-2">
														{oversizedDetails.length > 0 ? (
															oversizedDetails.map((detail) => {
																const approval = oversizedApprovalMap.get(
																	detail.relativePath,
																)
																const modifiedLabel = formatModifiedTime(
																	detail.lastModifiedMtimeMs,
																)
																const recommendationTone =
																	detail.recommendation === "likely_useful"
																		? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
																		: detail.recommendation === "probably_skip"
																			? "border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground"
																			: "border-amber-500/30 bg-amber-500/10 text-amber-200"

																return (
																	<div
																		key={detail.relativePath}
																		className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] p-3">
																		<div className="flex flex-wrap items-start justify-between gap-3">
																			<div className="min-w-0 flex-1">
																				<div
																					title={detail.relativePath}
																					className="break-all text-[12px] font-medium leading-4 text-vscode-foreground">
																					{detail.relativePath}
																				</div>
																				<div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.08em] text-vscode-descriptionForeground">
																					<span>
																						{formatBytes(detail.sizeBytes)}
																					</span>
																					<span>
																						{detail.status.replace(
																							/_/g,
																							" ",
																						)}
																					</span>
																					{modifiedLabel && (
																						<span className="normal-case tracking-normal">
																							{modifiedLabel}
																						</span>
																					)}
																					{detail.status ===
																						"needs_reapproval" && (
																						<span className="text-amber-300">
																							Needs reapproval
																						</span>
																					)}
																				</div>
																				<p className="mt-2 mb-0 text-[11px] leading-4 text-vscode-descriptionForeground">
																					{detail.reason}
																				</p>
																			</div>
																			<div className="flex shrink-0 flex-col items-end gap-2">
																				<div
																					className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] ${recommendationTone}`}>
																					{detail.recommendation ===
																					"likely_useful"
																						? "Likely useful"
																						: detail.recommendation ===
																							  "probably_skip"
																							? "Probably skip"
																							: "Review manually"}
																				</div>
																				{approval ? (
																					<div className="text-right text-[10px] leading-4 text-vscode-descriptionForeground">
																						Approved up to{" "}
																						{formatBytes(
																							approval.approvedMaxBytes,
																						)}
																					</div>
																				) : detail.status === "skipped" ||
																				  detail.status ===
																						"needs_reapproval" ? (
																					<Button
																						type="button"
																						variant="outline"
																						size="sm"
																						onClick={() =>
																							approveOversizedFile(
																								detail.relativePath,
																								detail.sizeBytes,
																							)
																						}>
																						Approve For Indexing
																					</Button>
																				) : (
																					<div className="text-right text-[10px] leading-4 text-vscode-descriptionForeground">
																						{detail.status === "eligible"
																							? "Now within limit"
																							: detail.status ===
																								  "missing"
																								? "File missing"
																								: "Tracked approval"}
																					</div>
																				)}
																			</div>
																		</div>
																	</div>
																)
															})
														) : (
															<div className="rounded-xl border border-dashed border-vscode-dropdown-border/60 px-3 py-3 text-[11px] leading-4 text-vscode-descriptionForeground">
																{oversizedDetailsState.loading
																	? "Loading tracked oversized files..."
																	: "No tracked oversized files are available yet."}
															</div>
														)}
														{oversizedDetailsState.hasMore && (
															<button
																type="button"
																onClick={() =>
																	requestOversizedDetails(oversizedDetails.length, 20)
																}
																disabled={oversizedDetailsState.loading}
																className="w-full rounded-lg border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-3 py-2 text-[11px] font-medium text-vscode-foreground transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:cursor-default disabled:opacity-60">
																{oversizedDetailsState.loading
																	? "Loading tracked files..."
																	: "Load more tracked files"}
															</button>
														)}
													</div>
												)}
											</div>
										)}

										{resilienceHighlights.warningItems.length === 0 &&
											resilienceHighlights.resumedPendingJobs === 0 &&
											displayedOversizedCount === 0 &&
											oversizedDetailsState.total === 0 &&
											!oversizedDetailsState.loading && (
												<div
													className={`${surfaceCardClass} px-4 py-5 text-[12px] leading-5 text-vscode-descriptionForeground`}>
													No warnings or manual review items in the current snapshot.
												</div>
											)}
									</div>
								</div>

								{showDebugSection && (
									<div className="space-y-2">
										<div className={sectionLabelClass}>Debug</div>
										<div
											className={`${surfaceCardClass} rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2 text-xs leading-5 text-vscode-descriptionForeground`}>
											<div className="font-medium text-vscode-foreground">Roo Build</div>
											<div>version: {rooVersion}</div>
											<div>build: {rooBuildTimestamp}</div>
											<div>context: {renderContext}</div>
											<div>view: code index tuning</div>
											{rooDebugInfo.webviewId ? (
												<div>webview: {rooDebugInfo.webviewId}</div>
											) : null}
											{rooDebugInfo.origin ? <div>origin: {rooDebugInfo.origin}</div> : null}
											{pipelineSnapshot ? (
												<div>run mode: {getIndexingRunModeLabel(pipelineSnapshot)}</div>
											) : null}
											{debug ? <div>debug mode: enabled</div> : null}
										</div>
									</div>
								)}
							</div>
						)}

						<div className={cn("space-y-2", activeTab !== "settings" && "hidden")}>
							{/* Enable/Disable Toggle */}
							<div className={`${surfaceCardClass} mt-5 p-3`}>
								<div className="flex items-start justify-between gap-2.5">
									<div className="space-y-0.5">
										<div className={sectionLabelClass}>Indexer</div>
										<div className="text-[13px] font-medium leading-5">
											{t("settings:codeIndex.enableLabel")}
										</div>
										<div className="max-w-[32ch] text-[11px] leading-4 text-vscode-descriptionForeground">
											Turn semantic code search on for this workspace.
										</div>
									</div>
									<div className="flex items-center gap-2">
										<StandardTooltip content={t("settings:codeIndex.enableDescription")}>
											<span className="codicon codicon-info cursor-help text-xs text-vscode-descriptionForeground" />
										</StandardTooltip>
									</div>
								</div>
							</div>
							<div className="mt-2.5 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.016)] px-3 py-2.5">
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<div className="text-[12px] font-medium leading-5 text-vscode-foreground">
											Indexing engine
										</div>
										<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
											{currentSettings.codebaseIndexEnabled
												? "Semantic code search is enabled for this workspace."
												: "Semantic code search is currently turned off."}
										</div>
									</div>
									<div className="shrink-0">
										<VSCodeCheckbox
											checked={currentSettings.codebaseIndexEnabled}
											onChange={(e: any) =>
												updateSetting("codebaseIndexEnabled", e.target.checked)
											}>
											<span className="text-[12px] font-medium">
												{currentSettings.codebaseIndexEnabled ? "On" : "Off"}
											</span>
										</VSCodeCheckbox>
									</div>
								</div>
							</div>
							{currentSettings.codebaseIndexEnabled && (
								<div className="mt-2.5 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2">
									<div className="space-y-0.5 pb-2">
										<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-vscode-descriptionForeground/68">
											Workspace behavior
										</div>
										<div className="text-[11px] leading-4 text-vscode-descriptionForeground">
											Choose how indexing behaves in this workspace and in future workspaces.
										</div>
									</div>
									<div className="divide-y divide-vscode-dropdown-border/40 rounded-lg border border-vscode-dropdown-border/40 bg-[rgba(0,0,0,0.06)]">
										<div className="px-3 py-2.5">
											<div className="flex items-start gap-2">
												<input
													type="checkbox"
													id="workspace-indexing-toggle"
													checked={indexingStatus.workspaceEnabled ?? false}
													onChange={(e) =>
														vscode.postMessage({
															type: "toggleWorkspaceIndexing",
															bool: e.target.checked,
														})
													}
													className="accent-vscode-focusBorder"
												/>
												<label
													htmlFor="workspace-indexing-toggle"
													className="flex cursor-pointer flex-col gap-0.5 text-vscode-foreground">
													<span className="text-[12px] font-medium leading-5">
														{t("settings:codeIndex.workspaceToggleLabel")}
													</span>
													<span className="text-[11px] leading-4 text-vscode-descriptionForeground">
														Control whether this workspace actively participates in code
														indexing.
													</span>
												</label>
											</div>
											{!indexingStatus.workspaceEnabled && (
												<p className="m-0 pt-1.5 pl-6 text-[11px] leading-4 text-vscode-descriptionForeground">
													{t("settings:codeIndex.workspaceDisabledMessage")}
												</p>
											)}
										</div>
										<div className="px-3 py-2.5">
											<div className="flex items-start gap-2">
												<input
													type="checkbox"
													id="auto-enable-default-toggle"
													checked={indexingStatus.autoEnableDefault ?? true}
													onChange={(e) =>
														vscode.postMessage({
															type: "setAutoEnableDefault",
															bool: e.target.checked,
														})
													}
													className="accent-vscode-focusBorder"
												/>
												<label
													htmlFor="auto-enable-default-toggle"
													className="flex cursor-pointer flex-col gap-0.5 text-vscode-foreground">
													<span className="text-[12px] font-medium leading-5">
														{t("settings:codeIndex.autoEnableDefaultLabel")}
													</span>
													<span className="text-[11px] leading-4 text-vscode-descriptionForeground">
														Apply your preferred indexing default automatically when new
														workspaces open.
													</span>
												</label>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* Setup Settings Disclosure */}
							<div ref={setupSectionRef} className="mt-5 scroll-mt-4">
								<button
									onClick={() => setIsSetupSettingsOpen(!isSetupSettingsOpen)}
									className={disclosureButtonClass}
									aria-expanded={isSetupSettingsOpen}>
									<div>
										<div className={sectionLabelClass}>Configuration</div>
										<div className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">Setup</div>
									</div>
									<span
										className={`codicon codicon-${isSetupSettingsOpen ? "chevron-down" : "chevron-right"} text-vscode-descriptionForeground`}></span>
								</button>

								{isSetupSettingsOpen && (
									<div className={disclosurePanelClass}>
										<div className={groupedListClass}>
											{/* Embedder Provider Section */}
											<div className={fieldGroupClass}>
												<label className="text-sm font-medium">
													{t("settings:codeIndex.embedderProviderLabel")}
												</label>
												<Select
													value={currentSettings.codebaseIndexEmbedderProvider}
													onValueChange={(value: EmbedderProvider) => {
														updateSetting("codebaseIndexEmbedderProvider", value)
														// Clear model selection when switching providers
														updateSetting("codebaseIndexEmbedderModelId", "")

														// Auto-populate Region and Profile when switching to Bedrock
														// if the main API provider is also configured for Bedrock
														if (
															value === "bedrock" &&
															apiConfiguration?.apiProvider === "bedrock"
														) {
															// Only populate if currently empty
															if (
																!currentSettings.codebaseIndexBedrockRegion &&
																apiConfiguration.awsRegion
															) {
																updateSetting(
																	"codebaseIndexBedrockRegion",
																	apiConfiguration.awsRegion,
																)
															}
															if (
																!currentSettings.codebaseIndexBedrockProfile &&
																apiConfiguration.awsProfile
															) {
																updateSetting(
																	"codebaseIndexBedrockProfile",
																	apiConfiguration.awsProfile,
																)
															}
														}
													}}>
													<SelectTrigger className="w-full">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="openai">
															{t("settings:codeIndex.openaiProvider")}
														</SelectItem>
														<SelectItem value="ollama">
															{t("settings:codeIndex.ollamaProvider")}
														</SelectItem>
														<SelectItem value="openai-compatible">
															{t("settings:codeIndex.openaiCompatibleProvider")}
														</SelectItem>
														<SelectItem value="gemini">
															{t("settings:codeIndex.geminiProvider")}
														</SelectItem>
														<SelectItem value="mistral">
															{t("settings:codeIndex.mistralProvider")}
														</SelectItem>
														<SelectItem value="vercel-ai-gateway">
															{t("settings:codeIndex.vercelAiGatewayProvider")}
														</SelectItem>
														<SelectItem value="bedrock">
															{t("settings:codeIndex.bedrockProvider")}
														</SelectItem>
														<SelectItem value="openrouter">
															{t("settings:codeIndex.openRouterProvider")}
														</SelectItem>
													</SelectContent>
												</Select>
											</div>

											{/* Provider-specific settings */}
											{currentSettings.codebaseIndexEmbedderProvider === "openai" && (
												<>
													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.openAiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={currentSettings.codeIndexOpenAiKey || ""}
															onInput={(e: any) =>
																updateSetting("codeIndexOpenAiKey", e.target.value)
															}
															placeholder={t("settings:codeIndex.openAiKeyPlaceholder")}
															className={cn("w-full", {
																"border-red-500": formErrors.codeIndexOpenAiKey,
															})}
														/>
														{formErrors.codeIndexOpenAiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codeIndexOpenAiKey}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "ollama" && (
												<>
													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.ollamaBaseUrlLabel")}
														</label>
														<VSCodeTextField
															value={currentSettings.codebaseIndexEmbedderBaseUrl || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderBaseUrl",
																	e.target.value,
																)
															}
															onBlur={(e: any) => {
																// Set default Ollama URL if field is empty
																if (!e.target.value.trim()) {
																	e.target.value = DEFAULT_OLLAMA_URL
																	updateSetting(
																		"codebaseIndexEmbedderBaseUrl",
																		DEFAULT_OLLAMA_URL,
																	)
																}
															}}
															placeholder={t("settings:codeIndex.ollamaUrlPlaceholder")}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderBaseUrl,
															})}
														/>
														{formErrors.codebaseIndexEmbedderBaseUrl && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderBaseUrl}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeTextField
															value={currentSettings.codebaseIndexEmbedderModelId || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															placeholder={t("settings:codeIndex.modelPlaceholder")}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}
														/>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelDimensionLabel")}
														</label>
														<VSCodeTextField
															value={
																currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
																""
															}
															onInput={(e: any) => {
																const value = e.target.value
																	? parseInt(e.target.value, 10) || undefined
																	: undefined
																updateSetting(
																	"codebaseIndexEmbedderModelDimension",
																	value,
																)
															}}
															placeholder={t(
																"settings:codeIndex.modelDimensionPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelDimension,
															})}
														/>
														{formErrors.codebaseIndexEmbedderModelDimension && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelDimension}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "openai-compatible" && (
												<>
													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.openAiCompatibleBaseUrlLabel")}
														</label>
														<VSCodeTextField
															value={
																currentSettings.codebaseIndexOpenAiCompatibleBaseUrl ||
																""
															}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexOpenAiCompatibleBaseUrl",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.openAiCompatibleBaseUrlPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexOpenAiCompatibleBaseUrl,
															})}
														/>
														{formErrors.codebaseIndexOpenAiCompatibleBaseUrl && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexOpenAiCompatibleBaseUrl}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.openAiCompatibleApiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={
																currentSettings.codebaseIndexOpenAiCompatibleApiKey ||
																""
															}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexOpenAiCompatibleApiKey",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.openAiCompatibleApiKeyPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexOpenAiCompatibleApiKey,
															})}
														/>
														{formErrors.codebaseIndexOpenAiCompatibleApiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexOpenAiCompatibleApiKey}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeTextField
															value={currentSettings.codebaseIndexEmbedderModelId || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															placeholder={t("settings:codeIndex.modelPlaceholder")}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}
														/>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelDimensionLabel")}
														</label>
														<VSCodeTextField
															value={
																currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
																""
															}
															onInput={(e: any) => {
																const value = e.target.value
																	? parseInt(e.target.value, 10) || undefined
																	: undefined
																updateSetting(
																	"codebaseIndexEmbedderModelDimension",
																	value,
																)
															}}
															placeholder={t(
																"settings:codeIndex.modelDimensionPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelDimension,
															})}
														/>
														{formErrors.codebaseIndexEmbedderModelDimension && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelDimension}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "gemini" && (
												<>
													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.geminiApiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={currentSettings.codebaseIndexGeminiApiKey || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexGeminiApiKey",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.geminiApiKeyPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500": formErrors.codebaseIndexGeminiApiKey,
															})}
														/>
														{formErrors.codebaseIndexGeminiApiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexGeminiApiKey}
															</p>
														)}
													</div>

													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "mistral" && (
												<>
													<div className={fieldGroupClass}>
														<label className="text-sm font-medium">
															{t("settings:codeIndex.mistralApiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={currentSettings.codebaseIndexMistralApiKey || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexMistralApiKey",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.mistralApiKeyPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500": formErrors.codebaseIndexMistralApiKey,
															})}
														/>
														{formErrors.codebaseIndexMistralApiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexMistralApiKey}
															</p>
														)}
													</div>

													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "vercel-ai-gateway" && (
												<>
													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.vercelAiGatewayApiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={
																currentSettings.codebaseIndexVercelAiGatewayApiKey || ""
															}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexVercelAiGatewayApiKey",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.vercelAiGatewayApiKeyPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexVercelAiGatewayApiKey,
															})}
														/>
														{formErrors.codebaseIndexVercelAiGatewayApiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexVercelAiGatewayApiKey}
															</p>
														)}
													</div>

													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "bedrock" && (
												<>
													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.bedrockRegionLabel")}
														</label>
														<VSCodeTextField
															value={currentSettings.codebaseIndexBedrockRegion || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexBedrockRegion",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.bedrockRegionPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500": formErrors.codebaseIndexBedrockRegion,
															})}
														/>
														{formErrors.codebaseIndexBedrockRegion && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexBedrockRegion}
															</p>
														)}
													</div>

													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.bedrockProfileLabel")}
															<span className="text-xs text-vscode-descriptionForeground ml-1">
																({t("settings:codeIndex.optional")})
															</span>
														</label>
														<VSCodeTextField
															value={currentSettings.codebaseIndexBedrockProfile || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexBedrockProfile",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.bedrockProfilePlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexBedrockProfile,
															})}
														/>
														{formErrors.codebaseIndexBedrockProfile && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexBedrockProfile}
															</p>
														)}
														{!formErrors.codebaseIndexBedrockProfile && (
															<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
																{t("settings:codeIndex.bedrockProfileDescription")}
															</p>
														)}
													</div>

													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>
												</>
											)}

											{currentSettings.codebaseIndexEmbedderProvider === "openrouter" && (
												<>
													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.openRouterApiKeyLabel")}
														</label>
														<VSCodeTextField
															type="password"
															value={currentSettings.codebaseIndexOpenRouterApiKey || ""}
															onInput={(e: any) =>
																updateSetting(
																	"codebaseIndexOpenRouterApiKey",
																	e.target.value,
																)
															}
															placeholder={t(
																"settings:codeIndex.openRouterApiKeyPlaceholder",
															)}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexOpenRouterApiKey,
															})}
														/>
														{formErrors.codebaseIndexOpenRouterApiKey && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexOpenRouterApiKey}
															</p>
														)}
													</div>

													<div className="space-y-2">
														<label className="text-sm font-medium">
															{t("settings:codeIndex.modelLabel")}
														</label>
														<VSCodeDropdown
															value={currentSettings.codebaseIndexEmbedderModelId}
															onChange={(e: any) =>
																updateSetting(
																	"codebaseIndexEmbedderModelId",
																	e.target.value,
																)
															}
															className={cn("w-full", {
																"border-red-500":
																	formErrors.codebaseIndexEmbedderModelId,
															})}>
															<VSCodeOption value="" className="p-2">
																{t("settings:codeIndex.selectModel")}
															</VSCodeOption>
															{getAvailableModels().map((modelId) => {
																const model =
																	codebaseIndexModels?.[
																		currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																	]?.[modelId]
																return (
																	<VSCodeOption
																		key={modelId}
																		value={modelId}
																		className="p-2">
																		{modelId}{" "}
																		{model
																			? t("settings:codeIndex.modelDimensions", {
																					dimension: model.dimension,
																				})
																			: ""}
																	</VSCodeOption>
																)
															})}
														</VSCodeDropdown>
														{formErrors.codebaseIndexEmbedderModelId && (
															<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
																{formErrors.codebaseIndexEmbedderModelId}
															</p>
														)}
													</div>

													{/* Provider Routing for OpenRouter */}
													{openRouterEmbeddingProviders &&
														Object.keys(openRouterEmbeddingProviders).length > 0 && (
															<div className={fieldGroupClass}>
																<label className="text-sm font-medium">
																	<a
																		href="https://openrouter.ai/docs/features/provider-routing"
																		target="_blank"
																		rel="noopener noreferrer"
																		className="flex items-center gap-1 hover:underline">
																		{t(
																			"settings:codeIndex.openRouterProviderRoutingLabel",
																		)}
																		<span className="codicon codicon-link-external text-xs" />
																	</a>
																</label>
																<Select
																	value={
																		currentSettings.codebaseIndexOpenRouterSpecificProvider ||
																		OPENROUTER_DEFAULT_PROVIDER_NAME
																	}
																	onValueChange={(value) =>
																		updateSetting(
																			"codebaseIndexOpenRouterSpecificProvider",
																			value,
																		)
																	}>
																	<SelectTrigger className="w-full">
																		<SelectValue />
																	</SelectTrigger>
																	<SelectContent>
																		<SelectItem
																			value={OPENROUTER_DEFAULT_PROVIDER_NAME}>
																			{OPENROUTER_DEFAULT_PROVIDER_NAME}
																		</SelectItem>
																		{Object.entries(
																			openRouterEmbeddingProviders,
																		).map(([value, { label }]) => (
																			<SelectItem key={value} value={value}>
																				{label}
																			</SelectItem>
																		))}
																	</SelectContent>
																</Select>
																<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
																	{t(
																		"settings:codeIndex.openRouterProviderRoutingDescription",
																	)}
																</p>
															</div>
														)}
												</>
											)}

											{/* Qdrant Settings */}
											<div className={fieldGroupClass}>
												<label className="text-sm font-medium">
													{t("settings:codeIndex.qdrantUrlLabel")}
												</label>
												<VSCodeTextField
													value={currentSettings.codebaseIndexQdrantUrl || ""}
													onInput={(e: any) =>
														updateSetting("codebaseIndexQdrantUrl", e.target.value)
													}
													onBlur={(e: any) => {
														// Set default Qdrant URL if field is empty
														if (!e.target.value.trim()) {
															currentSettings.codebaseIndexQdrantUrl = DEFAULT_QDRANT_URL
															updateSetting("codebaseIndexQdrantUrl", DEFAULT_QDRANT_URL)
														}
													}}
													placeholder={t("settings:codeIndex.qdrantUrlPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codebaseIndexQdrantUrl,
													})}
												/>
												{formErrors.codebaseIndexQdrantUrl && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codebaseIndexQdrantUrl}
													</p>
												)}
											</div>

											<div className={fieldGroupClass}>
												<label className="text-sm font-medium">
													{t("settings:codeIndex.qdrantApiKeyLabel")}
												</label>
												<VSCodeTextField
													type="password"
													value={currentSettings.codeIndexQdrantApiKey || ""}
													onInput={(e: any) =>
														updateSetting("codeIndexQdrantApiKey", e.target.value)
													}
													placeholder={t("settings:codeIndex.qdrantApiKeyPlaceholder")}
													className={cn("w-full", {
														"border-red-500": formErrors.codeIndexQdrantApiKey,
													})}
												/>
												{formErrors.codeIndexQdrantApiKey && (
													<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
														{formErrors.codeIndexQdrantApiKey}
													</p>
												)}
											</div>
										</div>
									</div>
								)}
							</div>

							{/* Advanced Settings Disclosure */}
							<div ref={advancedSectionRef} className="mt-5 scroll-mt-4">
								<button
									onClick={() => setIsAdvancedSettingsOpen(!isAdvancedSettingsOpen)}
									className={disclosureButtonClass}
									aria-expanded={isAdvancedSettingsOpen}>
									<div>
										<div className={sectionLabelClass}>Tuning</div>
										<div className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">
											{t("settings:codeIndex.advancedConfigLabel")}
										</div>
									</div>
									<span
										className={`codicon codicon-${isAdvancedSettingsOpen ? "chevron-down" : "chevron-right"} text-vscode-descriptionForeground`}></span>
								</button>

								{isAdvancedSettingsOpen && (
									<div className={disclosurePanelClass}>
										<div className={groupedListClass}>
											{/* Search Score Threshold Slider */}
											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.searchMinScoreLabel")}
													</label>
													<StandardTooltip
														content={t("settings:codeIndex.searchMinScoreDescription")}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<div className="flex items-center gap-2">
													<Slider
														min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_SCORE}
														max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_SCORE}
														step={CODEBASE_INDEX_DEFAULTS.SEARCH_SCORE_STEP}
														value={[
															currentSettings.codebaseIndexSearchMinScore ??
																CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
														]}
														onValueChange={(values) =>
															updateSetting("codebaseIndexSearchMinScore", values[0])
														}
														className="flex-1 min-w-[80px]"
														data-testid="search-min-score-slider"
													/>
													<span className="w-12 text-center">
														{(
															currentSettings.codebaseIndexSearchMinScore ??
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
														).toFixed(2)}
													</span>
													<VSCodeButton
														appearance="icon"
														title={t("settings:codeIndex.resetToDefault")}
														onClick={() =>
															updateSetting(
																"codebaseIndexSearchMinScore",
																CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
															)
														}>
														<span className="codicon codicon-discard" />
													</VSCodeButton>
												</div>
											</div>

											{/* Maximum Search Results Slider */}
											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.searchMaxResultsLabel")}
													</label>
													<StandardTooltip
														content={t("settings:codeIndex.searchMaxResultsDescription")}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<div className="flex items-center gap-2">
													<Slider
														min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS}
														max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS}
														step={CODEBASE_INDEX_DEFAULTS.SEARCH_RESULTS_STEP}
														value={[
															currentSettings.codebaseIndexSearchMaxResults ??
																CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
														]}
														onValueChange={(values) =>
															updateSetting("codebaseIndexSearchMaxResults", values[0])
														}
														className="flex-1 min-w-[80px]"
														data-testid="search-max-results-slider"
													/>
													<span className="w-12 text-center">
														{currentSettings.codebaseIndexSearchMaxResults ??
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS}
													</span>
													<VSCodeButton
														appearance="icon"
														title={t("settings:codeIndex.resetToDefault")}
														onClick={() =>
															updateSetting(
																"codebaseIndexSearchMaxResults",
																CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
															)
														}>
														<span className="codicon codicon-discard" />
													</VSCodeButton>
												</div>
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.maxFilesLabel")}
													</label>
													<StandardTooltip
														content={t("settings:codeIndex.maxFilesDescription")}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<VSCodeTextField
													value={currentSettings.codebaseIndexMaxFiles?.toString() || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexMaxFiles",
															e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined,
														)
													}
													placeholder="100000"
													className="w-full"
												/>
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														Max indexed file size (MB)
													</label>
													<StandardTooltip content="Files larger than this are skipped unless you explicitly approve them below.">
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<VSCodeTextField
													value={currentSettings.codebaseIndexMaxFileSizeMb?.toString() || ""}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexMaxFileSizeMb",
															e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined,
														)
													}
													placeholder="1"
													className="w-full"
												/>
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.embeddingBatchSizeLabel")}
													</label>
													<StandardTooltip
														content={t("settings:codeIndex.embeddingBatchSizeDescription")}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<VSCodeTextField
													value={
														currentSettings.codebaseIndexEmbeddingBatchSize?.toString() ||
														""
													}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexEmbeddingBatchSize",
															e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined,
														)
													}
													placeholder="60"
													className="w-full"
												/>
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.embeddingLaneConcurrencyLabel")}
													</label>
													<StandardTooltip
														content={t(
															"settings:codeIndex.embeddingLaneConcurrencyDescription",
														)}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<VSCodeTextField
													value={
														currentSettings.codebaseIndexEmbeddingLaneConcurrency?.toString() ||
														""
													}
													onInput={(e: any) =>
														updateSetting(
															"codebaseIndexEmbeddingLaneConcurrency",
															e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined,
														)
													}
													placeholder="2"
													className="w-full"
												/>
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-center gap-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.fileSearchIndexLimitLabel")}
													</label>
													<StandardTooltip
														content={t(
															"settings:codeIndex.fileSearchIndexLimitDescription",
														)}>
														<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
													</StandardTooltip>
												</div>
												<VSCodeTextField
													value={
														currentSettings.maximumIndexedFilesForFileSearch?.toString() ||
														""
													}
													onInput={(e: any) =>
														updateSetting(
															"maximumIndexedFilesForFileSearch",
															e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined,
														)
													}
													placeholder="10000"
													className="w-full"
												/>
											</div>

											<div className="space-y-2 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] p-3">
												<div className="flex items-start gap-2">
													<input
														type="checkbox"
														id="respect-gitignore-toggle"
														checked={currentSettings.codebaseIndexRespectGitIgnore}
														onChange={(e) =>
															updateSetting(
																"codebaseIndexRespectGitIgnore",
																e.target.checked,
															)
														}
														className="mt-0.5 accent-vscode-focusBorder"
													/>
													<div className="space-y-1">
														<label
															htmlFor="respect-gitignore-toggle"
															className="cursor-pointer text-sm text-vscode-foreground">
															{t("settings:codeIndex.respectGitIgnoreLabel")}
														</label>
														<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground">
															{t("settings:codeIndex.respectGitIgnoreDescription")}
														</p>
														<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground/90">
															{t("settings:codeIndex.rooIgnoreAlwaysAppliesNote")}
														</p>
													</div>
												</div>
												{!currentSettings.codebaseIndexRespectGitIgnore && (
													<div className="flex items-start gap-2 rounded-xl border border-yellow-500/35 bg-yellow-500/10 px-3 py-2 text-xs leading-5 text-vscode-descriptionForeground">
														<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
														<span>{t("settings:codeIndex.respectGitIgnoreWarning")}</span>
													</div>
												)}
											</div>

											<div className={fieldGroupClass}>
												<div className="flex items-start gap-2">
													<input
														type="checkbox"
														id="code-index-debug-logging-toggle"
														checked={currentSettings.codebaseIndexDebugLogging}
														onChange={(e) =>
															updateSetting("codebaseIndexDebugLogging", e.target.checked)
														}
														className="mt-0.5 accent-vscode-focusBorder"
													/>
													<div className="space-y-1">
														<label
															htmlFor="code-index-debug-logging-toggle"
															className="cursor-pointer text-sm text-vscode-foreground">
															{t("settings:codeIndex.debugLoggingLabel")}
														</label>
														<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground">
															{t("settings:codeIndex.debugLoggingDescription")}
														</p>
													</div>
												</div>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
					</div>

					<div
						className={cn(
							"flex-shrink-0 border-t border-vscode-dropdown-border/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.012))] px-5 py-4 backdrop-blur-md",
							activeTab !== "settings" && "hidden",
						)}>
						<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
							{showDebugSection ? (
								<div className="rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] px-3 py-2 text-xs leading-5 text-vscode-descriptionForeground">
									<div className="font-medium text-vscode-foreground">Roo Build</div>
									<div>version: {rooVersion}</div>
									<div>build: {rooBuildTimestamp}</div>
									<div>context: {renderContext}</div>
									<div>view: code index tuning</div>
									{rooDebugInfo.webviewId ? <div>webview: {rooDebugInfo.webviewId}</div> : null}
									{rooDebugInfo.origin ? <div>origin: {rooDebugInfo.origin}</div> : null}
									{debug ? <div>debug mode: enabled</div> : null}
								</div>
							) : (
								<div />
							)}

							{hasUnsavedChanges || saveStatus === "saving" ? (
								<Button
									variant="primary"
									className={footerPrimaryButtonClass}
									onClick={handleSaveSettings}
									disabled={!hasUnsavedChanges || saveStatus === "saving"}>
									{saveStatus === "saving"
										? t("settings:codeIndex.saving")
										: t("settings:codeIndex.saveSettings")}
								</Button>
							) : (
								<Button variant="outline" className={footerDisabledButtonClass} disabled>
									{t("settings:codeIndex.saveSettings")}
								</Button>
							)}
						</div>

						{saveStatus === "error" && (
							<div className="mt-2">
								<span className="text-sm text-vscode-errorForeground block">
									{saveError || t("settings:codeIndex.saveError")}
								</span>
							</div>
						)}
					</div>
				</PopoverContent>
			</Popover>

			{/* Discard Changes Dialog */}
			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
