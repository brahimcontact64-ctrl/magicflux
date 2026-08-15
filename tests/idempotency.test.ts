/**
 * Phase 8.1 — Provider-native trigger idempotency.
 *
 * Covers lib/runtime/idempotency.ts: key derivation priority (Shopify
 * delivery ID > generic Idempotency-Key header > payload hash fallback),
 * and reserveIdempotencyKey()'s atomic DB-unique-constraint-backed
 * dedup (insert-and-catch-23505, not check-then-insert).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeLocksTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.idempotency_key === row.idempotency_key);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505' } })) };
    }
    this.rows.push({ ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: match ? { ...match } : null, error: null };
      },
    };
    return api;
  }
  delete() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      then(resolve: (v: { error: null }) => unknown) {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every(([c, v]) => rows[i][c] === v)) rows.splice(i, 1);
        }
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return api;
  }
}

class FakeExecutionsTable {
  constructor(private rows: Row[]) {}
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: match ? { ...match } : null, error: null };
      },
    };
    return api;
  }
}

let locksRows: Row[];
let execRows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === 'runtime_execution_locks') return new FakeLocksTable(locksRows);
      if (name === 'workflow_executions_v2') return new FakeExecutionsTable(execRows);
      throw new Error(`unexpected table ${name}`);
    },
  })),
}));

beforeEach(() => {
  locksRows = [];
  execRows = [];
});

// ─── Key derivation ──────────────────────────────────────────────────────────

function headerMap(entries: Record<string, string>) {
  return { get: (name: string) => entries[name.toLowerCase()] ?? null };
}

describe('deriveWebhookIdempotencyKey', () => {
  it('uses the Shopify webhook ID when present, regardless of other headers', async () => {
    const { deriveWebhookIdempotencyKey } = await import('../lib/runtime/idempotency');
    const result = deriveWebhookIdempotencyKey({
      workflowId: 'wf-1',
      rawBody: '{"a":1}',
      headers: headerMap({ 'x-shopify-webhook-id': 'shopify-evt-123', 'idempotency-key': 'generic-999' }),
    });
    expect(result.source).toBe('shopify_webhook_id');
    expect(result.key).toBe('webhook:wf-1:shopify:shopify-evt-123');
  });

  it('falls back to a generic Idempotency-Key header when no Shopify ID is present', async () => {
    const { deriveWebhookIdempotencyKey } = await import('../lib/runtime/idempotency');
    const result = deriveWebhookIdempotencyKey({
      workflowId: 'wf-1',
      rawBody: '{"a":1}',
      headers: headerMap({ 'idempotency-key': 'generic-999' }),
    });
    expect(result.source).toBe('idempotency_key_header');
    expect(result.key).toBe('webhook:wf-1:idem:generic-999');
  });

  it('falls back to a deterministic payload hash when no event ID is available', async () => {
    const { deriveWebhookIdempotencyKey } = await import('../lib/runtime/idempotency');
    const r1 = deriveWebhookIdempotencyKey({ workflowId: 'wf-1', rawBody: '{"a":1}', headers: headerMap({}) });
    const r2 = deriveWebhookIdempotencyKey({ workflowId: 'wf-1', rawBody: '{"a":1}', headers: headerMap({}) });
    const r3 = deriveWebhookIdempotencyKey({ workflowId: 'wf-1', rawBody: '{"a":2}', headers: headerMap({}) });
    expect(r1.source).toBe('payload_hash');
    expect(r1.key).toBe(r2.key); // same body → same key, deterministic
    expect(r1.key).not.toBe(r3.key); // different body → different key
  });

  it('the same raw Shopify event ID produces different keys for two different workflows', async () => {
    const { deriveWebhookIdempotencyKey } = await import('../lib/runtime/idempotency');
    const wfA = deriveWebhookIdempotencyKey({ workflowId: 'wf-A', rawBody: '{}', headers: headerMap({ 'x-shopify-webhook-id': 'evt-1' }) });
    const wfB = deriveWebhookIdempotencyKey({ workflowId: 'wf-B', rawBody: '{}', headers: headerMap({ 'x-shopify-webhook-id': 'evt-1' }) });
    expect(wfA.key).not.toBe(wfB.key);
  });
});

// ─── Atomic reservation ──────────────────────────────────────────────────────

describe('reserveIdempotencyKey — atomic DB-unique-constraint-backed dedup', () => {
  it('the first reservation for a key succeeds (not a duplicate)', async () => {
    const { reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    const result = await reserveIdempotencyKey({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'key-a' });
    expect(result.isDuplicate).toBe(false);
  });

  it('the same event arriving twice: the second call is reported as a duplicate of the first execution', async () => {
    const { reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    await reserveIdempotencyKey({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'key-a' });
    execRows.push({ id: 'exec-1', user_id: 'user-1', status: 'running' });

    const second = await reserveIdempotencyKey({ executionId: 'exec-2', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'key-a' });
    expect(second.isDuplicate).toBe(true);
    if (!second.isDuplicate) return;
    expect(second.existing?.executionId).toBe('exec-1');
    expect(second.existing?.status).toBe('running');
  });

  it('the same raw event ID reserved by two different users (via distinct composite keys) never collides', async () => {
    const { deriveWebhookIdempotencyKey, reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    // Two different users' workflows both received Shopify event "evt-1" —
    // the workflow ID (unique per row, one user each) makes the composite keys distinct.
    const keyForUserA = deriveWebhookIdempotencyKey({ workflowId: 'wf-user-a', rawBody: '{}', headers: headerMap({ 'x-shopify-webhook-id': 'evt-1' }) });
    const keyForUserB = deriveWebhookIdempotencyKey({ workflowId: 'wf-user-b', rawBody: '{}', headers: headerMap({ 'x-shopify-webhook-id': 'evt-1' }) });

    const resultA = await reserveIdempotencyKey({ executionId: 'exec-user-a', userId: 'user-a', workflowId: 'wf-user-a', idempotencyKey: keyForUserA.key });
    const resultB = await reserveIdempotencyKey({ executionId: 'exec-user-b', userId: 'user-b', workflowId: 'wf-user-b', idempotencyKey: keyForUserB.key });

    expect(resultA.isDuplicate).toBe(false);
    expect(resultB.isDuplicate).toBe(false); // NOT treated as a duplicate of user A's execution
    expect(locksRows).toHaveLength(2);
  });

  it('the same raw event ID on two different workflows for the same user never collides', async () => {
    const { deriveWebhookIdempotencyKey, reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    const keyWfA = deriveWebhookIdempotencyKey({ workflowId: 'wf-1', rawBody: '{}', headers: headerMap({ 'idempotency-key': 'shared-evt' }) });
    const keyWfB = deriveWebhookIdempotencyKey({ workflowId: 'wf-2', rawBody: '{}', headers: headerMap({ 'idempotency-key': 'shared-evt' }) });

    const resultA = await reserveIdempotencyKey({ executionId: 'exec-a', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: keyWfA.key });
    const resultB = await reserveIdempotencyKey({ executionId: 'exec-b', userId: 'user-1', workflowId: 'wf-2', idempotencyKey: keyWfB.key });

    expect(resultA.isDuplicate).toBe(false);
    expect(resultB.isDuplicate).toBe(false);
  });

  it('two concurrent reservation attempts for the SAME key: only one succeeds (atomic insert, not check-then-insert)', async () => {
    const { reserveIdempotencyKey } = await import('../lib/runtime/idempotency');
    execRows.push({ id: 'exec-1', user_id: 'user-1', status: 'running' });

    const [a, b] = await Promise.all([
      reserveIdempotencyKey({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'race-key' }),
      reserveIdempotencyKey({ executionId: 'exec-2', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'race-key' }),
    ]);
    const duplicateCount = [a, b].filter((r) => r.isDuplicate).length;
    expect(duplicateCount).toBe(1);
  });

  it('releaseIdempotencyKey removes the reservation so a retried event is accepted as new, not a phantom duplicate', async () => {
    const { reserveIdempotencyKey, releaseIdempotencyKey } = await import('../lib/runtime/idempotency');
    await reserveIdempotencyKey({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'release-key' });
    expect(locksRows).toHaveLength(1);

    await releaseIdempotencyKey({ executionId: 'exec-1', userId: 'user-1' });
    expect(locksRows).toHaveLength(0);

    const retried = await reserveIdempotencyKey({ executionId: 'exec-2', userId: 'user-1', workflowId: 'wf-1', idempotencyKey: 'release-key' });
    expect(retried.isDuplicate).toBe(false);
  });
});
