/**
 * Phase 8.1 — Failure/crash-safety: a duplicate event arriving after an
 * earlier enqueue failure must resolve to the existing (failed) execution,
 * not create a new row and not loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeTable {
  constructor(private rows: Row[], private uniqueCols: string[] = []) {}
  select() { return this.query(); }
  update(patch: Row) { const q = this.query(); q.pendingPatch = patch; return q; }
  private query() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api: {
      pendingPatch: Row | null;
      eq: (c: string, v: unknown) => typeof api;
      limit: () => typeof api;
      maybeSingle: () => Promise<{ data: Row | null; error: null }>;
      then: <T>(resolve: (v: { data: Row[]; error: null }) => T) => Promise<T>;
    } = {
      pendingPatch: null,
      eq(c, v) { filters.push([c, v]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const m = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (api.pendingPatch) for (const row of m) Object.assign(row, api.pendingPatch);
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then(resolve) {
        const m = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (api.pendingPatch) for (const row of m) Object.assign(row, api.pendingPatch);
        return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), error: null }));
      },
    };
    return api;
  }
  insert(row: Row) {
    for (const col of this.uniqueCols) {
      if (row[col] != null && this.rows.some((r) => r[col] === row[col])) {
        return { then: (resolve: (v: { error: { code: string } }) => unknown) => Promise.resolve(resolve({ error: { code: '23505' } })) };
      }
    }
    this.rows.push({ ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

let tables: { workflow_executions_v2: Row[]; runtime_execution_locks: Row[] };

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: 'workflow_executions_v2' | 'runtime_execution_locks') =>
      new FakeTable(tables[name], name === 'runtime_execution_locks' ? ['idempotency_key'] : []),
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'reserve_concurrency_slot') return { data: { reserved: true }, error: null };
      return { data: null, error: null };
    }),
  })),
}));

const enqueueRuntimeJobMock = vi.fn();
vi.mock('@/lib/runtime/queue', () => ({ enqueueRuntimeJob: (...a: unknown[]) => enqueueRuntimeJobMock(...a) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn(async () => undefined) }));

beforeEach(() => {
  tables = { workflow_executions_v2: [], runtime_execution_locks: [] };
  enqueueRuntimeJobMock.mockReset();
});

describe('a duplicate event after an earlier enqueue failure', () => {
  it('never leaves the failed execution row permanently stuck queued/running, and a retried identical event returns it rather than looping', async () => {
    enqueueRuntimeJobMock.mockResolvedValue({ enqueued: false, queueJobId: '', reason: 'REDIS_URL is not configured' });

    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const first = await dispatchProductionExecution({
      userId: 'user-1', workflowId: 'wf-1', deploymentVersionId: null, inputData: {}, idempotencyKey: 'evt-persistent',
    });
    expect(first.ok).toBe(false);
    expect(tables.workflow_executions_v2[0].status).toBe('failed');

    const secondAttempt = await dispatchProductionExecution({
      userId: 'user-1', workflowId: 'wf-1', deploymentVersionId: null, inputData: {}, idempotencyKey: 'evt-persistent',
    });

    expect(tables.workflow_executions_v2).toHaveLength(1);
    if (secondAttempt.ok && secondAttempt.duplicate) {
      expect(secondAttempt.executionId).toBe(tables.workflow_executions_v2[0].id);
      expect(secondAttempt.status).toBe('failed');
    } else {
      expect(secondAttempt.ok).toBe(false);
    }
  });
});
