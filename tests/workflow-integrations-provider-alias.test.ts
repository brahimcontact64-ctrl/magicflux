/**
 * Phase 9.9.4E — Workflow integration attachment / provider alias
 * unification (app/api/workflows/[id]/integrations/route.ts).
 *
 * Root cause this exists to prevent: this route queried `user_integrations`
 * directly and grouped/compared by the RAW stored provider string, while
 * requiredProvidersFromWorkflow() (lib/integrations.ts) always reports the
 * CANONICAL 'gmail' for a real n8n-nodes-base.gmail node -- but Settings'
 * legacy SMTP connect flow stores that same credential under the literal
 * 'email'. A genuinely connected credential was therefore invisible to
 * discovery ("No connected integrations") and, even if a matching id were
 * guessed, rejected on attach ("Integration provider mismatch"). The fix
 * reuses the ONE already-established canonical mechanism
 * (getUserIntegrations() / canonicalizeProviderId(), Phase 9.8.5/9.9.4B)
 * end-to-end -- discovery, attach, detach -- instead of a second,
 * uncanonicalized code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000e1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000e2';
const WORKFLOW_ID = 'wf-integrations-alias-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]): this { this.inFilters.push([col, vals]); return this; }
  select(_cols?: string): this { return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => {
      if (this.filters.every(([c, v]) => r[c] === v) && this.inFilters.every(([c, vals]) => vals.includes(r[c]))) idx.push(i);
    });
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
    return result.map((r) => ({ ...r }));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
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
  insert(row: Row): { select: () => { maybeSingle: () => Promise<{ data: Row | null; error: null }> } } {
    const saved = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(saved);
    return { select: () => ({ maybeSingle: async () => ({ data: { ...saved }, error: null }) }) };
  }
  update(patch: Row): FakeQuery & { select: () => FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> } } {
    const q = new FakeQuery(this.rows, 'select') as FakeQuery & { select: () => FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> } };
    const rows = this.rows;
    q.select = () => {
      const q2 = new FakeQuery(rows, 'select') as FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> };
      q2.maybeSingle = async () => {
        const filters = (q as unknown as { filters: Array<[string, unknown]> }).filters;
        const target = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        if (!target) return { data: null, error: null };
        Object.assign(target, patch);
        return { data: { ...target }, error: null };
      };
      return q2;
    };
    return q;
  }
  upsert(row: Row, opts?: { onConflict?: string }): FakeQuery & { select: () => FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> } } {
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const idx = conflictCols.length ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c])) : -1;
    let saved: Row;
    if (idx >= 0) { this.rows[idx] = { ...this.rows[idx], ...row }; saved = this.rows[idx]; }
    else { saved = { id: row.id ?? `fake-${this.rows.length}`, ...row }; this.rows.push(saved); }
    const q = new FakeQuery([saved], 'select') as FakeQuery & { select: () => FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> } };
    q.select = () => {
      const q2 = new FakeQuery([saved], 'select') as FakeQuery & { maybeSingle: () => Promise<{ data: Row | null; error: null }> };
      q2.maybeSingle = async () => ({ data: { ...saved }, error: null });
      return q2;
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
const mockGetUserFromRequest = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

function seedWorkflow(id: string, userId: string, requiredProviders: string[]) {
  fakeDb.tables.set('workflows', [
    { id, user_id: userId, integrations: requiredProviders },
  ]);
}

function seedUserIntegrations(rows: Row[]) {
  fakeDb.tables.set('user_integrations', rows);
}

function makeReq(method: string, body?: Record<string, unknown>) {
  return new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/integrations`), {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  fakeDb.tables.clear();
  mockGetUserFromRequest.mockReset();
  mockGetUserFromRequest.mockResolvedValue({ id: OWNER_ID });
});

describe('GET /api/workflows/[id]/integrations -- provider alias unification', () => {
  it('a connected legacy "email" credential is discoverable under the canonical "gmail" key', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requiredProviders).toEqual(['gmail']);
    expect(body.availableByProvider.gmail).toBeDefined();
    expect(body.availableByProvider.gmail).toHaveLength(1);
    expect(body.availableByProvider.gmail[0].integrationId).toBe('int-email-1');
    // Never exposes credentials to the client.
    expect(JSON.stringify(body)).not.toContain('"credentials"');
  });

  it('Airtable discovery/attachment is unaffected (no alias involved)', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    seedUserIntegrations([
      { id: 'int-airtable-1', user_id: OWNER_ID, provider: 'airtable', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'airtable', integration_id: 'int-airtable-1' },
    ]);

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(body.availableByProvider.airtable).toHaveLength(1);
    expect(body.attached).toEqual([{ provider: 'airtable', integrationId: 'int-airtable-1' }]);
  });

  it('a disconnected ("not_connected") credential never appears as available -- fails closed', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-gmail-stale', user_id: OWNER_ID, provider: 'gmail', name: null, credentials: {}, status: 'not_connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(body.availableByProvider.gmail ?? []).toHaveLength(0);
  });

  it('cross-tenant: a different user\'s workflow cannot be listed -- 404, no data leaked', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    mockGetUserFromRequest.mockResolvedValue({ id: ATTACKER_ID });

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(404);
  });

  it('unauthorized without a session', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/workflows/[id]/integrations -- attach, canonical storage', () => {
  it('attaches a "gmail"-required node to a credential stored as legacy "email"', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The API response is always canonical, regardless of storage shape.
    expect(body.attached.provider).toBe('gmail');

    // Phase 9.9.4F -- stored under the credential's OWN raw label ("email"),
    // NOT the canonical "gmail" -- the live DB CHECK constraint on this
    // column does not allow "gmail" at all (see the route's own comment).
    // Storing "email" here is the deliberate, schema-safe fix; every reader
    // (this route's GET, resolveWorkflowIntegrations()) canonicalizes at
    // comparison/response time instead.
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('email');
    expect(rows[0].integration_id).toBe('int-email-1');
  });

  it('a subsequent GET reflects the attachment as canonical "gmail", attached=true', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    const { POST, GET } = await import('../app/api/workflows/[id]/integrations/route');
    await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });

    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();
    expect(body.attached).toEqual([{ provider: 'gmail', integrationId: 'int-email-1' }]);
    expect(body.availableByProvider.gmail[0].attached).toBe(true);
  });

  it('rejects a genuine provider mismatch (attaching a Slack credential as "gmail")', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-slack-1', user_id: OWNER_ID, provider: 'slack', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-slack-1' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
  });

  it('rejects attaching a disconnected credential -- fails closed', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'invalid', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(422);
  });

  it('cross-tenant: cannot attach another user\'s credential to your own workflow', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-attacker-email', user_id: ATTACKER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-attacker-email' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('cross-tenant: cannot attach a credential to someone else\'s workflow', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    mockGetUserFromRequest.mockResolvedValue({ id: ATTACKER_ID });
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('Slack "Default" can be attached, and remains attached after reload', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['slack']);
    seedUserIntegrations([
      { id: 'int-slack-1', user_id: OWNER_ID, provider: 'slack', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    const { POST, GET } = await import('../app/api/workflows/[id]/integrations/route');
    const attachRes = await POST(makeReq('POST', { provider: 'slack', integrationId: 'int-slack-1' }), { params: { id: WORKFLOW_ID } });
    expect(attachRes.status).toBe(200);

    // Simulate a page reload -- a fresh GET must still show it attached.
    const reloadRes = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const reloadBody = await reloadRes.json();
    expect(reloadBody.attached).toEqual([{ provider: 'slack', integrationId: 'int-slack-1' }]);
    expect(reloadBody.availableByProvider.slack[0].name).toBe('Default');
    expect(reloadBody.availableByProvider.slack[0].attached).toBe(true);
  });

  it('attaching Gmail does not disturb an existing Airtable attachment', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable', 'gmail']);
    seedUserIntegrations([
      { id: 'int-airtable-1', user_id: OWNER_ID, provider: 'airtable', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'airtable', integration_id: 'int-airtable-1' },
    ]);

    const { POST, GET } = await import('../app/api/workflows/[id]/integrations/route');
    await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });

    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();
    const attachedProviders = body.attached.map((a: { provider: string }) => a.provider).sort();
    expect(attachedProviders).toEqual(['airtable', 'gmail']);
  });
});

describe('DELETE /api/workflows/[id]/integrations -- detach, canonical', () => {
  it('detaching "gmail" removes the row regardless of whether it was stored canonically', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: 'int-email-1' },
    ]);
    const { DELETE } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await DELETE(makeReq('DELETE', { provider: 'gmail' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(200);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('cross-tenant: cannot detach another user\'s workflow integration', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: 'int-email-1' },
    ]);
    mockGetUserFromRequest.mockResolvedValue({ id: ATTACKER_ID });
    const { DELETE } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await DELETE(makeReq('DELETE', { provider: 'gmail' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(1);
  });
});

describe('resolveWorkflowIntegrations -- runtime resolves the SAME credential attach/discovery found', () => {
  it('resolves a workflow_integrations row stored under the canonical label too (defensive/back-compat)', async () => {
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: { smtp_host: 'smtp.test.com' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: 'int-email-1' },
    ]);

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const { resolved } = await resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] });
    expect(resolved.get('gmail' as never)?.id).toBe('int-email-1');
  });

  it('Phase 9.9.4F: resolves a row stored under the credential\'s OWN raw label "email" -- the actual production storage shape', async () => {
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: { smtp_host: 'smtp.test.com' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'email', integration_id: 'int-email-1' },
    ]);

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const { resolved } = await resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] });
    expect(resolved.get('gmail' as never)?.id).toBe('int-email-1');
  });
});

describe('Phase 9.9.4F -- exact production regression: the DB CHECK constraint on workflow_integrations.provider does not allow "gmail"', () => {
  it('the exact reported case end-to-end: discover -> attach -> reload shows Attached -> runtime resolves the same credential, with no DB constraint violation', async () => {
    // 1. A connected credential stored as provider "email" (the founder's
    // real, already-certified SMTP connection).
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: { smtp_host: 'smtp.test.com' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);

    const { GET, POST } = await import('../app/api/workflows/[id]/integrations/route');

    // 2. GET exposes it for the required provider "gmail".
    const discoverRes = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const discoverBody = await discoverRes.json();
    expect(discoverBody.availableByProvider.gmail).toHaveLength(1);
    const discoveredIntegrationId = discoverBody.availableByProvider.gmail[0].integrationId;
    expect(discoveredIntegrationId).toBe('int-email-1');

    // 3. POST attaches that exact discovered integration id as "gmail" --
    // this is the exact call that used to 500 with "temporary_system_problem"
    // (Postgres check_violation on workflow_integrations_provider_check,
    // since 'gmail' is not in its allowed value list).
    const attachRes = await POST(makeReq('POST', { provider: 'gmail', integrationId: discoveredIntegrationId }), { params: { id: WORKFLOW_ID } });
    const attachBody = await attachRes.json();
    expect(attachRes.status).toBe(200);
    expect(attachBody.error).toBeUndefined();
    expect(attachBody.success).toBe(true);

    // 4. Reload (a fresh GET) reports Gmail Attached.
    const reloadRes = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const reloadBody = await reloadRes.json();
    expect(reloadBody.attached).toEqual([{ provider: 'gmail', integrationId: 'int-email-1' }]);
    expect(reloadBody.availableByProvider.gmail[0].attached).toBe(true);

    // 5. Runtime resolves that attachment back to the SAME connected SMTP credential.
    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const { resolved } = await resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] });
    expect(resolved.get('gmail' as never)?.id).toBe('int-email-1');
    expect(resolved.get('gmail' as never)?.credentials.smtp_host).toBe('smtp.test.com');

    // The underlying user_integrations credential was never duplicated or migrated.
    expect(fakeDb.tables.get('user_integrations')).toHaveLength(1);
  });

  it('duplicate/idempotent attach: clicking Attach twice for the same provider does not create a second row and both calls succeed', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const first = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });
    const second = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
  });

  it('re-attaching with a different (but still valid, same-tenant) credential updates the existing row in place rather than creating a duplicate', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedUserIntegrations([
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      { id: 'int-email-2', user_id: OWNER_ID, provider: 'email', name: 'Second inbox', credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-02' },
    ]);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-1' }), { params: { id: WORKFLOW_ID } });
    const second = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'int-email-2' }), { params: { id: WORKFLOW_ID } });

    expect(second.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].integration_id).toBe('int-email-2');
  });
});

/**
 * Phase 9.9.4H — stale/cross-request cached "Attached" status.
 *
 * Root cause: getUserFromRequest() (lib/supabase-server.ts) reads the auth
 * token off `req.headers` directly rather than through next/headers'
 * cookies()/headers() functions. On this app's Next.js 13 App Router, a GET
 * Route Handler with no dynamic-API call and no `dynamic` export is treated
 * as static/cacheable -- Vercel's Full Route Cache can then serve the exact
 * same cached JSON body (captured for whichever request populated the
 * cache first) to every subsequent request against that URL, for any user,
 * regardless of later attach/detach writes. That fully explains the
 * observed symptom: the Builder kept showing Gmail as "Attached" while
 * direct, repeated production reads confirmed workflow_integrations had no
 * such row at all -- the UI was rendering a stale cached snapshot, not a
 * fresh server read.
 *
 * This can't be exercised as a real Vercel-cache integration test under
 * vitest, so this pins the fix at the source level: the route module must
 * declare `export const dynamic = 'force-dynamic'` so Next.js never
 * statically caches this per-user, mutable-state GET response. Regresses
 * loudly (a failing assertion, not a silent behavior change) if anyone
 * ever removes the directive.
 */
describe('Phase 9.9.4H -- GET /api/workflows/[id]/integrations must never be statically cached', () => {
  it('declares force-dynamic so every request re-reads server truth instead of serving a cached snapshot', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'workflows', '[id]', 'integrations', 'route.ts'),
      'utf8'
    );
    expect(source).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
  });
});
