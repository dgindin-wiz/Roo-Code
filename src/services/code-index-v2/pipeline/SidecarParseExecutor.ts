import { ChildProcess, fork } from "child_process"
import { existsSync } from "fs"
import * as path from "path"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { ParsedChunkUpsertInput } from "./ParseExecution"
import { ParseSidecarChildToHostMessage, ParseSidecarHostToChildMessage } from "../sidecar/parseProtocol"

interface PendingRequest<T> {
	resolve: (value: T) => void
	reject: (error: Error) => void
}

interface ParseLane {
	index: number
	child?: ChildProcess
	ready?: Promise<void>
	pending: Map<string, PendingRequest<any>>
}

export class SidecarParseExecutor {
	private static readonly SHUTDOWN_TIMEOUT_MS = 5_000
	private static readonly INIT_TIMEOUT_MS = 10_000
	private readonly lanes: ParseLane[]
	private requestCounter = 0
	private readonly sidecarScriptPath = this.resolveSidecarScriptPath()

	constructor(
		private readonly workspacePath: string,
		laneConcurrency: number,
	) {
		const laneCount = Math.max(1, laneConcurrency)
		this.lanes = Array.from({ length: laneCount }, (_, index) => ({
			index,
			pending: new Map(),
		}))
	}

	async parseRevision(input: {
		runId: string
		revisionId: string
		normalizedPath: string
		maxFileSizeBytes?: number
		laneId?: number
		signal?: AbortSignal
	}): Promise<{ chunks: ParsedChunkUpsertInput[]; parseLatencyMs: number }> {
		const lane = await this.ensureLane(input.laneId ?? 1, input.signal)
		const requestId = this.nextRequestId("parse")
		return this.sendRequest(
			lane,
			{
				type: "parse-revision",
				requestId,
				runId: input.runId,
				revisionId: input.revisionId,
				normalizedPath: input.normalizedPath,
				maxFileSizeBytes: input.maxFileSizeBytes,
			},
			input.signal,
		)
	}

	async dispose(): Promise<void> {
		await Promise.all(
			this.lanes.map(async (lane) => {
				if (!lane.child) {
					return
				}
				const requestId = this.nextRequestId(`shutdown-${lane.index + 1}`)
				try {
					await Promise.race([
						this.sendRequest<void>(lane, {
							type: "shutdown",
							requestId,
						}),
						new Promise<void>((_, reject) =>
							setTimeout(
								() =>
									reject(new Error(`Code index parse sidecar ${lane.index + 1} shutdown timed out`)),
								SidecarParseExecutor.SHUTDOWN_TIMEOUT_MS,
							),
						),
					])
				} catch {
					lane.child.kill()
				} finally {
					lane.child = undefined
					lane.ready = undefined
					lane.pending.clear()
				}
			}),
		)
	}

	private async ensureLane(laneId: number, signal?: AbortSignal): Promise<ParseLane> {
		const lane = this.lanes[(laneId - 1) % this.lanes.length]
		if (!lane.ready) {
			lane.ready = this.spawnLane(lane, signal).catch((error) => {
				lane.ready = undefined
				throw error
			})
		}
		await this.withAbort(signal, lane.ready, "Parse/chunk stage aborted")
		return lane
	}

	private resolveSidecarScriptPath(): string {
		const candidates = [
			path.join(__dirname, "workers", "codeIndexV2ParseSidecarBootstrap.js"),
			path.join(__dirname, "workers", "codeIndexV2ParseSidecar.js"),
			path.join(__dirname, "..", "..", "..", "workers", "codeIndexV2ParseSidecarBootstrap.js"),
			path.join(__dirname, "..", "..", "..", "workers", "codeIndexV2ParseSidecar.js"),
		]
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate
			}
		}
		return candidates[0]
	}

	private async spawnLane(lane: ParseLane, signal?: AbortSignal): Promise<void> {
		const child = fork(this.sidecarScriptPath, [], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			execArgv: [],
			env: {
				...process.env,
				ROO_CODE_INDEX_V2_DIAGNOSTICS_DIR: IndexDebugLoggerV2.getDiagnosticsDirectory(),
			},
		})
		lane.child = child
		child.on("spawn", () => {
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-process-spawned", {
				component: "CodeIndexParseSidecar",
				processRole: "host",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
			})
		})
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const line = String(chunk).trim()
			if (!line) {
				return
			}
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-stdout", {
				component: "CodeIndexParseSidecar",
				processRole: "sidecar",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				errorMessage: line.slice(0, 1000),
			})
		})
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const line = String(chunk).trim()
			if (!line) {
				return
			}
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-stderr", {
				component: "CodeIndexParseSidecar",
				processRole: "sidecar",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				errorMessage: line.slice(0, 1000),
			})
		})
		child.on("message", (message: ParseSidecarChildToHostMessage) => {
			this.handleChildMessage(lane, message)
		})
		child.on("error", (error) => {
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-process-error", {
				component: "CodeIndexParseSidecar",
				processRole: "host",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				errorMessage: error.message,
			})
			for (const pending of lane.pending.values()) {
				pending.reject(error)
			}
			lane.pending.clear()
			lane.child = undefined
			lane.ready = undefined
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(`parse:${lane.index + 1}`)
		})
		child.on("exit", (code, signal) => {
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(`parse:${lane.index + 1}`)
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-exit", {
				component: "CodeIndexParseSidecar",
				processRole: "sidecar",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				exitCode: code,
				exitSignal: signal,
			})
			const error = new Error(
				`Code index parse sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
			for (const pending of lane.pending.values()) {
				pending.reject(error)
			}
			lane.pending.clear()
			lane.child = undefined
			lane.ready = undefined
		})
		child.on("close", (code, signal) => {
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-close", {
				component: "CodeIndexParseSidecar",
				processRole: "sidecar",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				exitCode: code,
				exitSignal: signal,
			})
		})

		IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-spawn", {
			component: "CodeIndexParseSidecar",
			processRole: "host",
			sidecarLane: lane.index + 1,
			sidecarScriptPath: this.sidecarScriptPath,
			workspacePath: this.workspacePath,
		})

		const initReadyPromise = new Promise<void>((resolve, reject) => {
			const readyRequestId = `ready:init-${lane.index + 1}:${this.nextRequestId("init")}`
			lane.pending.set(readyRequestId, { resolve, reject })
			IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-init-sent", {
				component: "CodeIndexParseSidecar",
				processRole: "host",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
			})
			lane.child?.send({
				type: "init",
				payload: {
					workspacePath: this.workspacePath,
				},
			} satisfies ParseSidecarHostToChildMessage)
		})

		await this.withTimeoutAndAbort(
			initReadyPromise,
			SidecarParseExecutor.INIT_TIMEOUT_MS,
			() => {
				const error = new Error(
					`Code index parse sidecar failed to initialize within ${SidecarParseExecutor.INIT_TIMEOUT_MS}ms.`,
				)
				this.failLaneStartup(lane, error, "timeout")
				return error
			},
			signal,
			() => {
				const error = new Error("Parse/chunk stage aborted")
				this.failLaneStartup(lane, error, "aborted")
				return error
			},
		)
	}

	private sendRequest<T>(lane: ParseLane, message: ParseSidecarHostToChildMessage, signal?: AbortSignal): Promise<T> {
		if (!lane.child) {
			return Promise.reject(new Error("Code index parse sidecar lane is unavailable"))
		}
		const requestId = "requestId" in message ? message.requestId : this.nextRequestId("request")
		return this.withAbort(
			signal,
			new Promise<T>((resolve, reject) => {
				const cleanupAbort = this.attachAbort(signal, () => {
					lane.pending.delete(requestId)
					reject(new Error("Parse/chunk stage aborted"))
				})
				lane.pending.set(requestId, {
					resolve: (value) => {
						cleanupAbort()
						resolve(value)
					},
					reject: (error) => {
						cleanupAbort()
						reject(error)
					},
				})
				lane.child?.send(message)
			}),
			"Parse/chunk stage aborted",
		)
	}

	private handleChildMessage(lane: ParseLane, message: ParseSidecarChildToHostMessage) {
		switch (message.type) {
			case "lifecycle":
				IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", message.stage, {
					component: "CodeIndexParseSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					memory: message.memory,
					cpu: message.cpu,
				})
				return
			case "ready":
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					`parse:${lane.index + 1}`,
					"parseSidecars",
					`parse-lane-${lane.index + 1}`,
					message.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-ready", {
					component: "CodeIndexParseSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: message.pid,
					memory: message.memory,
					cpu: message.cpu,
				})
				for (const [requestId, pending] of lane.pending) {
					if (requestId.startsWith("ready:init-")) {
						pending.resolve(undefined)
						lane.pending.delete(requestId)
						break
					}
				}
				return
			case "parse-result": {
				const pending = lane.pending.get(message.requestId)
				if (!pending) return
				lane.pending.delete(message.requestId)
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					`parse:${lane.index + 1}`,
					"parseSidecars",
					`parse-lane-${lane.index + 1}`,
					lane.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-result", {
					component: "CodeIndexParseSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					requestId: message.requestId,
					parseLatencyMs: message.parseLatencyMs,
					chunkCount: message.chunks.length,
					memory: message.memory,
					cpu: message.cpu,
				})
				pending.resolve({
					chunks: message.chunks,
					parseLatencyMs: message.parseLatencyMs,
				})
				return
			}
			case "shutdown-complete": {
				const pending = lane.pending.get(message.requestId)
				if (pending) {
					lane.pending.delete(message.requestId)
					pending.resolve(undefined)
				}
				return
			}
			case "error": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					`parse:${lane.index + 1}`,
					"parseSidecars",
					`parse-lane-${lane.index + 1}`,
					lane.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-error", {
					component: "CodeIndexParseSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					requestId: message.requestId,
					errorMessage: message.errorMessage,
					memory: message.memory,
					cpu: message.cpu,
				})
				if (message.requestId) {
					const pending = lane.pending.get(message.requestId)
					if (pending) {
						lane.pending.delete(message.requestId)
						pending.reject(new Error(message.errorMessage))
					}
					return
				}
				this.rejectPendingReadyRequests(lane, new Error(message.errorMessage))
			}
		}
	}

	private failLaneStartup(lane: ParseLane, error: Error, reason: "timeout" | "aborted") {
		IndexDebugLoggerV2.log("basic", "CodeIndexParseSidecar", "parse-sidecar-startup-failed", {
			component: "CodeIndexParseSidecar",
			processRole: "host",
			sidecarLane: lane.index + 1,
			sidecarPid: lane.child?.pid,
			errorMessage: error.message,
			jobId: reason,
		})
		this.rejectPendingReadyRequests(lane, error)
		lane.child?.kill()
		lane.child = undefined
		lane.ready = undefined
		IndexDebugLoggerV2.clearTrackedProcessSnapshot(`parse:${lane.index + 1}`)
	}

	private rejectPendingReadyRequests(lane: ParseLane, error: Error) {
		for (const [requestId, pending] of lane.pending) {
			if (requestId.startsWith("ready:init-")) {
				lane.pending.delete(requestId)
				pending.reject(error)
			}
		}
	}

	private attachAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
		if (!signal) {
			return () => undefined
		}
		if (signal.aborted) {
			onAbort()
			return () => undefined
		}
		let fired = false
		const listener = () => {
			if (fired) {
				return
			}
			fired = true
			onAbort()
		}
		signal.addEventListener("abort", listener, { once: true })
		return () => signal.removeEventListener("abort", listener)
	}

	private withAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>, abortMessage: string): Promise<T> {
		if (!signal) {
			return promise
		}
		if (signal.aborted) {
			return Promise.reject(new Error(abortMessage))
		}
		return new Promise<T>((resolve, reject) => {
			const cleanupAbort = this.attachAbort(signal, () => reject(new Error(abortMessage)))
			promise.then(
				(value) => {
					cleanupAbort()
					resolve(value)
				},
				(error) => {
					cleanupAbort()
					reject(error)
				},
			)
		})
	}

	private withTimeoutAndAbort<T>(
		promise: Promise<T>,
		timeoutMs: number,
		onTimeout: () => Error,
		signal?: AbortSignal,
		onAbort?: () => Error,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => reject(onTimeout()), timeoutMs)
			const cleanupAbort = this.attachAbort(signal, () => reject(onAbort?.() ?? new Error("Operation aborted")))
			promise.then(
				(value) => {
					clearTimeout(timeout)
					cleanupAbort()
					resolve(value)
				},
				(error) => {
					clearTimeout(timeout)
					cleanupAbort()
					reject(error)
				},
			)
		})
	}

	private nextRequestId(prefix: string) {
		this.requestCounter += 1
		return `${prefix}:${this.requestCounter}`
	}
}
