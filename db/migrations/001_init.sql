-- 001_init.sql
-- Documents + chunks for the multi-tenant knowledge base.
-- Requires PostgreSQL 15+ and pgvector 0.8+ (for hnsw.iterative_scan).

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PG < 13

-- The application connects as kb_app. It must NOT own the tables and must not
-- have BYPASSRLS, otherwise row level security is silently skipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_app') THEN
    CREATE ROLE kb_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Returns the tenant bound to the current transaction, or NULL.
-- current_setting(..., true) yields '' (not NULL) once a SET LOCAL has been
-- reset on a pooled connection, so normalise that before the uuid cast.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  filename     text        NOT NULL CHECK (length(filename) BETWEEN 1 AND 512),
  mime_type    text,
  page_count   integer     CHECK (page_count IS NULL OR page_count > 0),
  checksum     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Target for the composite FK below.
  CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Avoid ingesting the same file twice for a tenant.
  CONSTRAINT documents_tenant_checksum_key UNIQUE (tenant_id, checksum)
);

CREATE INDEX documents_tenant_created_idx ON documents (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- document_chunks
-- ---------------------------------------------------------------------------
CREATE TABLE document_chunks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  document_id  uuid        NOT NULL,
  chunk_index  integer     NOT NULL CHECK (chunk_index >= 0),
  page_number  integer     NOT NULL CHECK (page_number > 0),
  content      text        NOT NULL,
  token_count  integer,
  embedding    vector(1536) NOT NULL,
  content_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Composite FK: a chunk can only point at a document of the SAME tenant.
  CONSTRAINT document_chunks_document_fk
    FOREIGN KEY (tenant_id, document_id)
    REFERENCES documents (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT document_chunks_doc_chunk_key UNIQUE (document_id, chunk_index)
);

-- Approximate nearest neighbour search on cosine distance.
CREATE INDEX document_chunks_embedding_hnsw_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full text search.
CREATE INDEX document_chunks_content_tsv_gin_idx
  ON document_chunks USING gin (content_tsv);

-- Tenant scoping / FK lookups.
CREATE INDEX document_chunks_tenant_document_idx
  ON document_chunks (tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
ALTER TABLE documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents       FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE  ROW LEVEL SECURITY;

-- With no tenant set, app_current_tenant() is NULL and the comparison is never
-- true, so the default is "see nothing / write nothing".
CREATE POLICY documents_tenant_isolation ON documents
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY document_chunks_tenant_isolation ON document_chunks
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, document_chunks TO kb_app;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO kb_app;

COMMIT;
