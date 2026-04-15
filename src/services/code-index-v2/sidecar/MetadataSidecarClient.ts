import { ChildProcess, fork } from "child_process"
import { existsSync } from "fs"
import * as path from "path"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import type { DiffPlannerSummary } from "../pipeline/DiffPlanner"
import type { ResolvedMetadataStorePaths } from "../store/MetadataPathResolver"
import type { MetadataSidecarChildToHostMessage, MetadataSidecarHostToChildMessage } from "./metadataProtocol"

interface PendingRequest {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	startedAtMs: number
	operation: string
	timeoutMs: number
	timer: ReturnType<typeof setTimeout>
}

const HOT_PATH_TIMEOUT_MS = 5_000
const HEAVY_OPERATION_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 90_000
const INIT_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 2_000

const HOT_PATH_OPERATIONS = new Set([
	"getRunBacklogMetrics",
	"claimJobs",
	"claimJobsWithLease",
	"heartbeatRun",
	"appendRunSample",
	"heartbeatJobs",
	"getRunProgressRecord",
	"getNextRetryAt",
])

const HEAVY_OPERATIONS = new Set([
	"runPlannerSlice",
	"persistParsedRevision",
	"finalizeReadyRevisionsBatch",
	"performMaintenance",
])

const CLEANUP_OPERATIONS = new Set(["clearStorage", "cleanupStaleRuns"])

const REMOTE_OPERATION_ALLOWLIST = new Set([
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

export class MetadataSidecarRequestTimeoutError extends Error {
	override name = "MetadataSidecarRequestTimeoutError"

	constructor(
		public readonly operation: string,
		public readonly requestId: string,
		public readonly timeoutMs: number,
		public readonly elapsedMs: number,
	) {
		super(`Metadata sidecar timed out during ${operation} after ${elapsedMs}ms (timeout ${timeoutMs}ms).`)
	}
}

export class MetadataSidecarUnavailableError extends Error {
	override name = "MetadataSidecarUnavailableError"

	constructor(
		message: string,
		public readonly causeError?: Error,
	) {
		super(message)
	}
}

export function isMetadataSidecarRuntimeError(error: unknown): boolean {
	return error instanceof MetadataSidecarRequestTimeoutError || error instanceof MetadataSidecarUnavailableError
}

function getOperationTimeoutMs(operation: string): number {
	if (HOT_PATH_OPERATIONS.has(operation)) {
		return HOT_PATH_TIMEOUT_MS
	}
	if (HEAVY_OPERATIONS.has(operation)) {
		return HEAVY_OPERATION_TIMEOUT_MS
	}
	if (CLEANUP_OPERATIONS.has(operation)) {
		return CLEANUP_TIMEOUT_MS
	}
	return HEAVY_OPERATION_TIMEOUT_MS
}

function summarizeOperationArgs(operation: string, args: unknown[]): Record<string, unknown> {
	switch (operation) {
		case "runPlannerSlice": {
			const options = (args[1] as { revisionIds?: string[]; limit?: number; maxJobs?: number } | undefined) ?? {}
			return {
				runId: args[0],
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

export class MetadataSidecarClient {
	private static readonly SHUTDOWN_TIMEOUT_MS = 5_000
	private readonly sidecarScriptPath = this.resolveSidecarScriptPath()
	private child: ChildProcess | undefined
	private ready: Promise<void> | undefined
	private readonly pending = new Map<string, PendingRequest>()
	private requestCounter = 0
	private unhealthyError: Error | undefined
	private terminatingChildPid: number | undefined

	constructor(private readonly paths: ResolvedMetadataStorePaths) {
		return new Proxy(this, {
			get: (target, prop, receiver) => {
				if (typeof prop !== "string" || prop in target) {
					const value = Reflect.get(target, prop, receiver)
					return typeof value === "function" ? value.bind(target) : value
				}
				if (!REMOTE_OPERATION_ALLOWLIST.has(prop)) {
					return undefined
				}
				return (...args: unknown[]) => target.invokeRemote(prop, args)
			},
		}) as MetadataSidecarClient
	}

	async initialize(): Promise<void> {
		await this.ensureReady()
	}

	async dispose(): Promise<void> {
		if (!this.child) {
			this.unhealthyError = undefined
			return
		}
		const child = this.child
		const requestId = this.nextRequestId("shutdown")
		try {
			await Promise.race([
				this.sendRequest<void>(
					{
						type: "shutdown",
						requestId,
					},
					requestId,
					"shutdown",
					MetadataSidecarClient.SHUTDOWN_TIMEOUT_MS,
				),
				new Promise<void>((_, reject) =>
					setTimeout(
						() => reject(new Error("Metadata sidecar shutdown timed out")),
						MetadataSidecarClient.SHUTDOWN_TIMEOUT_MS,
					),
				),
			])
		} catch {
			this.terminateChild(child)
		} finally {
			this.resetClientState()
		}
	}

	getWorkspaceId(): string {
		return this.paths.workspaceHash
	}

	getDatabasePath(): string {
		return this.paths.dbPath
	}

	getTelemetryDatabasePath(): string {
		return this.paths.telemetryDbPath
	}

	getBootstrapPath(): string {
		return this.paths.bootstrapPath
	}

	getDiagnosticsDirectoryPath(): string {
		return this.paths.diagnosticsRootDir
	}

	async runPlannerSlice(
		runId: string,
		options?: { revisionIds?: string[]; limit?: number; maxJobs?: number },
		signal?: AbortSignal,
	): Promise<DiffPlannerSummary> {
		await this.ensureReady()
		const requestId = this.nextRequestId("planner")
		const timeoutMs = getOperationTimeoutMs("runPlannerSlice")
		const resultPromise = this.sendRequest<DiffPlannerSummary>(
			{
				type: "call",
				requestId,
				operation: "runPlannerSlice",
				args: [runId, options],
			},
			requestId,
			"runPlannerSlice",
			timeoutMs,
		)

		if (!signal) {
			return resultPromise
		}

		if (signal.aborted) {
			this.sendFireAndForget({
				type: "cancel",
				requestId,
			})
			throw new Error("Diff planner aborted")
		}

		return await Promise.race([
			resultPromise,
			new Promise<DiffPlannerSummary>((_, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort)
					this.sendFireAndForget({
						type: "cancel",
						requestId,
					})
					reject(new Error("Diff planner aborted"))
				}
				signal.addEventListener("abort", onAbort, { once: true })
				resultPromise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined)
			}),
		])
	}

	private async invokeRemote(operation: string, args: unknown[]): Promise<unknown> {
		await this.ensureReady()
		const requestId = this.nextRequestId(operation)
		return this.sendRequest(
			{
				type: "call",
				requestId,
				operation,
				args,
			},
			requestId,
			operation,
			getOperationTimeoutMs(operation),
		)
	}

	private async ensureReady(): Promise<void> {
		if (this.unhealthyError) {
			throw this.unhealthyError
		}
		if (!this.ready) {
			this.ready = this.spawnSidecar()
		}
		await this.ready
		if (this.unhealthyError) {
			throw this.unhealthyError
		}
	}

	private resolveSidecarScriptPath(): string {
		const candidates = [
			path.join(__dirname, "workers", "codeIndexV2MetadataSidecar.js"),
			path.join(__dirname, "..", "..", "..", "workers", "codeIndexV2MetadataSidecar.js"),
		]
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate
			}
		}
		return candidates[0]
	}

	private async spawnSidecar(): Promise<void> {
		const child = fork(this.sidecarScriptPath, [], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			execArgv: [],
			env: {
				...process.env,
				ROO_CODE_INDEX_V2_DIAGNOSTICS_DIR: this.paths.diagnosticsRootDir,
			},
		})
		this.child = child
		child.on("message", (message: MetadataSidecarChildToHostMessage) => this.handleChildMessage(message))
		child.on("exit", (code, signal) => this.handleChildExit(child, code, signal))
		IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-spawn", {
			component: "MetadataSidecar",
			processRole: "host",
			sidecarScriptPath: this.sidecarScriptPath,
			workspacePath: this.paths.workspacePath,
		})

		await new Promise<void>((resolve, reject) => {
			const requestId = `ready:${this.nextRequestId("init")}`
			const timer = setTimeout(() => {
				const pending = this.pending.get(requestId)
				if (!pending) {
					return
				}
				const elapsedMs = Math.max(Date.now() - pending.startedAtMs, 0)
				const error = new MetadataSidecarRequestTimeoutError("init", requestId, INIT_TIMEOUT_MS, elapsedMs)
				this.logRequestEvent("metadata-sidecar-request-timeout", requestId, "init", {
					elapsedMs,
					timeoutMs: INIT_TIMEOUT_MS,
					pendingRequestCount: this.pending.size,
				})
				this.failSidecar(error)
			}, INIT_TIMEOUT_MS)
			this.pending.set(requestId, {
				resolve: () => resolve(),
				reject,
				startedAtMs: Date.now(),
				operation: "init",
				timeoutMs: INIT_TIMEOUT_MS,
				timer,
			})
			this.logRequestEvent("metadata-sidecar-request-start", requestId, "init", {
				timeoutMs: INIT_TIMEOUT_MS,
				pendingRequestCount: this.pending.size,
			})
			child.send({
				type: "init",
				payload: {
					paths: this.paths,
				},
			} satisfies MetadataSidecarHostToChildMessage)
		})
	}

	private sendFireAndForget(message: MetadataSidecarHostToChildMessage) {
		this.child?.send(message)
	}

	private sendRequest<T>(
		message: MetadataSidecarHostToChildMessage,
		requestId: string,
		operation: string,
		timeoutMs: number,
	): Promise<T> {
		if (!this.child) {
			return Promise.reject(
				new MetadataSidecarUnavailableError(`Metadata sidecar is unavailable during ${operation}.`),
			)
		}
		if (this.unhealthyError) {
			return Promise.reject(this.unhealthyError)
		}
		return new Promise<T>((resolve, reject) => {
			const startedAtMs = Date.now()
			const timer = setTimeout(() => {
				const pending = this.pending.get(requestId)
				if (!pending) {
					return
				}
				const elapsedMs = Math.max(Date.now() - startedAtMs, 0)
				const error = new MetadataSidecarRequestTimeoutError(operation, requestId, timeoutMs, elapsedMs)
				this.logRequestEvent("metadata-sidecar-request-timeout", requestId, operation, {
					elapsedMs,
					timeoutMs,
					pendingRequestCount: this.pending.size,
					...summarizeOperationArgs(operation, message.type === "call" ? message.args : []),
				})
				if (operation === "runPlannerSlice") {
					this.sendFireAndForget({
						type: "cancel",
						requestId,
					})
				}
				this.failSidecar(error)
			}, timeoutMs)

			this.pending.set(requestId, {
				resolve: (value) => resolve(value as T),
				reject,
				startedAtMs,
				operation,
				timeoutMs,
				timer,
			})
			this.logRequestEvent("metadata-sidecar-request-start", requestId, operation, {
				timeoutMs,
				pendingRequestCount: this.pending.size,
				...summarizeOperationArgs(operation, message.type === "call" ? message.args : []),
			})
			this.child?.send(message)
		})
	}

	private handleChildMessage(message: MetadataSidecarChildToHostMessage) {
		switch (message.type) {
			case "ready": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					"metadataSidecar",
					"metadata-sidecar",
					this.paths.workspacePath,
					message.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-ready", {
					component: "MetadataSidecar",
					processRole: "sidecar",
					sidecarPid: message.pid,
					workspacePath: this.paths.workspacePath,
					memory: message.memory,
					cpu: message.cpu,
				})
				const requestId = this.findReadyRequestId()
				const pending = this.takePendingRequest(requestId)
				if (pending) {
					this.logRequestEvent("metadata-sidecar-request-complete", requestId, pending.operation, {
						elapsedMs: Math.max(Date.now() - pending.startedAtMs, 0),
						pendingRequestCount: this.pending.size,
					})
					pending.resolve(undefined)
				}
				return
			}
			case "response": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					"metadataSidecar",
					"metadata-sidecar",
					this.paths.workspacePath,
					this.child?.pid,
					message.memory,
					message.cpu,
				)
				const pending = this.takePendingRequest(message.requestId)
				if (pending) {
					this.logRequestEvent("metadata-sidecar-request-complete", message.requestId, pending.operation, {
						elapsedMs: Math.max(Date.now() - pending.startedAtMs, 0),
						pendingRequestCount: this.pending.size,
					})
					pending.resolve(message.result)
				}
				return
			}
			case "error": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					"metadataSidecar",
					"metadata-sidecar",
					this.paths.workspacePath,
					this.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-error", {
					component: "MetadataSidecar",
					processRole: "sidecar",
					sidecarPid: this.child?.pid,
					errorMessage: message.errorMessage,
					workspacePath: this.paths.workspacePath,
					memory: message.memory,
					cpu: message.cpu,
				})
				if (message.requestId) {
					const pending = this.takePendingRequest(message.requestId)
					if (pending) {
						this.logRequestEvent(
							"metadata-sidecar-request-complete",
							message.requestId,
							pending.operation,
							{
								elapsedMs: Math.max(Date.now() - pending.startedAtMs, 0),
								pendingRequestCount: this.pending.size,
								status: "error",
							},
						)
						const error = new MetadataSidecarUnavailableError(
							`Metadata sidecar failed during ${pending.operation}: ${message.errorMessage}`,
						)
						error.stack = message.stack
						pending.reject(error)
					}
				}
				return
			}
			case "shutdown-complete": {
				const pending = this.takePendingRequest(message.requestId)
				if (pending) {
					this.logRequestEvent("metadata-sidecar-request-complete", message.requestId, pending.operation, {
						elapsedMs: Math.max(Date.now() - pending.startedAtMs, 0),
						pendingRequestCount: this.pending.size,
					})
					pending.resolve(undefined)
				}
			}
		}
	}

	private handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
		IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey())
		IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-exit", {
			component: "MetadataSidecar",
			processRole: "sidecar",
			sidecarPid: child.pid,
			exitCode: code,
			exitSignal: signal,
			workspacePath: this.paths.workspacePath,
		})

		const exitedChild = this.child === child
		if (exitedChild) {
			this.child = undefined
			this.ready = undefined
		}
		const error =
			this.unhealthyError ??
			new MetadataSidecarUnavailableError(
				`Metadata sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
			)
		for (const requestId of Array.from(this.pending.keys())) {
			const pending = this.takePendingRequest(requestId)
			pending?.reject(error)
		}
		if (!this.unhealthyError && this.terminatingChildPid !== child.pid) {
			this.unhealthyError = error
		}
		if (this.terminatingChildPid === child.pid) {
			this.terminatingChildPid = undefined
		}
	}

	private failSidecar(error: Error) {
		if (!this.unhealthyError) {
			this.unhealthyError = error
		}
		const child = this.child
		const pendingIds = Array.from(this.pending.keys())
		for (const requestId of pendingIds) {
			const pending = this.takePendingRequest(requestId)
			pending?.reject(error)
		}
		this.ready = undefined
		if (child) {
			this.terminateChild(child)
		}
	}

	private terminateChild(child: ChildProcess) {
		if (this.terminatingChildPid === child.pid) {
			return
		}
		this.terminatingChildPid = child.pid
		if (child.exitCode == null && child.signalCode == null) {
			child.kill("SIGTERM")
			setTimeout(() => {
				if (this.child === child && child.exitCode == null && child.signalCode == null) {
					child.kill("SIGKILL")
				}
			}, KILL_GRACE_MS)
		}
	}

	private takePendingRequest(requestId: string): PendingRequest | undefined {
		const pending = this.pending.get(requestId)
		if (!pending) {
			return undefined
		}
		clearTimeout(pending.timer)
		this.pending.delete(requestId)
		return pending
	}

	private resetClientState() {
		IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey())
		for (const requestId of Array.from(this.pending.keys())) {
			this.takePendingRequest(requestId)
		}
		this.child = undefined
		this.ready = undefined
		this.unhealthyError = undefined
		this.terminatingChildPid = undefined
	}

	private logRequestEvent(
		message:
			| "metadata-sidecar-request-start"
			| "metadata-sidecar-request-complete"
			| "metadata-sidecar-request-timeout",
		requestId: string,
		operation: string,
		fields: Record<string, unknown>,
	) {
		IndexDebugLoggerV2.log("basic", "MetadataSidecar", message, {
			component: "MetadataSidecar",
			processRole: "host",
			workspacePath: this.paths.workspacePath,
			requestId,
			operation,
			sidecarPid: this.child?.pid,
			memory: IndexDebugLoggerV2.getMemorySnapshot(),
			cpu: IndexDebugLoggerV2.getCpuSnapshot(),
			...fields,
		})
	}

	private findReadyRequestId(): string {
		return Array.from(this.pending.keys()).find((key) => key.startsWith("ready:")) ?? ""
	}

	private nextRequestId(prefix: string): string {
		this.requestCounter += 1
		return `${prefix}:${this.requestCounter}`
	}

	private getTrackedProcessKey(): string {
		return `metadata-sidecar:${this.paths.workspaceHash}`
	}
}
