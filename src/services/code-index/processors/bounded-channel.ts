/**
 * A bounded async producer-consumer channel.
 *
 * - `push(item)` blocks (awaits) when the buffer is at capacity.
 * - `drain()` yields items as they arrive; completes when the channel is closed and empty.
 * - `close()` signals no more items will be pushed.
 *
 * Thread-safety: single producer + single consumer (no mutex needed).
 * Abort-safe: pass an AbortSignal to wake blocked pushers/drainers immediately.
 */
export class BoundedChannel<T> {
	private _buffer: T[] = []
	private _pushWaiters: Array<() => void> = []
	private _drainWaiters: Array<() => void> = []
	private _closed = false

	constructor(private readonly _maxSize: number) {
		if (_maxSize < 1) throw new Error("BoundedChannel maxSize must be >= 1")
	}

	/** Number of items currently buffered. */
	get size(): number {
		return this._buffer.length
	}

	get closed(): boolean {
		return this._closed
	}

	/**
	 * Push an item into the channel.
	 * If the buffer is full, this awaits until a consumer drains an item.
	 * Resolves to `true` if the item was accepted, `false` if the channel was closed.
	 */
	async push(item: T, signal?: AbortSignal): Promise<boolean> {
		while (this._buffer.length >= this._maxSize && !this._closed) {
			if (signal?.aborted) return false
			await new Promise<void>((resolve) => {
				this._pushWaiters.push(resolve)

				// If signal aborts while we're waiting, wake up to check
				if (signal) {
					const onAbort = () => {
						const idx = this._pushWaiters.indexOf(resolve)
						if (idx >= 0) this._pushWaiters.splice(idx, 1)
						resolve()
					}
					signal.addEventListener("abort", onAbort, { once: true })
				}
			})
		}
		if (this._closed) return false
		if (signal?.aborted) return false

		this._buffer.push(item)
		this._wakeOne(this._drainWaiters)
		return true
	}

	/**
	 * Async generator that yields items from the channel.
	 * Completes when the channel is closed AND the buffer is empty.
	 */
	async *drain(signal?: AbortSignal): AsyncGenerator<T> {
		while (!this._closed || this._buffer.length > 0) {
			// Wait for an item if buffer is empty and channel is still open
			while (this._buffer.length === 0 && !this._closed) {
				if (signal?.aborted) return
				await new Promise<void>((resolve) => {
					this._drainWaiters.push(resolve)

					if (signal) {
						const onAbort = () => {
							const idx = this._drainWaiters.indexOf(resolve)
							if (idx >= 0) this._drainWaiters.splice(idx, 1)
							resolve()
						}
						signal.addEventListener("abort", onAbort, { once: true })
					}
				})
				if (signal?.aborted) return
			}

			// Drain all available items
			while (this._buffer.length > 0) {
				if (signal?.aborted) return
				const item = this._buffer.shift()!
				this._wakeOne(this._pushWaiters)
				yield item
			}
		}
	}

	/**
	 * Close the channel. No more items can be pushed.
	 * Wakes all blocked pushers and drainers.
	 */
	close(): void {
		this._closed = true
		this._wakeAll(this._drainWaiters)
		this._wakeAll(this._pushWaiters)
	}

	private _wakeOne(waiters: Array<() => void>): void {
		const waiter = waiters.shift()
		if (waiter) waiter()
	}

	private _wakeAll(waiters: Array<() => void>): void {
		const all = waiters.splice(0)
		for (const waiter of all) waiter()
	}
}
