/**
 * Incident 9.9.17F -- engine-level regression coverage, same harness shape
 * as tests/wait-for-acknowledgment-engine-integration.test.ts (real
 * WorkflowEngine + ExecutionManager, mocked Supabase + fetch), covering:
 *
 *   Part 1 -- the plaintext acknowledgment token must not survive into
 *   durable execution state (workflow_executions_v2.output_data,
 *   runtime_execution_checkpoints/_snapshots, runtime_node_states,
 *   workflow_execution_steps) once the notification carrying it has been
 *   sent and the execution parks -- while the LIVE Gmail/Slack sends still
 *   receive the real, working URL.
 *
 *   Part 2 -- a Wait For Acknowledgment TIMEOUT resume must never be
 *   blocked on (or re-execute) Airtable/Gmail/the initial Slack notice --
 *   it can only ever reach its own Escalation Alert node.
 *
 *   Part 6 -- a provider failure during escalation must not retroactively
 *   hide that the SLA deadline already expired (ack row stays
 *   'timed_out'), and must not falsely record the escalation as delivered.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000ac';
const WORKFLOW_ID = 'wf-9917f-test';

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

// vi.stubEnv touches the real process.env, which -- unlike vi.mock/vi.stubGlobal
// -- is not automatically reset between test FILES sharing a worker process.
// Explicit beforeAll/afterAll here (rather than the module-scope stubEnv calls
// used before) is what stops NODE_ENV=production from leaking into unrelated
// test files run afterward in the same worker.
beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function topology(slaMinutes: number): unknown {
  return {
    name: 'Hot Lead SLA (Incident 9.9.17F test)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'airtable', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
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

const AIRTABLE_CREDS = { personal_access_token: 'pat-fake', base_id: 'appREAL' };
const SLACK_CREDS = { bot_token: 'xoxb-fake' };
const GMAIL_CREDS = { access_token: 'ya29-fake' };

async function seedIntegrations(opts?: { withGmail?: boolean; withAirtable?: boolean }) {
  const rows: Row[] = [
    { id: 'i2', user_id: USER_ID, provider: 'slack', credentials: SLACK_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null },
  ];
  if (opts?.withAirtable !== false) {
    rows.push({ id: 'i1', user_id: USER_ID, provider: 'airtable', credentials: AIRTABLE_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null });
  }
  if (opts?.withGmail !== false) {
    rows.push({ id: 'i3', user_id: USER_ID, provider: 'gmail', credentials: GMAIL_CREDS, status: 'connected', name: null, last_verified_at: null, created_at: null });
  }
  fakeDb.tables.set('user_integrations', rows);
}

function slackCallsToChannel(channel: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => {
    if (!String(url).includes('slack.com')) return false;
    try { return JSON.parse((init as { body: string }).body).channel === channel; } catch { return false; }
  }).length;
}

function providerCallCount(hostFragment: string): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(hostFragment)).length;
}

/** Recursively searches a value for any string containing the given substring -- used to prove a token is truly absent, not just absent from one obvious field. */
function containsSubstringDeep(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => containsSubstringDeep(v, needle));
  if (value && typeof value === 'object') return Object.values(value).some((v) => containsSubstringDeep(v, needle));
  return false;
}

describe('Incident 9.9.17F Part 1 -- ACK token must not persist in durable execution state', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('the LIVE Gmail/Slack sends still receive the real, working acknowledgment URL with its real token', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });

    const ackRows = fakeDb.tables.get('workflow_acknowledgments') as Row[];
    const challengeId = String(ackRows[0].id);

    const gmailCall = fetchMock.mock.calls.find(([url]) => String(url).includes('gmail.googleapis.com'));
    const gmailMime = Buffer.from(JSON.parse(gmailCall![1].body).raw, 'base64url').toString('utf8');
    expect(gmailMime).toContain('https://www.magicflux.ai');
    expect(gmailMime).toMatch(new RegExp(`/api/acknowledgments/${challengeId}/ack\\?token=[^\\s"]+`));

    const slackCall = fetchMock.mock.calls.find(([url]) => String(url).includes('slack.com'));
    const slackBody = JSON.parse(slackCall![1].body);
    expect(slackBody.text).toMatch(new RegExp(`/api/acknowledgments/${challengeId}/ack\\?token=[^\\s"]+`));
  });

  it('once parked, workflow_executions_v2.output_data, runtime_execution_checkpoints, runtime_execution_snapshots, runtime_node_states, and workflow_execution_steps all have the token stripped from acknowledgment_url -- while the row/host/path remain for diagnostics', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const result = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(result.status).toBe('waiting');

    // Extract the real token from the LIVE Gmail send so we can prove it is
    // truly gone from durable storage, not just "some redaction happened".
    const gmailCall = fetchMock.mock.calls.find(([url]) => String(url).includes('gmail.googleapis.com'));
    const gmailMime = Buffer.from(JSON.parse(gmailCall![1].body).raw, 'base64url').toString('utf8');
    const realToken = gmailMime.match(/token=([^\s"&]+)/)?.[1];
    expect(realToken).toBeTruthy();

    const durableTables = [
      'workflow_executions_v2',
      'runtime_execution_checkpoints',
      'runtime_execution_snapshots',
      'runtime_node_states',
      'workflow_execution_steps',
    ];

    for (const tableName of durableTables) {
      const rows = fakeDb.tables.get(tableName) ?? [];
      expect(containsSubstringDeep(rows, realToken!), `${tableName} must not contain the plaintext ACK token`).toBe(false);
    }

    // The URL's shape (host/path), which carries real diagnostic value, is
    // preserved -- only the token query param itself was stripped. Look at
    // the persisted execution row's own output_data specifically.
    const execRow = (fakeDb.tables.get('workflow_executions_v2') as Row[])[0];
    const flatSearch = JSON.stringify(execRow.output_data ?? {});
    expect(flatSearch).toContain('https://www.magicflux.ai/api/acknowledgments/');
    expect(flatSearch).toContain('token=%5BREDACTED%5D');
  });
});

describe('Incident 9.9.17F Part 2 -- timeout resume must never require or touch Airtable/Gmail/the initial Slack notice', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
  });

  it('a timeout resume succeeds even when Gmail AND Airtable are completely disconnected -- it only ever needs Slack for Escalation Alert', async () => {
    await seedIntegrations({ withGmail: false, withAirtable: false });
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');

    // The initial send needs all three -- seed them for the fresh run, then
    // disconnect Gmail/Airtable before the resume to prove resume doesn't
    // re-check them.
    await seedIntegrations({ withGmail: true, withAirtable: true });
    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const airtableCallsBefore = providerCallCount('api.airtable.com');
    const gmailCallsBefore = providerCallCount('gmail.googleapis.com');
    const leadsSlackCallsBefore = slackCallsToChannel('#leads');

    // Now disconnect Gmail and Airtable entirely -- exactly the "Railway
    // never had Google OAuth env parity" scenario this incident hit.
    await seedIntegrations({ withGmail: false, withAirtable: false });

    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[])[0];
    ackRow.deadline_at = new Date(Date.now() - 1000).toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });

    // Before the Part 2 fix this threw SETUP_REQUIRED:gmail and the
    // execution ended 'failed' before ever reaching Wait For Acknowledgment.
    expect(resumed.status).toBe('success');
    expect(ackRow.status).toBe('timed_out');
    expect(slackCallsToChannel('#leads-escalation')).toBe(1);

    // Never re-touched the earlier, already-delivered notifications.
    expect(providerCallCount('api.airtable.com')).toBe(airtableCallsBefore);
    expect(providerCallCount('gmail.googleapis.com')).toBe(gmailCallsBefore);
    expect(slackCallsToChannel('#leads')).toBe(leadsSlackCallsBefore);
  });

  it('requiredProvidersFromWorkflow scoped from "Await acknowledgment" resolves to only slack, never gmail/airtable', async () => {
    const { requiredProvidersFromWorkflow } = await import('../lib/integrations');
    const scoped = requiredProvidersFromWorkflow(topology(15), { fromNodeName: 'Await acknowledgment' });
    expect(scoped.sort()).toEqual(['slack']);

    const fullGraph = requiredProvidersFromWorkflow(topology(15));
    expect(fullGraph.sort()).toEqual(['airtable', 'gmail', 'slack']);
  });
});

describe('Incident 9.9.17F Part 6 -- an escalation provider failure must not erase the recorded timeout, nor fake a delivered escalation', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    vi.resetModules();
    await seedIntegrations();
  });

  it('Escalation Alert failing every retry still leaves the ack row "timed_out" (never reverted to pending), and never records a false succeeded side-effect', async () => {
    fetchMock.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('slack.com')) {
        const body = JSON.parse(init?.body ?? '{}');
        // Fail only the escalation channel; the initial "#leads" notice
        // during the fresh run must still succeed normally.
        if (body.channel === '#leads-escalation') {
          return Promise.resolve(jsonResponse({ ok: false, error: 'rate_limited' }, false, 429));
        }
      }
      return Promise.resolve(jsonResponse({ id: 'recNEW', ok: true }));
    });

    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[])[0];
    ackRow.deadline_at = new Date(Date.now() - 1000).toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {}, maxRetries: 0 });

    // The escalation SEND failed, so the execution itself ends up failed --
    // but the fact that the deadline expired must already be durable.
    expect(resumed.status).toBe('failed');
    expect(ackRow.status).toBe('timed_out');

    const ledgerRows = fakeDb.tables.get('workflow_side_effects') as Row[];
    const escalationRows = ledgerRows.filter((r) => r.node_id === 'escalate');
    // Never a false 'succeeded' -- either no row (never got far enough to
    // claim), or a row explicitly NOT 'succeeded'.
    expect(escalationRows.every((r) => r.status !== 'succeeded')).toBe(true);
  });
});

describe('Incident 9.9.17F -- worker restart during the wait must not duplicate any effect', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('resuming twice before the deadline (simulating a worker restart mid-wait) re-parks both times without resending anything', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const airtableCalls = providerCallCount('api.airtable.com');
    const gmailCalls = providerCallCount('gmail.googleapis.com');
    const leadsSlackCalls = slackCallsToChannel('#leads');

    const first = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });
    const second = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });

    expect(first.status).toBe('waiting');
    expect(second.status).toBe('waiting');
    expect(providerCallCount('api.airtable.com')).toBe(airtableCalls);
    expect(providerCallCount('gmail.googleapis.com')).toBe(gmailCalls);
    expect(slackCallsToChannel('#leads')).toBe(leadsSlackCalls);
    expect(slackCallsToChannel('#leads-escalation')).toBe(0);
    expect(slackCallsToChannel('#leads-handled')).toBe(0);
    expect((fakeDb.tables.get('workflow_acknowledgments') as Row[])).toHaveLength(1);
  });
});
