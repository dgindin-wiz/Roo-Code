import { ChildProcess, fork } from "child_process"
import { existsSync } from "fs"
import * as path from "path"
import type { IndexingSidecarState } from "@roo-code/types"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import type { DiffPlannerSummary } from "../pipeline/DiffPlanner"
import type { ResolvedMetadataStorePaths } from "../store/MetadataPathResolver"
import { REMOTE_METADATA_OPERATION_SET } from "./metadataOperations"
import type {
	MetadataSidecarChildToHostMessage,
	MetadataSidecarHostToChildMessage,
	MetadataSidecarRole,
} from "./metadataProtocol"

interface PendingRequest {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	startedAtMs: number
	operation: string
	timeoutMs: number
	timer: ReturnType<typeof setTimeout>
}

const HOT_PATH_TIMEOUT_MS = 5_000
const CLAIM_TIMEOUT_MS = 10_000
const POLL_TIMEOUT_MS = 10_000
const HEAVY_OPERATION_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 90_000
const VACUUM_TIMEOUT_MS = 10 * 60_000
const INIT_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 2_000

const HOT_PATH_OPERATIONS = new Set([
	"heartbeatRun",
	"appendRunSample",
	"heartbeatJobs",
	"getRunProgressRecord",
	"getNextRetryAt",
])

const CLAIM_OPERATIONS = new Set(["claimJobs", "claimJobsWithLease"])

const POLL_OPERATIONS = new Set(["getRunBacklogMetrics"])

const HEAVY_OPERATIONS = new Set([
	"runPlannerSlice",
	"persistParsedRevision",
	"finalizeReadyRevisionsBatch",
	"listPlannedRevisionResolutions",
	"listReadyRevisionResolutions",
])

const CLEANUP_OPERATIONS = new Set(["clearStorage", "cleanupStaleRuns", "performMaintenance"])

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

function getOperationTimeoutMs(operation: string, args: unknown[] = []): number {
	if (CLAIM_OPERATIONS.has(operation)) {
		return CLAIM_TIMEOUT_MS
	}
	if (HOT_PATH_OPERATIONS.has(operation)) {
		return HOT_PATH_TIMEOUT_MS
	}
	if (POLL_OPERATIONS.has(operation)) {
		return POLL_TIMEOUT_MS
	}
	if (HEAVY_OPERATIONS.has(operation)) {
		return HEAVY_OPERATION_TIMEOUT_MS
	}
	if (CLEANUP_OPERATIONS.has(operation)) {
		if (operation === "performMaintenance") {
			const input = args[0] as { vacuumMode?: string } | undefined
			if (input?.vacuumMode === "full") {
				return VACUUM_TIMEOUT_MS
			}
		}
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
		case "getRunSummary":
		case "heartbeatRun":
		case "getRunProgressRecord":
		case "markRunComplete":
		case "markRunDiscoveryComplete":
		case "markRunFailed":
		case "markRunStopped":
			return {
				runId: args[0] ?? null,
			}
		case "listRunSummaries":
		case "listRecentRunProgress":
			return {
				limit: args[0] ?? null,
			}
		case "listReadyRevisionResolutions":
			return {
				runId: args[0] ?? null,
				limit: args[1] ?? null,
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
			const input =
				(args[0] as
					| {
							checkpointMode?: string
							shrinkMemory?: boolean
							pruneFootprint?: boolean
							markFootprintCleanup?: boolean
							maxPruneBatches?: number
							vacuumMode?: string
					  }
					| undefined) ?? {}
			return {
				checkpointMode: input.checkpointMode ?? "PASSIVE",
				shrinkMemory: input.shrinkMemory ?? false,
				pruneFootprint: input.pruneFootprint ?? true,
				markFootprintCleanup: input.markFootprintCleanup ?? false,
				maxPruneBatches: input.maxPruneBatches ?? null,
				vacuumMode: input.vacuumMode ?? "none",
			}
		}
		default:
			return {}
	}
}

interface MetadataSidecarClientOptions {
	role?: MetadataSidecarRole
}

export interface MetadataSidecarClientDiagnostics {
	role: MetadataSidecarRole
	label: string
	state: IndexingSidecarState
	pid: number | null
	pendingRequestCount: number
	lastOperation: string | null
	lastElapsedMs: number | null
	lastTimeoutMs: number | null
	lastError: string | null
	updatedAt: number
}

export class MetadataSidecarClient {
	private static readonly SHUTDOWN_TIMEOUT_MS = 5_000
	private readonly sidecarScriptPath = this.resolveSidecarScriptPath()
	private readonly role: MetadataSidecarRole
	private child: ChildProcess | undefined
	private ready: Promise<void> | undefined
	private readonly pending = new Map<string, PendingRequest>()
	private requestCounter = 0
	private unhealthyError: Error | undefined
	private terminatingChildPid: number | undefined
	private expectedExitChildPid: number | undefined
	private lastOperation: string | undefined
	private lastElapsedMs: number | undefined
	private lastTimeoutMs: number | undefined
	private lastError: string | undefined
	private diagnosticsUpdatedAt = Date.now()

	constructor(
		private readonly paths: ResolvedMetadataStorePaths,
		options: MetadataSidecarClientOptions = {},
	) {
		this.role = options.role ?? "writer"
		return new Proxy(this, {
			get: (target, prop, receiver) => {
				if (typeof prop !== "string" || prop in target) {
					const value = Reflect.get(target, prop, receiver)
					return typeof value === "function" ? value.bind(target) : value
				}
				if (!REMOTE_METADATA_OPERATION_SET.has(prop)) {
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
			this.lastError = undefined
			this.diagnosticsUpdatedAt = Date.now()
			return
		}
		const child = this.child
		this.expectedExitChildPid = child.pid
		const requestId = this.nextRequestId("shutdown")
		let shutdownError: Error | undefined
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
		} catch (error) {
			shutdownError = error instanceof Error ? error : new Error(String(error))
			this.terminateChild(child)
			await this.waitForChildExit(child, KILL_GRACE_MS + 500).catch(() => undefined)
		} finally {
			this.clearPendingRequests(
				shutdownError
					? new MetadataSidecarUnavailableError(
							"Metadata sidecar was disposed while requests were pending.",
							shutdownError,
						)
					: undefined,
			)
			if (this.child === child) {
				this.child = undefined
				this.ready = undefined
			}
			this.unhealthyError = undefined
			this.lastError = undefined
			this.diagnosticsUpdatedAt = Date.now()
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

	getDiagnosticsSnapshot(): MetadataSidecarClientDiagnostics {
		return {
			role: this.role,
			label: this.getSidecarLabel(),
			state: this.getDiagnosticState(),
			pid: this.child?.pid ?? null,
			pendingRequestCount: this.pending.size,
			lastOperation: this.lastOperation ?? null,
			lastElapsedMs: this.lastElapsedMs ?? null,
			lastTimeoutMs: this.lastTimeoutMs ?? null,
			lastError: this.unhealthyError?.message ?? this.lastError ?? null,
			updatedAt: this.diagnosticsUpdatedAt,
		}
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
			getOperationTimeoutMs(operation, args),
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
			sidecarRole: this.role,
			sidecarLabel: this.getSidecarLabel(),
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
				this.recordRequestError("init", elapsedMs, error.message, INIT_TIMEOUT_MS)
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
			this.recordRequestStart("init")
			child.send({
				type: "init",
				payload: {
					paths: this.paths,
					role: this.role,
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
				this.recordRequestError(operation, elapsedMs, error.message, timeoutMs)
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
			this.recordRequestStart(operation)
			this.child?.send(message)
		})
	}

	private handleChildMessage(message: MetadataSidecarChildToHostMessage) {
		switch (message.type) {
			case "ready": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					this.getTrackedProcessGroup(),
					this.getSidecarLabel(),
					this.paths.workspacePath,
					message.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-ready", {
					component: "MetadataSidecar",
					processRole: "sidecar",
					sidecarRole: this.role,
					sidecarLabel: this.getSidecarLabel(),
					sidecarPid: message.pid,
					workspacePath: this.paths.workspacePath,
					memory: message.memory,
					cpu: message.cpu,
				})
				const requestId = this.findReadyRequestId()
				const pending = this.takePendingRequest(requestId)
				if (pending) {
					const elapsedMs = Math.max(Date.now() - pending.startedAtMs, 0)
					this.logRequestEvent("metadata-sidecar-request-complete", requestId, pending.operation, {
						elapsedMs,
						pendingRequestCount: this.pending.size,
					})
					this.recordRequestComplete(pending.operation, elapsedMs)
					pending.resolve(undefined)
				}
				return
			}
			case "response": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					this.getTrackedProcessGroup(),
					this.getSidecarLabel(),
					this.paths.workspacePath,
					this.child?.pid,
					message.memory,
					message.cpu,
				)
				const pending = this.takePendingRequest(message.requestId)
				if (pending) {
					const elapsedMs = Math.max(Date.now() - pending.startedAtMs, 0)
					this.logRequestEvent("metadata-sidecar-request-complete", message.requestId, pending.operation, {
						elapsedMs,
						pendingRequestCount: this.pending.size,
					})
					this.recordRequestComplete(pending.operation, elapsedMs)
					pending.resolve(message.result)
				}
				return
			}
			case "error": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(),
					this.getTrackedProcessGroup(),
					this.getSidecarLabel(),
					this.paths.workspacePath,
					this.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-error", {
					component: "MetadataSidecar",
					processRole: "sidecar",
					sidecarRole: this.role,
					sidecarLabel: this.getSidecarLabel(),
					sidecarPid: this.child?.pid,
					errorMessage: message.errorMessage,
					workspacePath: this.paths.workspacePath,
					memory: message.memory,
					cpu: message.cpu,
				})
				if (message.requestId) {
					const pending = this.takePendingRequest(message.requestId)
					if (pending) {
						const elapsedMs = Math.max(Date.now() - pending.startedAtMs, 0)
						this.logRequestEvent(
							"metadata-sidecar-request-complete",
							message.requestId,
							pending.operation,
							{
								elapsedMs,
								pendingRequestCount: this.pending.size,
								status: "error",
							},
						)
						const error = new MetadataSidecarUnavailableError(
							`Metadata sidecar failed during ${pending.operation}: ${message.errorMessage}`,
						)
						error.stack = message.stack
						this.recordRequestError(pending.operation, elapsedMs, error.message)
						pending.reject(error)
					}
				}
				return
			}
			case "shutdown-complete": {
				const pending = this.takePendingRequest(message.requestId)
				if (pending) {
					const elapsedMs = Math.max(Date.now() - pending.startedAtMs, 0)
					this.logRequestEvent("metadata-sidecar-request-complete", message.requestId, pending.operation, {
						elapsedMs,
						pendingRequestCount: this.pending.size,
					})
					this.recordRequestComplete(pending.operation, elapsedMs)
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
			sidecarRole: this.role,
			sidecarLabel: this.getSidecarLabel(),
			sidecarPid: child.pid,
			exitCode: code,
			exitSignal: signal,
			workspacePath: this.paths.workspacePath,
		})

		const exitedChild = this.child === child
		const expectedExit = this.expectedExitChildPid === child.pid
		if (exitedChild) {
			this.child = undefined
			this.ready = undefined
		}
		const error =
			this.unhealthyError ??
			new MetadataSidecarUnavailableError(
				`Metadata sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
			)
		if (!expectedExit) {
			this.recordClientError(error.message)
		}
		for (const requestId of Array.from(this.pending.keys())) {
			const pending = this.takePendingRequest(requestId)
			pending?.reject(error)
		}
		if (!this.unhealthyError && this.terminatingChildPid !== child.pid && !expectedExit) {
			this.unhealthyError = error
		}
		if (this.terminatingChildPid === child.pid) {
			this.terminatingChildPid = undefined
		}
		if (expectedExit) {
			this.expectedExitChildPid = undefined
		}
		if (this.role === "reader") {
			this.unhealthyError = undefined
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
				if (child.exitCode == null && child.signalCode == null) {
					child.kill("SIGKILL")
				}
			}, KILL_GRACE_MS)
		}
	}

	private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
		if (child.exitCode != null || child.signalCode != null) {
			return Promise.resolve()
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				child.off("exit", onExit)
				reject(new Error("Timed out waiting for metadata sidecar exit"))
			}, timeoutMs)
			const onExit = () => {
				clearTimeout(timer)
				resolve()
			}
			child.once("exit", onExit)
		})
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

	private clearPendingRequests(error?: Error) {
		IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey())
		for (const requestId of Array.from(this.pending.keys())) {
			const pending = this.takePendingRequest(requestId)
			if (error) {
				pending?.reject(error)
			}
		}
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
			sidecarRole: this.role,
			sidecarLabel: this.getSidecarLabel(),
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

	private getDiagnosticState(): IndexingSidecarState {
		if (this.unhealthyError || (!this.child && this.lastError)) {
			return "failed"
		}
		if (!this.child) {
			return "standby"
		}
		return this.pending.size > 0 ? "busy" : "online"
	}

	private recordRequestStart(operation: string) {
		this.lastOperation = operation
		this.diagnosticsUpdatedAt = Date.now()
	}

	private recordRequestComplete(operation: string, elapsedMs: number) {
		this.lastOperation = operation
		this.lastElapsedMs = elapsedMs
		this.lastTimeoutMs = undefined
		this.lastError = undefined
		this.diagnosticsUpdatedAt = Date.now()
	}

	private recordRequestError(operation: string, elapsedMs: number, errorMessage: string, timeoutMs?: number) {
		this.lastOperation = operation
		this.lastElapsedMs = elapsedMs
		this.lastTimeoutMs = timeoutMs
		this.lastError = errorMessage
		this.diagnosticsUpdatedAt = Date.now()
	}

	private recordClientError(errorMessage: string) {
		this.lastError = errorMessage
		this.diagnosticsUpdatedAt = Date.now()
	}

	private getTrackedProcessKey(): string {
		return `metadata-${this.role}-sidecar:${this.paths.workspaceHash}`
	}

	private getTrackedProcessGroup(): string {
		return this.role === "writer" ? "metadataWriterSidecar" : "metadataReaderSidecar"
	}

	private getSidecarLabel(): string {
		return this.role === "writer" ? "metadata-writer-sidecar" : "metadata-reader-sidecar"
	}
}
