/**
 * Phase 9.9.4C — Human Review classification truth + Airtable Confidence
 * mapping, engine-level proof.
 *
 * Drives the REAL WorkflowEngine + ExecutionManager against mocked Supabase
 * and mocked provider fetch calls (Airtable/Slack/Gmail), using the
 * corrected topology: AI Classifier -> Needs Review? -> Human Review (with
 * "outputField": "classification" configured) -> terminal action sets
 * (Airtable + Slack + Gmail for Hot, Airtable + Gmail for Warm, Airtable
 * only for Cold) -- matching the real certified production shape, but with
 * an Airtable "Classification" field mapped as a real expression
 * (={{$json["classification"]}}) rather than a per-node literal, so the
 * classification-truth fix is actually exercised end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000fa';
const WORKFLOW_ID = 'wf-classification-truth-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  private matched(): Row[] {
    if (this.pendingPatch) for (const i of this.matchedIndexes()) Object.assign(this.rows[i], this.pendingPatch);
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
    return new FakeQuery(this.rows, 'select').update(patch);
  }
}

// Phase 9.9.11A -- Part 7: unlike the generic FakeTableHandle above (whose
// insert() never conflicts), workflow_side_effects' real DB behavior this
// harness must faithfully model is its UNIQUE(execution_id, node_id,
// effect_key) constraint -- lib/runtime/side-effect-ledger.ts's
// claimSideEffect() depends on a genuine 23505 conflict to detect an
// already-claimed effect, exactly like the applied migration guarantees.
class FakeSideEffectsHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows, 'select').update(patch); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id && r.effect_key === row.effect_key);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string; message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505', message: 'duplicate key' } })) };
    }
    this.rows.push({ id: `ledger-${this.rows.length + 1}`, updated_at: new Date().toISOString(), ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle | FakeSideEffectsHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    const rows = this.tables.get(name)!;
    if (name === 'workflow_side_effects') return new FakeSideEffectsHandle(rows);
    return new FakeTableHandle(rows);
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
  getUserFromAccessToken: vi.fn(),
  getBearerToken: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stepNames(status?: string): string[] {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
  return steps.filter((s) => !status || s.status === status).map((s) => s.node_name);
}

function stepOutputData(nodeName: string): Record<string, unknown> | undefined {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string; output_data: unknown }>;
  const step = [...steps].reverse().find((s) => s.node_name === nodeName && s.status === 'success');
  return step?.output_data as Record<string, unknown> | undefined;
}

// Corrected topology (HUMAN DECISION AUTHORITY CONTRACT, Phase 9.9.3.2/
// 9.9.4C): Human Review's own outcome ports feed the SAME terminal action
// nodes the normal chain uses, AND its "outputField" is configured so a
// human's decision becomes the canonical "classification" for every
// downstream reader, including the Airtable expression mapping below.
function topology(confidenceThreshold: number): unknown {
  return {
    name: 'Lead routing (classification truth)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      {
        id: 'classifier', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
        parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold },
      },
      {
        id: 'needsReview', name: 'Needs Review?', type: 'n8n-nodes-base.if',
        parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } },
      },
      { id: 'review', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Confirm.', allowedOutcomes: ['Hot', 'Warm', 'Cold'], outputField: 'classification' } },
      { id: 'ifHot', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } },
      { id: 'ifWarm', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } },
      {
        id: 'airtableHot', name: 'Save to Airtable (Hot)', type: 'n8n-nodes-base.airtable',
        parameters: { baseId: 'appREAL0000000000', tableId: 'tblREAL0000000000', operation: 'create', fields: { Name: '={{$json["name"]}}', Classification: '={{$json["classification"]}}', Confidence: '={{$json["confidence"]}}' } },
      },
      { id: 'slackHot', name: 'Slack Notification (Hot)', type: 'n8n-nodes-base.slack', parameters: { text: 'Hot lead', channel: '#leads' } },
      { id: 'emailHot', name: 'Send Email (Hot)', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Hot lead', text: 'x' } },
      {
        id: 'airtableWarm', name: 'Save to Airtable (Warm)', type: 'n8n-nodes-base.airtable',
        parameters: { baseId: 'appREAL0000000000', tableId: 'tblREAL0000000000', operation: 'create', fields: { Name: '={{$json["name"]}}', Classification: '={{$json["classification"]}}', Confidence: '={{$json["confidence"]}}' } },
      },
      { id: 'emailWarm', name: 'Send Email (Warm)', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Warm lead', text: 'x' } },
      {
        id: 'airtableCold', name: 'Save to Airtable (Cold)', type: 'n8n-nodes-base.airtable',
        parameters: { baseId: 'appREAL0000000000', tableId: 'tblREAL0000000000', operation: 'create', fields: { Name: '={{$json["name"]}}', Classification: '={{$json["classification"]}}', Confidence: '={{$json["confidence"]}}' } },
      },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'AI Classifier' }]] },
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'If Hot' }]] },
      'Human Review': {
        main: [
          [{ node: 'Save to Airtable (Hot)' }, { node: 'Slack Notification (Hot)' }, { node: 'Send Email (Hot)' }],
          [{ node: 'Save to Airtable (Warm)' }, { node: 'Send Email (Warm)' }],
          [{ node: 'Save to Airtable (Cold)' }],
        ],
      },
      'If Hot': { main: [[{ node: 'Save to Airtable (Hot)' }, { node: 'Slack Notification (Hot)' }, { node: 'Send Email (Hot)' }], [{ node: 'If Warm' }]] },
      'If Warm': { main: [[{ node: 'Save to Airtable (Warm)' }, { node: 'Send Email (Warm)' }], [{ node: 'Save to Airtable (Cold)' }]] },
    },
  };
}

const AIRTABLE_CREDS = { personal_access_token: 'pat-fake', base_id: 'appREAL0000000000' };
const SLACK_CREDS = { bot_token: 'xoxb-fake' };
const GMAIL_CREDS = { access_token: 'ya29-fake' };

async function seedIntegrations() {
  fakeDb.tables.set('user_integrations', [
    { id: 'i1', user_id: USER_ID, provider: 'airtable', credentials: AIRTABLE_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: 'i2', user_id: USER_ID, provider: 'slack', credentials: SLACK_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: 'i3', user_id: USER_ID, provider: 'gmail', credentials: GMAIL_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
  ]);
}

function withMockedClassifier(classification: string, confidence: number) {
  vi.doMock('../lib/workflow-runtime/node-handlers/ai-classifier', () => ({
    aiClassifierHandler: async (node: { parameters?: Record<string, unknown> }, inputData: unknown) => {
      const params = node.parameters ?? {};
      const threshold = typeof params.confidenceThreshold === 'number' ? params.confidenceThreshold : 0.6;
      const data = (inputData && typeof inputData === 'object') ? inputData as Record<string, unknown> : {};
      return {
        status: 'success',
        // ai_confidence mirrors the real ai-classifier.ts handler's Phase
        // 9.9.9 Part F addition -- always equal to confidence, never
        // touched by humanReviewHandler on resume.
        outputData: { ...data, classification, confidence, ai_confidence: confidence, reason: 'mocked', needs_review: confidence < threshold },
        logs: ['mocked classifier'],
      };
    },
  }));
}

describe('Human Review classification truth + Airtable Confidence mapping (Phase 9.9.4C)', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('confident AI path: preserves the AI classification and numeric confidence in the Airtable record', async () => {
    withMockedClassifier('Hot', 0.9);
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('success');
    expect(stepNames('success')).toContain('Save to Airtable (Hot)');
    expect(stepNames('success')).not.toContain('Human Review');

    const airtableCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.airtable.com'));
    const body = JSON.parse(airtableCall![1].body);
    expect(body.fields.Classification).toBe('Hot');
    expect(body.fields.Confidence).toBe(0.9);
    expect(typeof body.fields.Confidence).toBe('number');
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });

  it('low-confidence execution pauses BEFORE any Airtable/Slack/Email side effect', async () => {
    withMockedClassifier('Hot', 0.4);
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    expect(result.status).toBe('waiting');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.airtable.com'))).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('slack.com'))).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com'))).toHaveLength(0);

    const reviewRows = fakeDb.tables.get('workflow_review_items') ?? [];
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0].status).toBe('pending');
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });

  it('reviewer selecting Warm (disagreeing with AI\'s Hot): downstream classification equals the HUMAN-selected outcome, not the stale AI value', async () => {
    withMockedClassifier('Hot', 0.4);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });
    expect(started.status).toBe('waiting');

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Warm';

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });
    expect(resumed.status).toBe('success');

    // Exactly the Warm outcome's own action set ran, resumed exactly once.
    const successNames = stepNames('success');
    expect(successNames).toContain('Save to Airtable (Warm)');
    expect(successNames).toContain('Send Email (Warm)');
    expect(successNames).not.toContain('Save to Airtable (Hot)');
    expect(successNames).not.toContain('Save to Airtable (Cold)');
    expect(successNames.filter((n) => n === 'Save to Airtable (Warm)')).toHaveLength(1);

    // _conditionBranch still corresponds to the selected outcome (Warm = index 1).
    const reviewOutput = stepOutputData('Human Review');
    expect(reviewOutput?._conditionBranch).toBe(1);
    expect(reviewOutput?.classification).toBe('Warm');

    // The Airtable record written for the Warm outcome reflects the HUMAN
    // decision, not the AI's stale "Hot" classification.
    const airtableCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.airtable.com'));
    const body = JSON.parse(airtableCall![1].body);
    expect(body.fields.Classification).toBe('Warm');
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });

  it('duplicate review resume causes no duplicate Airtable/Slack/Email side effects', async () => {
    withMockedClassifier('Cold', 0.3);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Hot';

    fakeDb.tables.set('workflows', [{ id: WORKFLOW_ID, user_id: USER_ID, workflow_json: topology(0.6) }]);

    const { attemptReviewResume } = await import('../lib/runtime/review-resume');
    const item = {
      id: String(reviewRows[0].id),
      user_id: USER_ID,
      workflow_id: WORKFLOW_ID,
      execution_id: started.executionId,
      node_id: String(reviewRows[0].node_id),
      node_name: String(reviewRows[0].node_name ?? ''),
      deployment_version_id: null,
      mode: 'live' as const,
    };

    const first = await attemptReviewResume(item);
    expect(first.resumed).toBe(true);

    // A duplicate/retried resume against the same already-decided item.
    reviewRows[0].status = 'resume_pending';
    const second = await attemptReviewResume(item);
    expect(second.resumed).toBe(true);

    const airtableCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('api.airtable.com'));
    const slackCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('slack.com'));
    const emailCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com'));
    expect(airtableCalls).toHaveLength(1);
    expect(slackCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });
});

// ─── Phase 9.9.9 -- Part E: the two specific override scenarios requested ──

describe('Human Review outcome override -- Phase 9.9.9 Part E regression scenarios', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('AI says Cold at low confidence -> Human selects Warm -> downstream classification === "Warm"', async () => {
    withMockedClassifier('Cold', 0.2);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });
    expect(started.status).toBe('waiting');

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Warm';

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });
    expect(resumed.status).toBe('success');

    const successNames = stepNames('success');
    expect(successNames).toContain('Save to Airtable (Warm)');
    expect(successNames).toContain('Send Email (Warm)');
    expect(successNames).not.toContain('Save to Airtable (Cold)');
    expect(successNames).not.toContain('Save to Airtable (Hot)');

    const reviewOutput = stepOutputData('Human Review');
    expect(reviewOutput?.classification).toBe('Warm');
    expect(reviewOutput?._conditionBranch).toBe(1); // Warm is index 1 of ["Hot","Warm","Cold"]

    const airtableCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.airtable.com'));
    const body = JSON.parse(airtableCall![1].body);
    expect(body.fields.Classification).toBe('Warm');
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });

  it('AI says Warm at low confidence -> Human selects Hot -> downstream classification === "Hot"', async () => {
    withMockedClassifier('Warm', 0.3);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });
    expect(started.status).toBe('waiting');

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Hot';

    const resumed = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });
    expect(resumed.status).toBe('success');

    const successNames = stepNames('success');
    expect(successNames).toContain('Save to Airtable (Hot)');
    expect(successNames).toContain('Slack Notification (Hot)');
    expect(successNames).toContain('Send Email (Hot)');
    expect(successNames).not.toContain('Save to Airtable (Warm)');
    expect(successNames).not.toContain('Save to Airtable (Cold)');

    const reviewOutput = stepOutputData('Human Review');
    expect(reviewOutput?.classification).toBe('Hot');
    expect(reviewOutput?._conditionBranch).toBe(0); // Hot is index 0

    const airtableCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.airtable.com'));
    const body = JSON.parse(airtableCall![1].body);
    expect(body.fields.Classification).toBe('Hot');
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });
});

// ─── Phase 9.9.9 -- Part F: honest confidence semantics ────────────────────

describe('Confidence semantics after Human Review -- Phase 9.9.9 Part F', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('a reviewed execution still carries BOTH the original ai_confidence and the human decision, distinctly -- never mislabels one as the other', async () => {
    withMockedClassifier('Cold', 0.2);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Warm';

    await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });

    const reviewOutput = stepOutputData('Human Review');
    // The human's decision is the canonical classification.
    expect(reviewOutput?.classification).toBe('Warm');
    // A distinct, honestly-named field carries the AI's ORIGINAL confidence
    // in its own (different, now-superseded) proposal -- never presented as
    // confidence in "Warm".
    expect(reviewOutput?.ai_confidence).toBe(0.2);
    // `decision` is the discriminator a notification template uses to know
    // a human was involved at all -- absent on the direct (non-reviewed) path.
    expect(reviewOutput?.decision).toBe('Warm');
    // The legacy `confidence` field is left completely untouched (backward
    // compatible with the existing, already-certified strict Airtable
    // "Confidence" mapping) -- humanReviewHandler never deletes or renames it.
    expect(reviewOutput?.confidence).toBe(0.2);
  });

  it('the direct (non-reviewed, confident) AI path also gets ai_confidence, equal to confidence, and has no "decision" field', async () => {
    withMockedClassifier('Hot', 0.95);
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });

    const classifierOutput = stepOutputData('AI Classifier');
    expect(classifierOutput?.confidence).toBe(0.95);
    expect(classifierOutput?.ai_confidence).toBe(0.95);

    const airtableCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.airtable.com'));
    const body = JSON.parse(airtableCall![1].body);
    // Confirms this exact scenario never produces a "decision" field a
    // template could mistake for a human override.
    expect(body.fields).not.toHaveProperty('decision');
  });
});

// ─── Phase 9.9.11A -- Part 7: Human Review resume through the ledger ───────

describe('Human Review resume integration with the durable side-effect ledger (Phase 9.9.11A Part 7)', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('a duplicate resume that reaches the engine a second time (simulating a recovery race with an interactive resume) cannot repeat the already-succeeded downstream Airtable/Slack/Gmail effects -- the ledger, not just review-resume.ts\'s own separate guard, prevents it', async () => {
    withMockedClassifier('Hot', 0.4);
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({
      workflowJson: topology(0.6), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live',
    });
    expect(started.status).toBe('waiting');

    const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
    reviewRows[0].status = 'resume_pending';
    reviewRows[0].decision_outcome = 'Hot';

    const first = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });
    expect(first.status).toBe('success');

    const airtableCallsAfterFirst = fetchMock.mock.calls.filter(([url]) => String(url).includes('api.airtable.com')).length;
    const slackCallsAfterFirst = fetchMock.mock.calls.filter(([url]) => String(url).includes('slack.com')).length;
    const emailCallsAfterFirst = fetchMock.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com')).length;
    expect(airtableCallsAfterFirst).toBe(1);
    expect(slackCallsAfterFirst).toBe(1);
    expect(emailCallsAfterFirst).toBe(1);

    // Deliberately calls resumeWorkflowExecution() AGAIN directly -- this
    // bypasses lib/runtime/review-resume.ts's OWN separately-proven
    // "stillAtThisNode" guard entirely (that guard is exactly what a real
    // recovery sweep goes through -- see review-resume-crash-safety.test.ts
    // -- this test isolates what happens if the engine is ever re-entered
    // for the same execution regardless). The side-effect ledger, wired
    // into runtime/node-runner.ts, is the layer that must independently
    // prevent a real duplicate here.
    const second = await resumeWorkflowExecution({
      executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(0.9), mode: 'live', inputData: {},
    });

    const airtableCallsAfterSecond = fetchMock.mock.calls.filter(([url]) => String(url).includes('api.airtable.com')).length;
    const slackCallsAfterSecond = fetchMock.mock.calls.filter(([url]) => String(url).includes('slack.com')).length;
    const emailCallsAfterSecond = fetchMock.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com')).length;

    // No new provider calls at all -- the ledger suppressed every one as
    // duplicate_suppressed rather than letting the resumed branch execute
    // its side effects twice.
    expect(airtableCallsAfterSecond).toBe(airtableCallsAfterFirst);
    expect(slackCallsAfterSecond).toBe(slackCallsAfterFirst);
    expect(emailCallsAfterSecond).toBe(emailCallsAfterFirst);
    expect(second.status).toBe('success');

    const ledgerRows = fakeDb.tables.get('workflow_side_effects') as Row[];
    expect(ledgerRows.filter((r) => r.status === 'succeeded')).toHaveLength(3); // Airtable, Slack, Gmail -- one ledger row each, never duplicated
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  });
});
