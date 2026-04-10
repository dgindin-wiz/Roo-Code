import * as fs from "fs"
import * as readline from "readline"
import * as path from "path"
import * as zlib from "zlib"
import { CODE_INDEX_V2_LOG_BASENAME } from "../shared/constants"

export interface IndexingRunDiagnosis {
	logPath: string
	workspacePath?: string
	runId?: string
	lineCount: number
	firstTimestamp?: string
	lastTimestamp?: string
	lastComponent?: string
	lastMessage?: string
	lastBlockingReason?: string
	completed: boolean
	inferredStage: "parse" | "planner" | "embed" | "delete" | "retry_backoff" | "unknown"
	performanceSummary?: {
		discoveredFiles?: number
		filesChanged?: number
		chunksParsed?: number
		vectorsCreated?: number
		totalRunMs?: number
	}
	recentMessages: Array<{ timestamp?: string; component?: string; message?: string }>
}

export async function analyzeIndexingRunFromDebugLog(input: {
	logPath: string
	workspacePath?: string
	runId?: string
}): Promise<IndexingRunDiagnosis> {
	const entries: any[] = []
	const candidateRuns = new Map<string, { timestamp?: string; workspacePath?: string }>()

	const file = readline.createInterface({
		input: createLogStreamInput(input.logPath),
		crlfDelay: Infinity,
	})

	for await (const line of file) {
		try {
			const entry = JSON.parse(line)
			if (input.runId) {
				if (entry.runId === input.runId) {
					entries.push(entry)
				}
				continue
			}

			if (input.workspacePath) {
				if (
					entry.workspacePath === input.workspacePath ||
					entry.workspacePath?.startsWith(input.workspacePath)
				) {
					entries.push(entry)
					if (entry.runId) {
						candidateRuns.set(entry.runId, {
							timestamp: entry.timestamp,
							workspacePath: entry.workspacePath,
						})
					}
				}
			}
		} catch {
			// Best effort parsing only.
		}
	}

	let selectedRunId = input.runId
	if (!selectedRunId && candidateRuns.size > 0) {
		selectedRunId = Array.from(candidateRuns.entries()).sort((left, right) =>
			String(right[1].timestamp ?? "").localeCompare(String(left[1].timestamp ?? "")),
		)[0]?.[0]
	}

	const filteredEntries =
		selectedRunId && !input.runId ? entries.filter((entry) => entry.runId === selectedRunId) : entries

	const lastEntry = filteredEntries[filteredEntries.length - 1]
	const performanceSummaryEntry = filteredEntries.find((entry) => entry.message === "index-performance-summary")
	const lastBlockingReason = filteredEntries
		.map((entry) => entry.blockingReason ?? entry.blocking_reason)
		.filter((value): value is string => Boolean(value))
		.at(-1)

	return {
		logPath: input.logPath,
		workspacePath: input.workspacePath ?? lastEntry?.workspacePath,
		runId: selectedRunId ?? lastEntry?.runId,
		lineCount: filteredEntries.length,
		firstTimestamp: filteredEntries[0]?.timestamp,
		lastTimestamp: lastEntry?.timestamp,
		lastComponent: lastEntry?.component,
		lastMessage: lastEntry?.message,
		lastBlockingReason,
		completed: filteredEntries.some((entry) => entry.message === "index-performance-summary"),
		inferredStage: inferStage(lastBlockingReason, lastEntry?.component, lastEntry?.message),
		performanceSummary: performanceSummaryEntry
			? {
					discoveredFiles: performanceSummaryEntry.discoveredFiles,
					filesChanged: performanceSummaryEntry.filesChanged,
					chunksParsed: performanceSummaryEntry.chunksParsed,
					vectorsCreated: performanceSummaryEntry.vectorsCreated,
					totalRunMs: performanceSummaryEntry.totalRunMs,
				}
			: undefined,
		recentMessages: filteredEntries.slice(-10).map((entry) => ({
			timestamp: entry.timestamp,
			component: entry.component,
			message: entry.message,
		})),
	}
}

function createLogStreamInput(logPath: string): NodeJS.ReadableStream {
	if (fs.existsSync(logPath) && fs.statSync(logPath).isDirectory()) {
		const logFiles = fs
			.readdirSync(logPath)
			.filter(
				(entry) =>
					entry === CODE_INDEX_V2_LOG_BASENAME ||
					(entry.startsWith(`${CODE_INDEX_V2_LOG_BASENAME}.`) && entry.endsWith(".gz")),
			)
			.map((entry) => path.join(logPath, entry))
			.sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs)
		const streams = logFiles.map((entry) =>
			entry.endsWith(".gz") ? fs.createReadStream(entry).pipe(zlib.createGunzip()) : fs.createReadStream(entry),
		)
		return concatenateStreams(streams)
	}

	if (logPath.endsWith(".gz")) {
		return fs.createReadStream(logPath).pipe(zlib.createGunzip())
	}

	return fs.createReadStream(logPath)
}

function concatenateStreams(streams: Array<NodeJS.ReadableStream>): NodeJS.ReadableStream {
	const { PassThrough } = require("stream") as typeof import("stream")
	const output = new PassThrough()
	const [first, ...rest] = streams
	if (!first) {
		process.nextTick(() => output.end())
		return output
	}
	const pipeNext = (stream: NodeJS.ReadableStream | undefined) => {
		if (!stream) {
			output.end()
			return
		}
		stream.pipe(output, { end: false })
		stream.once("end", () => pipeNext(rest.shift()))
		stream.once("error", () => pipeNext(rest.shift()))
	}
	pipeNext(first)
	return output
}

export function formatIndexingRunDiagnosis(diagnosis: IndexingRunDiagnosis): string {
	return [
		"Code Index V2 Run Diagnosis",
		"",
		`Log: ${diagnosis.logPath}`,
		`Workspace: ${diagnosis.workspacePath ?? "unknown"}`,
		`Run: ${diagnosis.runId ?? "unknown"}`,
		`Lines: ${diagnosis.lineCount.toLocaleString()}`,
		`Started: ${diagnosis.firstTimestamp ?? "unknown"}`,
		`Last event: ${diagnosis.lastTimestamp ?? "unknown"} • ${diagnosis.lastComponent ?? "unknown"} • ${diagnosis.lastMessage ?? "unknown"}`,
		`Completed: ${diagnosis.completed ? "yes" : "no"}`,
		`Blocking reason: ${diagnosis.lastBlockingReason ?? "none recorded"}`,
		`Inferred stage: ${diagnosis.inferredStage}`,
		diagnosis.performanceSummary
			? `Performance summary: ${diagnosis.performanceSummary.discoveredFiles ?? 0} discovered, ${diagnosis.performanceSummary.filesChanged ?? 0} changed, ${diagnosis.performanceSummary.chunksParsed ?? 0} parsed chunks, ${diagnosis.performanceSummary.vectorsCreated ?? 0} vectors, ${(diagnosis.performanceSummary.totalRunMs ?? 0).toLocaleString()} ms total`
			: "Performance summary: unavailable",
		"",
		"Recent messages:",
		...diagnosis.recentMessages.map(
			(entry) =>
				`- ${entry.timestamp ?? "unknown"} ${entry.component ?? "unknown"} ${entry.message ?? "unknown"}`,
		),
	].join("\n")
}

function inferStage(
	blockingReason?: string,
	lastComponent?: string,
	lastMessage?: string,
): IndexingRunDiagnosis["inferredStage"] {
	if (blockingReason?.includes("parsed") || lastComponent === "ParseChunkService") {
		return "parse"
	}
	if (blockingReason?.includes("planning") || lastComponent === "DiffPlanner") {
		return "planner"
	}
	if (blockingReason?.includes("delete")) {
		return "delete"
	}
	if (blockingReason?.includes("retry")) {
		return "retry_backoff"
	}
	if (
		blockingReason?.includes("upsert") ||
		lastComponent === "EmbedUpsertWorker" ||
		lastMessage?.includes("embedding")
	) {
		return "embed"
	}
	return "unknown"
}
