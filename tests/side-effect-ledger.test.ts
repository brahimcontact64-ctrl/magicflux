/**
 * Phase 9.9.11A -- Part D: durable side-effect ledger
 * (lib/runtime/side-effect-ledger.ts), now wired into the live execution
 * path (see tests/node-runner-side-effect-ledger.test.ts for the
 * end-to-end NodeRunner integration).
 *
 * Canonical key: (execution_id, node_id, effect_key) -- widened from the
 * Phase 9.9.11 draft's (execution_id, node_id) during the Part 1 safety
 * review, since a future node performing more than one distinct external
 * effect needs each independently claimable. Every current call site uses
 * DEFAULT_EFFECT_KEY ("primary").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

class FakeSideEffectsTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id && r.effect_key === row.effect_key);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string; message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505', message: 'duplicate key' } })) };
    }
    this.rows.push({ id: `ledger-${this.rows.length + 1}`, updated_at: nowIso(), ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    let ltefilter: [string, unknown] | null = null;
    let limitN: number | null = null;
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      lte(col: string, val: unknown) { ltefilter = [col, val]; return api; },
      limit(n: number) { limitN = n; return api; },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: match ? { ...match } : null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        let result = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (ltefilter) result = result.filter((r) => String(r[ltefilter![0]]) <= String(ltefilter![1]));
        if (limitN !== null) result = result.slice(0, limitN);
        return Promise.resolve(resolve({ data: result.map((r) => ({ ...r })), error: null }));
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
  it('the first claim for a (execution, node, effect_key) triple succeeds, using DEFAULT_EFFECT_KEY when omitted', async () => {
    const { claimSideEffect, DEFAULT_EFFECT_KEY } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].effect_key).toBe(DEFAULT_EFFECT_KEY);
  });

  it('a DIFFERENT effect_key on the SAME (execution, node) is independently claimable -- proves the widened key', async () => {
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const a = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectKey: 'recipient-a', effectType: 'email_send' });
    const b = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectKey: 'recipient-b', effectType: 'email_send' });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('a concurrent second claim for the SAME triple, while the first is still in_progress, is never granted', async () => {
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    const second = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.existing.status).toBe('in_progress');
  });

  it('a row already "succeeded" is never re-claimed -- the caller must short-circuit instead of calling the provider again', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'succeeded', attempts: 1, provider_ref: { id: 'recABC' }, last_error: null, updated_at: nowIso() });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(false);
    if (result.claimed) return;
    expect(result.existing.status).toBe('succeeded');
    expect(result.existing.providerRef).toEqual({ id: 'recABC' });
  });

  it('a row already "indeterminate" is never re-claimed -- never blindly retried', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'indeterminate', attempts: 1, provider_ref: null, last_error: 'timeout', updated_at: nowIso() });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(false);
  });

  it('a row previously "failed" (known never to have reached the provider) CAN be re-claimed for a safe retry', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'failed', attempts: 1, provider_ref: null, last_error: 'validation error', updated_at: nowIso() });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(true);
    expect(rows.find((r) => r.id === 'x')?.status).toBe('in_progress');
    expect(rows.find((r) => r.id === 'x')?.attempts).toBe(2);
  });

  it('a STALE "in_progress" row (crashed prior attempt) is still NOT auto-reclaimed by claimSideEffect -- never speculatively resolved as safe-to-retry', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'in_progress', attempts: 1, provider_ref: null, last_error: null, updated_at: nowIso(-10 * 60_000) });
    const { claimSideEffect, isStaleInProgress } = await import('../lib/runtime/side-effect-ledger');
    const result = await claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' });
    expect(result.claimed).toBe(false);
    if (result.claimed) return;
    expect(isStaleInProgress(result.existing)).toBe(true);
  });

  it('two concurrent claims racing to re-claim a "failed" row: only one wins', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'failed', attempts: 1, provider_ref: null, last_error: 'e', updated_at: nowIso() });
    const { claimSideEffect } = await import('../lib/runtime/side-effect-ledger');
    const [a, b] = await Promise.all([
      claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' }),
      claimSideEffect({ userId: 'u1', workflowId: 'wf1', executionId: 'exec1', nodeId: 'node1', effectType: 'airtable_create' }),
    ]);
    const claimedCount = [a, b].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);
  });
});

describe('isStaleInProgress', () => {
  it('a fresh in_progress row is never stale', async () => {
    const { isStaleInProgress } = await import('../lib/runtime/side-effect-ledger');
    expect(isStaleInProgress({ id: 'x', status: 'in_progress', providerRef: null, attempts: 1, lastError: null, updatedAt: nowIso() })).toBe(false);
  });
  it('an old in_progress row is stale', async () => {
    const { isStaleInProgress } = await import('../lib/runtime/side-effect-ledger');
    expect(isStaleInProgress({ id: 'x', status: 'in_progress', providerRef: null, attempts: 1, lastError: null, updatedAt: nowIso(-10 * 60_000) })).toBe(true);
  });
  it('a non-in_progress row is never "stale" (the concept only applies to in_progress)', async () => {
    const { isStaleInProgress } = await import('../lib/runtime/side-effect-ledger');
    expect(isStaleInProgress({ id: 'x', status: 'succeeded', providerRef: null, attempts: 1, lastError: null, updatedAt: nowIso(-10 * 60_000) })).toBe(false);
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

describe('reconcileStaleSideEffects -- Part 4/6: conservative, never infers success', () => {
  it('marks a stale in_progress row indeterminate, never succeeded/failed', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'in_progress', attempts: 1, provider_ref: null, last_error: null, updated_at: nowIso(-10 * 60_000) });
    const { reconcileStaleSideEffects } = await import('../lib/runtime/side-effect-ledger');
    const result = await reconcileStaleSideEffects({ leaseMs: 5 * 60_000 });
    expect(result.scanned).toBe(1);
    expect(result.markedIndeterminate).toBe(1);
    expect(rows[0].status).toBe('indeterminate');
  });

  it('never touches a fresh in_progress row (still within the lease window)', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'in_progress', attempts: 1, provider_ref: null, last_error: null, updated_at: nowIso() });
    const { reconcileStaleSideEffects } = await import('../lib/runtime/side-effect-ledger');
    const result = await reconcileStaleSideEffects({ leaseMs: 5 * 60_000 });
    expect(result.scanned).toBe(0);
    expect(rows[0].status).toBe('in_progress');
  });

  it('never touches a row already succeeded/failed/indeterminate', async () => {
    rows.push({ id: 'x', user_id: 'u1', workflow_id: 'wf1', execution_id: 'exec1', node_id: 'node1', effect_key: 'primary', status: 'succeeded', attempts: 1, provider_ref: { id: 'recX' }, last_error: null, updated_at: nowIso(-10 * 60_000) });
    const { reconcileStaleSideEffects } = await import('../lib/runtime/side-effect-ledger');
    const result = await reconcileStaleSideEffects({ leaseMs: 5 * 60_000 });
    expect(result.scanned).toBe(0);
    expect(rows[0].status).toBe('succeeded');
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
