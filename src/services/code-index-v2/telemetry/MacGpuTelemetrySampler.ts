import { execFile } from "child_process"
import { promisify } from "util"
import { CodeIndexV2GpuSnapshot } from "../logging/log-types"

const execFileAsync = promisify(execFile)

export class MacGpuTelemetrySampler {
	private static readonly SAMPLE_TTL_MS = 5_000
	private lastSampleAt = 0
	private lastSample: CodeIndexV2GpuSnapshot | null = null

	static isSupported(): boolean {
		return process.platform === "darwin"
	}

	async sample(force = false): Promise<CodeIndexV2GpuSnapshot | null> {
		if (!MacGpuTelemetrySampler.isSupported()) {
			return null
		}

		const now = Date.now()
		if (!force && this.lastSample && now - this.lastSampleAt < MacGpuTelemetrySampler.SAMPLE_TTL_MS) {
			return {
				...this.lastSample,
				sampleAgeMs: now - this.lastSampleAt,
			}
		}

		try {
			const { stdout } = await execFileAsync("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"])
			const sample = this.parseIoregOutput(stdout)
			this.lastSampleAt = now
			this.lastSample = sample
			return sample ? { ...sample, sampleAgeMs: 0 } : null
		} catch {
			this.lastSampleAt = now
			this.lastSample = null
			return null
		}
	}

	private parseIoregOutput(stdout: string): CodeIndexV2GpuSnapshot | null {
		const numeric = (patterns: RegExp[]): number | undefined => {
			for (const pattern of patterns) {
				const match = stdout.match(pattern)
				const value = match?.[1]
				if (!value) {
					continue
				}
				const parsed = Number(value)
				if (Number.isFinite(parsed)) {
					return parsed
				}
			}
			return undefined
		}

		const utilizationPercent = numeric([
			/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/i,
			/"GPU Core Utilization %"\s*=\s*(\d+(?:\.\d+)?)/i,
			/"GPU Busy"\s*=\s*(\d+(?:\.\d+)?)/i,
		])
		const rendererUtilizationPercent = numeric([/"Renderer Utilization %"\s*=\s*(\d+(?:\.\d+)?)/i])
		const tilerUtilizationPercent = numeric([/"Tiler Utilization %"\s*=\s*(\d+(?:\.\d+)?)/i])
		const memoryPressurePercent = numeric([/"Memory Pressure %"\s*=\s*(\d+(?:\.\d+)?)/i])
		const inUseBytes = numeric([
			/"In use system memory"\s*=\s*(\d+)/i,
			/"In use system memory \(driver\)"\s*=\s*(\d+)/i,
			/"In Use Bytes"\s*=\s*(\d+)/i,
			/"In Use"\s*=\s*(\d+)/i,
		])
		const allocatedBytes = numeric([
			/"Alloc system memory"\s*=\s*(\d+)/i,
			/"Allocated Bytes"\s*=\s*(\d+)/i,
			/"Alloc Bytes"\s*=\s*(\d+)/i,
		])
		const powerW = numeric([/"Power \(W\)"\s*=\s*(\d+(?:\.\d+)?)/i, /"GPU Power"\s*=\s*(\d+(?:\.\d+)?)/i])
		const temperatureC = numeric([
			/"Temperature\(C\)"\s*=\s*(\d+(?:\.\d+)?)/i,
			/"Temperature"\s*=\s*(\d+(?:\.\d+)?)/i,
		])

		if (
			utilizationPercent === undefined &&
			rendererUtilizationPercent === undefined &&
			tilerUtilizationPercent === undefined &&
			memoryPressurePercent === undefined &&
			inUseBytes === undefined &&
			allocatedBytes === undefined &&
			powerW === undefined &&
			temperatureC === undefined
		) {
			return null
		}

		return {
			sampler: "ioreg",
			utilizationPercent,
			rendererUtilizationPercent,
			tilerUtilizationPercent,
			deviceUtilizationPercent: utilizationPercent,
			inUseBytes,
			allocatedBytes,
			memoryPressurePercent,
			powerW,
			temperatureC,
		}
	}
}
