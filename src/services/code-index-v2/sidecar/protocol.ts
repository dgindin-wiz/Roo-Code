import { CodeIndexConfig } from "../../code-index/interfaces/config"
import type {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
} from "../../code-index/interfaces/embedder"
import { CodeIndexV2CpuSnapshot, CodeIndexV2MemorySnapshot } from "../logging/log-types"
import { EmbedUpsertBatchItem } from "../pipeline/EmbedUpsertExecution"

export interface SidecarRuntimeMetadata {
	provider: string
	modelId: string
	runtimeKind: "local" | "remote"
	runtimeLabel: string
	deviceHint?: string
}

export interface SidecarInitPayload {
	workspacePath: string
	config: CodeIndexConfig
	vectorSize: number
	runtime: SidecarRuntimeMetadata
	runtimeProfile?: AdaptiveEmbeddingControllerState
}

export type SidecarLogLevel = "basic" | "verbose" | "trace"

export type SidecarHostToChildMessage =
	| {
			type: "init"
			payload: SidecarInitPayload
	  }
	| {
			type: "execute-upsert"
			requestId: string
			runId: string
			laneId: number
			items: EmbedUpsertBatchItem[]
	  }
	| {
			type: "recycle"
			requestId: string
			reason: "pressure" | "interval" | "shutdown"
	  }
	| {
			type: "cancel"
			requestId: string
	  }
	| {
			type: "controller-update"
			runtimeProfile?: AdaptiveEmbeddingControllerState
	  }
	| {
			type: "shutdown"
			requestId: string
	  }

export type SidecarChildToHostMessage =
	| {
			type: "ready"
			pid: number
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "log"
			level: SidecarLogLevel
			component: string
			message: string
			context?: Record<string, unknown>
	  }
	| {
			type: "upsert-result"
			requestId: string
			embeddingCount: number
			embedLatencyMs: number
			upsertLatencyMs: number
			pointIds: string[]
			runtimeProfile?: AdaptiveEmbeddingControllerState
			runtimeObservations?: AdaptiveProviderObservation[]
			variantTelemetry: {
				storedVariantCount: number
				embeddedVariantCount: number
				storedVariantCountsByType: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
				embeddedVariantCountsByType: Partial<Record<"raw_code" | "summary" | "symbol_signature", number>>
				skippedVectorizationReasons: Record<string, number>
			}
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "recycle-complete"
			requestId: string
			memoryBefore: CodeIndexV2MemorySnapshot
			memoryAfter: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "cancelled"
			requestId: string
	  }
	| {
			type: "shutdown-complete"
			requestId: string
	  }
	| {
			type: "error"
			requestId?: string
			errorMessage: string
			stack?: string
			retryable?: boolean
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
	  }
