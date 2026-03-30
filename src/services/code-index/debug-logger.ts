import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * File-based debug logger for code indexing progress.
 * Writes to ~/roo-index-debug.log so it can be reviewed after testing.
 * Set ENABLED = false to disable all logging.
 */
export class IndexDebugLogger {
	static ENABLED = true
	private static _stream: fs.WriteStream | null = null
	private static _logPath = path.join(os.homedir(), "roo-index-debug.log")
	private static _updateCount = 0
	private static _lastLogTime = 0

	private static _getStream(): fs.WriteStream {
		if (!this._stream) {
			this._stream = fs.createWriteStream(this._logPath, { flags: "a" })
			this._write(`\n${"=".repeat(80)}\n[${new Date().toISOString()}] Debug logging started\n${"=".repeat(80)}`)
		}
		return this._stream
	}

	private static _write(line: string): void {
		try {
			this._getStream().write(line + "\n")
		} catch {
			// Silently fail — debug logging should never break indexing
		}
	}

	/**
	 * Log a progress event with throttling.
	 * Phase transitions are always logged; regular updates throttled to 1/sec.
	 */
	static log(source: string, method: string, data: Record<string, any>): void {
		if (!this.ENABLED) return
		this._updateCount++
		const now = Date.now()
		const isPhaseTransition = data.phaseTransition === true
		// Throttle non-transition logs to 1 per second
		if (!isPhaseTransition && now - this._lastLogTime < 1000) return
		this._lastLogTime = now

		const ts = new Date().toISOString().substring(11, 23) // HH:MM:SS.mmm
		const dataStr = Object.entries(data)
			.filter(([k]) => k !== "phaseTransition")
			.map(([k, v]) => `${k}=${v}`)
			.join(" ")
		this._write(`[${ts}] #${this._updateCount} ${source}.${method} | ${dataStr}`)
	}

	/**
	 * Log a suppressed update (change detection rejected the update).
	 */
	static logSuppressed(source: string, method: string, data: Record<string, any>): void {
		if (!this.ENABLED) return
		this._updateCount++
		const now = Date.now()
		if (now - this._lastLogTime < 2000) return // More aggressive throttle for suppressed
		this._lastLogTime = now

		const ts = new Date().toISOString().substring(11, 23)
		const dataStr = Object.entries(data)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ")
		this._write(`[${ts}] #${this._updateCount} ${source}.${method} SUPPRESSED | ${dataStr}`)
	}

	/**
	 * Flush and close the log file.
	 */
	static close(): void {
		if (this._stream) {
			this._write(
				`[${new Date().toISOString().substring(11, 23)}] Debug logging ended (${this._updateCount} total events)`,
			)
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
}
