import { IndexDebugLoggerV2 } from "../services/code-index-v2/logging/IndexDebugLoggerV2"
import { DiffPlanner } from "../services/code-index-v2/pipeline/DiffPlanner"
import {
	MetadataSidecarChildToHostMessage,
	MetadataSidecarHostToChildMessage,
} from "../services/code-index-v2/sidecar/metadataProtocol"
import { SqliteMetadataRepository } from "../services/code-index-v2/store/SqliteMetadataRepository"

const ALLOWED_OPERATIONS = new Set([
	"adoptRetryableJobsFromStaleRuns",
	"adoptRevisionToRun",
	"beginRun",
	"claimJobs",
	"claimJobsWithLease",
	"countChunksForRevisions",
	"cleanupStaleRuns",
	"clearStorage",
	"completeJobs",
	"countActiveChunksForWorkspace",
	"countActiveIndexedFilesForWorkspace",
	"countOutstandingResumedJobs",
	"countTrackedFilesForWorkspace",
	"createFileRevision",
	"enqueueJobs",
	"ensureWorkspaceRecord",
	"excludeFilesFromIndexing",
	"failJob",
	"finalizeReadyRevisionsBatch",
	"findReusableRevision",
	"getActiveChunksByFingerprints",
	"getActiveChunksByRelativePaths",
	"getActiveRevisionForFile",
	"getChunkVariantsByChunkIds",
	"getChunksByIds",
	"getChunksForRevision",
	"getDiffBaselineRevision",
	"getDiscoveredFilesByRelativePaths",
	"getDiscoveredFilesForWorkspace",
	"getFileRecordByWorkspacePathOptional",
	"getNextRetryAt",
	"getRunProgressRecord",
	"getRevisionJobResolution",
	"getRevisionsByState",
	"getRunBacklogMetrics",
	"getTrackedFilesForWorkspace",
	"heartbeatJobs",
	"heartbeatRun",
	"listRevisionWarnings",
	"listPlannedRevisionResolutions",
	"listTrackedOversizedFiles",
	"listTrackedOversizedRelativePaths",
	"listWarningRelativePaths",
	"markChunkState",
	"markChunkStates",
	"markChunkVariantStates",
	"markFileTombstoned",
	"markJobTerminalFailed",
	"markRevisionCommitted",
	"markRevisionDegraded",
	"markRevisionState",
	"markRevisionSuperseded",
	"markRevisionTerminalFailure",
	"markRunComplete",
	"markRunDiscoveryComplete",
	"markRunFailed",
	"markRunStopped",
	"persistParsedRevision",
	"recordWatchEvent",
	"releaseJobs",
	"replaceTrackedOversizedFiles",
	"searchActiveChunksLexically",
	"searchActiveChunksLexicallyWithStatus",
	"upsertFileRecords",
	"appendRunSample",
	"checkpointWal",
	"performMaintenance",
	"writeRunSummary",
	"runPlannerSlice",
])

let repository: SqliteMetadataRepository | undefined
let diffPlanner: DiffPlanner | undefined
const pendingControllers = new Map<string, AbortController>()

function send(message: MetadataSidecarChildToHostMessage) {
	if (typeof process.send === "function") {
		process.send(message)
	}
}

function getMemorySnapshot() {
	return IndexDebugLoggerV2.getMemorySnapshot()
}

function getCpuSnapshot() {
	return IndexDebugLoggerV2.getCpuSnapshot()
}

function summarizeOperationArgs(operation: string, args: unknown[]): Record<string, unknown> {
	switch (operation) {
		case "runPlannerSlice": {
			const options = (args[1] as { revisionIds?: string[]; limit?: number; maxJobs?: number } | undefined) ?? {}
			return {
				runId: args[0] ?? null,
				revisionCount: options.revisionIds?.length ?? 0,
				limit: options.limit ?? null,
				maxJobs: options.maxJobs ?? null,
			}
		}
		case "claimJobs":
		case "claimJobsWithLease":
			return {
				jobType: args[0] ?? null,
				limit: args[1] ?? null,
				runId: args[2] ?? null,
			}
		case "getRunBacklogMetrics":
		case "heartbeatRun":
		case "getRunProgressRecord":
		case "markRunComplete":
		case "markRunDiscoveryComplete":
		case "markRunFailed":
		case "markRunStopped":
			return {
				runId: args[0] ?? null,
			}
		case "appendRunSample": {
			const input = (args[0] as { runId?: string; stage?: string; eventType?: string } | undefined) ?? {}
			return {
				runId: input.runId ?? null,
				stage: input.stage ?? null,
				eventType: input.eventType ?? null,
			}
		}
		case "persistParsedRevision": {
			const input = (args[0] as { revisionId?: string; chunks?: unknown[] } | undefined) ?? {}
			return {
				revisionId: input.revisionId ?? null,
				chunkCount: input.chunks?.length ?? 0,
			}
		}
		case "finalizeReadyRevisionsBatch": {
			const input = (args[0] as { runId?: string; resolutions?: unknown[] } | undefined) ?? {}
			return {
				runId: input.runId ?? null,
				resolutionCount: input.resolutions?.length ?? 0,
			}
		}
		case "enqueueJobs": {
			const jobs = Array.isArray(args[0]) ? args[0] : []
			return {
				jobCount: jobs.length,
				runId: (jobs[0] as { runId?: string } | undefined)?.runId ?? null,
			}
		}
		case "clearStorage": {
			const input = (args[0] as { includeTelemetry?: boolean } | undefined) ?? {}
			return {
				includeTelemetry: input.includeTelemetry ?? false,
			}
		}
		case "performMaintenance": {
			const input = (args[0] as { checkpointMode?: string; shrinkMemory?: boolean } | undefined) ?? {}
			return {
				checkpointMode: input.checkpointMode ?? "PASSIVE",
				shrinkMemory: input.shrinkMemory ?? false,
			}
		}
		default:
			return {}
	}
}

function logRequestEvent(
	message: "metadata-sidecar-request-start" | "metadata-sidecar-request-complete",
	requestId: string,
	operation: string,
	fields: Record<string, unknown>,
) {
	IndexDebugLoggerV2.log("basic", "MetadataSidecar", message, {
		component: "MetadataSidecar",
		processRole: "sidecar",
		requestId,
		operation,
		sidecarPid: process.pid,
		pendingRequestCount: pendingControllers.size,
		memory: getMemorySnapshot(),
		cpu: getCpuSnapshot(),
		...fields,
	})
}

async function handleMessage(message: MetadataSidecarHostToChildMessage) {
	try {
		switch (message.type) {
			case "init": {
				IndexDebugLoggerV2.configureDiagnosticsDirectory(
					message.payload.paths.diagnosticsRootDir,
					message.payload.paths.workspacePath,
				)
				repository = new SqliteMetadataRepository(message.payload.paths)
				await repository.initialize()
				diffPlanner = new DiffPlanner(repository as any)
				send({
					type: "ready",
					pid: process.pid,
					memory: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
				return
			}
			case "call": {
				if (!repository) {
					throw new Error("Metadata sidecar received work before initialization")
				}
				if (!ALLOWED_OPERATIONS.has(message.operation)) {
					throw new Error(`Unsupported metadata sidecar operation: ${message.operation}`)
				}
				const startedAt = Date.now()
				const summary = summarizeOperationArgs(message.operation, message.args)
				logRequestEvent("metadata-sidecar-request-start", message.requestId, message.operation, summary)
				try {
					let result: unknown
					if (message.operation === "runPlannerSlice") {
						if (!diffPlanner) {
							throw new Error("Metadata sidecar planner is unavailable")
						}
						const controller = new AbortController()
						pendingControllers.set(message.requestId, controller)
						try {
							result = await diffPlanner.run(
								String(message.args[0]),
								controller.signal,
								(message.args[1] as
									| { revisionIds?: string[]; limit?: number; maxJobs?: number }
									| undefined) ?? undefined,
							)
						} finally {
							pendingControllers.delete(message.requestId)
						}
					} else {
						const operation = (repository as unknown as Record<string, (...args: unknown[]) => unknown>)[
							message.operation
						]
						if (typeof operation !== "function") {
							throw new Error(
								`Metadata sidecar cannot invoke non-function operation: ${message.operation}`,
							)
						}
						result = await operation.apply(repository, message.args)
					}
					logRequestEvent("metadata-sidecar-request-complete", message.requestId, message.operation, {
						elapsedMs: Math.max(Date.now() - startedAt, 0),
						status: "ok",
						...summary,
					})
					send({
						type: "response",
						requestId: message.requestId,
						result,
						memory: getMemorySnapshot(),
						cpu: getCpuSnapshot(),
					})
				} catch (error) {
					logRequestEvent("metadata-sidecar-request-complete", message.requestId, message.operation, {
						elapsedMs: Math.max(Date.now() - startedAt, 0),
						status: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						...summary,
					})
					send({
						type: "error",
						requestId: message.requestId,
						errorMessage: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						memory: getMemorySnapshot(),
						cpu: getCpuSnapshot(),
					})
				}
				return
			}
			case "cancel": {
				pendingControllers.get(message.requestId)?.abort()
				pendingControllers.delete(message.requestId)
				return
			}
			case "shutdown": {
				await repository?.dispose()
				send({
					type: "shutdown-complete",
					requestId: message.requestId,
				})
				process.exit(0)
			}
		}
	} catch (error) {
		send({
			type: "error",
			requestId: message.type === "call" ? message.requestId : undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			memory: getMemorySnapshot(),
			cpu: getCpuSnapshot(),
		})
	}
}

process.on("message", (message: MetadataSidecarHostToChildMessage) => {
	void handleMessage(message)
})
