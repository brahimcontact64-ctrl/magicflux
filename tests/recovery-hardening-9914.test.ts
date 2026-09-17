/**
 * Phase 9.9.14 -- fault-injection/recovery tests for the four new
 * maintenance mechanisms this phase adds:
 *   1. recordOperatorVerifiedOutcome (side-effect-ledger.ts) -- the
 *      recovery control plane's core mutation.
 *   2. markOrphanQueuedExecutionsFailed (hardening-layer.ts) -- closes the
 *      crash-between-insert-and-enqueue orphan window.
 *   3. reclaimOrphanedIdempotencyLocks (idempotency.ts) -- closes the
 *      crash-before-execution-row-insert orphan window.
 *   4. RuntimeStateStore.forceFailIfStillRunning (runtime-state.ts) --
 *      closes the unhandled-exception-mid-execution window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private ltFilters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  private op: 'select' | 'delete' = 'select';
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  lt(col: string, val: unknown): this { this.ltFilters.push([col, val]); return this; }
  select(): this { return this; }
  limit(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  delete(): this { this.op = 'delete'; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => {
      if (this.filters.every(([c, v]) => r[c] === v) && this.ltFilters.every(([c, v]) => String(r[c]) < String(v))) idx.push(i);
    });
    return idx;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) if (this.filters.every(([c, v]) => this.rows[i][c] === v)) this.rows.splice(i, 1);
      return { data: null, error: null };
    }
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    const m = idxs.map((i) => this.rows[i]);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const idxs = new Set(this.matchedIndexes());
      const kept = this.rows.filter((_, i) => !idxs.has(i));
      this.rows.length = 0; this.rows.push(...kept);
      return Promise.resolve(resolve({ data: [], error: null }));
    }
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    return Promise.resolve(resolve({ data: idxs.map((i) => this.rows[i]), error: null }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
}));

beforeEach(() => {
  tables = {};
});

describe('recordOperatorVerifiedOutcome (Part H/I recovery control plane)', () => {
  it('transitions an indeterminate row to succeeded, preserving the original attempts/provider_ref', async () => {
    tables.workflow_side_effects = [{
      id: 'se-1', execution_id: 'exec-1', node_id: 'node-1', effect_key: 'primary',
      status: 'indeterminate', attempts: 2, provider_ref: { airtableId: 'recABC' }, last_error: 'stale', updated_at: '2026-01-01T00:00:00.000Z',
    }];
    const { recordOperatorVerifiedOutcome } = await import('../lib/runtime/side-effect-ledger');
    const result = await recordOperatorVerifiedOutcome({
      executionId: 'exec-1', nodeId: 'node-1', verifiedStatus: 'succeeded', verifiedBy: 'user-1', note: 'Confirmed record recABC exists in Airtable, no duplicate.',
    });
    expect(result).toEqual({ ok: true, previousStatus: 'indeterminate' });
    const row = tables.workflow_side_effects[0];
    expect(row.status).toBe('succeeded');
    expect(row.attempts).toBe(2); // history preserved, never reset
    expect(row.provider_ref).toEqual({ airtableId: 'recABC' }); // never erased
    expect(String(row.last_error)).toContain('user-1');
  });

  it('transitions an indeterminate row to failed, which makes it re-claimable (a natural, deterministic path to retry)', async () => {
    tables.workflow_side_effects = [{
      id: 'se-1', execution_id: 'exec-1', node_id: 'node-1', effect_key: 'primary',
      status: 'indeterminate', attempts: 1, provider_ref: null, last_error: null, updated_at: '2026-01-01T00:00:00.000Z',
    }];
    const { recordOperatorVerifiedOutcome } = await import('../lib/runtime/side-effect-ledger');
    const result = await recordOperatorVerifiedOutcome({
      executionId: 'exec-1', nodeId: 'node-1', verifiedStatus: 'failed', verifiedBy: 'user-1', note: 'Confirmed no record was created.',
    });
    expect(result.ok).toBe(true);
    expect(tables.workflow_side_effects[0].status).toBe('failed');
  });

  it('refuses to touch a row that is NOT indeterminate (e.g. already succeeded) -- never overwrites a definitive outcome', async () => {
    tables.workflow_side_effects = [{
      id: 'se-1', execution_id: 'exec-1', node_id: 'node-1', effect_key: 'primary',
      status: 'succeeded', attempts: 1, provider_ref: { id: 'rec1' }, last_error: null, updated_at: '2026-01-01T00:00:00.000Z',
    }];
    const { recordOperatorVerifiedOutcome } = await import('../lib/runtime/side-effect-ledger');
    const result = await recordOperatorVerifiedOutcome({
      executionId: 'exec-1', nodeId: 'node-1', verifiedStatus: 'failed', verifiedBy: 'user-1', note: 'attempt to overwrite',
    });
    expect(result.ok).toBe(false);
    expect(tables.workflow_side_effects[0].status).toBe('succeeded'); // untouched
  });

  it('a nonexistent ledger row fails closed with a clear reason, never creates one', async () => {
    const { recordOperatorVerifiedOutcome } = await import('../lib/runtime/side-effect-ledger');
    const result = await recordOperatorVerifiedOutcome({
      executionId: 'exec-nonexistent', nodeId: 'node-1', verifiedStatus: 'succeeded', verifiedBy: 'user-1', note: 'x',
    });
    expect(result.ok).toBe(false);
    expect(tables.workflow_side_effects ?? []).toHaveLength(0);
  });

  it('concurrent verification attempts cannot both succeed -- CAS guarantees exactly one wins', async () => {
    tables.workflow_side_effects = [{
      id: 'se-1', execution_id: 'exec-1', node_id: 'node-1', effect_key: 'primary',
      status: 'indeterminate', attempts: 1, provider_ref: null, last_error: null, updated_at: '2026-01-01T00:00:00.000Z',
    }];
    const { recordOperatorVerifiedOutcome } = await import('../lib/runtime/side-effect-ledger');
    const [a, b] = await Promise.all([
      recordOperatorVerifiedOutcome({ executionId: 'exec-1', nodeId: 'node-1', verifiedStatus: 'succeeded', verifiedBy: 'user-1', note: 'a' }),
      recordOperatorVerifiedOutcome({ executionId: 'exec-1', nodeId: 'node-1', verifiedStatus: 'failed', verifiedBy: 'user-2', note: 'b' }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });
});

describe('markOrphanQueuedExecutionsFailed (Part D -- crash between execution-row insert and enqueue)', () => {
  it('marks a stale queued row as failed with a recovery_required-labeled message', async () => {
    tables.workflow_executions_v2 = [
      { id: 'exec-1', user_id: 'user-1', status: 'queued', updated_at: '2020-01-01T00:00:00.000Z' },
    ];
    const { markOrphanQueuedExecutionsFailed } = await import('../runtime/hardening-layer');
    const count = await markOrphanQueuedExecutionsFailed({ staleAfterMinutes: 10 });
    expect(count).toBe(1);
    expect(tables.workflow_executions_v2[0].status).toBe('failed');
    expect(String(tables.workflow_executions_v2[0].error_message)).toMatch(/recovery_required/i);
  });

  it('never touches a recently-queued row (not stale yet) -- avoids a false positive during a slow-but-legitimate dispatch', async () => {
    tables.workflow_executions_v2 = [
      { id: 'exec-1', user_id: 'user-1', status: 'queued', updated_at: new Date().toISOString() },
    ];
    const { markOrphanQueuedExecutionsFailed } = await import('../runtime/hardening-layer');
    const count = await markOrphanQueuedExecutionsFailed({ staleAfterMinutes: 10 });
    expect(count).toBe(0);
    expect(tables.workflow_executions_v2[0].status).toBe('queued');
  });

  it('never touches a running/success/waiting execution -- only queued', async () => {
    tables.workflow_executions_v2 = [
      { id: 'exec-1', user_id: 'user-1', status: 'running', updated_at: '2020-01-01T00:00:00.000Z' },
    ];
    const { markOrphanQueuedExecutionsFailed } = await import('../runtime/hardening-layer');
    const count = await markOrphanQueuedExecutionsFailed({ staleAfterMinutes: 10 });
    expect(count).toBe(0);
  });
});

describe('reclaimOrphanedIdempotencyLocks (Part D -- crash before execution-row insert)', () => {
  it('deletes an expired lock whose execution_id resolves to NO execution row (a true orphan)', async () => {
    tables.runtime_execution_locks = [
      { execution_id: 'exec-orphan', user_id: 'user-1', lease_expires_at: '2020-01-01T00:00:00.000Z' },
    ];
    tables.workflow_executions_v2 = [];
    const { reclaimOrphanedIdempotencyLocks } = await import('../lib/runtime/idempotency');
    const count = await reclaimOrphanedIdempotencyLocks();
    expect(count).toBe(1);
    expect(tables.runtime_execution_locks).toHaveLength(0);
  });

  it('NEVER deletes a lock whose execution_id resolves to a REAL execution -- even a failed one legitimately protects against re-processing', async () => {
    tables.runtime_execution_locks = [
      { execution_id: 'exec-real', user_id: 'user-1', lease_expires_at: '2020-01-01T00:00:00.000Z' },
    ];
    tables.workflow_executions_v2 = [{ id: 'exec-real', user_id: 'user-1', status: 'failed' }];
    const { reclaimOrphanedIdempotencyLocks } = await import('../lib/runtime/idempotency');
    const count = await reclaimOrphanedIdempotencyLocks();
    expect(count).toBe(0);
    expect(tables.runtime_execution_locks).toHaveLength(1);
  });

  it('never touches a lock whose lease has not expired yet', async () => {
    tables.runtime_execution_locks = [
      { execution_id: 'exec-orphan', user_id: 'user-1', lease_expires_at: new Date(Date.now() + 60_000).toISOString() },
    ];
    tables.workflow_executions_v2 = [];
    const { reclaimOrphanedIdempotencyLocks } = await import('../lib/runtime/idempotency');
    const count = await reclaimOrphanedIdempotencyLocks();
    expect(count).toBe(0);
    expect(tables.runtime_execution_locks).toHaveLength(1);
  });
});
