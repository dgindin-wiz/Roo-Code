import { CodeIndexV2CpuSnapshot, CodeIndexV2MemorySnapshot } from "../logging/log-types"
import type { ResolvedMetadataStorePaths } from "../store/MetadataPathResolver"

export type MetadataSidecarRole = "writer" | "reader"

export interface MetadataSidecarInitPayload {
	paths: ResolvedMetadataStorePaths
	role?: MetadataSidecarRole
}

export type MetadataSidecarHostToChildMessage =
	| {
			type: "init"
			payload: MetadataSidecarInitPayload
	  }
	| {
			type: "call"
			requestId: string
			operation: string
			args: unknown[]
	  }
	| {
			type: "cancel"
			requestId: string
	  }
	| {
			type: "shutdown"
			requestId: string
	  }

export type MetadataSidecarChildToHostMessage =
	| {
			type: "ready"
			pid: number
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "response"
			requestId: string
			result: unknown
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "error"
			requestId?: string
			errorMessage: string
			stack?: string
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "shutdown-complete"
			requestId: string
	  }
