import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import {
	AdaptiveEmbeddingControllerState,
	AdaptiveProviderObservation,
	applyAdaptiveProviderObservation,
	cloneAdaptiveEmbeddingControllerState,
} from "../shared/adaptiveEmbeddingController"

interface EmbeddingRuntimeProfileStorePayload {
	version: 1
	profiles: Record<string, AdaptiveEmbeddingControllerState>
}

export class EmbeddingRuntimeProfileStore {
	private static readonly WRITE_DEBOUNCE_MS = 500
	private readonly filePath: string
	private readonly profiles = new Map<string, AdaptiveEmbeddingControllerState>()
	private writeTimer: NodeJS.Timeout | undefined
	private writeChain: Promise<void> = Promise.resolve()

	constructor(context: vscode.ExtensionContext) {
		this.filePath = path.join(
			context.globalStorageUri.fsPath,
			"code-index-v2",
			"runtime",
			"embedding-runtime-profiles.json",
		)
		this.loadFromDisk()
	}

	getProfile(key: string): AdaptiveEmbeddingControllerState | undefined {
		return cloneAdaptiveEmbeddingControllerState(this.profiles.get(key))
	}

	setProfile(
		key: string,
		state: AdaptiveEmbeddingControllerState | undefined,
	): AdaptiveEmbeddingControllerState | undefined {
		if (!state) {
			this.profiles.delete(key)
			this.scheduleWrite()
			return undefined
		}

		this.profiles.set(key, { ...state })
		this.scheduleWrite()
		return this.getProfile(key)
	}

	applyObservation(key: string, observation: AdaptiveProviderObservation): AdaptiveEmbeddingControllerState {
		const next = applyAdaptiveProviderObservation(this.profiles.get(key), observation).state
		this.profiles.set(key, next)
		this.scheduleWrite()
		return { ...next }
	}

	async flush(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer)
			this.writeTimer = undefined
		}

		const payload: EmbeddingRuntimeProfileStorePayload = {
			version: 1,
			profiles: Object.fromEntries(this.profiles.entries()),
		}

		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				try {
					fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
					await safeWriteJson(this.filePath, payload, { prettyPrint: true })
				} catch {
					// Persistence is best-effort; indexing should not fail if the runtime profile cache cannot be written.
				}
			})

		await this.writeChain
	}

	private loadFromDisk() {
		try {
			if (!fs.existsSync(this.filePath)) {
				return
			}

			const raw = fs.readFileSync(this.filePath, "utf8")
			const payload = JSON.parse(raw) as Partial<EmbeddingRuntimeProfileStorePayload>
			for (const [key, value] of Object.entries(payload.profiles ?? {})) {
				if (value && typeof value === "object") {
					this.profiles.set(key, value)
				}
			}
		} catch {
			// Ignore corrupt profile state and relearn from live observations.
		}
	}

	private scheduleWrite() {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer)
		}

		this.writeTimer = setTimeout(() => {
			void this.flush()
		}, EmbeddingRuntimeProfileStore.WRITE_DEBOUNCE_MS)
		this.writeTimer.unref?.()
	}
}
