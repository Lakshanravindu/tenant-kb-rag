import { UnauthorizedError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Guard used at every entry point that touches tenant data.
 * Anything that is not a well-formed tenant id is treated as unauthenticated;
 * we deliberately don't tell the caller which check failed.
 */
export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new UnauthorizedError('Missing tenantId');
  }
  if (!UUID_RE.test(tenantId)) {
    throw new UnauthorizedError('Invalid tenantId');
  }
}
