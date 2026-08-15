/**
 * Phase 7.5 — Real production-runtime E2E test.
 *
 * LIVE DB STATUS: BLOCKED (same reasoning as tests/credential-e2e-mocked.test.ts
 * — the only Supabase configured is a remote *.supabase.co project, and a local
 * stack cannot be started with ~229MB free disk). Additionally, this project's
 * local REDIS_URL resolves to a port already bound by an unrelated running
 * project's Redis container, so it is not safe to exercise as isolated test
 * infrastructure either.
 *
 * This test instead drives the ACTUAL production runtime path —
 * lib/workflow-runtime/engine.ts → runtime/execution-manager.ts →
 * runtime/workflow-engine.ts (WorkflowEngine) → runtime/node-runner.ts →
 * lib/workflow-runtime/node-handlers (real dispatchNode + real handlers) —
 * NOT lib/execution/engine.ts (the mock engine used by tests/execution-engine.test.ts).
 * Only the network boundary (createServiceClient / Supabase) is faked, via a
 * generic in-memory table implementation supporting the exact query shapes
 * runtime/*.ts issues (insert, upsert, update, delete, select, eq, limit,
 * order, maybeSingle). All orchestration, locking, retry, and dispatch logic
 * runs unmodified.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-000000000099';
const WORKFLOW_ID = 'wf-e2e-test';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'd'.repeat(64);
  }
});

// ─── Generic in-memory fake Supabase client ────────────────────────────────────

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}

  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }

  // No-op column projection — chained after insert()/update() in real Supabase
  // usage (e.g. .insert({...}).select('id')); the fake always returns full rows.
  select(_cols?: string): this {
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => {
      if (this.filters.every(([col, val]) => r[col] === val)) idx.push(i);
    });
    return idx;
  }

  private matched(): Row[] {
    let result = this.matchedIndexes().map((i) => this.rows[i]);
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    return result;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) {
        if (this.filters.every(([col, val]) => this.rows[i][col] === val)) this.rows.splice(i, 1);
      }
      return { data: null, error: null };
    }
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }

  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const removeIdx = new Set(this.matchedIndexes());
      const kept = this.rows.filter((_, i) => !removeIdx.has(i));
      this.rows.length = 0;
      this.rows.push(...kept);
      return Promise.resolve(resolve({ data: [], error: null }));
    }
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}

  select(): FakeQuery {
    return new FakeQuery(this.rows, 'select');
  }

  delete(): FakeQuery {
    return new FakeQuery(this.rows, 'delete');
  }

  insert(row: Row): FakeQuery {
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    return new FakeQuery([withId], 'select');
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string }): { then: (resolve: (v: { error: null }) => unknown) => Promise<unknown> } {
    const incoming = Array.isArray(rows) ? rows : [rows];
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const row of incoming) {
      const idx = conflictCols.length
        ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c]))
        : -1;
      if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...row };
      else this.rows.push({ id: row.id ?? `fake-${this.rows.length}`, ...row });
    }
    return { then: (resolve) => Promise.resolve(resolve({ error: null })) };
  }

  update(patch: Row): FakeQuery {
    const q = new FakeQuery(this.rows, 'select');
    const applyPatch = (): Row[] => {
      // Apply the patch to every row matching the filter chain built up via .eq()
      const filters = (q as unknown as { filters: Array<[string, unknown]> }).filters;
      const matched: Row[] = [];
      for (const row of this.rows) {
        if (filters.every(([col, val]) => row[col] === val)) {
          Object.assign(row, patch);
          matched.push(row);
        }
      }
      return matched;
    };
    const originalThen = q.then.bind(q);
    q.then = <T,>(resolve: (v: { data: Row[]; error: null }) => T) => {
      applyPatch();
      return originalThen(resolve);
    };
    const originalMaybeSingle = q.maybeSingle.bind(q);
    q.maybeSingle = async () => {
      const matched = applyPatch();
      if (matched.length > 0) return { data: { ...matched[0] }, error: null };
      return originalMaybeSingle();
    };
    return q;
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();

  from(name: string): FakeTableHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTableHandle(this.tables.get(name)!);
  }
}

// lib/workflow-runtime/engine.ts holds a module-level ExecutionManager
// singleton whose RuntimeStateStore captures createServiceClient() ONCE at
// construction (`private db = createServiceClient()`), not per query. So the
// fake db instance itself must stay the same object across tests — only its
// contents are reset — otherwise the singleton keeps querying a stale,
// orphaned fake after the first test.
const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
  getUserFromAccessToken: vi.fn(),
  getBearerToken: vi.fn(),
}));

// This test drives the real httpHandler against fake hostnames (example.internal)
// that don't resolve — the SSRF guard's real dns.lookup() would block (and slowly
// time out on) every one of them. SSRF policy itself has its own dedicated
// tests/ssrf-guard.test.ts; this suite is about runtime orchestration, not
// network policy, so the guard is bypassed here.
vi.mock('../lib/workflow-runtime/node-handlers/ssrf-guard', () => ({
  checkUrlSafe: vi.fn().mockResolvedValue({ allowed: true }),
  checkHostnameSafe: vi.fn().mockResolvedValue({ allowed: true }),
  isBlockedAddress: vi.fn().mockReturnValue(false),
}));

// Trigger → HTTP Request → Condition. Every node type here must resolve to a
// real handler in lib/workflow-runtime/node-handlers/index.ts's pickHandler()
// — an unrouted type (e.g. a generic "noOp") hits the UNSUPPORTED_NODE_TYPE
// fallback and fails immediately in live mode, which would invalidate what
// this test is trying to prove.
function httpWorkflow(url: string): unknown {
  return {
    name: 'E2E Test Workflow',
    nodes: [
      { id: 'trigger', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { id: 'http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { url, method: 'GET' } },
      { id: 'condition', name: 'Check Status', type: 'n8n-nodes-base.if', parameters: {} },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Call API' }]] },
      'Call API': { main: [[{ node: 'Check Status' }]] },
    },
  };
}

describe('Production runtime E2E (mocked infrastructure — live DB/Redis BLOCKED, see file header)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeDb.tables.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('executes a real trigger → HTTP → condition → final workflow through the real runtime engine and persists rows in the correct order', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: 'ok' }),
      headers: { get: () => 'application/json', entries: () => Object.entries({})[Symbol.iterator]() },
    });

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');

    const result = await runWorkflowExecution({
      workflowJson: httpWorkflow('https://example.internal/api/data'),
      inputData: {},
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
    });

    expect(result.status).toBe('success');

    // 1. Execution row created in workflow_executions_v2.
    const executions = fakeDb.tables.get('workflow_executions_v2') ?? [];
    expect(executions).toHaveLength(1);
    expect(executions[0].user_id).toBe(USER_ID);
    expect(executions[0].workflow_id).toBe(WORKFLOW_ID);
    expect(executions[0].status).toBe('success');

    // Durations persisted: started_at set at init, completed_at set at terminal state.
    expect(executions[0].started_at).toBeTruthy();

    // 2. Node step rows created for every node, in the correct topological order.
    const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
    expect(steps.length).toBeGreaterThan(0);
    const successSteps = steps.filter((s) => s.status === 'success').map((s) => s.node_name);
    expect(successSteps).toEqual(['Manual Trigger', 'Call API', 'Check Status']);

    // 3. The real HTTP handler actually ran (not the mock engine) — fetch was called.
    expect(fetchMock).toHaveBeenCalledWith('https://example.internal/api/data', expect.objectContaining({ method: 'GET' }));

    // 4. Outputs persisted on the HTTP step's terminal row. workflow_execution_steps
    //    is append-only — one row per status transition (queued/running/success) —
    //    so the terminal 'success' row specifically must carry the output.
    const httpStep = steps.find((s) => s.node_name === 'Call API' && s.status === 'success') as unknown as { output_data: unknown };
    expect(httpStep.output_data).toBeTruthy();
  }, 20000);

  it('retry state: a node that fails with retry budget remaining schedules an execution-level retry (status=waiting, nextRunAt set), with a real "retrying" node state persisted in between', async () => {
    // Real retry architecture (runtime/workflow-engine.ts + runtime/node-runner.ts) is
    // two-tier: node-runner retries the SAME node inline up to `maxRetries` times within
    // one call; if still failing, the workflow-engine schedules a whole-execution retry
    // for later (status='waiting' + nextRunAt) rather than failing the run outright,
    // UNLESS the execution-level retry budget (retryCount vs maxRetries) is also
    // exhausted — see the maxRetries:0 timeout test below for that terminal case.
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}), headers: { get: () => 'application/json', entries: () => Object.entries({})[Symbol.iterator]() } });

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');

    const result = await runWorkflowExecution({
      workflowJson: httpWorkflow('https://example.internal/api/always-fails'),
      inputData: {},
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
      maxRetries: 1,
    });

    expect(result.status).toBe('waiting');
    expect(result.nextRunAt).toBeTruthy();

    const executions = fakeDb.tables.get('workflow_executions_v2') ?? [];
    expect(executions[0].status).toBe('waiting');
    expect(executions[0].retry_count).toBe(1);
    expect(executions[0].next_run_at).toBeTruthy();

    const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
    const httpSteps = steps.filter((s) => s.node_name === 'Call API');
    // The real node-runner retry loop persisted at least one 'retrying' state
    // before the node's per-attempt budget was exhausted.
    expect(httpSteps.some((s) => s.status === 'retrying')).toBe(true);
    // A retrying upstream node must not leave the downstream node marked success.
    expect(steps.some((s) => s.node_name === 'Check Status' && s.status === 'success')).toBe(false);
  }, 20000);

  it('failure state: repeated resume cycles that exhaust the execution-level retry budget end in a genuine terminal failed status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}), headers: { get: () => 'application/json', entries: () => Object.entries({})[Symbol.iterator]() } });

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const workflowJson = httpWorkflow('https://example.internal/api/always-fails');

    // Call 1: fresh execution, retryCount=0 — schedules an execution-level retry (waiting).
    const first = await runWorkflowExecution({
      workflowJson, inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live', maxRetries: 1,
    });
    expect(first.status).toBe('waiting');

    // Call 2: simulates the resume endpoint calling back in with the same executionId
    // and the incremented retryCount the first call persisted — exactly what
    // app/api/workflows/executions/resume/route.ts does for a real waiting execution.
    const second = await runWorkflowExecution({
      workflowJson,
      inputData: {},
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
      maxRetries: 1,
      executionId: first.executionId,
      resumeFromNodeId: 'Call API',
      retryCount: 1,
    });

    expect(second.status).toBe('failed');
    const executions = fakeDb.tables.get('workflow_executions_v2') ?? [];
    expect(executions[0].status).toBe('failed');
    expect(executions[0].error_message).toBeTruthy();
  }, 20000);

  it('timeout state: the real HTTP handler reports a timeout, and it is persisted through the real retry/failure path', async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const wf = httpWorkflow('https://example.internal/api/slow');
    (wf as { nodes: Array<{ parameters: Record<string, unknown> }> }).nodes[1].parameters.timeout = 50;

    const result = await runWorkflowExecution({
      workflowJson: wf,
      inputData: {},
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
      maxRetries: 0,
    });

    expect(result.status).toBe('failed');
    const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string; error_message: string }>;
    const httpStep = steps.find((s) => s.node_name === 'Call API' && s.status === 'failed');
    expect(httpStep?.error_message).toContain('timed out');
  }, 20000);
});
