# World-Class Code Index Plan

## Summary
Upgrade the code index as a V2-native, phased redesign that makes chunking structure-aware, metadata-rich, and retrieval-aware without making indexing depend on extra LLM calls.

The redesign will:
- Replace the current "AST when available, otherwise raw chunking" model with explicit chunk strategies per file type.
- Represent one logical chunk as a structured entity with metadata plus multiple deterministic text views.
- Add parent/child relationships so retrieval can return symbol-level hits and then expand to file/class context.
- Introduce hybrid retrieval and reranking in later phases using local lexical indexing plus existing vector search.
- Preserve the current external search entrypoints initially, then enrich results without breaking callers.

Defaults chosen:
- Implement in `code-index-v2` only.
- Use deterministic summaries first; no model-generated summaries in the main rollout.
- Use phased rollout, with parser/indexing improvements first and hybrid retrieval after data quality is in place.
- Use SQLite FTS for lexical search rather than a new external service.

## Key Changes

### Phase 1: Structured chunk model and metadata-rich parsing
- Replace the current parser output contract with a logical chunk model that includes:
  - `chunkKind`: `file`, `module`, `class`, `function`, `method`, `type`, `enum`, `constant`, `config_section`, `fallback`
  - `symbolName`
  - `symbolQualifiedName`
  - `symbolSignature`
  - `parentSymbolName`
  - `parentChunkFingerprint`
  - `language`
  - `imports`
  - `docComment`
  - `startLine`, `endLine`
  - `content`
  - `summaryText`
  - `searchText`
  - stable `chunkFingerprint`
- Keep Tree-sitter as the primary parser for code files, but make chunking explicitly symbol-first:
  - chunk at function, method, class, interface/type, enum, module, and top-level constant boundaries
  - include attached docstrings/comments with the owning symbol
  - keep whole symbols intact when they fit limits
  - for oversized symbols, split only at stable internal boundaries such as block statements, case arms, object members, or parser-recognized child scopes
  - only use line-based fallback when no structural parser exists or parsing fails
- Add language-specific config parsers:
  - JSON: split by top-level objects, arrays of meaningful records, policy/resource statements, route/config sections
  - YAML: add `.yml`/`.yaml` support using the existing `yaml` dependency and split by top-level keys / semantic sections
  - TOML: split by tables / sections rather than raw size
- Add deterministic summaries:
  - code chunks: `"TypeScript method Foo.bar(x, y) in src/foo.ts; attached doc: ..."`
  - config chunks: `"YAML section services.api.environment in docker-compose.yml"`
  - summary generation must be parser/metadata driven only, with no embedding-model call
- Add aggressive low-value file filtering before parse/chunk:
  - generated/minified assets
  - vendored dependencies
  - lockfiles
  - snapshot outputs
  - binaries / oversized machine-generated artifacts
- Keep current ignore semantics (`.rooignore`, `.gitignore`) and layer the new exclusions on top as deterministic candidate rejection rules.

### Phase 2: Storage model, schema migration, and multi-view indexing
- Extend V2 metadata schema so one logical chunk can carry structured metadata and multiple indexable representations.
- Change storage to:
  - keep `chunks` as the logical chunk table
  - add `chunk_variants` table with one row per representation:
    - `variantType`: `raw_code`, `code_with_docs`, `summary`, `symbol_signature`
    - `text`
    - `textHash`
    - `tokenEstimate`
    - `embeddingModel`
    - `vectorPointId`
    - `state`
  - add metadata columns to `chunks` for symbol hierarchy and chunk classification
- Parent/child model:
  - file record remains the top-level parent
  - optional file-level parent chunk for module/file summary
  - symbol-level child chunks under file or enclosing class/module
  - subchunks for oversized symbols linked back to the owning symbol chunk
- Vector payload for every embedded variant will include:
  - workspace/file/revision IDs
  - path and path segments
  - language
  - chunk kind
  - symbol name / qualified name
  - parent symbol
  - line range
  - parser version / chunker version
  - variant type
  - parent chunk ID / fingerprint
- Migration behavior:
  - bump V2 schema version
  - create new tables/indexes
  - mark existing parsed/upserted revisions stale
  - perform one-time V2 reparse/re-embed after upgrade
  - keep legacy V1 data path unchanged during rollout

### Phase 3: Hybrid retrieval, reranking, and context expansion
- Add SQLite FTS-based lexical indexing for searchable text views:
  - file path
  - symbol names / qualified names
  - signatures
  - raw code
  - summary text
- Keep Qdrant for vector retrieval.
- Change `ICodeIndexEngine.search()` implementation to a staged retrieval pipeline:
  1. generate query embedding
  2. retrieve vector candidates from Qdrant
  3. retrieve lexical candidates from SQLite FTS
  4. union/deduplicate by logical chunk
  5. rerank with deterministic scoring
  6. expand top results with parent and near-neighbor chunks
- Reranking signals:
  - vector score
  - lexical score
  - exact symbol-name match
  - exact / partial path match
  - language match when query implies one
  - symbol-kind match when query implies one
  - boosted score for doc-comment/signature matches
  - slight boost for parent-child proximity when multiple hits share a file/class
- Result expansion rules:
  - if a subchunk wins, include its owning symbol chunk
  - if a method wins, optionally include enclosing class summary
  - include adjacent sibling symbols only when line-distance is near and result budget allows
- Keep current `codebase_search` tool contract initially, but enrich internal results to support future UI/tool improvements with symbol metadata and match reasons.

### Phase 4: Evaluation and tuning loop
- Add an offline evaluation harness for code retrieval quality.
- Build a fixed benchmark set from representative repo questions:
  - semantic behavior questions
  - exact symbol lookup
  - path-aware lookup
  - config/policy lookup
  - large-function / nested-class cases
- Evaluate:
  - recall@k
  - MRR / ranking quality
  - exact-hit rate for symbol/path queries
  - latency by stage
  - index size and embedding count
- Tune chunk strategy and reranking weights only through benchmark results; do not tune by intuition alone.

## Public APIs / Interfaces / Types
- Replace the current minimal parsed-chunk shape with a richer parser output type in V2 adapters.
- Extend V2 storage schema with `chunk_variants` and structured chunk metadata fields.
- Extend vector payload and search-result types to carry:
  - `language`
  - `chunkKind`
  - `symbolName`
  - `symbolQualifiedName`
  - `parentSymbolName`
  - `variantType`
  - `parentChunkFingerprint`
- Keep `ICodeIndexEngine.search(query, limit)` signature unchanged in the first rollout; enrich the returned `VectorStoreSearchResult` payload shape internally.
- Keep the existing user-facing `codebase_search` output stable in the first pass, then optionally add symbol metadata in a backward-compatible way.

## Test Plan
- Parser unit tests:
  - whole-function/class/type chunking
  - attached doc-comment capture
  - oversized function splitting at structural boundaries
  - parser failure fallback
  - JSON/YAML/TOML semantic section chunking
  - minified/generated/lockfile exclusion
- Storage and diff tests:
  - schema migration from current V2
  - stable chunk fingerprints across unchanged edits
  - expected upsert/delete behavior for changed symbols only
  - correct parent/child and variant linkage
- Retrieval tests:
  - exact symbol query beats semantically similar but wrong snippets
  - path-aware query boosts correct file subtree
  - summary-only natural-language query finds correct chunk
  - vector + lexical candidate merge deduplicates correctly
  - parent/neighbor expansion returns coherent context without flooding results
- Integration tests:
  - end-to-end reindex on schema upgrade
  - targeted update only reindexes touched files/chunks
  - `codebase_search` still returns valid results during/after migration
  - indexing latency and memory remain within current operational guardrails

## Assumptions
- V2 is the only implementation target for this redesign.
- Deterministic summaries are the default and the only required summary mechanism in the main roadmap.
- SQLite FTS is acceptable as the lexical search layer because the repo already uses local SQLite metadata storage.
- Qdrant remains the vector store.
- A one-time V2 reindex on schema upgrade is acceptable.
- Legacy V1 parser/search behavior can remain as-is until V2 is fully validated.
