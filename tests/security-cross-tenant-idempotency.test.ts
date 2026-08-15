/**
 * Phase 8.1 security — cross-tenant idempotency lookup fails closed. If a
 * lock row ever existed under a key an attacker guessed/reused but it
 * belongs to a different user, the lookup must never hand back that other
 * tenant's execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeLocksTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.idempotency_key === row.idempotency_key);
    if (conflict) return { then: (resolve: (v: { error: { code: string } }) => unknown) => Promise.resolve(resolve({ error: { code: '23505' } })) };
    this.rows.push({ ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const m = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: m ? { ...m } : null, error: null };
      },
    };
    return api;
  }
}

class FakeExecTable {
  constructor(private rows: Row[]) {}
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const m = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: m ? { ...m } : null, error: null };
      },
    };
    return api;
  }
}

let locksRows: Row[];
let execRows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => (name === 'runtime_execution_locks' ? new FakeLocksTable(locksRows) : new FakeExecTable(execRows)),
  })),
}));

beforeEach(() => { locksRows = []; execRows = []; });

describe('cross-tenant idempotency lookup fails closed', () => {
  it('if a lock row belongs to a different user than the requester, the lookup returns null rather than another tenant\'s execution', async () => {
    locksRows.push({ execution_id: 'victim-exec', idempotency_key: 'guessed-key' });
    execRows.push({ id: 'victim-exec', user_id: 'victim-user', status: 'running' });

    const { reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    const result = await reserveIdempotencyKey({
      executionId: 'attacker-exec', userId: 'attacker-user', workflowId: 'wf-attacker', idempotencyKey: 'guessed-key',
    });

    expect(result.isDuplicate).toBe(true);
    if (!result.isDuplicate) return;
    expect(result.existing).toBeNull();
  });
});
