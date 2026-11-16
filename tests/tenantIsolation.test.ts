jest.mock('pg', () => ({ Pool: jest.fn() }));

import { Pool } from 'pg';
import { withTenant } from '../src/lib/db';
import { UnauthorizedError } from '../src/lib/errors';
import { hybridSearch } from '../src/lib/hybridSearch';
import { createChatHandler, type ChatDeps } from '../src/server/chatHandler';
import { chunk, embedding, fakePool, TENANT_A, TENANT_B } from './helpers/fakePool';

const badTenantIds: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['empty string', ''],
  ['whitespace', '   '],
  ['a number', 42],
  ['a non-uuid string', 'tenant-a'],
  ['a SQL injection attempt', "x' OR '1'='1"],
];

describe('tenant isolation', () => {
  describe('hybridSearch', () => {
    it.each(badTenantIds)('throws UnauthorizedError for %s before touching the database', async (_label, tenantId) => {
      const db = fakePool();

      await expect(
        hybridSearch(tenantId as string, embedding(), 5, { queryText: 'q', db: db.pool }),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      expect(db.connect).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('does not even create the default connection pool when tenantId is missing', async () => {
      await expect(hybridSearch(undefined as unknown as string, embedding(), 5)).rejects.toThrow(UnauthorizedError);
      expect(Pool).not.toHaveBeenCalled();
    });

    it('checks the tenant before validating other arguments', async () => {
      const db = fakePool();
      // Bad embedding AND missing tenant -> the auth error must win.
      await expect(hybridSearch('', [1, 2, 3], 0, { db: db.pool })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('binds the tenant to the transaction and scopes every query to it', async () => {
      const db = fakePool({ vector: [chunk('a')], keyword: [chunk('a')] });

      await hybridSearch(TENANT_A, embedding(), 5, { queryText: 'leave policy', db: db.pool });

      const calls = db.query.mock.calls;
      expect(calls[0]![0]).toBe('BEGIN READ ONLY');
      expect(calls[1]).toEqual(["SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]]);

      const searchCalls = calls.filter(([sql]) => /document_chunks/.test(sql));
      expect(searchCalls).toHaveLength(2);
      for (const [sql, params] of searchCalls) {
        expect(sql).toMatch(/c?\.?tenant_id = \$1/);
        expect(params![0]).toBe(TENANT_A);
      }
      expect(calls.at(-1)![0]).toBe('COMMIT');
      expect(db.release).toHaveBeenCalledTimes(1);
    });

    it('uses a fresh tenant binding per call so tenants never share state', async () => {
      const db = fakePool();

      await hybridSearch(TENANT_A, embedding(), 3, { db: db.pool });
      await hybridSearch(TENANT_B, embedding(), 3, { db: db.pool });

      const bindings = db.query.mock.calls
        .filter(([sql]) => sql.includes('set_config'))
        .map(([, params]) => params![0]);
      expect(bindings).toEqual([TENANT_A, TENANT_B]);
    });
  });

  describe('withTenant', () => {
    it.each(badTenantIds)('rejects %s without acquiring a connection', async (_label, tenantId) => {
      const db = fakePool();
      const fn = jest.fn();

      await expect(withTenant(tenantId as string, fn, db.pool)).rejects.toBeInstanceOf(UnauthorizedError);

      expect(db.connect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });

    it('rolls back and releases the connection if the work fails', async () => {
      const db = fakePool();

      await expect(
        withTenant(TENANT_A, async () => {
          throw new Error('query failed');
        }, db.pool),
      ).rejects.toThrow('query failed');

      expect(db.sqlCalls()).toContain('ROLLBACK');
      expect(db.sqlCalls()).not.toContain('COMMIT');
      expect(db.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/chat', () => {
    function deps() {
      return {
        anthropic: { beta: { messages: { stream: jest.fn() } } },
        embedder: { embed: jest.fn() },
        search: jest.fn(),
        model: 'test-model',
      };
    }

    function post(body: unknown) {
      return new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it.each([
      ['missing', { question: 'What is the leave policy?' }],
      ['empty', { tenantId: '', question: 'What is the leave policy?' }],
      ['malformed', { tenantId: 'acme', question: 'What is the leave policy?' }],
    ])('returns 401 when tenantId is %s, without embedding, searching or calling Claude', async (_label, body) => {
      const d = deps();
      const handler = createChatHandler(() => d as unknown as ChatDeps);

      const res = await handler(post(body));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(d.embedder.embed).not.toHaveBeenCalled();
      expect(d.search).not.toHaveBeenCalled();
      expect(d.anthropic.beta.messages.stream).not.toHaveBeenCalled();
    });

    it('returns 401 (not 400) when both tenantId and question are missing', async () => {
      const d = deps();
      const res = await createChatHandler(() => d as unknown as ChatDeps)(post({}));
      expect(res.status).toBe(401);
    });
  });
});
