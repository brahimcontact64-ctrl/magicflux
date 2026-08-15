/**
 * Phase 8 — DAG / branching execution semantics (runtime/workflow-engine.ts).
 *
 * Drives the REAL WorkflowEngine (not the mock engine) against a mocked
 * Supabase client, same approach as tests/runtime-e2e-mocked.test.ts.
 *
 * Findings this file locks in:
 *   1. IF-branch routing is ALREADY correct — only the selected branch's
 *      downstream nodes are queued (gated by outputData._conditionBranch in
 *      workflow-engine.ts). The non-taken branch is never touched.
 *   2. Fan-in was NOT safe before this phase — a node reachable from two
 *      parallel branches was queued twice and executed twice (duplicate side
 *      effects, e.g. a duplicate email/Slack message). Fixed by deduping the
 *      queue on enqueue: a node already pending does not get a second entry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000d4';
const WORKFLOW_ID = 'wf-dag-test';

// ─── Generic in-memory fake Supabase client (same shape as runtime-e2e-mocked.test.ts) ───

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  // No-op column projection — chained after insert()/update() (e.g. .insert({...}).select('id')).
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  private matched(): Row[] {
    let result = this.matchedIndexes().map((i) => this.rows[i]);
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as string | number; const bv = b[col] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    return result;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) if (this.filters.every(([c, v]) => this.rows[i][c] === v)) this.rows.splice(i, 1);
      return { data: null, error: null };
    }
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const removeIdx = new Set(this.matchedIndexes());
      const kept = this.rows.filter((_, i) => !removeIdx.has(i));
      this.rows.length = 0; this.rows.push(...kept);
      return Promise.resolve(resolve({ data: [], error: null }));
    }
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  delete(): FakeQuery { return new FakeQuery(this.rows, 'delete'); }
  insert(row: Row): FakeQuery {
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    return new FakeQuery([withId], 'select');
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): { then: (resolve: (v: { error: null }) => unknown) => Promise<unknown> } {
    const incoming = Array.isArray(rows) ? rows : [rows];
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const row of incoming) {
      const idx = conflictCols.length ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c])) : -1;
      if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...row };
      else this.rows.push({ id: row.id ?? `fake-${this.rows.length}`, ...row });
    }
    return { then: (resolve) => Promise.resolve(resolve({ error: null })) };
  }
  update(patch: Row): FakeQuery {
    const q = new FakeQuery(this.rows, 'select');
    const originalThen = q.then.bind(q);
    q.then = <T,>(resolve: (v: { data: Row[]; error: null }) => T) => {
      const filters = (q as unknown as { filters: Array<[string, unknown]> }).filters;
      for (const row of this.rows) if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, patch);
      return originalThen(resolve);
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

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
  getUserFromAccessToken: vi.fn(),
  getBearerToken: vi.fn(),
}));

vi.mock('../lib/workflow-runtime/node-handlers/ssrf-guard', () => ({
  checkUrlSafe: vi.fn().mockResolvedValue({ allowed: true }),
  checkHostnameSafe: vi.fn().mockResolvedValue({ allowed: true }),
  isBlockedAddress: vi.fn().mockReturnValue(false),
}));

function stepNames(status?: string): string[] {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
  return steps.filter((s) => !status || s.status === status).map((s) => s.node_name);
}

describe('IF-branch routing (runtime/workflow-engine.ts)', () => {
  beforeEach(() => { fakeDb.tables.clear(); });

  function ifWorkflow(conditionsTrue: boolean): unknown {
    return {
      name: 'IF branch test',
      nodes: [
        { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        {
          id: 'cond', name: 'Check', type: 'n8n-nodes-base.if',
          parameters: { conditions: [{ field: 'ok', operator: 'equals', value: conditionsTrue ? 'yes' : 'no-match' }] },
        },
        { id: 'onTrue', name: 'On True', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'onFalse', name: 'On False', type: 'n8n-nodes-base.if', parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: 'Check' }]] },
        // main[0] = true branch -> On True, main[1] = false branch -> On False
        Check: { main: [[{ node: 'On True' }], [{ node: 'On False' }]] },
      },
    };
  }

  it('only executes the TRUE branch when the condition matches — the FALSE branch node never runs', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: ifWorkflow(true),
      inputData: { ok: 'yes' },
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
    });

    expect(result.status).toBe('success');
    expect(stepNames()).toContain('On True');
    expect(stepNames()).not.toContain('On False');
  });

  it('only executes the FALSE branch when the condition does not match — the TRUE branch node never runs', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: ifWorkflow(false),
      inputData: { ok: 'yes' },
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      mode: 'live',
    });

    expect(result.status).toBe('success');
    expect(stepNames()).toContain('On False');
    expect(stepNames()).not.toContain('On True');
  });
});

describe('Fan-out / fan-in (runtime/workflow-engine.ts)', () => {
  beforeEach(() => { fakeDb.tables.clear(); });

  it('fan-out: a node with two independent downstream targets runs both (no merge required)', async () => {
    const workflow = {
      name: 'Fan-out test',
      nodes: [
        { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'a', name: 'Branch A', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'b', name: 'Branch B', type: 'n8n-nodes-base.if', parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: 'Branch A' }, { node: 'Branch B' }]] },
      },
    };

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: workflow, inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('success');
    expect(stepNames()).toContain('Branch A');
    expect(stepNames()).toContain('Branch B');
  });

  it('fan-in: a node reachable from two parallel branches executes exactly ONCE, not once per incoming edge', async () => {
    // Trigger -> {A, B} -> both feed into Merge. Before the dedup fix, Merge
    // would be queued twice (once when A completes, once when B completes)
    // and therefore run twice — a real duplicate-side-effect bug (e.g. a
    // downstream email/Slack node would fire twice for one workflow run).
    const workflow = {
      name: 'Fan-in test',
      nodes: [
        { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'a', name: 'Branch A', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'b', name: 'Branch B', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'merge', name: 'Merge', type: 'n8n-nodes-base.if', parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: 'Branch A' }, { node: 'Branch B' }]] },
        'Branch A': { main: [[{ node: 'Merge' }]] },
        'Branch B': { main: [[{ node: 'Merge' }]] },
      },
    };

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: workflow, inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('success');
    // workflow_execution_steps is append-only — one row per status transition
    // per attempt (e.g. 'running' then 'success'), so count terminal 'success'
    // rows to get distinct executions, not all rows for this node name.
    const mergeRuns = stepNames('success').filter((n) => n === 'Merge');
    expect(mergeRuns).toHaveLength(1);
  });

  it('fan-in after a skipped IF branch: Merge still runs exactly once (only one predecessor actually fires)', async () => {
    // Check(true) -> On True -> Merge
    //            \-> On False -> Merge   (never fires — false branch skipped)
    // Merge must still run — and exactly once — even though it's only ever
    // reached via the one branch that actually executed.
    const workflow = {
      name: 'Fan-in after IF test',
      nodes: [
        { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'cond', name: 'Check', type: 'n8n-nodes-base.if', parameters: { conditions: [{ field: 'ok', operator: 'equals', value: 'yes' }] } },
        { id: 'onTrue', name: 'On True', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'onFalse', name: 'On False', type: 'n8n-nodes-base.if', parameters: {} },
        { id: 'merge', name: 'Merge', type: 'n8n-nodes-base.if', parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: 'Check' }]] },
        Check: { main: [[{ node: 'On True' }], [{ node: 'On False' }]] },
        'On True': { main: [[{ node: 'Merge' }]] },
        'On False': { main: [[{ node: 'Merge' }]] },
      },
    };

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: workflow, inputData: { ok: 'yes' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('success');
    expect(stepNames()).toContain('On True');
    expect(stepNames()).not.toContain('On False');
    expect(stepNames('success').filter((n) => n === 'Merge')).toHaveLength(1);
  });
});
