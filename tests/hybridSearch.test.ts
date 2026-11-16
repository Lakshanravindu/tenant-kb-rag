import { ValidationError } from '../src/lib/errors';
import { hybridSearch } from '../src/lib/hybridSearch';
import { chunk, embedding, fakePool, TENANT_A } from './helpers/fakePool';

describe('hybridSearch', () => {
  it('fuses vector and keyword results with RRF and returns document metadata', async () => {
    const db = fakePool({
      vector: [chunk('a', { filename: 'handbook.pdf', pageNumber: 3 }), chunk('b'), chunk('c')],
      keyword: [chunk('c'), chunk('a', { filename: 'handbook.pdf', pageNumber: 3 }), chunk('d')],
    });

    const results = await hybridSearch(TENANT_A, embedding(), 3, { queryText: 'annual leave', db: db.pool });

    expect(results.map((r) => r.chunkId)).toEqual(['a', 'c', 'b']);
    expect(results[0]).toMatchObject({
      chunkId: 'a',
      filename: 'handbook.pdf',
      pageNumber: 3,
      vectorRank: 1,
      keywordRank: 2,
    });
    expect(results[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(results[2]).toMatchObject({ chunkId: 'b', vectorRank: 2, keywordRank: null });
  });

  it('returns at most topK results', async () => {
    const db = fakePool({ vector: ['a', 'b', 'c', 'd', 'e'].map((id) => chunk(id)) });
    const results = await hybridSearch(TENANT_A, embedding(), 2, { db: db.pool });
    expect(results).toHaveLength(2);
  });

  it('passes the embedding as a pgvector literal and a widened candidate pool', async () => {
    const db = fakePool();
    await hybridSearch(TENANT_A, embedding(0.5), 5, { queryText: 'q', db: db.pool });

    const vectorCall = db.query.mock.calls.find(([sql]) => sql.includes('embedding <=>'))!;
    const [, vectorLiteral, limit] = vectorCall[1]!;
    expect(vectorLiteral).toMatch(/^\[0\.5(,0\.5){1535}\]$/);
    expect(limit).toBe(20);
  });

  it('skips the keyword query when there is no query text', async () => {
    const db = fakePool({ vector: [chunk('a')] });
    await hybridSearch(TENANT_A, embedding(), 5, { queryText: '   ', db: db.pool });
    expect(db.sqlCalls().some((sql) => sql.includes('websearch_to_tsquery'))).toBe(false);
  });

  it('returns an empty list when nothing matches', async () => {
    const db = fakePool();
    await expect(hybridSearch(TENANT_A, embedding(), 5, { queryText: 'q', db: db.pool })).resolves.toEqual([]);
  });

  it.each([
    ['wrong dimension', [0.1, 0.2]],
    ['non-finite values', [...embedding().slice(1), Number.NaN]],
  ])('rejects an embedding with %s', async (_label, emb) => {
    const db = fakePool();
    await expect(hybridSearch(TENANT_A, emb, 5, { db: db.pool })).rejects.toBeInstanceOf(ValidationError);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 51])('rejects topK = %p', async (topK) => {
    const db = fakePool();
    await expect(hybridSearch(TENANT_A, embedding(), topK, { db: db.pool })).rejects.toBeInstanceOf(ValidationError);
  });

  it('propagates database errors after rolling back', async () => {
    const db = fakePool({ failOn: /websearch_to_tsquery/ });
    await expect(hybridSearch(TENANT_A, embedding(), 5, { queryText: 'q', db: db.pool })).rejects.toThrow('boom');
    expect(db.sqlCalls()).toContain('ROLLBACK');
    expect(db.release).toHaveBeenCalled();
  });
});
