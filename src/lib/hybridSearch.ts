import type { Pool, PoolClient } from 'pg';
import { withTenant, getPool } from './db';
import { ValidationError } from './errors';
import { reciprocalRankFusion, DEFAULT_RRF_K } from './rrf';
import { assertTenantId } from './tenant';

export const EMBEDDING_DIMENSIONS = 1536;
const MAX_TOP_K = 50;

export interface ChunkRow {
  chunkId: string;
  documentId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
}

export interface SearchResult extends ChunkRow {
  /** RRF score (higher is better). */
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

export interface HybridSearchOptions {
  /** Raw query text for the full-text leg. Without it only vector search runs. */
  queryText?: string;
  /** How many candidates each leg fetches before fusion. Defaults to max(4 * topK, 20). */
  candidateK?: number;
  rrfK?: number;
  db?: Pool;
}

// Both queries filter on tenant_id explicitly as well as relying on RLS:
// the WHERE clause lets the planner use the tenant index, and RLS is the
// backstop if someone edits a query and forgets the filter.

const VECTOR_SQL = `
  SELECT c.id          AS "chunkId",
         c.document_id AS "documentId",
         d.filename,
         c.page_number AS "pageNumber",
         c.chunk_index AS "chunkIndex",
         c.content
  FROM (
    -- Keep the ANN search in its own subquery so the planner uses the HNSW
    -- index; join for metadata afterwards and re-apply the order.
    SELECT id, document_id, page_number, chunk_index, content,
           embedding <=> $2::vector AS distance
    FROM document_chunks
    WHERE tenant_id = $1
    ORDER BY distance
    LIMIT $3
  ) c
  JOIN documents d ON d.id = c.document_id AND d.tenant_id = $1
  ORDER BY c.distance, c.id
`;

const KEYWORD_SQL = `
  SELECT c.id          AS "chunkId",
         c.document_id AS "documentId",
         d.filename,
         c.page_number AS "pageNumber",
         c.chunk_index AS "chunkIndex",
         c.content
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id AND d.tenant_id = $1,
       websearch_to_tsquery('english', $2) q
  WHERE c.tenant_id = $1
    AND c.content_tsv @@ q
  ORDER BY ts_rank_cd(c.content_tsv, q) DESC, c.id
  LIMIT $3
`;

/**
 * Hybrid retrieval: pgvector ANN + Postgres full-text search, fused with RRF.
 * Returns the top `topK` chunks for the tenant, best first.
 */
export async function hybridSearch(
  tenantId: string,
  queryEmbedding: number[],
  topK: number,
  options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  // Fail closed before we touch the pool.
  assertTenantId(tenantId);
  validateEmbedding(queryEmbedding);
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new ValidationError(`topK must be an integer between 1 and ${MAX_TOP_K}`);
  }

  const candidateK = options.candidateK ?? Math.max(topK * 4, 20);
  const queryText = options.queryText?.trim() ?? '';
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  const [vectorHits, keywordHits] = await withTenant(
    tenantId,
    async (client: PoolClient) => {
      // Let HNSW keep scanning when the tenant filter discards most neighbours
      // (pgvector >= 0.8). Without this, a small tenant in a big table can get
      // fewer than candidateK rows back.
      await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      await client.query('SET LOCAL hnsw.ef_search = 100');

      // Sequential on purpose: one pg client can only run one query at a time.
      const vector = await client.query<ChunkRow>(VECTOR_SQL, [tenantId, vectorLiteral, candidateK]);
      const keyword = queryText
        ? await client.query<ChunkRow>(KEYWORD_SQL, [tenantId, queryText, candidateK])
        : { rows: [] as ChunkRow[] };

      return [vector.rows, keyword.rows] as const;
    },
    options.db ?? getPool(),
  );

  return reciprocalRankFusion([vectorHits, keywordHits], (r) => r.chunkId, options.rrfK ?? DEFAULT_RRF_K)
    .slice(0, topK)
    .map(({ item, score, ranks }) => ({
      ...item,
      score,
      vectorRank: ranks[0] ?? null,
      keywordRank: ranks[1] ?? null,
    }));
}

function validateEmbedding(embedding: unknown): asserts embedding is number[] {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new ValidationError(`queryEmbedding must be an array of ${EMBEDDING_DIMENSIONS} numbers`);
  }
  if (!embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new ValidationError('queryEmbedding contains non-finite values');
  }
}
