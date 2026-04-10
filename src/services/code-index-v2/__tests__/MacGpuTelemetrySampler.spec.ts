import { describe, expect, it } from "vitest"

import { MacGpuTelemetrySampler } from "../telemetry/MacGpuTelemetrySampler"

describe("MacGpuTelemetrySampler", () => {
	it("parses macOS system memory keys exposed by ioreg", () => {
		const sampler = new MacGpuTelemetrySampler() as any
		const sample = sampler.parseIoregOutput(`
			| |   "Device Utilization %" = 48
			| |   "In use system memory" = 3328599654
			| |   "Alloc system memory" = 7163871232
		`)

		expect(sample).toMatchObject({
			utilizationPercent: 48,
			inUseBytes: 3328599654,
			allocatedBytes: 7163871232,
		})
	})

	it("falls back to legacy in-use and allocated byte keys", () => {
		const sampler = new MacGpuTelemetrySampler() as any
		const sample = sampler.parseIoregOutput(`
			| |   "Renderer Utilization %" = 39
			| |   "In Use Bytes" = 2147483648
			| |   "Allocated Bytes" = 4294967296
		`)

		expect(sample).toMatchObject({
			rendererUtilizationPercent: 39,
			inUseBytes: 2147483648,
			allocatedBytes: 4294967296,
		})
	})

	it("returns null when no supported GPU telemetry keys are present", () => {
		const sampler = new MacGpuTelemetrySampler() as any
		expect(sampler.parseIoregOutput(`| |   "Some Other Key" = 1`)).toBeNull()
	})
})
