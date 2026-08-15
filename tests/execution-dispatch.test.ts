/**
 * Phase 8.1 — Async production execution dispatch.
 *
 * Proves lib/runtime/execution-dispatch.ts (which app/api/workflows/[id]/webhook/route.ts
 * now calls instead of running the workflow inline):
 *   - never calls the workflow engine directly — it only reserves state and
 *     enqueues a job;
 *   - creates the execution row as 'queued' before enqueueing;
 *   - returns the existing execution for a duplicate idempotency key without
 *     enqueueing a second job or double-reserving concurrency;
 *   - releases the idempotency-key reservation when concurrency is denied,
 *     so a legitimately-retriable event is not permanently poisoned;
 *   - never leaves an execution stuck 'queued' when the enqueue call itself
 *     fails — it is marked 'failed' and the concurrency slot is released.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000e1';
const WORKFLOW_ID = 'wf-dispatch-1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  private isDelete = false;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  limit(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  private apply(): Row[] {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    if (this.isDelete) {
      for (const row of m) {
        const idx = this.rows.indexOf(row);
        if (idx >= 0) this.rows.splice(idx, 1);
      }
    }
    return m;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.apply();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const m = this.apply();
    return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), error: null }));
  }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  delete(): this { this.isDelete = true; return this; }
}

class FakeTable {
  constructor(private rows: Row[], private uniqueCols: string[] = []) {}
  select() { return new FakeQuery(this.rows); }
  update(patch: Row) { return new FakeQuery(this.rows).update(patch); }
  delete() { return new FakeQuery(this.rows).delete(); }
  insert(row: Row): { then: <T>(resolve: (v: { data: Row | null; error: { code: string; message: string } | null }) => T) => Promise<T> } {
    for (const col of this.uniqueCols) {
      if (row[col] != null && this.rows.some((r) => r[col] === row[col])) {
        return { then: (resolve) => Promise.resolve(resolve({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${col})` } })) };
      }
    }
    const stored = { ...row };
    this.rows.push(stored);
    return { then: (resolve) => Promise.resolve(resolve({ data: stored, error: null })) };
  }
}

let tables: {
  workflow_executions_v2: Row[];
  runtime_execution_locks: Row[];
  runtime_usage_events: Row[];
};

function freshTables() {
  tables = { workflow_executions_v2: [], runtime_execution_locks: [], runtime_usage_events: [] };
}
freshTables();

const rpcMock = vi.fn(async (fn: string, _args: Record<string, unknown>) => {
  if (fn === 'reserve_concurrency_slot') return { data: { reserved: true }, error: null };
  if (fn === 'release_concurrency_slot') return { data: null, error: null };
  return { data: null, error: null };
});

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: keyof typeof tables) => new FakeTable(tables[name], name === 'runtime_execution_locks' ? ['idempotency_key'] : []),
    rpc: (fn: string, args: Record<string, unknown>) => rpcMock(fn, args),
  })),
}));

type EnqueueParams = { queueName: string; taskType: string; payload: Record<string, unknown>; dedupeKey?: string };
type EnqueueResult = { enqueued: boolean; queueJobId: string; reason?: string };
const enqueueRuntimeJobMock = vi.fn(async (_params: EnqueueParams): Promise<EnqueueResult> => ({ enqueued: true, queueJobId: 'job-1' }));
vi.mock('@/lib/runtime/queue', () => ({
  enqueueRuntimeJob: (params: EnqueueParams) => enqueueRuntimeJobMock(params),
}));

const runWorkflowExecutionMock = vi.fn();
vi.mock('@/lib/workflow-runtime/engine', () => ({
  runWorkflowExecution: runWorkflowExecutionMock,
}));

beforeEach(() => {
  freshTables();
  rpcMock.mockClear();
  enqueueRuntimeJobMock.mockClear();
  runWorkflowExecutionMock.mockClear();
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === 'reserve_concurrency_slot') return { data: { reserved: true }, error: null };
    return { data: null, error: null };
  });
  enqueueRuntimeJobMock.mockResolvedValue({ enqueued: true, queueJobId: 'job-1' });
});

describe('dispatchProductionExecution', () => {
  it('never calls the workflow engine directly — only reserves state and enqueues', async () => {
    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const result = await dispatchProductionExecution({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      deploymentVersionId: 'dv-1',
      inputData: { hello: 'world' },
      idempotencyKey: 'webhook:wf-dispatch-1:hash:abc',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
    expect(enqueueRuntimeJobMock).toHaveBeenCalledTimes(1);

    const call = enqueueRuntimeJobMock.mock.calls[0][0];
    expect(call.queueName).toBe('execution_queue');
    expect(call.taskType).toBe('run_workflow_execution');
    expect(call.payload.executionId).toBeTruthy();
    // The workflow JSON itself must never ride along in the job payload —
    // the worker re-resolves it from deploymentVersionId.
    expect(JSON.stringify(call.payload)).not.toContain('workflowJson');
  });

  it('creates the execution row as status=queued before enqueueing', async () => {
    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    await dispatchProductionExecution({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      deploymentVersionId: null,
      inputData: {},
      idempotencyKey: 'key-a',
    });

    expect(tables.workflow_executions_v2).toHaveLength(1);
    expect(tables.workflow_executions_v2[0].status).toBe('queued');
  });

  it('a duplicate idempotency key returns the existing execution and never enqueues a second job or re-reserves concurrency', async () => {
    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const first = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'dup-key',
    });
    expect(first.ok).toBe(true);

    enqueueRuntimeJobMock.mockClear();
    rpcMock.mockClear();

    const second = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'dup-key',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(first.ok && second.executionId).toBe(first.ok ? first.executionId : undefined);
    expect(enqueueRuntimeJobMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalledWith('reserve_concurrency_slot', expect.anything());
    expect(tables.workflow_executions_v2).toHaveLength(1); // no second row created
  });

  it('releases the idempotency-key reservation when concurrency is denied, so the same event can be retried later', async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'reserve_concurrency_slot') {
        return { data: { reserved: false, reason: 'USER_CONCURRENCY_LIMIT', current: 10, limit: 10 }, error: null };
      }
      return { data: null, error: null };
    });

    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const denied = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'retry-key',
    });

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('USER_CONCURRENCY_LIMIT');
    expect(tables.workflow_executions_v2).toHaveLength(0);
    expect(tables.runtime_execution_locks).toHaveLength(0); // released, not left as an orphaned claim

    // Concurrency frees up; the same event must now be accepted, not treated as a phantom duplicate.
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'reserve_concurrency_slot') return { data: { reserved: true }, error: null };
      return { data: null, error: null };
    });

    const retried = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'retry-key',
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.duplicate).toBe(false);
  });

  it('never leaves an execution stuck queued when the enqueue call fails — marks it failed and releases the concurrency slot', async () => {
    enqueueRuntimeJobMock.mockResolvedValue({ enqueued: false, queueJobId: '', reason: 'REDIS_URL is not configured' });

    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const result = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'enqueue-fail-key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ENQUEUE_FAILED');
    expect(tables.workflow_executions_v2[0].status).toBe('failed');
    expect(tables.workflow_executions_v2[0].status).not.toBe('queued');
    expect(tables.workflow_executions_v2[0].status).not.toBe('running');
    expect(rpcMock).toHaveBeenCalledWith('release_concurrency_slot', expect.objectContaining({ p_execution_id: expect.any(String) }));
  });

  it('never leaves an execution stuck queued when the queue throws instead of returning enqueued:false', async () => {
    enqueueRuntimeJobMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    const result = await dispatchProductionExecution({
      userId: USER_ID, workflowId: WORKFLOW_ID, deploymentVersionId: null, inputData: {}, idempotencyKey: 'enqueue-throw-key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ENQUEUE_FAILED');
    expect(tables.workflow_executions_v2[0].status).toBe('failed');
  });
});
