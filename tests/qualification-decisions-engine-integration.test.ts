/**
 * Phase 9.9.13 -- engine-level proof of the durable AI qualification
 * feedback record (workflow_qualification_decisions) AND the Part J SLA
 * gating reference topology, driven against the REAL WorkflowEngine +
 * ai-classifier.ts + human-review.ts + wait-for-acknowledgment.ts, mocked
 * Supabase/OpenAI/provider fetch -- same harness shape as
 * tests/human-review-classification-truth.test.ts and
 * tests/wait-for-acknowledgment-engine-integration.test.ts, combined here
 * because this is exactly the intersection Part J/L are about: Hot alone
 * gets the SLA acknowledgment, and every branch gets a qualification
 * feedback record.
 *
 * Reference topology (Part J):
 *   AI Classifier -> If Hot  -> Create Challenge -> Airtable -> Gmail -> Slack -> Wait For Ack -> (Handled/Escalation)
 *                 -> If Warm -> Airtable -> Gmail
 *                 -> If Cold -> Airtable
 * Human Review's own outcome ports feed the SAME per-label terminal chains.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000cd';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000ce';
const WORKFLOW_ID = 'wf-qualification-engine-test';

type Row = Record<string, unknown>;

// Simulates workflow_qualification_decisions.overridden, a real Postgres
// STORED GENERATED column (human_classification IS NOT NULL AND
// human_classification IS DISTINCT FROM ai_classification) -- application
// code never sets it directly, so this fake must derive it the same way
// real Postgres would whenever a row with both columns is touched.
function applyGeneratedColumns(row: Row): void {
  if ('ai_classification' in row) {
    row.overridden = row.human_classification != null && row.human_classification !== row.ai_classification;
  }
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) if (this.filters.every(([c, v]) => this.rows[i][c] === v)) this.rows.splice(i, 1);
      return { data: null, error: null };
    }
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) { Object.assign(this.rows[i], this.pendingPatch); applyGeneratedColumns(this.rows[i]); }
    const m = idxs.map((i) => this.rows[i]);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const removeIdx = new Set(this.matchedIndexes());
      const kept = this.rows.filter((_, i) => !removeIdx.has(i));
      this.rows.length = 0; this.rows.push(...kept);
      return Promise.resolve(resolve({ data: [], error: null }));
    }
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) { Object.assign(this.rows[i], this.pendingPatch); applyGeneratedColumns(this.rows[i]); }
    return Promise.resolve(resolve({ data: idxs.map((i) => this.rows[i]), error: null }));
  }
}

class FakeUniqueHandle {
  constructor(private rows: Row[], private keyCols: string[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows, 'select').update(patch); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => this.keyCols.every((c) => r[c] === row[c]));
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string; message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } })) };
    }
    const inserted: Row = { id: `row-${this.rows.length + 1}-${Math.random().toString(36).slice(2)}`, ...row };
    applyGeneratedColumns(inserted);
    this.rows.push(inserted);
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  delete(): FakeQuery { return new FakeQuery(this.rows, 'delete'); }
  insert(row: Row): FakeQuery {
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    return new FakeQuery([withId], 'select');
  }
  update(patch: Row): FakeQuery {
    return new FakeQuery(this.rows, 'select').update(patch);
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
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle | FakeUniqueHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    const rows = this.tables.get(name)!;
    if (name === 'workflow_acknowledgments') return new FakeUniqueHandle(rows, ['execution_id', 'node_id']);
    if (name === 'workflow_qualification_decisions') return new FakeUniqueHandle(rows, ['execution_id', 'classifier_node_id']);
    if (name === 'workflow_review_items') return new FakeUniqueHandle(rows, ['execution_id', 'node_id']);
    if (name === 'workflow_side_effects') return new FakeUniqueHandle(rows, ['execution_id', 'node_id', 'effect_key']);
    return new FakeTableHandle(rows);
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
}));

// Lets the REAL ai-classifier.ts run end-to-end (including the new Phase
// 9.9.13 persistence calls) without a real network call -- only the OpenAI
// SDK boundary is mocked, exactly the boundary aiClassifierHandler itself
// owns and validates the response of.
let nextClassifierReply: { classification: string; confidence: number; reason?: string; contradictions?: string[] } = {
  classification: 'Hot', confidence: 0.9,
};
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({ reason: 'mock reason', ...nextClassifierReply }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    };
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const AIRTABLE_CREDS = { personal_access_token: 'pat-fake', base_id: 'appREAL' };
const SLACK_CREDS = { bot_token: 'xoxb-fake' };
const GMAIL_CREDS = { access_token: 'ya29-fake' };

async function seedIntegrations(userId: string) {
  const existing = (fakeDb.tables.get('user_integrations') ?? []) as Row[];
  fakeDb.tables.set('user_integrations', [
    ...existing,
    { id: `i1-${userId}`, user_id: userId, provider: 'airtable', credentials: AIRTABLE_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: `i2-${userId}`, user_id: userId, provider: 'slack', credentials: SLACK_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: `i3-${userId}`, user_id: userId, provider: 'gmail', credentials: GMAIL_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
  ]);
}

function qualificationRows(): Row[] {
  return (fakeDb.tables.get('workflow_qualification_decisions') ?? []) as Row[];
}
function ackRows(): Row[] {
  return (fakeDb.tables.get('workflow_acknowledgments') ?? []) as Row[];
}

// Part J reference topology: classifier -> chained If Hot/Warm/Cold, each
// branch's own terminal actions, Hot alone gated behind the SLA pair.
function topology(confidenceThreshold: number): unknown {
  return {
    name: 'Lead qualification + SLA (Phase 9.9.13 engine test)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'classifier', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold } },
      { id: 'needsReview', name: 'Needs Review?', type: 'n8n-nodes-base.if', parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } } },
      { id: 'review', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Confirm.', allowedOutcomes: ['Hot', 'Warm', 'Cold'], outputField: 'classification' } },
      { id: 'ifHot', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } },
      { id: 'ifWarm', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } },
      { id: 'challenge', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes: 15 } },
      { id: 'airtableHot', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
      { id: 'gmailHot', name: 'Gmail Hot', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Hot lead', text: 'Acknowledge: {{$json["acknowledgment_url"]}}' } },
      { id: 'slackHot', name: 'Slack Hot', type: 'n8n-nodes-base.slack', parameters: { text: 'Hot: {{$json["acknowledgment_url"]}}', channel: '#leads-hot' } },
      { id: 'ack', name: 'Wait For Acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes: 15 } },
      { id: 'handled', name: 'Marked Handled', type: 'n8n-nodes-base.slack', parameters: { text: 'Lead handled', channel: '#leads-handled' } },
      { id: 'escalate', name: 'Escalation Notice', type: 'n8n-nodes-base.slack', parameters: { text: 'SLA BREACHED', channel: '#leads-escalation' } },
      { id: 'airtableWarm', name: 'Airtable Warm', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
      { id: 'gmailWarm', name: 'Gmail Warm', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Warm lead', text: 'x' } },
      { id: 'airtableCold', name: 'Airtable Cold', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'AI Classifier' }]] },
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'If Hot' }]] },
      'Human Review': { main: [[{ node: 'Create Acknowledgment Challenge' }], [{ node: 'Airtable Warm' }, { node: 'Gmail Warm' }], [{ node: 'Airtable Cold' }]] },
      'If Hot': { main: [[{ node: 'Create Acknowledgment Challenge' }], [{ node: 'If Warm' }]] },
      'If Warm': { main: [[{ node: 'Airtable Warm' }, { node: 'Gmail Warm' }], [{ node: 'Airtable Cold' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Airtable Hot' }]] },
      'Airtable Hot': { main: [[{ node: 'Gmail Hot' }]] },
      'Gmail Hot': { main: [[{ node: 'Slack Hot' }]] },
      'Slack Hot': { main: [[{ node: 'Wait For Acknowledgment' }]] },
      'Wait For Acknowledgment': { main: [[{ node: 'Marked Handled' }], [{ node: 'Escalation Notice' }]] },
    },
  };
}

function setClassifierReply(reply: typeof nextClassifierReply) {
  nextClassifierReply = reply;
}

describe('Phase 9.9.13 -- qualification decisions + SLA gating reference topology', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    process.env.OPENAI_API_KEY = 'test-key';
    vi.resetModules();
    await seedIntegrations(USER_ID);
    setClassifierReply({ classification: 'Hot', confidence: 0.9 });
  });

  it('automatic Hot: creates exactly one qualification decision row AND exactly one acknowledgment challenge', async () => {
    setClassifierReply({ classification: 'Hot', confidence: 0.95 });
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    expect(result.status).toBe('waiting');
    expect(qualificationRows()).toHaveLength(1);
    expect(qualificationRows()[0].ai_classification).toBe('Hot');
    expect(qualificationRows()[0].final_classification).toBe('Hot');
    expect(qualificationRows()[0].human_review_occurred).toBe(false);
    expect(ackRows()).toHaveLength(1);
  });

  it('automatic Warm: creates exactly one qualification decision row and ZERO acknowledgment challenges', async () => {
    setClassifierReply({ classification: 'Warm', confidence: 0.9 });
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    expect(result.status).toBe('success');
    expect(qualificationRows()).toHaveLength(1);
    expect(qualificationRows()[0].ai_classification).toBe('Warm');
    expect(ackRows()).toHaveLength(0);
  });

  it('automatic Cold: creates exactly one qualification decision row and ZERO acknowledgment challenges', async () => {
    setClassifierReply({ classification: 'Cold', confidence: 0.9 });
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    expect(result.status).toBe('success');
    expect(qualificationRows()).toHaveLength(1);
    expect(qualificationRows()[0].ai_classification).toBe('Cold');
    expect(ackRows()).toHaveLength(0);
  });

  it('low-confidence AI -> human CONFIRMS the same label: final == ai, overridden is falsy', async () => {
    setClassifierReply({ classification: 'Warm', confidence: 0.3 }); // below 0.6 threshold -> needs_review
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting'); // parked at Human Review

    expect(qualificationRows()).toHaveLength(1);
    const decisionId = qualificationRows()[0].id;

    const reviewRow = (fakeDb.tables.get('workflow_review_items') as Row[])[0];
    reviewRow.status = 'resumed';
    reviewRow.decision_outcome = 'Warm'; // confirms the AI's own proposal
    reviewRow.reviewed_by = USER_ID;
    reviewRow.reviewed_at = new Date().toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });
    expect(resumed.status).toBe('success');

    const row = qualificationRows().find((r) => r.id === decisionId)!;
    expect(row.ai_classification).toBe('Warm');
    expect(row.human_classification).toBe('Warm');
    expect(row.final_classification).toBe('Warm');
    expect(row.human_review_occurred).toBe(true);
    expect(row.overridden).toBeFalsy();
  });

  it('low-confidence AI -> human CHANGES the label (Cold -> Warm): ai/human/final all recorded distinctly, history never rewritten', async () => {
    setClassifierReply({ classification: 'Cold', confidence: 0.2 });
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const decisionId = qualificationRows()[0].id;
    expect(qualificationRows()[0].ai_classification).toBe('Cold');

    const reviewRow = (fakeDb.tables.get('workflow_review_items') as Row[])[0];
    reviewRow.status = 'resumed';
    reviewRow.decision_outcome = 'Warm'; // AI said Cold, human overrides to Warm
    reviewRow.reviewed_by = USER_ID;
    reviewRow.reviewed_at = new Date().toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });
    expect(resumed.status).toBe('success');

    const row = qualificationRows().find((r) => r.id === decisionId)!;
    // Part C -- never rewritten: ai_classification still says what the AI ACTUALLY originally said.
    expect(row.ai_classification).toBe('Cold');
    expect(row.human_classification).toBe('Warm');
    expect(row.final_classification).toBe('Warm');
    expect(row.overridden).toBe(true);
    expect(qualificationRows()).toHaveLength(1); // never a second row
  });

  it('Human Review -> Hot creates exactly one acknowledgment challenge (the SAME Hot chain the confident path uses)', async () => {
    setClassifierReply({ classification: 'Cold', confidence: 0.1 }); // low confidence -> Human Review
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');
    expect(ackRows()).toHaveLength(0); // nothing created yet -- AI proposed Cold

    const reviewRow = (fakeDb.tables.get('workflow_review_items') as Row[])[0];
    reviewRow.status = 'resumed';
    reviewRow.decision_outcome = 'Hot'; // human overrides Cold -> Hot
    reviewRow.reviewed_by = USER_ID;
    reviewRow.reviewed_at = new Date().toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });
    expect(resumed.status).toBe('waiting'); // now parked at the SLA wait node
    expect(ackRows()).toHaveLength(1);

    // Part D -- AI Cold -> Human Hot must produce exactly this shape.
    const decisionRow = qualificationRows()[0];
    expect(decisionRow.ai_classification).toBe('Cold');
    expect(decisionRow.human_classification).toBe('Hot');
    expect(decisionRow.final_classification).toBe('Hot');
    expect(decisionRow.human_review_occurred).toBe(true);
    expect(decisionRow.overridden).toBe(true);
  });

  it('Part D: a duplicate review resume/decision does not mutate the historical human decision or double-count the event', async () => {
    setClassifierReply({ classification: 'Cold', confidence: 0.1 });
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    const reviewRow = (fakeDb.tables.get('workflow_review_items') as Row[])[0];
    reviewRow.status = 'resumed';
    reviewRow.decision_outcome = 'Hot';
    reviewRow.reviewed_by = USER_ID;
    reviewRow.reviewed_at = new Date().toISOString();

    await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });
    const afterFirst = { ...qualificationRows()[0] };

    // A second, duplicate resume of the SAME already-decided review item
    // (e.g. a racing recovery sweep) must not create a second row, flip
    // human_review_occurred off and on again, or silently change the
    // recorded human decision.
    await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });

    expect(qualificationRows()).toHaveLength(1);
    expect(qualificationRows()[0]).toEqual(afterFirst);
  });

  it('duplicate Hot recovery does not create another acknowledgment challenge or another qualification decision row', async () => {
    setClassifierReply({ classification: 'Hot', confidence: 0.95 });
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(ackRows()).toHaveLength(1);
    expect(qualificationRows()).toHaveLength(1);

    const ackRow = ackRows()[0];
    ackRow.status = 'acknowledged';

    // Resume twice (duplicate recovery / racing sweep) -- neither a second
    // ack row nor a second qualification decision row should ever appear.
    await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });
    await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.6), mode: 'live', inputData: {} });

    expect(ackRows()).toHaveLength(1);
    expect(qualificationRows()).toHaveLength(1);
  });

  it('tenant isolation: two different users classifying concurrently each get their own row, never cross-visible', async () => {
    await seedIntegrations(OTHER_USER_ID);
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');

    setClassifierReply({ classification: 'Hot', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    setClassifierReply({ classification: 'Warm', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Beta' }, userId: OTHER_USER_ID, workflowId: 'wf-other-tenant', mode: 'live' });

    const rows = qualificationRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.user_id === USER_ID)?.ai_classification).toBe('Hot');
    expect(rows.find((r) => r.user_id === OTHER_USER_ID)?.ai_classification).toBe('Warm');
  });

  it('workflow isolation: two different workflows for the SAME user each get their own row', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    setClassifierReply({ classification: 'Hot', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    setClassifierReply({ classification: 'Cold', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Beta' }, userId: USER_ID, workflowId: 'wf-a-second-workflow', mode: 'live' });

    const rows = qualificationRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.workflow_id === WORKFLOW_ID)?.ai_classification).toBe('Hot');
    expect(rows.find((r) => r.workflow_id === 'wf-a-second-workflow')?.ai_classification).toBe('Cold');
  });

  it('policy-version separation: the SAME classifier config always hashes the same; a different config hashes differently', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    setClassifierReply({ classification: 'Hot', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    setClassifierReply({ classification: 'Warm', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Beta' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    // A DIFFERENT confidenceThreshold is a genuinely different ruleset.
    setClassifierReply({ classification: 'Cold', confidence: 0.9 });
    await runWorkflowExecution({ workflowJson: topology(0.9), inputData: { name: 'Gamma' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    const rows = qualificationRows();
    expect(rows).toHaveLength(3);
    const hashes = new Set(rows.map((r) => r.classification_policy_hash));
    expect(hashes.size).toBe(2); // first two share a hash, the third (different threshold) does not
  });

  it('no PII/raw payload/chain-of-thought stored: only classification metadata, never the raw lead fields or prompt text', async () => {
    setClassifierReply({ classification: 'Hot', confidence: 0.9 });
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    await runWorkflowExecution({ workflowJson: topology(0.6), inputData: { name: 'Acme', email: 'lead@example.com', phone: '555-1234' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    const row = qualificationRows()[0];
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('lead@example.com');
    expect(serialized).not.toContain('555-1234');
    expect(row.ai_reason).not.toMatch(/\$json|prompt|instruction/i);
  });
});
