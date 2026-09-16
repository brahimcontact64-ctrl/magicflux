/**
 * Phase 9.9.8C — Gmail OAuth Workflow Attachment Parity.
 *
 * Root cause: Settings correctly showed Gmail "Connected via Google OAuth"
 * (a real integration_credentials row, confirmed read-only in production),
 * but the workflow-attachment selector (GET /api/workflows/[id]/integrations)
 * showed "No connected integrations" for the same credential. Traced to
 * resolveBridgedIntegration() (lib/user-integrations.ts): it never set an
 * `id` on the UserIntegration it returns for ANY OAuth-bridged provider, and
 * the discovery route silently drops any integration with no id
 * (`if (!integration.id) return`) -- there was simply no id for the
 * selector to reference. Airtable/Slack never hit this because Brahim's
 * working connections for those live in the legacy user_integrations table,
 * which always has a real row id.
 *
 * Fix: resolveBridgedIntegration() now also resolves the credential's own
 * real integration_credentials.id (lib/credentials/storage.ts's new
 * getCredentialRowId()) as an opaque, non-secret attachment reference --
 * never a token, never a new table, never an alias to legacy SMTP/email.
 * The attach route (POST) now accepts this same opaque id, re-verifying
 * ownership and live connection status before ever persisting it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000a2';
const WORKFLOW_ID = 'wf-gmail-oauth-attach-test';
const GMAIL_CRED_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  async then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return resolve({ data: this.matched().map((r) => ({ ...r })), error: null });
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  insert(row: Row) {
    const saved = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(saved);
    return { select: () => ({ maybeSingle: async () => ({ data: { ...saved }, error: null }) }) };
  }
  update(patch: Row) {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const builder = {
      eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
      select() { return builder; },
      async maybeSingle(): Promise<{ data: Row | null; error: null }> {
        const target = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        if (!target) return { data: null, error: null };
        Object.assign(target, patch);
        return { data: { ...target }, error: null };
      },
    };
    return builder;
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
  fakeDb.tables.set('workflows', [{ id, user_id: userId, integrations: requiredProviders }]);
}

function seedGmailCredential(userId: string, id: string) {
  fakeDb.tables.set('integration_credentials', [
    { id, user_id: userId, provider: 'gmail', credential_key: 'oauth_google_gmail', encrypted_value: 'encrypted-token-blob', is_secret: true },
  ]);
}

function makeReq(method: string, body?: Record<string, unknown>) {
  return new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/integrations`), {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}

let gmailConnected: boolean;

beforeEach(() => {
  // Each test's own vi.doMock() calls must apply to a FRESH module graph --
  // otherwise a route/module already imported by an earlier test in this
  // file keeps its stale closure over whichever mock was active at that
  // earlier import time.
  vi.resetModules();
  fakeDb.tables.clear();
  mockGetUserFromRequest.mockReset();
  mockGetUserFromRequest.mockResolvedValue({ id: OWNER_ID });
  gmailConnected = true;
  vi.doMock('@/lib/credentials/storage', () => ({
    verifyProviderConnection: vi.fn(async (userId: string, provider: string) => {
      if (provider !== 'gmail') return { connected: false, missing: [] };
      return { connected: gmailConnected, missing: [] };
    }),
    getCredentialRowById: vi.fn(async (userId: string, id: string) => {
      const row = (fakeDb.tables.get('integration_credentials') ?? []).find((r) => r.id === id && r.user_id === userId);
      if (!row) return null;
      return { id: String(row.id), provider: String(row.provider), credentialKey: String(row.credential_key) };
    }),
  }));
});

describe('GET /api/workflows/[id]/integrations -- Gmail OAuth discovery (Phase 9.9.8C)', () => {
  it('1. a connected Gmail OAuth credential appears in workflow attachment discovery', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [{ id: GMAIL_CRED_ID, provider: 'gmail', credentials: { access_token: 'ya29.real-token' }, status: 'connected' }],
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.availableByProvider.gmail).toBeDefined();
    expect(body.availableByProvider.gmail).toHaveLength(1);
    expect(body.availableByProvider.gmail[0].integrationId).toBe(GMAIL_CRED_ID);
  });

  it('2. a disconnected Gmail does not appear in discovery', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [], // getUserIntegrations({connectedOnly:true}) omits it entirely once disconnected
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(body.availableByProvider.gmail ?? []).toHaveLength(0);
  });

  it('7. the discovery response never contains an OAuth access/refresh token', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [{ id: GMAIL_CRED_ID, provider: 'gmail', credentials: { access_token: 'ya29.super-secret-must-not-leak', refresh_token: '1//also-secret' }, status: 'connected' }],
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const text = await res.text();

    expect(text).not.toContain('ya29.super-secret-must-not-leak');
    expect(text).not.toContain('1//also-secret');
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('refresh_token');
  });

  it('9a. Airtable discovery is completely unaffected by the Gmail OAuth fix', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    fakeDb.tables.set('user_integrations', [
      { id: 'int-airtable-1', user_id: OWNER_ID, provider: 'airtable', name: null, status: 'connected' },
    ] as never);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [{ id: 'int-airtable-1', provider: 'airtable', credentials: {}, status: 'connected' }],
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();
    expect(body.availableByProvider.airtable).toHaveLength(1);
    expect(body.availableByProvider.airtable[0].integrationId).toBe('int-airtable-1');
  });
});

describe('POST /api/workflows/[id]/integrations -- attaching a Gmail OAuth credential (Phase 9.9.8C)', () => {
  it('3. attaching Gmail persists only the opaque credential id, never a secret, into workflow_integrations', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    // Either succeeds (constraint already allows 'gmail'), or fails with the
    // specific, honest PROVIDER_NOT_YET_ALLOWED schema-limitation error --
    // never a silent alias to 'email' and never a generic opaque failure.
    if (res.status === 200) {
      const rows = fakeDb.tables.get('workflow_integrations') ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0].integration_id).toBe(GMAIL_CRED_ID);
      expect(rows[0].provider).toBe('gmail'); // never aliased to 'email'
    } else {
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toBe('PROVIDER_NOT_YET_ALLOWED');
    }

    const text = await res.text();
    expect(text).not.toContain('ya29.');
    expect(text).not.toContain('encrypted-token-blob');
  });

  it('4. cross-tenant: cannot attach another user\'s Gmail OAuth credential', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(ATTACKER_ID, GMAIL_CRED_ID); // credential belongs to the ATTACKER, not OWNER

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('cross-tenant: cannot attach a real Gmail credential id to someone else\'s workflow', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    mockGetUserFromRequest.mockResolvedValue({ id: ATTACKER_ID });

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('rejects a Gmail credential that is no longer connected (revoked) at attach time -- fails closed', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    gmailConnected = false; // the row exists but verifyProviderConnection now says no

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('9b. attaching Airtable via the legacy path is completely unaffected', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    fakeDb.tables.set('user_integrations', [
      { id: 'int-airtable-1', user_id: OWNER_ID, provider: 'airtable', status: 'connected' },
    ] as never);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'airtable', integrationId: 'int-airtable-1' }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].integration_id).toBe('int-airtable-1');
    expect(rows[0].provider).toBe('airtable');
  });
});

// ─── Runtime resolution: resolveWorkflowIntegrations() ────────────────────────

describe('resolveWorkflowIntegrations -- runtime resolves the exact selected Gmail OAuth credential (Phase 9.9.8C)', () => {
  beforeEach(() => {
    // Earlier describe blocks in this file vi.doMock() '@/lib/user-integrations'
    // wholesale (route-level tests don't need the real bridging logic) --
    // doMock persists across tests in the same file regardless of
    // vi.resetModules(), so restore the real module explicitly here.
    vi.doUnmock('@/lib/user-integrations');
    vi.resetModules();
    vi.doMock('@/lib/credentials/oauth-providers', () => ({
      isOAuthProvider: (p: string) => p === 'gmail',
      getOAuthProviderConfig: (p: string) => (p === 'gmail' ? { credentialKey: 'oauth_google_gmail' } : null),
    }));
  });

  it('6. runtime resolves the selected Gmail credential server-side, returning a ready-to-use access_token', async () => {
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: GMAIL_CRED_ID },
    ]);
    // Full storage mock needed here (unlike the route-level tests above,
    // which mock '@/lib/user-integrations' wholesale) since this test
    // exercises the REAL bridging logic end-to-end.
    vi.doMock('@/lib/credentials/storage', () => ({
      verifyProviderConnection: vi.fn(async () => ({ connected: true, missing: [] })),
      getAllConnectedProviders: vi.fn(async () => ['gmail']),
      getCredentialRowId: vi.fn(async () => GMAIL_CRED_ID),
      getDecryptedProviderCredentials: vi.fn(async () => ({})),
    }));
    vi.doMock('@/lib/credentials/oauth-refresh', () => ({ getValidAccessToken: async () => 'ya29.real-access-token' }));

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const { resolved } = await resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] });

    expect(resolved.get('gmail' as never)?.id).toBe(GMAIL_CRED_ID);
    expect(resolved.get('gmail' as never)?.credentials.access_token).toBe('ya29.real-access-token');
  });

  it('5. activation/runtime resolution rejects a missing/revoked Gmail credential -- SETUP_REQUIRED, not a silent success', async () => {
    // The workflow_integrations row still points at a credential id that no
    // longer resolves (revoked/deleted) -- verifyProviderConnection now says
    // not connected, so getAllConnectedProviders-derived availability is empty.
    gmailConnected = false;
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: GMAIL_CRED_ID },
    ]);
    vi.doMock('@/lib/credentials/storage', () => ({
      verifyProviderConnection: vi.fn(async () => ({ connected: false, missing: [] })),
      getAllConnectedProviders: vi.fn(async () => []),
      getCredentialRowById: vi.fn(async () => null),
      getDecryptedProviderCredentials: vi.fn(async () => ({})),
    }));

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(
      resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] })
    ).rejects.toThrow('SETUP_REQUIRED:gmail');
  });

  it('8. no fallback to legacy SMTP/email: a broken Gmail OAuth credential never silently resolves to a coexisting legacy "email" row', async () => {
    gmailConnected = false;
    fakeDb.tables.set('user_integrations', [
      { id: 'int-email-1', user_id: OWNER_ID, provider: 'email', status: 'connected', credentials: {} },
    ] as never);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: GMAIL_CRED_ID },
    ]);
    vi.doMock('@/lib/credentials/storage', () => ({
      verifyProviderConnection: vi.fn(async () => ({ connected: false, missing: [] })),
      // Gmail was genuinely ATTEMPTED (appears in getAllConnectedProviders
      // -- e.g. a stale row still exists in integration_credentials but is
      // no longer valid), so Phase 9.9.7A's fail-closed rule excludes the
      // legacy 'email' row from fallback entirely.
      getAllConnectedProviders: vi.fn(async () => ['gmail']),
      getCredentialRowById: vi.fn(async () => null),
      getDecryptedProviderCredentials: vi.fn(async () => ({})),
    }));
    vi.doMock('@/lib/credentials/oauth-refresh', () => ({
      getValidAccessToken: vi.fn(async () => { throw new Error('refresh_token revoked'); }),
    }));

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(
      resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.gmail' }] })
    ).rejects.toThrow('SETUP_REQUIRED:gmail');
  });
});
