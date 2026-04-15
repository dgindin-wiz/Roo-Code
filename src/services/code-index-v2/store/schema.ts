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
  last_heartbeat_at INTEGER,
  heartbeat_owner TEXT,
  discovery_complete INTEGER NOT NULL DEFAULT 0,
  reconciliation_complete INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  blocking_reason TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS index_run_summaries (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  total_run_ms INTEGER,
  discovery_ms INTEGER,
  stat_hash_ms INTEGER,
  parse_chunk_ms INTEGER,
  diff_planning_ms INTEGER,
  embed_upsert_ms INTEGER,
  discovered_files INTEGER,
  files_scanned INTEGER,
  files_changed INTEGER,
  parsed_chunks INTEGER,
  planned_revisions INTEGER,
  synced_chunks INTEGER,
  upserted_chunks INTEGER,
  deleted_chunks INTEGER,
  committed_revisions INTEGER,
  retrying_parse_revisions INTEGER,
  terminal_failed_parse_revisions INTEGER,
  retrying_chunks INTEGER,
  terminal_failed_chunks INTEGER,
  degraded_revisions INTEGER,
  terminal_failed_revisions INTEGER,
  chunks_per_second REAL,
  peak_chunks_per_second REAL,
  average_batch_latency_ms REAL,
  peak_batch_latency_ms REAL,
  average_embed_latency_ms REAL,
  average_upsert_latency_ms REAL,
  average_metadata_commit_latency_ms REAL,
  average_idle_gap_ms REAL,
  peak_idle_gap_ms REAL,
  peak_batch_size INTEGER,
  peak_embedding_count INTEGER,
  lane_concurrency INTEGER,
  effective_batch_size INTEGER,
  peak_in_flight_chunk_count INTEGER,
  pressure_soft_transitions INTEGER,
  pressure_hard_transitions INTEGER,
  pressure_soft_duration_ms INTEGER,
  pressure_hard_duration_ms INTEGER,
  parse_throttle_ms INTEGER,
  peak_staged_chunks INTEGER,
  peak_queued_jobs INTEGER,
  host_rss_mb REAL,
  host_heap_used_mb REAL,
  host_external_mb REAL,
  host_cpu_percent REAL,
  tracked_sidecar_rss_mb REAL,
  parse_sidecar_rss_mb REAL,
  embed_sidecar_rss_mb REAL,
  metadata_sidecar_rss_mb REAL,
  metadata_sidecar_cpu_percent REAL,
  gpu_sampler TEXT,
  gpu_utilization_percent REAL,
  gpu_memory_pressure_percent REAL,
  gpu_in_use_bytes INTEGER,
  gpu_allocated_bytes INTEGER,
  gpu_power_w REAL,
  average_gpu_utilization_percent REAL,
  peak_gpu_utilization_percent REAL,
  average_gpu_in_use_bytes INTEGER,
  peak_gpu_in_use_bytes INTEGER,
  gpu_sample_count INTEGER,
  embeddings_per_chunk REAL,
  lane_occupancy_percent REAL,
  embed_active_percent REAL,
  blocked_on_parsed_revisions_ms INTEGER,
  blocked_on_staged_chunks_ms INTEGER,
  build_version TEXT,
  build_timestamp TEXT,
  build_sha TEXT,
  engine_version TEXT,
  provider TEXT,
  model_id TEXT,
  runtime_kind TEXT,
  device_hint TEXT,
  last_blocking_reason TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS index_run_samples (
  sample_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  blocking_reason TEXT,
  pressure_state TEXT,
  pressure_reasons_json TEXT,
  lane_concurrency INTEGER,
  effective_batch_size INTEGER,
  active_lane_count INTEGER,
  in_flight_chunk_count INTEGER,
  peak_in_flight_chunk_count INTEGER,
  chunks_per_second REAL,
  peak_chunks_per_second REAL,
  average_batch_latency_ms REAL,
  average_embed_latency_ms REAL,
  average_upsert_latency_ms REAL,
  average_metadata_commit_latency_ms REAL,
  average_idle_gap_ms REAL,
  waiting_for_jobs_ms REAL,
  waiting_for_in_flight_capacity_ms REAL,
  waiting_for_pressure_ms REAL,
  requested_batch_size INTEGER,
  embedding_count INTEGER,
  provider_batch_utilization REAL,
  embeddings_per_chunk REAL,
  lane_occupancy_percent REAL,
  embed_active_percent REAL,
  staged_chunks INTEGER,
  staged_chunk_bytes INTEGER,
  queued_upsert_jobs INTEGER,
  running_upsert_jobs INTEGER,
  queued_delete_jobs INTEGER,
  running_delete_jobs INTEGER,
  parsed_revisions INTEGER,
  planned_revisions INTEGER,
  host_rss_mb REAL,
  host_heap_used_mb REAL,
  host_external_mb REAL,
  host_cpu_percent REAL,
  tracked_sidecar_rss_mb REAL,
  parse_sidecar_rss_mb REAL,
  embed_sidecar_rss_mb REAL,
  metadata_sidecar_rss_mb REAL,
  metadata_sidecar_cpu_percent REAL,
  gpu_sampler TEXT,
  gpu_utilization_percent REAL,
  gpu_memory_pressure_percent REAL,
  gpu_in_use_bytes INTEGER,
  gpu_allocated_bytes INTEGER,
  gpu_power_w REAL,
  details_json TEXT
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
  vector_eligible INTEGER NOT NULL DEFAULT 1,
  vector_priority INTEGER NOT NULL DEFAULT 0,
  vector_eligibility_reason TEXT,
  novelty_score REAL,
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

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_lexical_fts USING fts5(
  chunk_id UNINDEXED,
  relative_path,
  symbol_qualified_name,
  symbol_name,
  parent_symbol_name,
  summary,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
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
  lease_owner TEXT,
  lease_expires_at INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_jobs_run_type_state_next_attempt ON jobs(run_id, job_type, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry ON jobs(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_revisions_run_state ON file_revisions(run_id, state, discovered_at);
CREATE INDEX IF NOT EXISTS idx_chunks_state_revision ON chunks(state, revision_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_workspace_observed ON watch_events(workspace_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_index_run_summaries_workspace_started ON index_run_summaries(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_run_samples_run_recorded ON index_run_samples(run_id, recorded_at ASC);
CREATE INDEX IF NOT EXISTS idx_index_run_samples_workspace_recorded ON index_run_samples(workspace_id, recorded_at DESC);
`

export function getCodeIndexV2SchemaVersion(): number {
	return CODE_INDEX_V2_SCHEMA_VERSION
}
