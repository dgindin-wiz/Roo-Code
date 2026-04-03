/**
 * Creates an isolated HTTP fetch function backed by a dedicated undici Agent.
 *
 * The OpenAI SDK v5 (and Qdrant client) use Node's built-in `fetch()` which
 * routes through the **global** undici dispatcher. Creating `new OpenAI()`
 * does NOT create new connection pools — all instances share one pool whose
 * native C++ buffers accumulate in V8's `external` memory and are never
 * freed because the global dispatcher is never destroyed.
 *
 * This utility creates a **private** undici Agent per client so that calling
 * `destroy()` tears down all its connections and immediately releases the
 * native TLS/socket buffers.
 *
 * Usage:
 *   const iso = createIsolatedFetch()
 *   const client = new OpenAI({ apiKey, fetch: iso.fetch })
 *   // ... later, to free memory:
 *   await iso.destroy()
 */

import { Agent, fetch as undiciFetch } from "undici"

export interface IsolatedFetch {
	/** A `fetch` compatible function that routes through the private Agent. */
	fetch: typeof globalThis.fetch
	/**
	 * Destroys the Agent and all its connections, freeing native TLS/socket
	 * buffers. Returns a Promise that resolves once all sockets are closed.
	 * The caller MUST await this to ensure V8's external memory counter
	 * actually decreases (unawaited destroys queue close events that never
	 * get processed while the event loop is busy with new requests).
	 */
	destroy: () => Promise<void>
}

// ── Diagnostic tracking ──────────────────────────────────────────────
// Tracks the total number of IsolatedFetch agents created and currently
// alive (not yet destroyed). Logged by the scanner at recycle boundaries
// to attribute memory growth to embedder agents vs Qdrant agents.
let _totalCreated = 0
let _totalDestroyed = 0

/** Returns diagnostic counters for IsolatedFetch agent lifecycle. */
export function getIsolatedFetchStats(): { created: number; destroyed: number; alive: number } {
	return {
		created: _totalCreated,
		destroyed: _totalDestroyed,
		alive: _totalCreated - _totalDestroyed,
	}
}

export function createIsolatedFetch(): IsolatedFetch {
	const agent = new Agent({
		keepAliveTimeout: 1_000, // Close idle connections after 1s (frees TLS buffers between batches)
		keepAliveMaxTimeout: 5_000, // Hard cap on keep-alive lifetime
		connections: 10, // max concurrent connections per origin
		pipelining: 1, // 1 request per connection (no HTTP pipelining)
	})

	_totalCreated++

	const isolatedFetch = ((url: any, init?: any) => {
		return undiciFetch(url, { ...init, dispatcher: agent })
	}) as unknown as typeof globalThis.fetch

	return {
		fetch: isolatedFetch,
		destroy: async () => {
			// Destroy the Agent and wait for all connections to close.
			// IMPORTANT: The caller MUST ensure no requests are in flight on this
			// agent before calling destroy(). The scanner achieves this by draining
			// all active batch promises before recycling (drain-then-recycle pattern).
			//
			// Awaiting agent.destroy() is CRITICAL — without it, the socket close
			// events never get processed because the event loop immediately resumes
			// batch processing, and the native TLS buffers accumulate forever.
			try {
				await agent.destroy()
				_totalDestroyed++
			} catch {
				// Agent may already be destroyed
			}
		},
	}
}
