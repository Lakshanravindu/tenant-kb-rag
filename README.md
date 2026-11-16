# tenant-kb-rag

Backend module for a multi-tenant knowledge base. Tenants upload internal documents; users ask questions and get answers streamed from Claude, grounded **only** in their own tenant's document chunks, with inline citations like `(Doc: handbook.pdf, p.4)`.

```
db/migrations/001_init.sql     Postgres schema: pgvector, tables, RLS, HNSW + GIN indexes
src/lib/rrf.ts                 Reciprocal Rank Fusion (pure, generic)
src/lib/hybridSearch.ts        hybridSearch(): vector + full-text search, fused with RRF
src/lib/db.ts                  withTenant(): per-transaction tenant binding for RLS
src/lib/tenant.ts              tenantId guard (throws UnauthorizedError)
src/lib/prompt.ts              Grounded system prompt builder
src/lib/citations.ts           Citation parser / validator
src/server/chatHandler.ts      POST /api/chat logic (SSE streaming)
app/api/chat/route.ts          Next.js App Router binding
tests/                         Jest tests
```

## Running it

```bash
npm install
npm test             # unit tests, no DB or API keys needed
npm run typecheck

# against a real database
psql "$ADMIN_DATABASE_URL" -f db/migrations/001_init.sql
cp .env.example .env # DATABASE_URL must use the kb_app role
npm run dev
```

```bash
curl -N -X POST localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"tenantId":"3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c","question":"How many days of annual leave do I get?"}'
```

Requirements: Node 20+, PostgreSQL 15+, pgvector 0.8+.

## Design decisions

### 1. Tenant isolation is enforced in three layers

1. **App guard:** `assertTenantId()` runs before anything else in `hybridSearch`, `withTenant` and the route. A missing or malformed id throws `UnauthorizedError` (401) before a DB connection is taken. It is checked before other validation, so an unauthenticated caller learns nothing else about the request.
2. **Explicit filter:** every query has `WHERE tenant_id = $1`. This is also what lets the planner use the tenant indexes.
3. **Row Level Security:** this is the backstop if someone writes a query and forgets the filter.
   - `withTenant()` opens a transaction and calls `set_config('app.tenant_id', $1, true)`, the parameterised form of `SET LOCAL`.
   - Policies compare `tenant_id` with `app_current_tenant()`.
   - The setting is transaction-scoped, so it can't leak to the next request that reuses the same pooled connection.
   - With no tenant set, the policy sees `NULL` and returns zero rows. The default is fail-closed.

Two details that make RLS actually work:
- **`FORCE ROW LEVEL SECURITY`, plus a separate `kb_app` role that doesn't own the tables.** Table owners and superusers bypass RLS otherwise.
- **`NULLIF(current_setting(...), '')`.** After a `SET LOCAL` is reset, a pooled connection reports `''` rather than `NULL`, and `''::uuid` would throw.

`document_chunks` has a **composite FK `(tenant_id, document_id) → documents(tenant_id, id)`**, so a chunk can never be attached to another tenant's document, even by a buggy ingestion job.

### 2. Schema and indexes

- `embedding vector(1536)` with an **HNSW** index (`vector_cosine_ops`, m=16, ef_construction=64).
  - HNSW was chosen over IVFFlat because it needs no training step and recall doesn't degrade as data is added.
- `content_tsv` is a **generated** `tsvector` column with a **GIN** index, so it can never get out of sync with `content`.
- `page_number` is stored on each chunk, because citations are per page.

**Filtered ANN caveat:** HNSW finds the nearest neighbours first and applies `WHERE tenant_id = …` afterwards. For a small tenant in a large table, most neighbours get filtered out and you can get back fewer rows than asked for. The search sets `hnsw.iterative_scan = relaxed_order` (pgvector 0.8), which keeps scanning until the limit is met. At larger scale, the options are partitioning by tenant (`PARTITION BY HASH (tenant_id)`) or a separate index per large tenant.

### 3. Hybrid search + RRF

- **Two retrieval legs.**
  - Vector search catches paraphrases.
  - Full-text search (`websearch_to_tsquery` + `ts_rank_cd`) catches exact terms that embeddings handle poorly: policy codes, product names, error numbers.
- **Each leg fetches `max(4·topK, 20)` candidates**, then the two lists are fused down to `topK`.
- **Why RRF:** `score = Σ 1/(k + rank)` with `k = 60`.
  - It only uses ranks. Cosine distance and `ts_rank` are on different scales, and RRF needs no normalisation or weight tuning.
  - A chunk ranked well by *both* retrievers beats one that only one retriever liked.
- **Determinism:** ties are broken by best individual rank, then by id, so results are stable and testable. Duplicate ids within one list count once.
- **Signature change:** `hybridSearch(tenantId, queryEmbedding, topK, { queryText })`. The brief's signature has no query text, but keyword search can't run on an embedding, so the raw text is a fourth (options) argument. Without it, only the vector leg runs.
- **Same transaction:** both legs run sequentially in one read-only transaction on one connection. A `pg` client can't run queries in parallel anyway, and it keeps both legs under the same tenant binding.

### 4. Streaming endpoint

`POST /api/chat` with body `{ tenantId, question }`. It returns `text/event-stream` with these events:

| event     | data                                               |
| --------- | -------------------------------------------------- |
| `sources` | chunks used for grounding (filename, page, score)  |
| `delta`   | `{ text }` answer tokens                            |
| `done`    | `{ stopReason, citations, unknownCitations }`       |
| `error`   | `{ message }`                                       |

**Validation and retrieval happen before the stream opens.** Bad input returns a plain 400 or 401, and a retrieval failure returns 502, instead of a 200 with an error event.

**Nothing retrieved → no model call.** The route streams a fixed "not found" answer. This is cheaper, and the model gets no chance to answer from general knowledge.

**Grounding prompt:**
- Sources are wrapped in `<source filename=… page=…>` tags. The model is told to answer only from them, cite every claim in exactly `(Doc: <filename>, p.<page>)`, and say so when the answer isn't there.
- **Prompt injection:** document text is treated as data, not instructions. The prompt says so, and any `</source>` in the content is stripped so a document can't close its own tag and inject instructions.

**Citation check:** after the stream finishes, citations are parsed and compared against the retrieved chunks. Any citation that doesn't match is reported in `unknownCitations` and logged. The client can then flag it to the user, or the team can alert on it.

**Model and API settings:**
- Model: `claude-opus-5-5` (override with `CLAUDE_MODEL`).
- `effort: medium`, which suits short grounded Q&A.
- Server-side refusal fallbacks (`fallbacks: "default"`) are enabled, so a request declined by a safety classifier is retried on a fallback model instead of returning nothing.
- If the client disconnects, the request's `AbortSignal` cancels the upstream Claude call.

**Embeddings:** Claude has no embeddings API, so the question is embedded with OpenAI `text-embedding-3-small`, which outputs 1536 dimensions to match the schema. It sits behind a small `Embedder` interface. It must be the same model used at ingestion.

**Why prompt-based citations instead of Claude's native `citations` feature:**
- The brief fixes the output format as `(Doc: …, p.N)`, so the citations need to be inline in the text.
- The native feature returns structured citation blocks per document. That would be a reasonable next step if the UI wants clickable, span-level citations.

### 5. Tests

`npm test` runs 60 tests in about 2 seconds. No database or network is needed: `pg` is replaced by a fake pool that records every call.

- **`rrf.test.ts`:** exact RRF scores, fusing items found by both retrievers, a full worked ordering, custom `k`, duplicates, null ranks, deterministic tie-breaks, invalid `k`.
- **`tenantIsolation.test.ts`:**
  - A missing, empty, whitespace, non-string, non-UUID or injection-shaped `tenantId` throws `UnauthorizedError` **before** `pool.connect()` is called, and before the default pool is even constructed.
  - The auth error wins over other validation errors.
  - The tenant is bound per transaction, and every search query is parameterised with it.
  - A failed transaction rolls back.
  - The route returns 401 without calling the embedder, the search or Claude.
- **`hybridSearch.test.ts`:** fusion end to end with metadata, the `topK` cap, the pgvector literal, skipping the keyword leg, input validation, errors propagating.
- **`chatHandler.test.ts`:** SSE event sequence, prompt contents, citation validation, the no-context path, 400/502 responses, a mid-stream failure.
- **`prompt.test.ts`:** citation formatting and parsing, prompt escaping.

## Not done / next steps

- **`tenantId` should come from auth, not the request body.** It is taken from the body because the brief specifies it. In production it must come from the verified session or JWT claims, and the body field should be dropped.
- **Ingestion is out of scope:** parsing, page-aware chunking and embedding batches are not built.
- **Integration tests** against a real Postgres + pgvector, for example with Testcontainers, so the RLS policies are exercised by real SQL rather than a fake pool.
- **Further work:**
  - Rate limiting per tenant.
  - Prompt caching on the instructions block.
  - A re-ranker (e.g. a cross-encoder) between RRF and generation.
  - Multi-turn conversation history.
