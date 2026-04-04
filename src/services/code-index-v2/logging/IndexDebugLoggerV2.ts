import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Package } from "../../../shared/package"
import { CODE_INDEX_V2_LOG_BASENAME } from "../shared/constants"
import { CodeIndexV2LogContext, CodeIndexV2LogLevel, CodeIndexV2MemorySnapshot } from "./log-types"

export class IndexDebugLoggerV2 {
	private static _channel: vscode.OutputChannel | undefined
	private static readonly _logPath = path.join(os.homedir(), CODE_INDEX_V2_LOG_BASENAME)

	static isEnabled(): boolean {
		try {
			return vscode.workspace.getConfiguration(Package.name).get<boolean>("codeIndex.debugLogging", false)
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

		const payload = {
			timestamp: new Date().toISOString(),
			level,
			component,
			message,
			...context,
			memory: this.getMemorySnapshot(),
		}

		const line = JSON.stringify(payload)

		try {
			this.getChannel().appendLine(`[CodeIndexV2] ${message}`)
		} catch {
			// Best effort only.
		}

		if (this.isEnabled()) {
			try {
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
			}
		} catch {
			return {
				rssMB: 0,
				heapUsedMB: 0,
				heapTotalMB: 0,
				externalMB: 0,
			}
		}
	}

	private static getChannel(): vscode.OutputChannel {
		if (!this._channel) {
			this._channel = vscode.window.createOutputChannel("Roo Code: Index V2")
		}
		return this._channel
	}
}
