import { describe, it, expect } from "vitest"
import { parseRetryAfterMs, HttpError } from "../validation-helpers"

describe("parseRetryAfterMs", () => {
	it("should return undefined when no Retry-After header is present", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		expect(parseRetryAfterMs(error)).toBeUndefined()
	})

	it("should parse numeric Retry-After (seconds) from error.headers", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": "5" }
		expect(parseRetryAfterMs(error)).toBe(5000)
	})

	it("should parse numeric Retry-After from response.headers (Record)", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		error.response = { status: 429, headers: { "Retry-After": "10" } }
		expect(parseRetryAfterMs(error)).toBe(10000)
	})

	it("should parse numeric Retry-After from response.headers (Headers object)", () => {
		const headers = new Headers()
		headers.set("Retry-After", "3")
		const error = new Error("429") as HttpError
		error.status = 429
		error.response = { status: 429, headers }
		expect(parseRetryAfterMs(error)).toBe(3000)
	})

	it("should parse HTTP-date Retry-After header", () => {
		const futureDate = new Date(Date.now() + 60000) // 60 seconds from now
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": futureDate.toUTCString() }
		const result = parseRetryAfterMs(error)
		expect(result).toBeDefined()
		// Should be approximately 60000ms (within 2s tolerance for test execution time)
		expect(result!).toBeGreaterThan(58000)
		expect(result!).toBeLessThan(62000)
	})

	it("should return undefined for past HTTP-date", () => {
		const pastDate = new Date(Date.now() - 10000) // 10 seconds ago
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": pastDate.toUTCString() }
		expect(parseRetryAfterMs(error)).toBeUndefined()
	})

	it("should return undefined for zero or negative seconds", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": "0" }
		expect(parseRetryAfterMs(error)).toBeUndefined()
	})

	it("should return undefined for non-parseable value", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": "not-a-number-or-date" }
		expect(parseRetryAfterMs(error)).toBeUndefined()
	})

	it("should prefer error.headers over response.headers", () => {
		const error = new Error("429") as HttpError
		error.status = 429
		error.headers = { "retry-after": "7" }
		error.response = { status: 429, headers: { "retry-after": "20" } }
		expect(parseRetryAfterMs(error)).toBe(7000)
	})
})
