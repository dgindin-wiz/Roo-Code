export const CODE_INDEX_V2_ENGINE_ID = "v2" as const
export const CODE_INDEX_LEGACY_ENGINE_ID = "legacy" as const

export const CODE_INDEX_V2_SCHEMA_VERSION = 5
export const CODE_INDEX_V2_DB_BASENAME = "roo-code-index-v2.sqlite"
export const CODE_INDEX_V2_LOG_BASENAME = "roo-code-index-v2.log"

export const CODE_INDEX_V2_DEFAULT_MEMORY_SOFT_LIMIT_MB = 1024
export const CODE_INDEX_V2_DEFAULT_MAX_DISCOVERY_BUFFER = 500
export const CODE_INDEX_V2_DEFAULT_MAX_PARSE_QUEUE = 100
export const CODE_INDEX_V2_DEFAULT_MAX_EMBED_QUEUE = 100
export const CODE_INDEX_V2_DEFAULT_MAX_VECTOR_QUEUE = 100

export type CodeIndexEngineKind = typeof CODE_INDEX_LEGACY_ENGINE_ID | typeof CODE_INDEX_V2_ENGINE_ID
