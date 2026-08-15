/**
 * Phase 8.1 security — the enqueued job payload must never contain the
 * workflow JSON, credentials, or API keys — only IDs and the caller-supplied
 * trigger input. The worker re-resolves the frozen snapshot itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const WORKFLOW_ID = 'wf-security-payload';

type Row = Record<string, unknown>;

class FakeTable {
  constructor(private rows: Row[], private uniqueCols: string[] = []) {}
  select() { return this.query(); }
  private query() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      limit() { return api; },
      async maybeSingle() {
        const m = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const m = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
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
    rpc: vi.fn(async (fn: string) => (fn === 'reserve_concurrency_slot' ? { data: { reserved: true }, error: null } : { data: null, error: null })),
  })),
}));

type EnqueueParams = { queueName: string; taskType: string; payload: Record<string, unknown>; dedupeKey?: string };
const enqueueRuntimeJobMock = vi.fn(async (_params: EnqueueParams) => ({ enqueued: true, queueJobId: 'job-1' }));
vi.mock('@/lib/runtime/queue', () => ({ enqueueRuntimeJob: (params: EnqueueParams) => enqueueRuntimeJobMock(params) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn(async () => undefined) }));

beforeEach(() => {
  tables = { workflow_executions_v2: [], runtime_execution_locks: [] };
  enqueueRuntimeJobMock.mockClear();
});

describe('queue payload tampering and secret leakage', () => {
  it('the enqueued job payload never contains the workflow JSON, credentials, or API keys — only IDs and the caller-supplied input', async () => {
    const { dispatchProductionExecution } = await import('../lib/runtime/execution-dispatch');
    await dispatchProductionExecution({
      userId: OWNER_ID,
      workflowId: WORKFLOW_ID,
      deploymentVersionId: 'dv-1',
      inputData: { orderId: 123 },
      idempotencyKey: 'k1',
    });

    expect(enqueueRuntimeJobMock).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(enqueueRuntimeJobMock.mock.calls[0][0]);
    expect(payload).not.toMatch(/workflowJson|workflow_json/i);
    expect(payload).not.toMatch(/api[_-]?key/i);
    expect(payload).not.toMatch(/access[_-]?token/i);
    expect(payload).not.toMatch(/credential/i);
    expect(payload).toContain('deploymentVersionId');
  });
});
