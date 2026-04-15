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
	startedAtMs?: number
}

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
	"writeRunSummary",
	"runPlannerSlice",
])

export class MetadataSidecarClient {
	private static readonly SHUTDOWN_TIMEOUT_MS = 5_000
	private readonly sidecarScriptPath = this.resolveSidecarScriptPath()
	private child: ChildProcess | undefined
	private ready: Promise<void> | undefined
	private readonly pending = new Map<string, PendingRequest>()
	private requestCounter = 0

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
			return
		}
		const requestId = this.nextRequestId("shutdown")
		try {
			await Promise.race([
				this.sendRequest<void>(
					{
						type: "shutdown",
						requestId,
					},
					requestId,
				),
				new Promise<void>((_, reject) =>
					setTimeout(
						() => reject(new Error("Metadata sidecar shutdown timed out")),
						MetadataSidecarClient.SHUTDOWN_TIMEOUT_MS,
					),
				),
			])
		} catch {
			this.child.kill()
		} finally {
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey())
			this.child = undefined
			this.ready = undefined
			this.pending.clear()
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
		const resultPromise = this.sendRequest<DiffPlannerSummary>(
			{
				type: "call",
				requestId,
				operation: "runPlannerSlice",
				args: [runId, options],
			},
			requestId,
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
		)
	}

	private async ensureReady(): Promise<void> {
		if (!this.ready) {
			this.ready = this.spawnSidecar()
		}
		await this.ready
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
		child.on("exit", (code, signal) => {
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey())
			IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-exit", {
				component: "MetadataSidecar",
				processRole: "sidecar",
				sidecarPid: child.pid,
				exitCode: code,
				exitSignal: signal,
				workspacePath: this.paths.workspacePath,
			})
			const error = new Error(
				`Metadata sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
			for (const pending of this.pending.values()) {
				pending.reject(error)
			}
			this.pending.clear()
			this.child = undefined
			this.ready = undefined
		})
		IndexDebugLoggerV2.log("basic", "MetadataSidecar", "metadata-sidecar-spawn", {
			component: "MetadataSidecar",
			processRole: "host",
			sidecarScriptPath: this.sidecarScriptPath,
			workspacePath: this.paths.workspacePath,
		})

		await new Promise<void>((resolve, reject) => {
			const requestId = `ready:${this.nextRequestId("init")}`
			this.pending.set(requestId, {
				resolve: () => resolve(),
				reject,
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

	private sendRequest<T>(message: MetadataSidecarHostToChildMessage, requestId: string): Promise<T> {
		if (!this.child) {
			return Promise.reject(new Error("Metadata sidecar is unavailable"))
		}
		return new Promise<T>((resolve, reject) => {
			this.pending.set(requestId, {
				resolve: (value) => resolve(value as T),
				reject,
				startedAtMs: Date.now(),
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
				this.pending.get(this.findReadyRequestId())?.resolve(undefined)
				this.pending.delete(this.findReadyRequestId())
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
				const pending = this.pending.get(message.requestId)
				if (pending) {
					pending.resolve(message.result)
					this.pending.delete(message.requestId)
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
				const error = new Error(message.errorMessage)
				error.stack = message.stack
				if (message.requestId) {
					const pending = this.pending.get(message.requestId)
					if (pending) {
						pending.reject(error)
						this.pending.delete(message.requestId)
					}
				}
				return
			}
			case "shutdown-complete": {
				const pending = this.pending.get(message.requestId)
				if (pending) {
					pending.resolve(undefined)
					this.pending.delete(message.requestId)
				}
			}
		}
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
