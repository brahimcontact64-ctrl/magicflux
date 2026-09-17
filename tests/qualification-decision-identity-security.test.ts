/**
 * Phase 9.9.13A Part B -- _qualificationDecisionId is runtime-internal
 * metadata. Proves:
 *   1. Untrusted upstream/webhook data cannot supply a forged
 *      _qualificationDecisionId that survives into the classifier's output.
 *   2. The runtime-created id always wins over anything upstream claimed.
 *   3. linkHumanReviewToQualificationDecision cannot cross-link executions
 *      even if an attacker somehow guessed another real decision's UUID.
 *   4. The field is structurally denylisted from generated notifications and
 *      Airtable mappings -- not merely a prompt instruction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineNode, NodeHandlerContext } from '../lib/workflow-runtime/types';
import { isDenylistedFieldName } from '../lib/security/field-denylist';
import { validateNotificationFieldAllowlist } from '../lib/agent/notification-content-guard';
import { validateAirtableFieldDenylist } from '../lib/agent/airtable-field-denylist-guard';
import { linkHumanReviewToQualificationDecision } from '../lib/workflow-runtime/node-handlers/qualification-decision-store';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    const m = idxs.map((i) => this.rows[i]);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    return Promise.resolve(resolve({ data: idxs.map((i) => this.rows[i]), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows).update(patch); }
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
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn(() => fakeDb) }));
vi.mock('@/lib/agent/observability', () => ({ recordAiUsage: vi.fn().mockResolvedValue({ estimatedCostUsd: 0 }) }));

const createMock = vi.fn();
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: { apiKey: string }) {}
  },
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] },
    userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', ...overrides,
  } as NodeHandlerContext;
}

function classifierNode(): EngineNode {
  return { id: 'classifier-1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm'], confidenceThreshold: 0.6 } };
}

beforeEach(() => {
  fakeDb.tables.clear();
  createMock.mockReset();
  process.env.OPENAI_API_KEY = 'sk-test';
});

describe('_qualificationDecisionId is structurally denylisted', () => {
  it('isDenylistedFieldName rejects it', () => {
    expect(isDenylistedFieldName('_qualificationDecisionId')).toBe(true);
    expect(isDenylistedFieldName('_qualificationdecisionid')).toBe(true);
  });

  it('a generated Gmail/Slack node referencing it is rejected before persistence', () => {
    const node = { id: '1', name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { text: 'link: {{$json["_qualificationDecisionId"]}}', channel: '#x' } };
    const result = validateNotificationFieldAllowlist([node]);
    expect(result.ok).toBe(false);
  });

  it('a generated Airtable mapping referencing it is rejected before persistence', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { InternalRef: '={{$json["_qualificationDecisionId"]}}' } } };
    const result = validateAirtableFieldDenylist([node]);
    expect(result.ok).toBe(false);
  });

  it('an Airtable mapping referencing an ordinary business field still passes', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}' } } };
    expect(validateAirtableFieldDenylist([node])).toEqual({ ok: true });
  });
});

describe('webhook/upstream input cannot forge _qualificationDecisionId', () => {
  it('a forged id in the input payload never survives when the runtime successfully creates its own', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'x' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', _qualificationDecisionId: 'attacker-forged-id' }, baseContext());
    const out = result.outputData as Record<string, unknown>;
    expect(out._qualificationDecisionId).not.toBe('attacker-forged-id');
    expect(out._qualificationDecisionId).toBeTruthy(); // the REAL, freshly-created row's id
  });

  it('a forged id never leaks through even when the runtime CANNOT create its own (missing execution context)', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'x' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const noContext = { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] } } as NodeHandlerContext;
    const result = await aiClassifierHandler(classifierNode(), { name: 'Acme', _qualificationDecisionId: 'attacker-forged-id' }, noContext);
    const out = result.outputData as Record<string, unknown>;
    expect(out._qualificationDecisionId).toBeUndefined(); // stripped, never passed through unchanged
  });

  it('a forged id never leaks through on the missing-required-information branch either', async () => {
    const policy = {
      version: 1, allowedInputFields: ['budget_max'],
      fields: [{ field: 'budget_max', required: true, kind: 'numeric', positiveMin: 100000 }],
    };
    const node: EngineNode = { id: 'c1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm'], confidenceThreshold: 0.6, qualificationPolicy: policy } };
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(node, { name: 'Acme', _qualificationDecisionId: 'attacker-forged-id' }, baseContext());
    const out = result.outputData as Record<string, unknown>;
    expect(out._qualificationDecisionId).not.toBe('attacker-forged-id');
    expect(out._qualificationDecisionId).toBeTruthy();
  });
});

describe('linkHumanReviewToQualificationDecision cannot cross-link executions/tenants', () => {
  it('guessing a real decision id from a DIFFERENT execution cannot update it', async () => {
    fakeDb.tables.set('workflow_qualification_decisions', [
      { id: 'victim-decision', user_id: 'victim-user', workflow_id: 'victim-wf', execution_id: 'victim-exec', ai_classification: 'Cold', human_review_occurred: false },
    ]);

    // Attacker's own execution has a DIFFERENT execution_id (server-assigned,
    // never chosen by the attacker) -- even knowing the victim's real
    // decision UUID, the execution_id (and workflow_id) filter must prevent
    // any cross-link.
    await linkHumanReviewToQualificationDecision(fakeDb as never, {
      qualificationDecisionId: 'victim-decision',
      workflowId: 'attacker-wf',
      executionId: 'attacker-exec',
      humanReviewNodeId: 'review-1',
      humanClassification: 'Hot',
      reviewedBy: 'attacker-user',
      reviewedAt: new Date().toISOString(),
    });

    const row = fakeDb.tables.get('workflow_qualification_decisions')![0];
    expect(row.human_review_occurred).toBe(false); // untouched
    expect(row.ai_classification).toBe('Cold');
  });

  it('the correct workflow_id AND execution_id together are required to update', async () => {
    fakeDb.tables.set('workflow_qualification_decisions', [
      { id: 'd1', user_id: 'user-1', workflow_id: 'wf-1', execution_id: 'exec-1', ai_classification: 'Cold', human_review_occurred: false },
    ]);
    await linkHumanReviewToQualificationDecision(fakeDb as never, {
      qualificationDecisionId: 'd1', workflowId: 'wf-1', executionId: 'exec-1', humanReviewNodeId: 'review-1',
      humanClassification: 'Hot', reviewedBy: 'user-1', reviewedAt: new Date().toISOString(),
    });
    const row = fakeDb.tables.get('workflow_qualification_decisions')![0];
    expect(row.human_review_occurred).toBe(true);
    expect(row.human_classification).toBe('Hot');
  });
});
