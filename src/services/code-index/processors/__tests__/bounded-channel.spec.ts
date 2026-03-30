// npx vitest services/code-index/processors/__tests__/bounded-channel.spec.ts

import { BoundedChannel } from "../bounded-channel"

describe("BoundedChannel", () => {
	describe("constructor", () => {
		it("should throw if maxSize < 1", () => {
			expect(() => new BoundedChannel(0)).toThrow("maxSize must be >= 1")
			expect(() => new BoundedChannel(-1)).toThrow("maxSize must be >= 1")
		})

		it("should create with valid maxSize", () => {
			const ch = new BoundedChannel<number>(5)
			expect(ch.size).toBe(0)
			expect(ch.closed).toBe(false)
		})
	})

	describe("push and drain", () => {
		it("should push and drain a single item", async () => {
			const ch = new BoundedChannel<string>(10)
			await ch.push("hello")
			ch.close()

			const items: string[] = []
			for await (const item of ch.drain()) {
				items.push(item)
			}
			expect(items).toEqual(["hello"])
		})

		it("should push and drain multiple items in order", async () => {
			const ch = new BoundedChannel<number>(10)
			await ch.push(1)
			await ch.push(2)
			await ch.push(3)
			ch.close()

			const items: number[] = []
			for await (const item of ch.drain()) {
				items.push(item)
			}
			expect(items).toEqual([1, 2, 3])
		})

		it("should return true when push succeeds", async () => {
			const ch = new BoundedChannel<number>(5)
			const result = await ch.push(42)
			expect(result).toBe(true)
			ch.close()
		})

		it("should return false when push is called on a closed channel", async () => {
			const ch = new BoundedChannel<number>(5)
			ch.close()
			const result = await ch.push(42)
			expect(result).toBe(false)
		})

		it("should track size correctly", async () => {
			const ch = new BoundedChannel<number>(5)
			expect(ch.size).toBe(0)
			await ch.push(1)
			expect(ch.size).toBe(1)
			await ch.push(2)
			expect(ch.size).toBe(2)
			ch.close()
		})
	})

	describe("backpressure", () => {
		it("should block push when buffer is full", async () => {
			const ch = new BoundedChannel<number>(2)
			await ch.push(1)
			await ch.push(2)
			expect(ch.size).toBe(2)

			// This push should block
			let pushResolved = false
			const pushPromise = ch.push(3).then((result) => {
				pushResolved = true
				return result
			})

			// Give microtask queue a chance
			await new Promise((r) => setTimeout(r, 10))
			expect(pushResolved).toBe(false) // Still blocked

			// Drain one item to unblock
			const drainGen = ch.drain()
			const first = await drainGen.next()
			expect(first.value).toBe(1)

			// Push should now resolve
			await new Promise((r) => setTimeout(r, 10))
			expect(pushResolved).toBe(true)

			ch.close()
		})

		it("should process items concurrently with producer-consumer pattern", async () => {
			const ch = new BoundedChannel<number>(3)
			const consumed: number[] = []

			// Consumer
			const consumerDone = (async () => {
				for await (const item of ch.drain()) {
					consumed.push(item)
				}
			})()

			// Producer
			for (let i = 0; i < 10; i++) {
				await ch.push(i)
			}
			ch.close()

			await consumerDone
			expect(consumed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		})
	})

	describe("abort signal", () => {
		it("should abort push when signal is aborted", async () => {
			const ch = new BoundedChannel<number>(1)
			await ch.push(1) // Fill buffer

			const controller = new AbortController()

			// This push should block
			const pushPromise = ch.push(2, controller.signal)

			// Abort after a short delay
			setTimeout(() => controller.abort(), 10)

			const result = await pushPromise
			expect(result).toBe(false) // Push rejected due to abort
			ch.close()
		})

		it("should abort drain when signal is aborted", async () => {
			const ch = new BoundedChannel<number>(10)

			const controller = new AbortController()
			const items: number[] = []

			// Start draining (will wait for items)
			const drainPromise = (async () => {
				for await (const item of ch.drain(controller.signal)) {
					items.push(item)
				}
			})()

			// Push one item
			await ch.push(1)
			await new Promise((r) => setTimeout(r, 10))

			// Abort
			controller.abort()
			await drainPromise

			// Should have gotten the item that was already buffered
			expect(items).toContain(1)
		})

		it("should return false immediately when push is called with already-aborted signal", async () => {
			const ch = new BoundedChannel<number>(1)
			await ch.push(1) // Fill buffer

			const controller = new AbortController()
			controller.abort()

			const result = await ch.push(2, controller.signal)
			expect(result).toBe(false)
			ch.close()
		})
	})

	describe("close", () => {
		it("should drain remaining items after close", async () => {
			const ch = new BoundedChannel<number>(10)
			await ch.push(1)
			await ch.push(2)
			ch.close()

			const items: number[] = []
			for await (const item of ch.drain()) {
				items.push(item)
			}
			expect(items).toEqual([1, 2])
		})

		it("should complete drain when closed with empty buffer", async () => {
			const ch = new BoundedChannel<number>(10)
			const items: number[] = []

			// Start drain
			const drainPromise = (async () => {
				for await (const item of ch.drain()) {
					items.push(item)
				}
			})()

			// Close immediately
			ch.close()
			await drainPromise

			expect(items).toEqual([])
			expect(ch.closed).toBe(true)
		})

		it("should wake blocked pushers on close", async () => {
			const ch = new BoundedChannel<number>(1)
			await ch.push(1) // Fill buffer

			let pushResult: boolean | undefined
			const pushPromise = ch.push(2).then((r) => {
				pushResult = r
				return r
			})

			await new Promise((r) => setTimeout(r, 10))
			expect(pushResult).toBeUndefined() // Still blocked

			ch.close()
			await pushPromise
			expect(pushResult).toBe(false)
		})
	})
})
