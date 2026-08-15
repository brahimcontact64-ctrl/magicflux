/**
 * Phase 8.1 — Failure/crash-safety: resume must not double-count usage
 * events. Covers runtime/runtime-state.ts's two usage-metering hooks:
 * initializeExecution (execution_started, insert-only) and
 * setExecutionState (execution_completed / execution_failed, terminal-only).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

const recordUsageEventMock = vi.fn(async (_params: { userId: string; workflowId: string; executionId: string; nodeId?: string; eventType: string; quantity?: number; metadata?: Record<string, unknown>; idempotencyKey: string }) => undefined);
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: recordUsageEventMock }));

let rows: Row[];

class FakeQuery {
  constructor(private allRows: Row[]) {}
  private filters: Array<[string, unknown]> = [];
  private patch: Row | null = null;
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  select() { return this; }
  update(patch: Row) { this.patch = patch; return this; }
  insert(row: Row) {
    const stored = { id: 'inserted-exec-id', ...row };
    this.allRows.push(stored);
    return { select: () => ({ maybeSingle: async () => ({ data: { id: stored.id }, error: null }) }) };
  }
  async maybeSingle() {
    const m = this.allRows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.patch) for (const row of m) Object.assign(row, this.patch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: () => new FakeQuery(rows) })),
}));

beforeEach(() => { rows = []; recordUsageEventMock.mockClear(); });

describe('resume does not double-count execution_started / terminal usage events', () => {
  it('initializeExecution only records execution_started on the fresh-insert path, not when reusing an existing executionId (resume)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    const freshId = await store.initializeExecution({
      workflowId: 'wf-1', userId: 'user-1', mode: 'live', inputData: {}, maxRetries: 3,
    });
    expect(recordUsageEventMock).toHaveBeenCalledTimes(1);
    expect(recordUsageEventMock.mock.calls[0][0]).toMatchObject({ eventType: 'execution_started' });

    recordUsageEventMock.mockClear();
    rows.push({ id: freshId, workflow_id: 'wf-1', user_id: 'user-1', status: 'waiting' });

    await store.initializeExecution({
      executionId: freshId, workflowId: 'wf-1', userId: 'user-1', mode: 'live', inputData: {}, maxRetries: 3,
    });
    expect(recordUsageEventMock).not.toHaveBeenCalled();
  });

  it('setExecutionState uses a stable execution-scoped idempotency key for terminal events, so a replayed completion cannot double-count downstream', async () => {
    rows.push({ id: 'exec-1', workflow_id: 'wf-1', user_id: 'user-1', started_at: new Date().toISOString() });

    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await store.setExecutionState({ executionId: 'exec-1', userId: 'user-1', state: 'completed', retryCount: 0 });
    await store.setExecutionState({ executionId: 'exec-1', userId: 'user-1', state: 'completed', retryCount: 0 });

    expect(recordUsageEventMock).toHaveBeenCalledTimes(2);
    const keys = recordUsageEventMock.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe('exec-1:execution_completed');
  });

  it('non-terminal state transitions (waiting, paused) never record a usage event', async () => {
    rows.push({ id: 'exec-1', workflow_id: 'wf-1', user_id: 'user-1', started_at: new Date().toISOString() });
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await store.setExecutionState({ executionId: 'exec-1', userId: 'user-1', state: 'waiting', retryCount: 0 });
    await store.setExecutionState({ executionId: 'exec-1', userId: 'user-1', state: 'paused', retryCount: 0 });
    expect(recordUsageEventMock).not.toHaveBeenCalled();
  });
});
