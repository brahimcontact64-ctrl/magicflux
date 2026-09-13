/**
 * Phase 9.9.2 — Durable Human Review / Approval, engine-level integration.
 *
 * Drives the REAL WorkflowEngine + humanReviewHandler against a mocked
 * Supabase client (same fake-DB harness as tests/dag-branching.test.ts),
 * proving the full pause -> decision -> resume -> correct-branch flow --
 * not just the handler in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000d5';
const WORKFLOW_ID = 'wf-review-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
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
  insert(row: Row): FakeQuery | Promise<{ error: null }> {
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

function stepNames(status?: string): string[] {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
  return steps.filter((s) => !status || s.status === status).map((s) => s.node_name);
}

function reviewWorkflow(): unknown {
  return {
    name: 'Review test',
    nodes: [
      { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { id: 'review', name: 'Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Approve or reject this order.' } },
      { id: 'approved', name: 'Approved Action', type: 'n8n-nodes-base.set', parameters: { fields: { status: 'approved' } } },
      { id: 'rejected', name: 'Rejected Action', type: 'n8n-nodes-base.set', parameters: { fields: { status: 'rejected' } } },
    ],
    connections: {
      Trigger: { main: [[{ node: 'Review' }]] },
      Review: { main: [[{ node: 'Approved Action' }], [{ node: 'Rejected Action' }]] },
    },
  };
}

describe('Human Review pause/resume (runtime/workflow-engine.ts + human-review.ts)', () => {
  beforeEach(() => { fakeDb.tables.clear(); });

  it('pauses execution and does NOT run either downstream branch before a decision exists', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: reviewWorkflow(), inputData: { orderId: 'ord-1' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('waiting');
    expect(result.nextRunAt).toBeUndefined();
    expect(stepNames()).not.toContain('Approved Action');
    expect(stepNames()).not.toContain('Rejected Action');

    const reviewRows = fakeDb.tables.get('workflow_review_items') ?? [];
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0].status).toBe('pending');
    expect(reviewRows[0].execution_id).toBe(result.executionId);
  });

  it('approve resumes the SAME execution and runs only the approve branch', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: reviewWorkflow(), inputData: { orderId: 'ord-2' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    // Simulate the decide endpoint's CAS update (the real route does the
    // same UPDATE ... WHERE status = 'pending').
    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'approved';
    reviewRows[0].decision_outcome = 'approve';
    reviewRows[0].reviewed_by = USER_ID;

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: reviewWorkflow(), mode: 'live', inputData: {},
    });

    expect(resumed.status).toBe('success');
    expect(stepNames()).toContain('Approved Action');
    expect(stepNames()).not.toContain('Rejected Action');
  });

  it('reject resumes the SAME execution and runs only the reject branch', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: reviewWorkflow(), inputData: { orderId: 'ord-3' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'rejected';
    reviewRows[0].decision_outcome = 'reject';
    reviewRows[0].reviewed_by = USER_ID;

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: reviewWorkflow(), mode: 'live', inputData: {},
    });

    expect(resumed.status).toBe('success');
    expect(stepNames()).toContain('Rejected Action');
    expect(stepNames()).not.toContain('Approved Action');
  });

  it('a resume attempt while still pending (no decision yet) waits again -- never guesses a branch', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: reviewWorkflow(), inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: reviewWorkflow(), mode: 'live', inputData: {},
    });

    expect(resumed.status).toBe('waiting');
    expect(stepNames()).not.toContain('Approved Action');
    expect(stepNames()).not.toContain('Rejected Action');
  });
});
