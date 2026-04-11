import { CodeIndexV2CpuSnapshot, CodeIndexV2MemorySnapshot } from "../logging/log-types"
import { ParsedChunkUpsertInput } from "../pipeline/ParseExecution"

export interface ParseSidecarInitPayload {
	workspacePath: string
}

export type ParseSidecarHostToChildMessage =
	| {
			type: "init"
			payload: ParseSidecarInitPayload
	  }
	| {
			type: "parse-revision"
			requestId: string
			runId: string
			revisionId: string
			normalizedPath: string
			relativePath: string
			maxFileSizeBytes?: number
	  }
	| {
			type: "shutdown"
			requestId: string
	  }

export type ParseSidecarChildToHostMessage =
	| {
			type: "lifecycle"
			stage:
				| "worker-bootstrap-start"
				| "worker-bootstrap-ready"
				| "worker-parser-init-start"
				| "worker-parser-init-complete"
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "ready"
			pid: number
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
	  }
	| {
			type: "parse-result"
			requestId: string
			chunks: ParsedChunkUpsertInput[]
			parseLatencyMs: number
			memory: CodeIndexV2MemorySnapshot
			cpu: CodeIndexV2CpuSnapshot
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
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
	  }
