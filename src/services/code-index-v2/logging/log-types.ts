export type CodeIndexV2LogLevel = "off" | "basic" | "verbose" | "trace"

export interface CodeIndexV2LogContext {
	workspacePath?: string
	runId?: string
	revisionId?: string
	jobId?: string
	engine?: string
	component?: string
	provider?: string
	modelId?: string
	errorMessage?: string
	[key: string]: unknown
}

export interface CodeIndexV2MemorySnapshot {
	rssMB: number
	heapUsedMB: number
	heapTotalMB: number
	externalMB: number
	arrayBuffersMB?: number
}

export interface CodeIndexV2CpuSnapshot {
	processPercent?: number
}

export interface CodeIndexV2GpuSnapshot {
	sampler?: string
	utilizationPercent?: number
	rendererUtilizationPercent?: number
	tilerUtilizationPercent?: number
	deviceUtilizationPercent?: number
	inUseBytes?: number
	allocatedBytes?: number
	memoryPressurePercent?: number
	powerW?: number
	temperatureC?: number
	sampleAgeMs?: number
}
