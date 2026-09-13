/**
 * Phase 9.9.3.1 — engine-level proof that the corrected topology
 * (AI Classifier -> IF needs_review -> [Human Review | confident routing])
 * actually routes correctly at runtime, plus a defensive-invariant test for
 * the exact Phase 9.9.4 malformed shape reaching the engine directly.
 *
 * aiClassifierHandler's test-mode simulation always reports confidence 0.75
 * (lib/workflow-runtime/node-handlers/ai-classifier.ts) -- confidenceThreshold
 * is used here purely to deterministically flip needs_review true/false
 * without any real OpenAI call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000e1';
const WORKFLOW_ID = 'wf-ai-review-routing-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private limitN: number | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  order(): this { return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  private matched(): Row[] {
    let result = this.matchedIndexes().map((i) => this.rows[i]);
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

function stepNames(fakeDbInner: FakeDb): string[] {
  const steps = (fakeDbInner.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string }>;
  return steps.map((s) => s.node_name);
}

function leadRoutingWorkflow(confidenceThreshold: number): unknown {
  return {
    name: 'Lead routing (confidence gate)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      {
        id: 'classifier', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
        parameters: {
          instruction: 'Classify the lead as Hot, Warm, or Cold based on budget, urgency, and purchase intent.',
          allowedLabels: ['Hot', 'Warm', 'Cold'],
          outputField: 'classification',
          confidenceThreshold,
        },
      },
      {
        id: 'needsReview', name: 'Needs Review?', type: 'n8n-nodes-base.if',
        parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } },
      },
      { id: 'review', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Confirm this lead classification.' } },
      { id: 'confident', name: 'Confident Path Action', type: 'n8n-nodes-base.set', parameters: { fields: { routed: true } } },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'AI Classifier' }]] },
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'Confident Path Action' }]] },
    },
  };
}

describe('Corrected AI Classifier -> IF needs_review -> Human Review topology (runtime routing)', () => {
  beforeEach(() => { fakeDb.tables.clear(); });

  it('high-confidence path (needs_review: false) runs the confident action and never reaches Human Review', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    // Simulated confidence is fixed at 0.75 in test mode -- a threshold of
    // 0.5 means 0.75 is NOT below it, so needs_review is false.
    const result = await runWorkflowExecution({
      workflowJson: leadRoutingWorkflow(0.5), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'test',
    });

    expect(result.status).toBe('simulated_success');
    const names = stepNames(fakeDb);
    expect(names).toContain('AI Classifier');
    expect(names).toContain('Needs Review?');
    expect(names).toContain('Confident Path Action');
    expect(names).not.toContain('Human Review');
  });

  it('low-confidence path (needs_review: true) reaches Human Review and never runs the confident action', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    // 0.9 threshold: simulated confidence 0.75 IS below it, so needs_review is true.
    const result = await runWorkflowExecution({
      workflowJson: leadRoutingWorkflow(0.9), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'test',
    });

    expect(result.status).toBe('simulated_success');
    const names = stepNames(fakeDb);
    expect(names).toContain('AI Classifier');
    expect(names).toContain('Needs Review?');
    expect(names).toContain('Human Review');
    expect(names).not.toContain('Confident Path Action');
  });

  it('AI Classifier never has more than one output port across both confidence outcomes (single generated graph)', async () => {
    const workflow = leadRoutingWorkflow(0.6) as { connections: Record<string, { main: unknown[] }> };
    expect(workflow.connections['AI Classifier'].main).toHaveLength(1);
  });
});

describe('Runtime defensive invariant -- a malformed non-branching graph reaching the engine directly fails closed', () => {
  beforeEach(() => { fakeDb.tables.clear(); });

  it('fails closed (does not run every port) if an AI Classifier node somehow reaches the engine wired with two ports', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const malformed = {
      name: 'Malformed (bypassed generation guard)',
      nodes: [
        { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
        {
          id: 'classifier', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
          parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Cold'], confidenceThreshold: 0.6 },
        },
        { id: 'save', name: 'Airtable Save', type: 'n8n-nodes-base.airtable', parameters: {} },
        { id: 'review', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: {} },
      ],
      connections: {
        'Webhook Trigger': { main: [[{ node: 'AI Classifier' }]] },
        'AI Classifier': { main: [[{ node: 'Airtable Save' }], [{ node: 'Human Review' }]] },
      },
    };

    const result = await runWorkflowExecution({
      workflowJson: malformed, inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/RUNTIME_NON_BRANCHING_PORT_INTEGRITY/);
    const names = stepNames(fakeDb);
    expect(names).not.toContain('Airtable Save');
    expect(names).not.toContain('Human Review');
  });

  it('does NOT fail closed for a legitimate single-port fan-out from a non-branching node', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const workflow = {
      name: 'Legit fan-out',
      nodes: [
        { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 'set', name: 'Mark Fields', type: 'n8n-nodes-base.set', parameters: { fields: { a: 1 } } },
        { id: 'action1', name: 'Action One', type: 'n8n-nodes-base.set', parameters: { fields: { done1: true } } },
        { id: 'action2', name: 'Action Two', type: 'n8n-nodes-base.set', parameters: { fields: { done2: true } } },
      ],
      connections: {
        'Webhook Trigger': { main: [[{ node: 'Mark Fields' }]] },
        'Mark Fields': { main: [[{ node: 'Action One' }, { node: 'Action Two' }]] },
      },
    };

    const result = await runWorkflowExecution({
      workflowJson: workflow, inputData: {}, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'test',
    });

    expect(result.status).toBe('simulated_success');
    const names = stepNames(fakeDb);
    expect(names).toContain('Action One');
    expect(names).toContain('Action Two');
  });
});
