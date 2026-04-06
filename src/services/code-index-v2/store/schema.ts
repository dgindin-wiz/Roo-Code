import { CODE_INDEX_V2_SCHEMA_VERSION } from "../shared/constants"

export const CODE_INDEX_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS index_runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  discovery_complete INTEGER NOT NULL DEFAULT 0,
  reconciliation_complete INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  last_seen_mtime_ms INTEGER,
  last_seen_size INTEGER,
  ignore_state TEXT NOT NULL,
  active_revision_id TEXT,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, relative_path)
);

CREATE TABLE IF NOT EXISTS file_revisions (
  revision_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fast_fingerprint TEXT,
  parser_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  state TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  committed_at INTEGER,
  superseded_at INTEGER,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  chunk_fingerprint TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT,
  chunk_kind TEXT,
  symbol_name TEXT,
  symbol_qualified_name TEXT,
  parent_symbol_name TEXT,
  parent_chunk_fingerprint TEXT,
  summary TEXT,
  search_text TEXT,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  token_estimate INTEGER,
  embedding_model TEXT,
  vector_point_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_variants (
  variant_id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  variant_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  token_estimate INTEGER,
  embedding_model TEXT,
  vector_point_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chunk_id, variant_type)
);

CREATE TABLE IF NOT EXISTS oversized_file_tracking (
  workspace_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  status TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  last_modified_mtime_ms INTEGER,
  recommendation TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_max_bytes INTEGER,
  source_run_id TEXT,
  last_evaluated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, relative_path)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  coalesced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  reconciliation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  missing_file_count INTEGER NOT NULL DEFAULT 0,
  changed_file_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_workspace_path ON files(workspace_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_revisions_file_state ON file_revisions(file_id, state);
CREATE INDEX IF NOT EXISTS idx_chunks_revision_state ON chunks(revision_id, state);
CREATE INDEX IF NOT EXISTS idx_chunk_variants_chunk_state ON chunk_variants(chunk_id, state);
CREATE INDEX IF NOT EXISTS idx_oversized_tracking_workspace_status ON oversized_file_tracking(workspace_id, status, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_state_next_attempt ON jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_watch_events_workspace_observed ON watch_events(workspace_id, observed_at);
`

export function getCodeIndexV2SchemaVersion(): number {
	return CODE_INDEX_V2_SCHEMA_VERSION
}
