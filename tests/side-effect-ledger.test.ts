/**
 * Phase 9.9.11 -- Part D: durable side-effect ledger
 * (lib/runtime/side-effect-ledger.ts).
 *
 * IMPORTANT: this module is NOT yet wired into the live execution path,
 * and its migration (supabase/migrations/20260916170907_add_workflow_side_effects_ledger.sql)
 * has NOT been applied to production -- see the Phase 9.9.11 report. These
 * tests prove the module's OWN logic is correct against a mocked DB
 * (matching tests/idempotency.test.ts's established convention for the
 * exact same insert-and-catch-23505 CAS pattern) so it is ready to review
 * and wire in once the migration is approved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeSideEffectsTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string; message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505', message: 'duplicate key' } })) };
    }
    this.rows.push({ id: `ledger-${this.rows.length + 1}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: match ? { ...match } : null, error: null };
      },
    };
    return api;
  }
  update(patch: Row) {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      select() { return api; },
      async maybeSingle() {
        const idx = rows.findIndex((r) => filters.every(([c, v]) => r[c] === v));
        if (idx < 0) return { data: null, error: null };
        Object.assign(rows[idx], patch);
        return { data: { ...rows[idx] }, error: null };
      },
      // update(...).eq(...) with no further chain (recordSideEffectOutcome) --
      // resolves like a thenable once all filters are applied.
      then(resolve: (v: { error: null }) => unknown) {
        for (const row of rows) {
          if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, patch);
        }
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return api;
  }
}

let rows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === 'workflow_side_effects') return new FakeSideEffectsTable(rows);
      throw new Error(`unexpected table ${name}`);
    },
  })),
}));

beforeEach(() => {
  rows = [];
});

describe('claimSideEffect', () => {
  it('the first claim for a (execution, node) pair succeeds', async () => {
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
  });

  it('a concurrent second claim for the SAME pair, while the first is still in_progress, is never granted', async () => {
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    const second = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.existing.status).toBe('in_progress');
  });

  it('a row already "succeeded" is never re-claimed -- the caller must short-circuit instead of calling the provider again', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', status: 'succeeded', attempts: 1, provider_ref: { id: 'recABC' }, last_error: null });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(false);
    if (result.claimed) return;
    expect(result.existing.status).toBe('succeeded');
    expect(result.existing.providerRef).toEqual({ id: 'recABC' });
  });

  it('a row already "indeterminate" is never re-claimed -- never blindly retried', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', status: 'indeterminate', attempts: 1, provider_ref: null, last_error: 'timeout' });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(false);
  });

  it('a row previously "failed" (known never to have reached the provider) CAN be re-claimed for a safe retry', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', status: 'failed', attempts: 1, provider_ref: null, last_error: 'validation error' });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(true);
    expect(rows.find((r) => r.id === 'x')?.status).toBe('in_progress');
    expect(rows.find((r) => r.id === 'x')?.attempts).toBe(2);
  });

  it('two concurrent claims racing to re-claim a "failed" row: only one wins', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', status: 'failed', attempts: 1, provider_ref: null, last_error: 'e' });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const [a, b] = await Promise.all([
      claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' }),
      claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' }),
    ]);
    const claimedCount = [a, b].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);
  });
});

describe('recordSideEffectOutcome + getSideEffectStatus', () => {
  it('records a succeeded outcome with the provider reference', async () => {
    const { claimSideEffect, recordSideEffectOutcome, getSideEffectStatus } = await import('../lib/runtime/side-effect-ledger');
    await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    await recordSideEffectOutcome({ executionId: 'exec1', nodeId: 'node1', status: 'succeeded', providerRef: { id: 'recABC' } });

    const status = await getSideEffectStatus({ executionId: 'exec1', nodeId: 'node1' });
    expect(status?.status).toBe('succeeded');
    expect(status?.providerRef).toEqual({ id: 'recABC' });
  });

  it('records an indeterminate outcome with the error, never a provider reference', async () => {
    const { claimSideEffect, recordSideEffectOutcome, getSideEffectStatus } = await import('../lib/runtime/side-effect-ledger');
    await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'gmail_send' });
    await recordSideEffectOutcome({ executionId: 'exec1', nodeId: 'node1', status: 'indeterminate', error: 'timeout waiting for response' });

    const status = await getSideEffectStatus({ executionId: 'exec1', nodeId: 'node1' });
    expect(status?.status).toBe('indeterminate');
    expect(status?.lastError).toBe('timeout waiting for response');
  });

  it('getSideEffectStatus returns null for an execution/node with no ledger row at all', async () => {
    const { getSideEffectStatus } = await import('../lib/runtime/side-effect-ledger');
    expect(await getSideEffectStatus({ executionId: 'no-such-exec', nodeId: 'node1' })).toBeNull();
  });
});

describe('tenant isolation via composite scoping', () => {
  it('the same node_id under two different executions never collides', async () => {
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const a = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec-A', nodeId: 'node1', effectType: 'airtable_create' });
    const b = await claimSideEffect({ userId: 'u2', workflowId: 'wf2', executionId: 'exec-B', nodeId: 'node1', effectType: 'airtable_create' });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true); // different execution_id -- not a collision
    expect(rows).toHaveLength(2);
  });
});
