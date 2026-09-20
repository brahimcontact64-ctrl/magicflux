/**
 * Incident 9.9.17I -- end-to-end certification, real WorkflowEngine +
 * ExecutionManager + the actual GET/POST route handlers, all sharing one
 * mocked Supabase instance (only Supabase and global fetch are mocked).
 *
 * Proves the two real production paths side by side:
 *   A) challenge -> GET (repeated/scanner-shaped, zero mutation) -> deadline
 *      passes -> pending -> timed_out -> Escalation Alert -> exactly one
 *      Slack escalation -> execution success.
 *   B) challenge -> GET (zero mutation) -> explicit POST before deadline ->
 *      pending -> acknowledged -> no escalation -> execution success.
 *
 * Short/expired synthetic deadlines are used by mutating deadline_at on the
 * fixture directly (the same technique already certified in
 * tests/incident-9917f-ack-security-and-resume.test.ts) -- the workflow's
 * own configured slaMinutes stays 15, matching real Sigma Plus; nothing
 * about the production SLA duration is changed anywhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-0000000000ae';
const WORKFLOW_ID = 'wf-9917i-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  is(col: string, _val: null): this { this.filters.push([col, null]); return this; }
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => {
      if (this.filters.every(([c, v]) => (v === null ? (r[c] === null || r[c] === undefined) : r[c] === v))) idx.push(i);
    });
    return idx;
  }
  private matched(): Row[] {
    // Compute matching indices ONCE, before applying any patch -- an
    // UPDATE...WHERE status='pending' SET status='acknowledged' (a real CAS,
    // exactly what this route does) must still report the row it just
    // changed, not re-filter against its own new value.
    const idx = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idx) Object.assign(this.rows[i], this.pendingPatch);
    let result = idx.map((i) => this.rows[i]);
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
    const m = this.matched();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched().map((r) => ({ ...r })), error: null }));
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

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function topology(slaMinutes: number): unknown {
  return {
    name: 'Hot Lead SLA (Incident 9.9.17I certification)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'airtable', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appREAL', tableId: 'tblREAL', operation: 'create', fields: { Name: '={{$json["name"]}}' } } },
      { id: 'challenge', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes } },
      { id: 'gmail', name: 'Send Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'founder@example.com', subject: 'Hot lead', text: 'Acknowledge: {{$json["acknowledgment_url"]}}' } },
      { id: 'slack', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { text: 'Hot lead: {{$json["name"]}} -- {{$json["acknowledgment_url"]}}', channel: '#leads' } },
      { id: 'ack', name: 'Await acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes } },
      { id: 'handled', name: 'Marked Handled', type: 'n8n-nodes-base.slack', parameters: { text: 'Lead handled', channel: '#leads-handled' } },
      { id: 'escalate', name: 'Escalation Alert', type: 'n8n-nodes-base.slack', parameters: { text: 'SLA BREACHED -- escalating', channel: '#leads-escalation' } },
    ],
    connections: {
      'Webhook Trigger': { main: [[{ node: 'Save to Airtable' }]] },
      'Save to Airtable': { main: [[{ node: 'Create Acknowledgment Challenge' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Send Gmail' }]] },
      'Send Gmail': { main: [[{ node: 'Slack Notification' }]] },
      'Slack Notification': { main: [[{ node: 'Await acknowledgment' }]] },
      'Await acknowledgment': { main: [[{ node: 'Marked Handled' }], [{ node: 'Escalation Alert' }]] },
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
  // attemptAcknowledgmentResume() (called from the real POST handler) looks
  // up the workflow snapshot to resume from -- in real production this row
  // always exists; this fixture must have it too for POST-triggered resume
  // to succeed exactly like it does against the real database.
  fakeDb.tables.set('workflows', [
    { id: WORKFLOW_ID, user_id: USER_ID, workflow_json: topology(15) },
  ]);
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

/** Extracts the real ack id + plaintext token from the actual Gmail send -- the same value a real recipient's email would contain. */
function extractAckLinkFromGmail(): { id: string; token: string } {
  const gmailCall = fetchMock.mock.calls.find(([url]) => String(url).includes('gmail.googleapis.com'));
  const mime = Buffer.from(JSON.parse(gmailCall![1].body).raw, 'base64url').toString('utf8');
  const match = mime.match(/\/api\/acknowledgments\/([^/]+)\/ack\?token=([^\s"&]+)/);
  if (!match) throw new Error('No acknowledgment link found in the Gmail send');
  return { id: match[1], token: match[2] };
}

function getReq(id: string, token: string): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${id}/ack`);
  url.searchParams.set('token', token);
  return new NextRequest(url, {
    headers: { 'user-agent': 'GoogleImageProxy/1.0', purpose: 'prefetch', 'sec-purpose': 'prefetch;prerender' },
  });
}
function postReq(id: string, token: string): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${id}/ack`);
  const body = new URLSearchParams({ token });
  return new NextRequest(url, { method: 'POST', body });
}

describe('Incident 9.9.17I -- Scenario A: scanner GETs, then a genuine timeout, then escalation', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('challenge -> repeated scanner-shaped GETs (zero mutation) -> deadline passes -> timed_out -> Escalation Alert fires exactly once -> execution success', async () => {
    const { runWorkflowExecution, resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');

    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const { id, token } = extractAckLinkFromGmail();
    const ackRowBefore = (fakeDb.tables.get('workflow_acknowledgments') as Row[]).find((r) => r.id === id)!;
    expect(ackRowBefore.status).toBe('pending');

    // A scanner/prefetcher fetches the link 20 times -- must never mutate.
    for (let i = 0; i < 20; i++) {
      const res = await GET(getReq(id, token), { params: { id } });
      expect(res.status).toBe(200);
    }
    expect(ackRowBefore.status).toBe('pending');
    expect(ackRowBefore.acknowledged_at ?? null).toBeNull();

    // The deadline genuinely passes (synthetic short deadline via direct
    // fixture mutation -- production's own 15-minute slaMinutes is untouched
    // anywhere in this file).
    ackRowBefore.deadline_at = new Date(Date.now() - 1000).toISOString();

    const resumed = await resumeWorkflowExecution({ executionId: started.executionId, userId: USER_ID, workflowId: WORKFLOW_ID, workflowJson: topology(15), mode: 'live', inputData: {} });

    expect(resumed.status).toBe('success');
    expect(ackRowBefore.status).toBe('timed_out');
    expect(slackCallsToChannel('#leads-escalation')).toBe(1);
    expect(slackCallsToChannel('#leads-handled')).toBe(0);

    // Original Hot effects remain exactly-once -- no replay during the
    // timeout resume.
    expect(providerCallCount('api.airtable.com')).toBe(1);
    expect(providerCallCount('gmail.googleapis.com')).toBe(1);
    expect(slackCallsToChannel('#leads')).toBe(1);

    const ledgerRows = fakeDb.tables.get('workflow_side_effects') as Row[];
    expect(ledgerRows.filter((r) => r.status === 'succeeded')).toHaveLength(4); // airtable + initial slack + escalation slack + ... (gmail is email_send, separately counted below)
    expect(ledgerRows.filter((r) => r.effect_type === 'email_send')).toHaveLength(1);
    expect(ledgerRows.filter((r) => r.effect_type === 'airtable_create')).toHaveLength(1);
    expect(ledgerRows.filter((r) => r.effect_type === 'slack_post')).toHaveLength(2); // initial notice + escalation
  });
});

describe('Incident 9.9.17I -- Scenario B: scanner GET, then a genuine human POST, no escalation', () => {
  beforeEach(async () => {
    fakeDb.tables.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW', ok: true }));
    vi.resetModules();
    await seedIntegrations();
  });

  it('challenge -> GET (zero mutation) -> explicit POST before deadline -> acknowledged -> resumed -> no escalation -> execution success', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const { GET, POST } = await import('../app/api/acknowledgments/[id]/ack/route');

    const started = await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    expect(started.status).toBe('waiting');

    const { id, token } = extractAckLinkFromGmail();

    // The human opens the email and taps the link -- a GET, zero mutation.
    const getRes = await GET(getReq(id, token), { params: { id } });
    expect(getRes.status).toBe(200);
    const getHtml = await getRes.text();
    expect(getHtml).toContain('Acknowledge Lead');
    const ackRow = (fakeDb.tables.get('workflow_acknowledgments') as Row[]).find((r) => r.id === id)!;
    expect(ackRow.status).toBe('pending');

    // Then explicitly submits the form -- a real POST.
    const postRes = await POST(postReq(id, token), { params: { id } });
    expect(postRes.status).toBe(200);
    const postHtml = await postRes.text();
    expect(postHtml).toContain('Lead acknowledged successfully');
    expect(postHtml).not.toContain(token);

    expect(ackRow.status).toBe('acknowledged');

    // The POST's own attemptAcknowledgmentResume() call already progressed
    // the (still-parked) execution all the way to completion -- no separate
    // retry-dispatcher wake-up needed since the resume happened immediately.
    const execRow = (fakeDb.tables.get('workflow_executions_v2') as Row[]).find((r) => r.id === started.executionId)!;
    expect(execRow.status).toBe('success');

    expect(slackCallsToChannel('#leads-handled')).toBe(1);
    expect(slackCallsToChannel('#leads-escalation')).toBe(0);
    expect(providerCallCount('api.airtable.com')).toBe(1);
    expect(providerCallCount('gmail.googleapis.com')).toBe(1);
    expect(slackCallsToChannel('#leads')).toBe(1);
  });

  it('the rendered "pending" page requires no JavaScript to acknowledge -- a plain form submission is sufficient', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    await runWorkflowExecution({ workflowJson: topology(15), inputData: { name: 'Acme Co' }, userId: USER_ID, workflowId: WORKFLOW_ID, mode: 'live' });
    const { id, token } = extractAckLinkFromGmail();

    const res = await GET(getReq(id, token), { params: { id } });
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).toContain('<form method="POST"');
  });
});
