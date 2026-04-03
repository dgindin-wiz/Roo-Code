import * as fs from "fs"
import * as zlib from "zlib"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { Package } from "../../shared/package"

/**
 * Dual-output debug logger for code indexing.
 *
 * **File log** (`~/roo-index-debug.log`):
 *   - Written when `roo-cline.codeIndex.debugLogging` is true.
 *   - High-frequency, throttled progress data.
 *
 * **OutputChannel** ("Roo Code: Index"):
 *   - Always available in VS Code's Output panel.
 *   - Receives phase transitions, errors, and session summaries only.
 *
 * Call `setContext()` at the start of each indexing session to populate
 * the session header with workspace, provider, and platform details.
 */
export interface IndexSessionContext {
	workspacePath: string
	embedderProvider?: string
	modelId?: string
	qdrantUrl?: string
}

// ─── Rotation constants ──────────────────────────────────────────
/** Rotate when the log file exceeds this size (5 MB). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
/** Number of compressed rotated files to keep (e.g. .1.gz, .2.gz). */
export const LOG_MAX_ROTATED = 2

export class IndexDebugLogger {
	// ─── File-based log ───────────────────────────────────────────────
	private static _stream: fs.WriteStream | null = null
	private static _logPath = path.join(os.homedir(), "roo-index-debug.log")
	private static _updateCount = 0
	private static _lastLogTime = 0

	// ─── OutputChannel ────────────────────────────────────────────────
	private static _outputChannel: vscode.OutputChannel | null = null

	// ─── Session context ──────────────────────────────────────────────
	private static _workspaceName: string = "unknown"
	private static _workspacePath: string = ""
	private static _sessionStartTime: number = 0
	private static _peakHeapMB: number = 0
	private static _extensionActivatedAt: number = Date.now()

	/**
	 * Check whether debug logging is enabled via VS Code settings.
	 * Falls back to `false` if the setting can't be read (e.g. in tests).
	 */
	private static _isEnabled(): boolean {
		try {
			return vscode.workspace.getConfiguration(Package.name).get<boolean>("codeIndex.debugLogging", false)
		} catch {
			return false
		}
	}

	// ─── OutputChannel (lazy) ─────────────────────────────────────────

	private static _getOutputChannel(): vscode.OutputChannel {
		if (!this._outputChannel) {
			try {
				this._outputChannel = vscode.window.createOutputChannel("Roo Code: Index")
			} catch {
				// In test environments, vscode.window may not be available
			}
		}
		return this._outputChannel!
	}

	// ─── File stream ──────────────────────────────────────────────────

	private static _getStream(): fs.WriteStream {
		if (!this._stream) {
			this._stream = fs.createWriteStream(this._logPath, { flags: "a" })
		}
		return this._stream
	}

	private static _writeToFile(line: string): void {
		try {
			this._getStream().write(line + "\n")
		} catch {
			// Silently fail — debug logging should never break indexing
		}
	}

	private static _writeToChannel(line: string): void {
		try {
			const channel = this._getOutputChannel()
			if (channel) {
				channel.appendLine(line)
			}
		} catch {
			// Silently fail — debug logging should never break indexing
		}
	}

	// ─── Formatting helpers ───────────────────────────────────────────

	private static _formatElapsed(): string {
		if (!this._sessionStartTime) return "+0:00:00"
		const totalSec = Math.floor((Date.now() - this._sessionStartTime) / 1000)
		const h = Math.floor(totalSec / 3600)
		const m = Math.floor((totalSec % 3600) / 60)
		const s = totalSec % 60
		return `+${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
	}

	static _getMemoryMB(): number {
		try {
			return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
		} catch {
			return 0
		}
	}

	static _getRssMB(): number {
		try {
			return Math.round(process.memoryUsage().rss / 1024 / 1024)
		} catch {
			return 0
		}
	}

	private static _formatExtensionUptime(): string {
		const totalSec = Math.floor((Date.now() - this._extensionActivatedAt) / 1000)
		const h = Math.floor(totalSec / 3600)
		const m = Math.floor((totalSec % 3600) / 60)
		const s = totalSec % 60
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
	}

	private static _formatDataStr(data: Record<string, any>, excludeKeys: string[] = []): string {
		return Object.entries(data)
			.filter(([k]) => !excludeKeys.includes(k))
			.map(([k, v]) => `${k}=${v}`)
			.join(" ")
	}

	// ─── Session lifecycle ────────────────────────────────────────────

	/**
	 * Sets the context for the current indexing session.
	 * Writes a rich session header to both outputs, resets elapsed time.
	 */
	static setContext(ctx: IndexSessionContext): void {
		this._workspacePath = ctx.workspacePath
		this._workspaceName = path.basename(ctx.workspacePath) || "unknown"
		this._sessionStartTime = Date.now()
		this._updateCount = 0
		this._peakHeapMB = 0

		// Rotate the log file if it has grown too large (before opening a new stream)
		if (this._isEnabled()) {
			this._rotateIfNeeded()
		}

		const heapMB = this._getMemoryMB()
		const openFolders = this._getOpenFolderCount()

		const separator = "=".repeat(80)
		const header = [
			"",
			separator,
			`[${new Date().toISOString()}] Code Index Session Started`,
			separator,
			`  workspace    : ${this._workspaceName} (${ctx.workspacePath})`,
			`  provider     : ${ctx.embedderProvider ?? "unknown"} / ${ctx.modelId ?? "default"}`,
			`  qdrant       : ${ctx.qdrantUrl ?? "unknown"}`,
			`  platform     : ${process.platform} ${process.arch} / Node ${process.version.slice(1)}`,
			`  rooVersion   : ${Package.version}`,
			`  heapUsed     : ${heapMB} MB`,
			`  extUptime    : ${this._formatExtensionUptime()}`,
			`  openFolders  : ${openFolders}`,
			separator,
		].join("\n")

		// Always write header to OutputChannel (no setting gate)
		this._writeToChannel(header)

		// Write to file if debug logging is enabled
		if (this._isEnabled()) {
			this._writeToFile(header)
		}
	}

	private static _getOpenFolderCount(): number {
		try {
			return vscode.workspace.workspaceFolders?.length ?? 0
		} catch {
			return 0
		}
	}

	// ─── Log rotation ────────────────────────────────────────────────

	/**
	 * Rotate the log file if it exceeds LOG_MAX_BYTES.
	 *
	 * Strategy (synchronous, runs once per session start):
	 *   1. Close the existing write stream if open.
	 *   2. Shift existing rotated files up: .2.gz → delete, .1.gz → .2.gz
	 *   3. Compress the current log to .1.gz via gzipSync.
	 *   4. Truncate the current log file to 0 bytes.
	 *
	 * All operations are sync to keep setContext() simple and avoid
	 * race conditions with the append-mode write stream.
	 */
	static _rotateIfNeeded(): void {
		try {
			let size: number
			try {
				size = fs.statSync(this._logPath).size
			} catch {
				return // File doesn't exist yet — nothing to rotate
			}

			if (size < LOG_MAX_BYTES) return

			// Close the current stream so we can manipulate the file
			if (this._stream) {
				this._stream.end()
				this._stream = null
			}

			// Shift existing rotated files: .2.gz → delete, .1.gz → .2.gz
			for (let i = LOG_MAX_ROTATED; i >= 1; i--) {
				const rotatedPath = `${this._logPath}.${i}.gz`
				if (i === LOG_MAX_ROTATED) {
					// Delete the oldest
					try {
						fs.unlinkSync(rotatedPath)
					} catch {
						// May not exist
					}
				} else {
					// Shift up
					const nextPath = `${this._logPath}.${i + 1}.gz`
					try {
						fs.renameSync(rotatedPath, nextPath)
					} catch {
						// May not exist
					}
				}
			}

			// Compress current log → .1.gz
			const rawData = fs.readFileSync(this._logPath)
			const compressed = zlib.gzipSync(rawData)
			fs.writeFileSync(`${this._logPath}.1.gz`, compressed)

			// Truncate the current log
			fs.writeFileSync(this._logPath, "")
		} catch {
			// Rotation failure should never break indexing — just continue
		}
	}

	// ─── Core logging ─────────────────────────────────────────────────

	/**
	 * Log a progress event with throttling.
	 * Phase transitions are always logged; regular updates throttled to 1/sec.
	 * Phase transitions also go to the OutputChannel.
	 */
	static log(source: string, method: string, data: Record<string, any>): void {
		if (!this._isEnabled()) return
		this._updateCount++
		const now = Date.now()
		const isPhaseTransition = data.phaseTransition === true
		// Throttle non-transition logs to 1 per second
		if (!isPhaseTransition && now - this._lastLogTime < 1000) return
		this._lastLogTime = now

		// Track peak memory
		const heapMB = this._getMemoryMB()
		if (heapMB > this._peakHeapMB) {
			this._peakHeapMB = heapMB
		}

		// Always append heapMB + rssMB so every log entry shows memory usage.
		// heapMB = V8 JS heap; rssMB = total process resident set (includes native buffers, sockets, etc.)
		// This helps diagnose silent hangs caused by heap exhaustion or native memory bloat.
		const rssMB = this._getRssMB()
		data = { ...data, heapMB, rssMB }

		const ts = new Date().toISOString().substring(11, 23) // HH:MM:SS.mmm
		const elapsed = this._formatElapsed()
		const tag = `[${this._workspaceName}]`
		const dataStr = this._formatDataStr(data, ["phaseTransition"])

		const line = `[${ts}] ${elapsed} ${tag} #${this._updateCount} ${source}.${method} | ${dataStr}`
		this._writeToFile(line)

		// Phase transitions also go to OutputChannel
		if (isPhaseTransition) {
			this._writeToChannel(line)
		}
	}

	/**
	 * Log a suppressed update (change detection rejected the update).
	 * File-only (never to OutputChannel), more aggressively throttled.
	 */
	static logSuppressed(source: string, method: string, data: Record<string, any>): void {
		if (!this._isEnabled()) return
		this._updateCount++
		const now = Date.now()
		if (now - this._lastLogTime < 2000) return // More aggressive throttle for suppressed
		this._lastLogTime = now

		const ts = new Date().toISOString().substring(11, 23)
		const elapsed = this._formatElapsed()
		const tag = `[${this._workspaceName}]`
		const dataStr = this._formatDataStr(data)

		this._writeToFile(`[${ts}] ${elapsed} ${tag} #${this._updateCount} ${source}.${method} SUPPRESSED | ${dataStr}`)
	}

	/**
	 * Log a message to the OutputChannel regardless of the debug setting.
	 * Use for important events (errors, completion summaries) that should
	 * always be visible in VS Code's Output panel.
	 */
	static logToChannel(message: string): void {
		const ts = new Date().toISOString().substring(11, 23)
		const elapsed = this._formatElapsed()
		const tag = `[${this._workspaceName}]`
		this._writeToChannel(`[${ts}] ${elapsed} ${tag} ${message}`)
	}

	/**
	 * Flush and close the log file with a session summary.
	 */
	static close(): void {
		if (this._stream) {
			const duration = this._sessionStartTime ? this._formatElapsed() : "unknown"
			const heapMB = this._getMemoryMB()
			const summary =
				`[${new Date().toISOString().substring(11, 23)}] Session ended` +
				` | duration=${duration} totalEvents=${this._updateCount} peakHeapMB=${this._peakHeapMB} currentHeapMB=${heapMB}`

			this._writeToFile(summary)
			this._writeToChannel(summary)

			this._stream.end()
			this._stream = null
		}
	}

	/**
	 * Get the log file path for user reference.
	 */
	static get logPath(): string {
		return this._logPath
	}

	/**
	 * Get the current workspace name tag.
	 */
	static get workspaceName(): string {
		return this._workspaceName
	}

	/**
	 * Get the session start time (epoch ms). 0 if no session active.
	 */
	static get sessionStartTime(): number {
		return this._sessionStartTime
	}
}
