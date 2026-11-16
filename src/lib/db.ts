import { Pool, type PoolClient } from 'pg';
import { assertTenantId } from './tenant';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }
  return pool;
}

/**
 * Runs `fn` inside a transaction bound to a single tenant.
 *
 * `set_config(..., true)` is the parameterised form of SET LOCAL, so the
 * tenant id lives only for this transaction and can't leak to the next
 * request that borrows the same pooled connection. RLS policies read it via
 * app_current_tenant().
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  db: Pool = getPool(),
): Promise<T> {
  assertTenantId(tenantId);

  const client = await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
