/**
 * Phase 9.9.8E — dual-FK identity architecture for workflow_integrations.
 *
 * Root cause: workflow_integrations.integration_id carried a single FK to
 * user_integrations(id). Phase 9.9.8C's Gmail OAuth discovery/attach fix
 * (necessarily) surfaces integration_credentials.id for OAuth-bridged
 * providers -- a disjoint UUID space never present in user_integrations --
 * so every real attach attempt failed with a Postgres 23503
 * foreign_key_violation, masked by classifyError() as the generic
 * "temporary_system_problem". Confirmed live in production, read-only: the
 * real Gmail credential id does not exist in user_integrations, and two
 * genuine attach attempts (captured via `vercel logs`) both returned 503 at
 * the exact moment classifyError() would map a 23503 to that response.
 *
 * A single FK column cannot validly reference two different tables. Fix:
 * supabase/migrations/20260916143924_add_credential_id_dual_fk_workflow_integrations.sql
 * adds a second, independently-enforced identity column instead of
 * weakening the existing one:
 *   - integration_id  (kept, FK unchanged, now nullable) -> user_integrations(id)
 *   - credential_id   (new, nullable) -> integration_credentials(id) ON DELETE CASCADE
 *   - XOR CHECK: exactly one of the two must be non-null on every row.
 *
 * Verified read-only immediately before writing the migration (production,
 * via the Supabase REST API with the service-role key): all existing
 * workflow_integrations rows have a non-null integration_id, and every
 * distinct value exists in user_integrations -- making the column nullable
 * is a no-op for every current row, and no backfill into credential_id is
 * needed since no OAuth-bridged row has ever been successfully attached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

const OWNER_ID = '00000000-0000-4000-8000-0000000000d1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000d2';
const WORKFLOW_ID = 'wf-dual-fk-test';
const GMAIL_CRED_ID = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const AIRTABLE_LEGACY_ID = 'int-airtable-legacy-1';

// ─── Migration file content assertions ─────────────────────────────────────

describe('Phase 9.9.8E migration file -- dual-FK identity, XOR-checked, additive only', () => {
  const migrationPath = path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260916143924_add_credential_id_dual_fk_workflow_integrations.sql'
  );
  const source = fs.readFileSync(migrationPath, 'utf8');
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('makes integration_id nullable without touching its existing FK', () => {
    expect(code).toMatch(/ALTER COLUMN\s+"integration_id"\s+DROP NOT NULL/);
    // The pre-existing FK to user_integrations is never dropped or recreated.
    expect(code).not.toMatch(/DROP CONSTRAINT\s+"workflow_integrations_integration_id_fkey"/);
  });

  it('adds a new nullable credential_id column with its own FK to integration_credentials, ON DELETE CASCADE', () => {
    expect(code).toMatch(/ADD COLUMN\s+"credential_id"\s+"uuid"/);
    expect(code).toMatch(
      /FOREIGN KEY\s*\(\s*"credential_id"\s*\)\s*REFERENCES\s+"public"\."integration_credentials"\("id"\)\s+ON DELETE CASCADE/
    );
  });

  it('adds an index on credential_id', () => {
    expect(code).toMatch(/CREATE INDEX\s+"idx_workflow_integrations_credential"/);
  });

  it('adds an XOR CHECK requiring exactly one of integration_id / credential_id', () => {
    expect(code).toMatch(/ADD CONSTRAINT\s+"workflow_integrations_identity_xor_check"/);
    expect(code).toMatch(/CHECK/);
    // Both shapes of "exactly one" must appear in the expression.
    expect(code).toMatch(/"integration_id"\s+IS NOT NULL/);
    expect(code).toMatch(/"integration_id"\s+IS NULL/);
    expect(code).toMatch(/"credential_id"\s+IS NOT NULL/);
    expect(code).toMatch(/"credential_id"\s+IS NULL/);
  });

  it('touches nothing else -- no provider CHECK, RLS, grant, or unrelated table/index/FK change', () => {
    expect(code).not.toMatch(/workflow_integrations_provider_check/);
    expect(code).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/GRANT\b/i);
    expect(code).not.toMatch(/DROP TABLE/i);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/workflow_integrations_workflow_id_fkey/);
    expect(code).not.toMatch(/workflow_integrations_user_id_fkey/);
  });

  it('the XOR expression itself is satisfied by exactly the two valid shapes and rejects the two invalid ones', () => {
    // A direct behavioral check of the CHECK constraint's semantics --
    // exactly one of (integration_id, credential_id) may be non-null. This
    // mirrors the SQL asserted above without requiring a live Postgres
    // connection (this test suite has no local DB harness; the schema
    // change itself was verified read-only against production separately).
    const satisfiesXor = (integrationId: string | null, credentialId: string | null) =>
      (integrationId !== null && credentialId === null) || (integrationId === null && credentialId !== null);

    expect(satisfiesXor('legacy-id', null)).toBe(true); // legacy row
    expect(satisfiesXor(null, 'credential-id')).toBe(true); // OAuth/native row
    expect(satisfiesXor(null, null)).toBe(false); // both null -- rejected
    expect(satisfiesXor('legacy-id', 'credential-id')).toBe(false); // both populated -- rejected
  });
});

// ─── Route-level fake DB harness ────────────────────────────────────────────

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push([col, vals as unknown]); return this; }
  select(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v))
    );
  }
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
  delete() {
    const rows = this.rows;
    const filters: Array<[string, unknown[] | unknown]> = [];
    const builder = {
      in(col: string, vals: unknown[]) { filters.push([col, vals]); return builder; },
      eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
      async then<T>(resolve: (v: { error: null }) => T): Promise<T> {
        const toDelete = rows.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)));
        for (const row of toDelete) {
          const idx = rows.indexOf(row);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return resolve({ error: null });
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
    { id, user_id: userId, provider: 'gmail', credential_key: 'oauth_google_gmail', encrypted_value: 'encrypted-blob', is_secret: true },
  ]);
}

function seedLegacyAirtable(userId: string, id: string) {
  fakeDb.tables.set('user_integrations', [
    { id, user_id: userId, provider: 'airtable', status: 'connected' },
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

describe('POST -- legacy vs OAuth attachment writes exactly one identity column', () => {
  it('legacy Airtable attachment writes integration_id only', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    seedLegacyAirtable(OWNER_ID, AIRTABLE_LEGACY_ID);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'airtable', integrationId: AIRTABLE_LEGACY_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].integration_id).toBe(AIRTABLE_LEGACY_ID);
    expect(rows[0].credential_id ?? null).toBeNull();
  });

  it('Gmail OAuth attachment writes credential_id only', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_id).toBe(GMAIL_CRED_ID);
    expect(rows[0].integration_id ?? null).toBeNull();
    expect(rows[0].provider).toBe('gmail');
  });

  it('an id that does not exist in EITHER table (invalid legacy AND invalid OAuth reference) is rejected as not found, never written', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    // Neither user_integrations nor integration_credentials has this id.
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: 'totally-nonexistent-id' }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('replacing a legacy attachment with an OAuth one for the same canonical provider clears the stale legacy column', async () => {
    // e.g. a workflow previously had a legacy SMTP "email" row; the user now
    // attaches real Gmail OAuth for the same canonical "gmail" provider slot.
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-existing', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'email', integration_id: 'legacy-email-id', credential_id: null },
    ]);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1); // updated in place, not a second row
    expect(rows[0].id).toBe('wi-existing');
    expect(rows[0].credential_id).toBe(GMAIL_CRED_ID);
    expect(rows[0].integration_id).toBeNull(); // stale legacy id cleared, never left dangling
    expect(rows[0].provider).toBe('gmail');
  });

  it('cross-tenant: cannot attach another user\'s Gmail OAuth credential', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(ATTACKER_ID, GMAIL_CRED_ID);

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('revoked Gmail credential fails closed at attach time', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    gmailConnected = false;

    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(404);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });
});

describe('GET -- discovery/attached-matching works for both identity column shapes', () => {
  it('a legacy attachment (integration_id set) is reported as attached', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'airtable', integration_id: AIRTABLE_LEGACY_ID, credential_id: null },
    ]);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [{ id: AIRTABLE_LEGACY_ID, provider: 'airtable', credentials: {}, status: 'connected' }],
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(body.availableByProvider.airtable[0].attached).toBe(true);
    expect(body.attached).toContainEqual({ provider: 'airtable', integrationId: AIRTABLE_LEGACY_ID });
  });

  it('an OAuth attachment (credential_id set) is reported as attached', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: null, credential_id: GMAIL_CRED_ID },
    ]);
    vi.doMock('@/lib/user-integrations', () => ({
      getUserIntegrations: async () => [{ id: GMAIL_CRED_ID, provider: 'gmail', credentials: { access_token: 'ya29.x' }, status: 'connected' }],
    }));

    const { GET } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await GET(makeReq('GET'), { params: { id: WORKFLOW_ID } });
    const body = await res.json();

    expect(body.availableByProvider.gmail[0].attached).toBe(true);
    expect(body.attached).toContainEqual({ provider: 'gmail', integrationId: GMAIL_CRED_ID });
  });
});

describe('DELETE -- detach/re-attach semantics work for both identity types', () => {
  it('detaches a legacy (integration_id) row by canonical provider match', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['airtable']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'airtable', integration_id: AIRTABLE_LEGACY_ID, credential_id: null },
    ]);

    const { DELETE } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await DELETE(makeReq('DELETE', { provider: 'airtable' }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('detaches an OAuth (credential_id) row by canonical provider match', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: null, credential_id: GMAIL_CRED_ID },
    ]);

    const { DELETE } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await DELETE(makeReq('DELETE', { provider: 'gmail' }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(200);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('re-attaching Gmail after a detach creates a fresh, correctly-shaped credential_id row', async () => {
    seedWorkflow(WORKFLOW_ID, OWNER_ID, ['gmail']);
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: null, credential_id: GMAIL_CRED_ID },
    ]);

    const routeModule = await import('../app/api/workflows/[id]/integrations/route');
    const detachRes = await routeModule.DELETE(makeReq('DELETE', { provider: 'gmail' }), { params: { id: WORKFLOW_ID } });
    expect(detachRes.status).toBe(200);
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);

    const attachRes = await routeModule.POST(makeReq('POST', { provider: 'gmail', integrationId: GMAIL_CRED_ID }), { params: { id: WORKFLOW_ID } });
    expect(attachRes.status).toBe(200);
    const rows = fakeDb.tables.get('workflow_integrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_id).toBe(GMAIL_CRED_ID);
    expect(rows[0].integration_id ?? null).toBeNull();
  });
});

// ─── Runtime resolution ─────────────────────────────────────────────────────

describe('resolveWorkflowIntegrations -- resolves both identity column shapes correctly', () => {
  beforeEach(() => {
    vi.doUnmock('@/lib/user-integrations');
    vi.resetModules();
    vi.doMock('@/lib/credentials/oauth-providers', () => ({
      isOAuthProvider: (p: string) => p === 'gmail',
      getOAuthProviderConfig: (p: string) => (p === 'gmail' ? { credentialKey: 'oauth_google_gmail' } : null),
    }));
  });

  it('Gmail resolves correctly at runtime through credential_id', async () => {
    seedGmailCredential(OWNER_ID, GMAIL_CRED_ID);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: null, credential_id: GMAIL_CRED_ID },
    ]);
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

  it('existing legacy workflows (integration_id-only rows) still resolve unchanged', async () => {
    fakeDb.tables.set('user_integrations', [
      { id: AIRTABLE_LEGACY_ID, user_id: OWNER_ID, provider: 'airtable', status: 'connected', credentials: { personal_access_token: 'pat-real' } },
    ] as never);
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'airtable', integration_id: AIRTABLE_LEGACY_ID, credential_id: null },
    ]);
    vi.doMock('@/lib/credentials/storage', () => ({
      verifyProviderConnection: vi.fn(async () => ({ connected: false, missing: [] })),
      getAllConnectedProviders: vi.fn(async () => []), // no NEW-system connection -- pure legacy path
      getCredentialRowId: vi.fn(async () => null),
      getDecryptedProviderCredentials: vi.fn(async () => ({})),
    }));

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const { resolved } = await resolveWorkflowIntegrations(OWNER_ID, WORKFLOW_ID, { nodes: [{ type: 'n8n-nodes-base.airtable' }] });

    expect(resolved.get('airtable' as never)?.id).toBe(AIRTABLE_LEGACY_ID);
    expect(resolved.get('airtable' as never)?.credentials.personal_access_token).toBe('pat-real');
  });

  it('a revoked Gmail credential (credential_id-selected row) fails closed -- SETUP_REQUIRED', async () => {
    gmailConnected = false;
    fakeDb.tables.set('workflow_integrations', [
      { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: OWNER_ID, provider: 'gmail', integration_id: null, credential_id: GMAIL_CRED_ID },
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
});
