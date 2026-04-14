import { ChildProcess, fork } from "child_process"
import { existsSync } from "fs"
import * as path from "path"
import { CodeIndexConfig } from "../../code-index/interfaces/config"
import type {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
} from "../../code-index/interfaces/embedder"
import { IndexDebugLoggerV2 } from "../logging/IndexDebugLoggerV2"
import { EmbedUpsertBatchItem, EmbedUpsertExecutionResult } from "./EmbedUpsertExecution"
import {
	SidecarChildToHostMessage,
	SidecarHostToChildMessage,
	SidecarInitPayload,
	SidecarRuntimeMetadata,
} from "../sidecar/protocol"

interface PendingRequest<T> {
	resolve: (value: T) => void
	reject: (error: Error) => void
	startedAtMs?: number
}

interface SidecarLane {
	index: number
	child?: ChildProcess
	ready?: Promise<void>
	pending: Map<string, PendingRequest<any>>
}

export class SidecarEmbedUpsertExecutor {
	private static readonly SHUTDOWN_TIMEOUT_MS = 5_000
	private readonly lanes: SidecarLane[]
	private requestCounter = 0
	private readonly sidecarScriptPath = this.resolveSidecarScriptPath()

	constructor(
		private readonly workspacePath: string,
		private readonly config: CodeIndexConfig,
		private readonly vectorSize: number,
		private readonly runtime: SidecarRuntimeMetadata,
		laneConcurrency: number,
		private readonly runtimeController?: {
			profile?: AdaptiveEmbeddingControllerState
			onRuntimeObservations?: (
				observations: AdaptiveProviderObservation[],
				reportedProfile?: AdaptiveEmbeddingControllerState,
			) => Promise<AdaptiveEmbeddingControllerState | undefined> | AdaptiveEmbeddingControllerState | undefined
		},
	) {
		const laneCount = Math.max(1, laneConcurrency)
		this.lanes = Array.from({ length: laneCount }, (_, index) => ({
			index,
			pending: new Map(),
		}))
	}

	async executeUpsertBatch(
		runId: string,
		laneId: number,
		items: EmbedUpsertBatchItem[],
		signal?: AbortSignal,
	): Promise<EmbedUpsertExecutionResult> {
		const lane = await this.ensureLane(laneId)
		const requestId = this.nextRequestId("upsert")
		const resultPromise = this.sendRequest<EmbedUpsertExecutionResult>(
			lane,
			{
				type: "execute-upsert",
				requestId,
				runId,
				laneId,
				items,
			},
			requestId,
		)

		if (!signal) {
			return resultPromise
		}

		if (signal.aborted) {
			this.sendFireAndForget(lane, {
				type: "cancel",
				requestId,
			})
			throw new Error("Embed/upsert worker aborted")
		}

		return await Promise.race([
			resultPromise,
			new Promise<EmbedUpsertExecutionResult>((_, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort)
					this.sendFireAndForget(lane, {
						type: "cancel",
						requestId,
					})
					reject(new Error("Embed/upsert worker aborted"))
				}
				signal.addEventListener("abort", onAbort, { once: true })
				resultPromise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined)
			}),
		])
	}

	async recycleClients(recycleReason: "pressure" | "interval" | "shutdown"): Promise<void> {
		await Promise.all(
			this.lanes.map(async (lane, index) => {
				if (!lane.child) {
					return
				}
				const requestId = this.nextRequestId(`recycle-${index + 1}`)
				await this.sendRequest<void>(
					lane,
					{
						type: "recycle",
						requestId,
						reason: recycleReason,
					},
					requestId,
				)
			}),
		)
	}

	async dispose(): Promise<void> {
		await Promise.all(
			this.lanes.map(async (lane) => {
				if (!lane.child) {
					return
				}
				const child = lane.child
				const requestId = this.nextRequestId(`shutdown-${lane.index + 1}`)
				try {
					await Promise.race([
						this.sendRequest<void>(
							lane,
							{
								type: "shutdown",
								requestId,
							},
							requestId,
						),
						new Promise<void>((_, reject) =>
							setTimeout(
								() => reject(new Error(`Code index sidecar ${lane.index + 1} shutdown timed out`)),
								SidecarEmbedUpsertExecutor.SHUTDOWN_TIMEOUT_MS,
							),
						),
					])
				} catch {
					child.kill()
				} finally {
					lane.child = undefined
					lane.ready = undefined
					lane.pending.clear()
				}
			}),
		)
	}

	private async ensureLane(laneId: number): Promise<SidecarLane> {
		const lane = this.lanes[(laneId - 1) % this.lanes.length]
		if (!lane.ready) {
			lane.ready = this.spawnLane(lane)
		}
		await lane.ready
		return lane
	}

	private resolveSidecarScriptPath(): string {
		const candidates = [
			path.join(__dirname, "workers", "codeIndexV2EmbedUpsertSidecar.js"),
			path.join(__dirname, "..", "..", "..", "workers", "codeIndexV2EmbedUpsertSidecar.js"),
		]
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate
			}
		}
		return candidates[0]
	}

	private async spawnLane(lane: SidecarLane): Promise<void> {
		const child = fork(this.sidecarScriptPath, [], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			execArgv: [],
			env: {
				...process.env,
				ROO_CODE_INDEX_V2_DIAGNOSTICS_DIR: IndexDebugLoggerV2.getDiagnosticsDirectory(this.workspacePath),
			},
		})
		lane.child = child
		child.on("message", (message: SidecarChildToHostMessage) => {
			this.handleChildMessage(lane, message)
		})
		child.on("exit", (code, signal) => {
			IndexDebugLoggerV2.clearTrackedProcessSnapshot(this.getTrackedProcessKey(lane))
			IndexDebugLoggerV2.log("basic", "CodeIndexIndexingSidecar", "sidecar-exit", {
				component: "CodeIndexIndexingSidecar",
				processRole: "sidecar",
				sidecarLane: lane.index + 1,
				sidecarPid: child.pid,
				exitCode: code,
				exitSignal: signal,
				workspacePath: this.workspacePath,
			})
			const error = new Error(
				`Code index sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			)
			for (const pending of lane.pending.values()) {
				pending.reject(error)
			}
			lane.pending.clear()
			lane.child = undefined
			lane.ready = undefined
		})
		IndexDebugLoggerV2.log("basic", "CodeIndexIndexingSidecar", "sidecar-spawn", {
			component: "CodeIndexIndexingSidecar",
			processRole: "host",
			sidecarLane: lane.index + 1,
			sidecarScriptPath: this.sidecarScriptPath,
			workspacePath: this.workspacePath,
		})

		await new Promise<void>((resolve, reject) => {
			const readyRequestId = `ready:init-${lane.index + 1}:${this.nextRequestId("init")}`
			lane.pending.set(readyRequestId, { resolve, reject })
			lane.child?.send({
				type: "init",
				payload: {
					workspacePath: this.workspacePath,
					config: this.config,
					vectorSize: this.vectorSize,
					runtime: this.runtime,
					runtimeProfile: this.runtimeController?.profile,
				},
			} satisfies SidecarHostToChildMessage)
		})
	}

	private sendFireAndForget(lane: SidecarLane, message: SidecarHostToChildMessage) {
		lane.child?.send(message)
	}

	private sendRequest<T>(lane: SidecarLane, message: SidecarHostToChildMessage, requestId: string): Promise<T> {
		if (!lane.child) {
			return Promise.reject(new Error("Code index sidecar lane is unavailable"))
		}

		return new Promise<T>((resolve, reject) => {
			lane.pending.set(requestId, { resolve, reject, startedAtMs: Date.now() })
			lane.child?.send(message)
		})
	}

	private handleChildMessage(lane: SidecarLane, message: SidecarChildToHostMessage) {
		switch (message.type) {
			case "ready": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(lane),
					"embedSidecars",
					`embed-lane-${lane.index + 1}`,
					this.workspacePath,
					message.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexIndexingSidecar", "sidecar-ready", {
					component: "CodeIndexIndexingSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: message.pid,
					memory: message.memory,
					cpu: message.cpu,
					workspacePath: this.workspacePath,
				})
				for (const [requestId, pending] of lane.pending) {
					if (requestId.startsWith("ready:init-")) {
						pending.resolve(undefined)
						lane.pending.delete(requestId)
						break
					}
				}
				return
			}
			case "log": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(lane),
					"embedSidecars",
					`embed-lane-${lane.index + 1}`,
					this.workspacePath,
					lane.child?.pid,
					(message.context?.memory as any) ?? undefined,
					(message.context?.cpu as any) ?? undefined,
				)
				IndexDebugLoggerV2.log(message.level, message.component, message.message, {
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					...(message.context ?? {}),
					workspacePath: this.workspacePath,
				})
				return
			}
			case "upsert-result": {
				const pending = lane.pending.get(message.requestId)
				if (!pending) {
					return
				}
				lane.pending.delete(message.requestId)
				const receivedAtMs = Date.now()
				const sidecarRoundTripLatencyMs =
					typeof pending.startedAtMs === "number"
						? Math.max(receivedAtMs - pending.startedAtMs, 0)
						: undefined
				const sidecarDeliveryDelayMs =
					typeof sidecarRoundTripLatencyMs === "number"
						? Math.max(sidecarRoundTripLatencyMs - message.embedLatencyMs - message.upsertLatencyMs, 0)
						: undefined
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(lane),
					"embedSidecars",
					`embed-lane-${lane.index + 1}`,
					this.workspacePath,
					lane.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexIndexingSidecar", "sidecar-upsert-result", {
					component: "CodeIndexIndexingSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					requestId: message.requestId,
					embeddingCount: message.embeddingCount,
					embedLatencyMs: message.embedLatencyMs,
					upsertLatencyMs: message.upsertLatencyMs,
					sidecarRoundTripLatencyMs,
					sidecarDeliveryDelayMs,
					memory: message.memory,
					cpu: message.cpu,
					workspacePath: this.workspacePath,
				})
				void this.handleRuntimeFeedback(message.runtimeObservations, message.runtimeProfile)
				pending.resolve({
					embeddingCount: message.embeddingCount,
					embedLatencyMs: message.embedLatencyMs,
					upsertLatencyMs: message.upsertLatencyMs,
					sidecarRoundTripLatencyMs,
					sidecarDeliveryDelayMs,
					pointIds: message.pointIds,
					variantTelemetry: message.variantTelemetry,
				})
				return
			}
			case "recycle-complete":
			case "shutdown-complete":
			case "cancelled": {
				const pending = lane.pending.get(message.requestId)
				if (pending) {
					lane.pending.delete(message.requestId)
					pending.resolve(undefined)
				}
				return
			}
			case "error": {
				IndexDebugLoggerV2.updateTrackedProcessSnapshot(
					this.getTrackedProcessKey(lane),
					"embedSidecars",
					`embed-lane-${lane.index + 1}`,
					this.workspacePath,
					lane.child?.pid,
					message.memory,
					message.cpu,
				)
				IndexDebugLoggerV2.log("basic", "CodeIndexIndexingSidecar", "sidecar-error", {
					component: "CodeIndexIndexingSidecar",
					processRole: "sidecar",
					sidecarLane: lane.index + 1,
					sidecarPid: lane.child?.pid,
					requestId: message.requestId,
					errorMessage: message.errorMessage,
					retryable: message.retryable,
					memory: message.memory,
					cpu: message.cpu,
					workspacePath: this.workspacePath,
				})
				if (message.requestId) {
					const pending = lane.pending.get(message.requestId)
					if (pending) {
						lane.pending.delete(message.requestId)
						pending.reject(new Error(message.errorMessage))
					}
				}
				return
			}
		}
	}

	private nextRequestId(prefix: string) {
		this.requestCounter += 1
		return `${prefix}:${this.requestCounter}`
	}

	private async handleRuntimeFeedback(
		observations?: AdaptiveProviderObservation[],
		reportedProfile?: AdaptiveEmbeddingControllerState,
	): Promise<void> {
		const nextProfile = await this.runtimeController?.onRuntimeObservations?.(observations ?? [], reportedProfile)
		if (!nextProfile) {
			return
		}

		if (this.runtimeController) {
			this.runtimeController.profile = nextProfile
		}

		for (const lane of this.lanes) {
			if (!lane.child) {
				continue
			}
			this.sendFireAndForget(lane, {
				type: "controller-update",
				runtimeProfile: nextProfile,
			})
		}
	}

	private getTrackedProcessKey(lane: SidecarLane): string {
		return `${this.workspacePath}:embed:${lane.index + 1}`
	}
}
