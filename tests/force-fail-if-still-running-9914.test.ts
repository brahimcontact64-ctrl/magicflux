/**
 * Phase 9.9.14 -- RuntimeStateStore.forceFailIfStillRunning: the last-resort
 * correction wired into WorkflowEngine.execute()'s own `finally` block for
 * an unhandled exception that skips every normal return path (e.g. a
 * transient Supabase write failure from persistNodeState() itself, which
 * explicitly throws RuntimeNodeStatePersistenceError). Proves it is a
 * true no-op on every clean exit and only ever corrects a genuinely stuck
 * 'running' row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const targets = this.matched();
    if (this.pendingPatch) for (const t of targets) Object.assign(t, this.pendingPatch);
    return Promise.resolve(resolve({ data: targets, error: null }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? []) })),
}));
vi.mock('@/lib/runtime/events', () => ({ emitRuntimeEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  tables = { workflow_executions_v2: [{ id: 'exec-1', user_id: 'user-1', status: 'running', error_message: null, updated_at: '2020-01-01T00:00:00.000Z' }] };
});

describe('RuntimeStateStore.forceFailIfStillRunning', () => {
  it('corrects a row genuinely still stuck at "running" (the unhandled-exception case this exists for)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await store.forceFailIfStillRunning('exec-1', 'user-1', 'Execution crashed -- recovery_required.');

    const row = tables.workflow_executions_v2[0];
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('Execution crashed -- recovery_required.');
  });

  it('is a no-op when the row already left "running" via a normal return path (success)', async () => {
    tables.workflow_executions_v2[0].status = 'success';
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await store.forceFailIfStillRunning('exec-1', 'user-1', 'should never apply');

    expect(tables.workflow_executions_v2[0].status).toBe('success'); // untouched
  });

  it('is a no-op when the row already left "running" via a normal return path (waiting)', async () => {
    tables.workflow_executions_v2[0].status = 'waiting';
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await store.forceFailIfStillRunning('exec-1', 'user-1', 'should never apply');

    expect(tables.workflow_executions_v2[0].status).toBe('waiting');
  });

  it('is a no-op when the row already left "running" via cancellation', async () => {
    tables.workflow_executions_v2[0].status = 'cancelled';
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await store.forceFailIfStillRunning('exec-1', 'user-1', 'should never apply');

    expect(tables.workflow_executions_v2[0].status).toBe('cancelled');
  });

  it('never throws even if the underlying update itself fails -- this runs inside a finally block and must never mask the original exception', async () => {
    tables.workflow_executions_v2 = undefined as never; // forces an error when .from() tries to read it
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValueOnce({
      from: () => { throw new Error('DB unavailable'); },
    } as never);

    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await expect(store.forceFailIfStillRunning('exec-1', 'user-1', 'x')).resolves.toBeUndefined();
  });

  it('never touches another tenant\'s row with the same execution id (defense in depth via user_id scoping)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();
    await store.forceFailIfStillRunning('exec-1', 'different-user', 'x');

    expect(tables.workflow_executions_v2[0].status).toBe('running'); // untouched -- user_id didn't match
  });
});
