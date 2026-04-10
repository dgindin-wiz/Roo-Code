import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"
import { Package } from "../../../shared/package"
import {
	CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME,
	CODE_INDEX_V2_LOG_BASENAME,
	CODE_INDEX_V2_LOG_ENV_VAR,
	CODE_INDEX_V2_LOG_MAX_BYTES,
	CODE_INDEX_V2_LOG_MAX_ROTATED_FILES,
} from "../shared/constants"
import {
	CodeIndexV2CpuSnapshot,
	CodeIndexV2GpuSnapshot,
	CodeIndexV2LogContext,
	CodeIndexV2LogLevel,
	CodeIndexV2MemorySnapshot,
} from "./log-types"

type VSCodeModule = typeof import("vscode")

let vscodeModule: VSCodeModule | undefined
try {
	// Sidecar processes do not have the VS Code module available.
	// Keep logging file-based there instead of crashing at module load time.
	vscodeModule = require("vscode") as VSCodeModule
} catch {
	vscodeModule = undefined
}

export class IndexDebugLoggerV2 {
	private static _channel: { appendLine(value: string): void } | undefined
	private static readonly _build = {
		version: Package.version,
		buildTimestamp: Package.buildTimestamp,
		sha: Package.sha,
	}
	private static _diagnosticsDir = process.env[CODE_INDEX_V2_LOG_ENV_VAR]
	private static _logPath = this.computeLogPath(this._diagnosticsDir)
	private static _lastCpuSample:
		| {
				usage: NodeJS.CpuUsage
				recordedAtMs: number
		  }
		| undefined
	private static _trackedProcesses = new Map<
		string,
		{
			group: string
			label: string
			pid?: number
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
			recordedAt: string
		}
	>()

	static isEnabled(): boolean {
		try {
			if (!vscodeModule) {
				return true
			}
			return vscodeModule.workspace.getConfiguration(Package.name).get<boolean>("codeIndex.debugLogging", false)
		} catch {
			return false
		}
	}

	static getLevel(): CodeIndexV2LogLevel {
		return this.isEnabled() ? "verbose" : "off"
	}

	static setContext(context: CodeIndexV2LogContext): void {
		this.log("basic", "Engine", "session-start", context)
	}

	static log(
		level: Exclude<CodeIndexV2LogLevel, "off">,
		component: string,
		message: string,
		context: CodeIndexV2LogContext = {},
	): void {
		if (!this.isEnabled() && level !== "basic") {
			return
		}

		const {
			memory: reportedMemory,
			cpu: reportedCpu,
			gpu: reportedGpu,
			...restContext
		} = context as CodeIndexV2LogContext & {
			memory?: CodeIndexV2MemorySnapshot
			cpu?: CodeIndexV2CpuSnapshot
			gpu?: CodeIndexV2GpuSnapshot
		}
		const payload = {
			timestamp: new Date().toISOString(),
			level,
			component,
			message,
			build: this._build,
			...restContext,
			memory: this.getMemorySnapshot(),
			cpu: this.getCpuSnapshot(),
			reportedMemory,
			reportedCpu,
			reportedGpu,
			trackedProcesses: this.getTrackedProcessSummary(),
		}

		const line = JSON.stringify(payload)

		try {
			this.getChannel().appendLine(`[CodeIndexV2] ${message}`)
		} catch {
			// Best effort only.
		}

		if (this.isEnabled()) {
			try {
				this.ensureLogDirectory()
				this.rotateIfNeeded()
				fs.appendFileSync(this._logPath, line + "\n")
			} catch {
				// Best effort only.
			}
		}
	}

	static getMemorySnapshot(): CodeIndexV2MemorySnapshot {
		try {
			const usage = process.memoryUsage()
			return {
				rssMB: Math.round(usage.rss / 1024 / 1024),
				heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
				heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
				externalMB: Math.round(usage.external / 1024 / 1024),
				arrayBuffersMB: Math.round(usage.arrayBuffers / 1024 / 1024),
			}
		} catch {
			return {
				rssMB: 0,
				heapUsedMB: 0,
				heapTotalMB: 0,
				externalMB: 0,
				arrayBuffersMB: 0,
			}
		}
	}

	static getCpuSnapshot(): CodeIndexV2CpuSnapshot {
		try {
			const nowMs = Date.now()
			const usage = process.cpuUsage()
			const previous = this._lastCpuSample
			this._lastCpuSample = {
				usage,
				recordedAtMs: nowMs,
			}

			if (!previous) {
				return {}
			}

			const elapsedMs = nowMs - previous.recordedAtMs
			if (elapsedMs <= 0) {
				return {}
			}

			const delta = process.cpuUsage(previous.usage)
			const cpuMicros = delta.user + delta.system
			const processPercent = Number(((cpuMicros / (elapsedMs * 1000)) * 100).toFixed(1))
			return {
				processPercent: Number.isFinite(processPercent) ? processPercent : undefined,
			}
		} catch {
			return {}
		}
	}

	static updateTrackedProcessSnapshot(
		key: string,
		group: string,
		label: string,
		pid: number | undefined,
		memory: CodeIndexV2MemorySnapshot | undefined,
		cpu?: CodeIndexV2CpuSnapshot,
	): void {
		this._trackedProcesses.set(key, {
			group,
			label,
			pid,
			memory,
			cpu,
			recordedAt: new Date().toISOString(),
		})
	}

	static clearTrackedProcessSnapshot(key: string): void {
		this._trackedProcesses.delete(key)
	}

	static configureDiagnosticsDirectory(directoryPath: string | undefined): void {
		this._diagnosticsDir = directoryPath
		if (directoryPath) {
			process.env[CODE_INDEX_V2_LOG_ENV_VAR] = directoryPath
		} else {
			delete process.env[CODE_INDEX_V2_LOG_ENV_VAR]
		}
		this._logPath = this.computeLogPath(directoryPath)
	}

	static getDiagnosticsDirectory(): string {
		return path.dirname(this._logPath)
	}

	static getLogPath(): string {
		return this._logPath
	}

	static getBuildInfo(): typeof IndexDebugLoggerV2._build {
		return { ...this._build }
	}

	static getTrackedProcessSummary(): Record<string, unknown> | undefined {
		if (this._trackedProcesses.size === 0) {
			return undefined
		}

		const groups = new Map<
			string,
			{
				count: number
				totalRssMB: number
				peakRssMB: number
				labels: string[]
			}
		>()

		for (const tracked of this._trackedProcesses.values()) {
			const entry = groups.get(tracked.group) ?? {
				count: 0,
				totalRssMB: 0,
				peakRssMB: 0,
				labels: [],
			}
			entry.count += 1
			entry.totalRssMB += tracked.memory?.rssMB ?? 0
			entry.peakRssMB = Math.max(entry.peakRssMB, tracked.memory?.rssMB ?? 0)
			entry.labels.push(tracked.pid ? `${tracked.label}:${tracked.pid}` : tracked.label)
			groups.set(tracked.group, entry)
		}

		let totalTrackedRssMB = 0
		const byGroup: Record<string, unknown> = {}
		for (const [group, entry] of groups) {
			totalTrackedRssMB += entry.totalRssMB
			byGroup[group] = entry
		}

		return {
			totalTrackedProcesses: this._trackedProcesses.size,
			totalTrackedRssMB,
			byGroup,
		}
	}

	static listLogFiles(): string[] {
		const diagnosticsDir = this.getDiagnosticsDirectory()
		try {
			const entries = fs
				.readdirSync(diagnosticsDir)
				.filter(
					(entry) =>
						entry === CODE_INDEX_V2_LOG_BASENAME ||
						(entry.startsWith(`${CODE_INDEX_V2_LOG_BASENAME}.`) && entry.endsWith(".gz")),
				)
				.map((entry) => path.join(diagnosticsDir, entry))
				.filter((entryPath) => fs.existsSync(entryPath))
			return entries.sort((left, right) => {
				const leftMtime = this.safeStatMtime(left)
				const rightMtime = this.safeStatMtime(right)
				return leftMtime - rightMtime
			})
		} catch {
			return fs.existsSync(this._logPath) ? [this._logPath] : []
		}
	}

	private static getChannel(): { appendLine(value: string): void } {
		if (!vscodeModule) {
			throw new Error("VS Code output channel is unavailable outside the extension host")
		}
		if (!this._channel) {
			this._channel = vscodeModule.window.createOutputChannel("Roo Code: Index V2")
		}
		return this._channel
	}

	private static computeLogPath(diagnosticsDir: string | undefined): string {
		if (diagnosticsDir && diagnosticsDir.trim().length > 0) {
			return path.join(diagnosticsDir, CODE_INDEX_V2_LOG_BASENAME)
		}
		return path.join(os.homedir(), CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME, CODE_INDEX_V2_LOG_BASENAME)
	}

	private static ensureLogDirectory(): void {
		fs.mkdirSync(path.dirname(this._logPath), { recursive: true })
	}

	private static rotateIfNeeded(): void {
		let stat: fs.Stats | undefined
		try {
			stat = fs.statSync(this._logPath)
		} catch {
			return
		}
		if (!stat.isFile() || stat.size < CODE_INDEX_V2_LOG_MAX_BYTES) {
			return
		}

		for (let index = CODE_INDEX_V2_LOG_MAX_ROTATED_FILES; index >= 1; index--) {
			const rotatedPath = `${this._logPath}.${index}.gz`
			if (!fs.existsSync(rotatedPath)) {
				continue
			}
			if (index === CODE_INDEX_V2_LOG_MAX_ROTATED_FILES) {
				fs.unlinkSync(rotatedPath)
				continue
			}
			fs.renameSync(rotatedPath, `${this._logPath}.${index + 1}.gz`)
		}

		const currentContents = fs.readFileSync(this._logPath)
		const compressed = zlib.gzipSync(currentContents)
		fs.writeFileSync(`${this._logPath}.1.gz`, compressed)
		fs.truncateSync(this._logPath, 0)
	}

	private static safeStatMtime(entryPath: string): number {
		try {
			return fs.statSync(entryPath).mtimeMs
		} catch {
			return 0
		}
	}
}
