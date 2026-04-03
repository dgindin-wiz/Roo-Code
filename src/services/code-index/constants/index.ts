import { CODEBASE_INDEX_DEFAULTS } from "@roo-code/types"

/**Parser */
export const MAX_BLOCK_CHARS = 1000
export const MIN_BLOCK_CHARS = 50
export const MIN_CHUNK_REMAINDER_CHARS = 200 // Minimum characters for the *next* chunk after a split
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15 // 15% tolerance for max chars

/**Search */
export const DEFAULT_SEARCH_MIN_SCORE = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
export const DEFAULT_MAX_SEARCH_RESULTS = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS

/**File Watcher */
export const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB

/**Directory Scanner — default cap on supported code files to index.
 * Applied AFTER extension filtering so non-code files don't consume the budget.
 * Configurable via `roo-cline.codeIndex.maxFiles` in VS Code settings. */
export const MAX_LIST_FILES_LIMIT_CODE_INDEX = 100_000
export const BATCH_SEGMENT_THRESHOLD = 60 // Number of code segments to batch for embeddings/upserts
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500
export const PARSING_CONCURRENCY = 10
export const MAX_PENDING_BATCHES = 20 // Maximum number of batches to accumulate before waiting
export const PARSE_CHUNK_SIZE = 100 // Number of candidate files to process per iteration (prevents 65K Promise explosion)
export const PROGRESS_THROTTLE_MS = 250 // Min interval between progress events (4/sec max, prevents event storm)
export const MAX_EMBED_QUEUE_FILES = 50 // Max files queued in embed channel before parsing pauses (bounds memory)
export const MAX_CONSECUTIVE_BATCH_FAILURES = 5 // Abort scan after N consecutive batch failures (fail fast)
export const BATCH_PROCESSING_TIMEOUT_MS = 120_000 // 2 minutes — if a single batch takes longer, treat as hung
export const CLIENT_RECYCLE_INTERVAL = 25 // Recycle HTTP clients every N batches to release accumulated native memory

/**Search */
export const SEARCH_EMBEDDING_TIMEOUT_MS = 30_000 // 30 seconds — timeout for generating query embedding during search

/**Parser */
export const MAX_PARSEABLE_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2MB — skip files larger than this to prevent OOM
export const PARSER_LOAD_TIMEOUT_MS = 30_000 // 30 seconds — timeout for loading a tree-sitter WASM parser

/**OpenAI Embedder */
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const BATCH_PROCESSING_CONCURRENCY = 10

/**Gemini Embedder */
export const GEMINI_MAX_ITEM_TOKENS = 2048
