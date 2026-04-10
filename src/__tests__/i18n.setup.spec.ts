import { describe, expect, it } from "vitest"
import { resolveLocalesDir } from "../i18n/setup"

describe("resolveLocalesDir", () => {
	it("prefers the co-located dist locales directory when present", () => {
		const path = { join: (...parts: string[]) => parts.join("/") }
		const fs = {
			existsSync: (candidate: string) => candidate === "/extension/dist/i18n/locales",
			statSync: () => ({ isDirectory: () => true }),
		}

		expect(resolveLocalesDir("/extension/dist", path, fs)).toBe("/extension/dist/i18n/locales")
	})

	it("falls back to the parent dist locales directory for worker bundles", () => {
		const path = { join: (...parts: string[]) => parts.join("/") }
		const fs = {
			existsSync: (candidate: string) => candidate === "/extension/dist/workers/../i18n/locales",
			statSync: () => ({ isDirectory: () => true }),
		}

		expect(resolveLocalesDir("/extension/dist/workers", path, fs)).toBe("/extension/dist/workers/../i18n/locales")
	})

	it("returns null when no candidate locales directory exists", () => {
		const path = { join: (...parts: string[]) => parts.join("/") }
		const fs = {
			existsSync: () => false,
			statSync: () => ({ isDirectory: () => false }),
		}

		expect(resolveLocalesDir("/extension/dist/workers", path, fs)).toBeNull()
	})
})
