/**
 * Phase 9.9.13 -- aiClassifierHandler's own durable qualification-decision
 * persistence (as opposed to tests/qualification-decisions-engine-integration.test.ts,
 * which proves the SAME thing end-to-end through the real engine). This
 * file exercises the handler directly, with a full execution context, so
 * the missing-information and contradiction-forced-review branches --
 * which never reach the "successful classification" code path -- are each
 * proven to record a decision row with the right qualification_status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineNode, NodeHandlerContext } from '../lib/workflow-runtime/types';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.classifier_node_id === row.classifier_node_id);
    if (conflict) {
      return { then: (resolve: (v: { error: { message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { message: 'duplicate key value violates unique constraint' } })) };
    }
    this.rows.push({ id: `row-${this.rows.length + 1}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
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
}));

vi.mock('@/lib/agent/observability', () => ({
  recordAiUsage: vi.fn().mockResolvedValue({ estimatedCostUsd: 0 }),
}));

const createMock = vi.fn();
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: { apiKey: string }) {}
  },
}));

function mockCompletion(content: Record<string, unknown>) {
  createMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
}

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] },
    userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', ...overrides,
  } as NodeHandlerContext;
}

const POLICY = {
  version: 1,
  allowedInputFields: ['budget_max', 'purchase_intent'],
  fields: [
    { field: 'budget_max', required: true, kind: 'numeric', positiveMin: 100000, negativeMax: 10000 },
    { field: 'purchase_intent', required: false, kind: 'enum', positiveValues: ['ready-to-start'], negativeValues: ['just-browsing'] },
  ],
  contradictions: [{ positiveField: 'budget_max', negativeField: 'purchase_intent', note: 'High budget but low purchase intent' }],
};

function classifierNode(overrides: Record<string, unknown> = {}): EngineNode {
  return {
    id: 'classifier-1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
    parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold: 0.6, qualificationPolicy: POLICY, ...overrides },
  };
}

beforeEach(() => {
  fakeDb.tables.clear();
  createMock.mockReset();
  process.env.OPENAI_API_KEY = 'sk-test';
});

describe('aiClassifierHandler qualification decision persistence (Phase 9.9.13)', () => {
  it('missing required information -> Human Review: records a row with qualification_status "needs_information"', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme' }, baseContext()); // budget_max absent

    expect(result.status).toBe('success');
    const out = result.outputData as Record<string, unknown>;
    expect(out.needs_review).toBe(true);
    expect(out._qualificationDecisionId).toBeTruthy();

    const rows = fakeDb.tables.get('workflow_qualification_decisions')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].qualification_status).toBe('needs_information');
    expect(rows[0].missing_required_fields).toEqual(['budget_max']);
    expect(rows[0].human_review_occurred).toBe(false);
  });

  it('a structural contradiction forces review: records a row with qualification_status "needs_review" and the contradiction note', async () => {
    mockCompletion({ classification: 'Hot', confidence: 0.95, reason: 'High budget.' });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000, purchase_intent: 'just-browsing' }, baseContext());

    expect(result.status).toBe('success');
    const out = result.outputData as Record<string, unknown>;
    expect(out.needs_review).toBe(true); // forced despite 0.95 confidence

    const rows = fakeDb.tables.get('workflow_qualification_decisions')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].qualification_status).toBe('needs_review');
    expect(rows[0].contradictions).toEqual(['High budget but low purchase intent']);
    expect(rows[0].ai_confidence).toBe(0.95); // the AI's real confidence is still recorded honestly
  });

  it('a confident, uncontested classification records qualification_status "classified"', async () => {
    mockCompletion({ classification: 'Hot', confidence: 0.95, reason: 'High budget and strong intent.' });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());

    expect(result.status).toBe('success');
    const rows = fakeDb.tables.get('workflow_qualification_decisions')!;
    expect(rows[0].qualification_status).toBe('classified');
    expect(rows[0].human_review_occurred).toBe(false);
    expect(rows[0].final_classification).toBe('Hot');
  });

  it('test mode never writes a durable row (matches every other durable capability\'s own precedent)', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000 }, baseContext({ mode: 'test' }));
    expect(result.status).toBe('simulated_success');
    expect(fakeDb.tables.get('workflow_qualification_decisions') ?? []).toHaveLength(0);
  });

  it('missing execution context (no userId/workflowId/executionId) never throws and never writes a row', async () => {
    mockCompletion({ classification: 'Hot', confidence: 0.9, reason: 'x' });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const node: EngineNode = { id: 'c1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm'], confidenceThreshold: 0.6 } };
    const result = await aiClassifierHandler(node, { name: 'Acme' }, { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] } } as NodeHandlerContext);
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>)._qualificationDecisionId).toBeUndefined();
    expect(fakeDb.tables.get('workflow_qualification_decisions') ?? []).toHaveLength(0);
  });

  it('a retried invocation of the SAME classifier node in the SAME execution is idempotent -- never a second row', async () => {
    mockCompletion({ classification: 'Hot', confidence: 0.9, reason: 'x' });
    mockCompletion({ classification: 'Hot', confidence: 0.9, reason: 'x' });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const node = classifierNode();
    await aiClassifierHandler(node, { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());
    await aiClassifierHandler(node, { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());
    expect(fakeDb.tables.get('workflow_qualification_decisions')).toHaveLength(1);
  });

  it('Part C: malformed model output, retried internally (bounded), creates ZERO rows if every attempt stays malformed', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'not json at all' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());
    expect(result.status).toBe('failed');
    expect(fakeDb.tables.get('workflow_qualification_decisions') ?? []).toHaveLength(0);
  });

  it('Part C: malformed output on attempt 1, valid on attempt 2 -- creates EXACTLY ONE row, not one per attempt', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Recovered on retry.' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());
    expect(result.status).toBe('success');
    expect(fakeDb.tables.get('workflow_qualification_decisions')).toHaveLength(1);
    expect(fakeDb.tables.get('workflow_qualification_decisions')![0].ai_reason).toBe('Recovered on retry.');
  });

  it('Part C: a real network/API failure (never retried) creates zero rows', async () => {
    createMock.mockRejectedValueOnce(new Error('network down'));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', budget_max: 500000, purchase_intent: 'ready-to-start' }, baseContext());
    expect(result.status).toBe('failed');
    expect(fakeDb.tables.get('workflow_qualification_decisions') ?? []).toHaveLength(0);
  });
});
