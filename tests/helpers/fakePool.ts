import type { Pool } from 'pg';
import type { ChunkRow } from '../../src/lib/hybridSearch';

export const TENANT_A = '3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c';
export const TENANT_B = '7a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';

export function embedding(fill = 0.01): number[] {
  return new Array(1536).fill(fill);
}

export function chunk(id: string, overrides: Partial<ChunkRow> = {}): ChunkRow {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    filename: `${id}.pdf`,
    pageNumber: 1,
    chunkIndex: 0,
    content: `content of ${id}`,
    ...overrides,
  };
}

/**
 * Minimal stand-in for pg.Pool. Routes queries by their SQL so tests can
 * control what each search leg returns, and records every call.
 */
export function fakePool(opts: { vector?: ChunkRow[]; keyword?: ChunkRow[]; failOn?: RegExp } = {}) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (opts.failOn?.test(sql)) throw new Error('boom');
    if (sql.includes('embedding <=>')) return { rows: opts.vector ?? [] };
    if (sql.includes('websearch_to_tsquery')) return { rows: opts.keyword ?? [] };
    return { rows: [] };
  });
  const release = jest.fn();
  const connect = jest.fn(async () => ({ query, release }));

  return {
    pool: { connect } as unknown as Pool,
    connect,
    query,
    release,
    sqlCalls: () => query.mock.calls.map(([sql]) => sql.trim()),
  };
}
