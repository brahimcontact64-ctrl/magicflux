/**
 * Phase 9.9.12 -- engine-level proof of the reference Hot Lead SLA
 * topology: Airtable -> Gmail -> Slack -> Await Acknowledgment -> (0:
 * marked handled / 1: escalation), driven against the REAL WorkflowEngine
 * + ExecutionManager, mocked Supabase and mocked provider fetch calls --
 * same harness shape as tests/human-review-classification-truth.test.ts
 * and tests/node-runner-side-effect-ledger.test.ts's own engine-level
 * proof, combined here to prove the NEW node type participates correctly
 * in both the durable-timer resume path AND the Phase 9.9.11A side-effect
 * ledger (Part G: "a duplicate timeout/recovery sweep must not produce
 * duplicate escalation notifications").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000ab';
const WORKFLOW_ID = 'wf-ack-engine-test';

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

// Phase 9.9.11A -- faithful CAS model for workflow_side_effects, exactly
// like tests/human-review-classification-truth.test.ts's own extension.
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

// Phase 9.9.12 -- same idea for workflow_acknowledgments' own
// (execution_id, node_id) uniqueness.
class FakeAcknowledgmentsHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows, 'select').update(patch); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id);
    if (conflict) {
      return { then: (resolve: (v: { error: { message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { message: 'duplicate key value violates unique constraint' } })) };
    }
    this.rows.push({ id: `ack-${this.rows.length + 1}`, ...row });
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
  from(name: string): FakeTableHandle | FakeSideEffectsHandle | FakeAcknowledgmentsHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    const rows = this.tables.get(name)!;
    if (name === 'workflow_side_effects') return new FakeSideEffectsHandle(rows);
    if (name === 'workflow_acknowledgments') return new FakeAcknowledgmentsHandle(rows);
    return new FakeTableHandle(rows);
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stepOutputData(nodeName: string): Record<string, unknown> | undefined {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string; output_data: unknown }>;
  const step = [...steps].reverse().find((s) => s.node_name === nodeName && s.status === 'success');
  return step?.output_data as Record<string, unknown> | undefined;
}

function topology(slaMinutes: number): unknown {
  return {
    name: 'Hot Lead SLA (engine test)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'airtable', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
      { id: 'gmail', name: 'Send Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Hot lead', text: 'x' } },
      { id: 'slack', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { text: 'Hot lead: {{$json["name"]}}', channel: '#leads' } },
      { id: 'ack', name: 'Await acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes } },
      { id: 'handled', name: 'Marked Handled', type: 'n8n-nodes-base.slack', parameters: { text: 'Lead handled', channel: '#leads-handled' } },
      { id: 'escalate', name: 'Escalation Notice', type: 'n8n-nodes-base.slack', parameters: { text: 'SLA BREACHED -- escalating', channel: '#leads-escalation' } },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Save to Airtable' }]] },
      'Save to Airtable': { main: [[{ node: 'Send Gmail' }]] },
      'Send Gmail': { main: [[{ node: 'Slack Notification' }]] },
      'Slack Notification': { main: [[{ node: 'Await acknowledgment' }]] },
      'Await acknowledgment': { main: [[{ node: 'Marked Handled' }], [{ node: 'Escalation Notice' }]] },
    },
  };
}

const AIRTABLE_CREDS = { personal_access_token: 'pat-fake', base_id: 'appREAL' };
const SLACK_CREDS = { bot_token: 'xoxb-fake' };
const GMAIL_CREDS = { access_token: 'ya29-fake' };

async function seedIntegrations() {
  fakeDb.tables.set('user_integrations', [
    { id: 'i1', user_id: USER_ID, provider: 'airtable', credentials: AIRTABLE_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: 'i2', user_id: USER_ID, provider: 'slack', credentials: SLACK_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
    { id: 'i3', user_id: USER_ID, provider: 'gmail', credentials: GMAIL_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
  ]);
}

function slackCallsToChannel(channel: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => {
    if (!String(url).includes('slack.com')) return false;
    try { return JSON.parse((init as { body: string }).body).channel === channel; } catch { return false; }
  }).length;
}

describe('Hot Lead SLA reference topology (Phase 9.9.12, Part C/G)', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('Airtable -> Gmail -> Slack all fire exactly once, then the execution parks awaiting acknowledgment', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    expect(result.status).toBe('waiting');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('api.airtable.com'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com'))).toHaveLength(1);
    expect(slackCallsToChannel('#leads')).toBe(1);
    expect(fakeDb.tables.get('workflow_acknowledgments')).toHaveLength(1);
    expect((fakeDb.tables.get('workflow_acknowledgments') as Row[])[0].status).toBe('pending');
  });

  it('acknowledged before the deadline: resumes to "Marked Handled", zero escalation notices', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    // Simulate the ack API route's own CAS having already flipped this to 'acknowledged'.
    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[])[0];
    ackRow.status = 'acknowledged';

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });

    expect(resumed.status).toBe('success');
    expect(slackCallsToChannel('#leads-handled')).toBe(1);
    expect(slackCallsToChannel('#leads-escalation')).toBe(0);
    const ackOutput = stepOutputData('Await acknowledgment');
    expect(ackOutput?._conditionBranch).toBe(0);
    expect(ackOutput?.acknowledgment_status).toBe('acknowledged');
  });

  it('no acknowledgment by the deadline: resumes to "Escalation Notice" exactly once; a duplicate resume/recovery sweep never sends a second escalation (Part G)', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    // Simulate the deadline having passed (the durable timer's real job --
    // see wait-for-acknowledgment.ts -- fires via the existing, separately-
    // certified retry-dispatcher.ts, which this test does not need to
    // re-prove; it only needs the deadline to be in the past by the time
    // the node is re-invoked).
    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[])[0];
    ackRow.deadline_at = new Date(Date.now() - 1000).toISOString();

    const first = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });
    expect(first.status).toBe('success');
    expect(slackCallsToChannel('#leads-escalation')).toBe(1);
    expect(ackRow.status).toBe('timed_out');

    // Duplicate recovery: the SAME execution is resumed again (e.g. a
    // recovery cron racing an interactive retry, or a genuinely duplicate
    // sweep) -- the escalation Slack call must NOT fire a second time. The
    // side-effect ledger (Phase 9.9.11A), not a second competing
    // idempotency mechanism (Part G), is what prevents it.
    const second = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });
    expect(second.status).toBe('success');
    expect(slackCallsToChannel('#leads-escalation')).toBe(1); // still exactly one, ever
    expect(slackCallsToChannel('#leads-handled')).toBe(0);

    const ledgerRows = fakeDb.tables.get('workflow_side_effects') as Row[];
    expect(ledgerRows.filter((r) => r.effect_type === 'slack_post' && r.status === 'succeeded')).toHaveLength(2); // the initial "#leads" notice + the one escalation, never duplicated
  });
});

// ─── Phase 9.9.12A -- Part I: the two-node split closes the chicken-and-egg gap ──

function topologyWithChallenge(slaMinutes: number): unknown {
  return {
    name: 'Hot Lead SLA with notification-embedded ack link (engine test)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'airtable', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
      // Positioned BEFORE the notifications -- this is the whole point.
      { id: 'challenge', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes } },
      { id: 'gmail', name: 'Send Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Hot lead', text: 'Acknowledge: {{$json["acknowledgment_url"]}}' } },
      { id: 'slack', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { text: 'Hot lead: {{$json["name"]}} -- {{$json["acknowledgment_url"]}}', channel: '#leads' } },
      { id: 'ack', name: 'Await acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes } },
      { id: 'handled', name: 'Marked Handled', type: 'n8n-nodes-base.slack', parameters: { text: 'Lead handled', channel: '#leads-handled' } },
      { id: 'escalate', name: 'Escalation Notice', type: 'n8n-nodes-base.slack', parameters: { text: 'SLA BREACHED -- escalating', channel: '#leads-escalation' } },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Save to Airtable' }]] },
      'Save to Airtable': { main: [[{ node: 'Create Acknowledgment Challenge' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Send Gmail' }]] },
      'Send Gmail': { main: [[{ node: 'Slack Notification' }]] },
      'Slack Notification': { main: [[{ node: 'Await acknowledgment' }]] },
      'Await acknowledgment': { main: [[{ node: 'Marked Handled' }], [{ node: 'Escalation Notice' }]] },
    },
  };
}

describe('Two-node split topology: Airtable -> Create Challenge -> Gmail -> Slack -> Await Acknowledgment (Part I)', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('the acknowledgment_url exists and is embedded in BOTH the Gmail and Slack notification bodies -- proves the chicken-and-egg gap is actually closed, not just documented', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topologyWithChallenge(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    expect(result.status).toBe('waiting');

    // Exactly one challenge row exists, and it's the one the notifications reference.
    const ackRows = fakeDb.tables.get('workflow_acknowledgments') as Row[];
    expect(ackRows).toHaveLength(1);
    const challengeId = String(ackRows[0].id);

    const gmailCall = fetchMock.mock.calls.find(([url]) => String(url).includes('gmail.googleapis.com'));
    const gmailMime = Buffer.from(JSON.parse(gmailCall![1].body).raw, 'base64url').toString('utf8');
    expect(gmailMime).toContain(`/api/acknowledgments/${challengeId}/ack?token=`);

    const slackCall = fetchMock.mock.calls.find(([url]) => String(url).includes('slack.com'));
    const slackBody = JSON.parse(slackCall![1].body);
    expect(slackBody.text).toContain(`/api/acknowledgments/${challengeId}/ack?token=`);

    // The wait node never created a SECOND row for the same lifecycle.
    expect(fakeDb.tables.get('workflow_acknowledgments')).toHaveLength(1);
  });

  it('acknowledging via the URL embedded in the ORIGINAL notification correctly resumes to "Marked Handled"', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topologyWithChallenge(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[])[0];
    ackRow.status = 'acknowledged'; // simulates the token route's own CAS, already unit-tested separately

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topologyWithChallenge(15), mode: 'live', inputData: {} });

    expect(resumed.status).toBe('success');
    expect(slackCallsToChannel('#leads-handled')).toBe(1);
    expect(slackCallsToChannel('#leads-escalation')).toBe(0);
  });
});
