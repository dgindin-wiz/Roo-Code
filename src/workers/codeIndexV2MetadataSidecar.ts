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
						throw new Error(`Metadata sidecar cannot invoke non-function operation: ${message.operation}`)
					}
					result = await operation.apply(repository, message.args)
				}
				send({
					type: "response",
					requestId: message.requestId,
					result,
					memory: getMemorySnapshot(),
					cpu: getCpuSnapshot(),
				})
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
