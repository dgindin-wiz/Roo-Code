export const CODE_INDEX_V2_ENGINE_ID = "v2" as const
export const CODE_INDEX_LEGACY_ENGINE_ID = "legacy" as const

export const CODE_INDEX_V2_SCHEMA_VERSION = 8
export const CODE_INDEX_V2_DB_BASENAME = "roo-code-index-v2.sqlite"
export const CODE_INDEX_V2_TELEMETRY_DB_BASENAME = "roo-code-index-v2-telemetry.sqlite"
export const CODE_INDEX_V2_LOG_BASENAME = "roo-code-index-v2.log"
export const CODE_INDEX_V2_DIAGNOSTICS_DIR_BASENAME = "diagnostics"
export const CODE_INDEX_V2_PERSISTENT_DIR_BASENAME = "persistent"
export const CODE_INDEX_V2_LOG_ENV_VAR = "ROO_CODE_INDEX_V2_DIAGNOSTICS_DIR"
export const CODE_INDEX_V2_LOG_MAX_BYTES = 8 * 1024 * 1024
export const CODE_INDEX_V2_LOG_MAX_ROTATED_FILES = 6

export const CODE_INDEX_V2_DEFAULT_MEMORY_SOFT_LIMIT_MB = 1024
export const CODE_INDEX_V2_DEFAULT_MAX_DISCOVERY_BUFFER = 500
export const CODE_INDEX_V2_DEFAULT_MAX_PARSE_QUEUE = 100
export const CODE_INDEX_V2_DEFAULT_MAX_EMBED_QUEUE = 100
export const CODE_INDEX_V2_DEFAULT_MAX_VECTOR_QUEUE = 100

export type CodeIndexEngineKind = typeof CODE_INDEX_LEGACY_ENGINE_ID | typeof CODE_INDEX_V2_ENGINE_ID
