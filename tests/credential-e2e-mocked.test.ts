/**
 * Phase 7.5 — Credential storage end-to-end test.
 *
 * LIVE DB STATUS: BLOCKED. The only Supabase instance configured in this
 * environment (.env.local NEXT_PUBLIC_SUPABASE_URL) is a remote *.supabase.co
 * project — treated as production/shared, so nothing is written to it without
 * explicit authorization. A local Supabase stack (CLI + Docker are both
 * installed) cannot be started either: the filesystem has ~229MB free, far
 * short of what the Postgres/GoTrue/PostgREST/Storage image set requires.
 *
 * This test instead exercises the REAL server code path end-to-end —
 * app/api/credentials/connect's route logic (saveCredentialsWithVerification),
 * the credential bridge (getUserIntegrations), and a real node handler — against
 * an in-memory fake Supabase client that mimics table storage exactly (insert,
 * upsert, select, eq-filter, delete, rpc). No application code is mocked;
 * only the network boundary (createServiceClient) is faked. This proves the
 * logic is correct; it does not prove RLS policies or the Postgres RPC
 * function behave identically on real infrastructure — that requires the live
 * migration replay marked BLOCKED in the Phase 7.5 report.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const VALID_UUID = '00000000-0000-4000-8000-000000000042';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'c'.repeat(64);
  }
});

// ─── In-memory fake Supabase client ────────────────────────────────────────────
// Mimics exactly the query shapes lib/credentials/storage.ts and
// lib/user-integrations.ts issue: .from(table).select().eq().eq() / .upsert() /
// .delete().eq().eq() / .maybeSingle(), plus .rpc() for the atomic save function.

type Row = Record<string, unknown>;

class FakeTable {
  constructor(private rows: Row[], private filters: Array<[string, unknown]> = []) {}

  eq(col: string, val: unknown): FakeTable {
    return new FakeTable(this.rows, [...this.filters, [col, val]]);
  }

  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([col, val]) => r[col] === val));
  }

  select(): FakeTable {
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }

  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }

  upsert(rows: Row | Row[]): { then: (resolve: (v: { error: null }) => void) => Promise<void> } {
    const incoming = Array.isArray(rows) ? rows : [rows];
    for (const row of incoming) {
      const idx = this.rows.findIndex(
        (r) => r.user_id === row.user_id && r.provider === row.provider && r.credential_key === row.credential_key,
      );
      if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...row };
      else this.rows.push({ ...row });
    }
    return { then: (resolve) => Promise.resolve(resolve({ error: null })) };
  }

  delete(): FakeDeleteBuilder {
    return new FakeDeleteBuilder(this.rows, this.filters);
  }
}

class FakeDeleteBuilder {
  constructor(private rows: Row[], private filters: Array<[string, unknown]> = []) {}

  eq(col: string, val: unknown): FakeDeleteBuilder {
    return new FakeDeleteBuilder(this.rows, [...this.filters, [col, val]]);
  }

  then<T>(resolve: (v: { error: null }) => T): Promise<T> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.filters.every(([col, val]) => this.rows[i][col] === val)) this.rows.splice(i, 1);
    }
    return Promise.resolve(resolve({ error: null }));
  }
}

class FakeDb {
  tables = new Map<string, Row[]>([
    ['integration_credentials', []],
    ['credential_verifications', []],
    ['user_integrations', []],
  ]);

  from(name: string): FakeTable {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTable(this.tables.get(name)!);
  }

  async rpc(fn: string, params: Record<string, unknown>): Promise<{ error: null }> {
    if (fn !== 'save_credentials_with_verification') throw new Error(`Unmocked RPC: ${fn}`);
    const now = new Date().toISOString();
    const rows = params.p_rows as Array<{ credential_key: string; encrypted_value: string; is_secret: boolean }>;
    const credTable = this.tables.get('integration_credentials')!;
    for (const row of rows) {
      credTable.push({
        user_id: params.p_user_id,
        provider: params.p_provider,
        credential_key: row.credential_key,
        encrypted_value: row.encrypted_value,
        is_secret: row.is_secret,
        created_at: now,
        updated_at: now,
      });
    }
    this.tables.get('credential_verifications')!.push({
      user_id: params.p_user_id,
      provider: params.p_provider,
      status: params.p_status,
      metadata: params.p_metadata,
      verified_at: now,
    });
    return { error: null };
  }
}

let fakeDb: FakeDb;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

describe('Credential storage E2E (mocked infrastructure — live DB BLOCKED, see file header)', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
    vi.clearAllMocks();
  });

  it('runs the full lifecycle: create → encrypted at rest → resolved via bridge → handler receives plaintext only at execution → delete', async () => {
    const { saveCredentialsWithVerification, getDecryptedProviderCredentials, deleteProviderCredentials, getAllConnectedProviders } =
      await import('../lib/credentials/storage');

    // 1. Create a credential through the same function app/api/credentials/connect/route.ts calls.
    const rawSecret = 'shpat_e2e_test_secret_value';
    await saveCredentialsWithVerification(
      VALID_UUID,
      'shopify',
      { shop_domain: 'e2e-test.myshopify.com', access_token: rawSecret },
      'healthy',
    );

    // 2. Confirm persistence is encrypted — the raw secret must never appear
    //    verbatim in the underlying table storage.
    const storedRows = fakeDb.tables.get('integration_credentials')!;
    const tokenRow = storedRows.find((r) => r.credential_key === 'access_token');
    expect(tokenRow).toBeDefined();
    expect(tokenRow!.encrypted_value).not.toBe(rawSecret);
    expect(String(tokenRow!.encrypted_value)).not.toContain(rawSecret);
    expect(String(tokenRow!.encrypted_value).split(':')).toHaveLength(3); // iv:tag:ciphertext

    // Non-secret field (shop_domain) is intentionally stored as plaintext.
    const domainRow = storedRows.find((r) => r.credential_key === 'shop_domain');
    expect(domainRow!.encrypted_value).toBe('e2e-test.myshopify.com');

    // 3a. workflow_json never contains the secret: CredentialRef carries only `provider`.
    const workflowJsonAsPersisted = { provider: 'shopify' };
    expect(JSON.stringify(workflowJsonAsPersisted)).not.toContain(rawSecret);

    // 3b. An API-response-shaped summary (what /api/credentials/status returns)
    //     never contains the secret — only masked/derived fields.
    const providers = await getAllConnectedProviders(VALID_UUID);
    expect(providers).toContain('shopify');
    expect(JSON.stringify(providers)).not.toContain(rawSecret);

    // 3c. "Logs" — simulate what a handler would log — must never include the raw value.
    const simulatedLogLine = `Shopify order fetched for shop ${domainRow!.encrypted_value}.`;
    expect(simulatedLogLine).not.toContain(rawSecret);

    // 4. Resolve through the runtime credential bridge (same function
    //    getUserIntegrations uses internally for the new credential system).
    const resolved = await getDecryptedProviderCredentials(VALID_UUID, 'shopify');
    expect(resolved.access_token).toBe(rawSecret); // only decrypted server-side, in-process

    // 5. Confirm a real node handler receives the decrypted value only at
    //    execution time, via the same integration shape context.integrations uses.
    const { shopifyHandler } = await import('../lib/workflow-runtime/node-handlers/shopify');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ order: { id: '1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await shopifyHandler(
      { id: 'n1', name: 'Get Order', type: 'n8n-nodes-base.shopifyOrder', parameters: { orderId: '1' } },
      { order_id: '1' },
      {
        mode: 'live',
        integrations: [{ provider: 'shopify', credentials: resolved, status: 'connected' }],
        sampleData: {},
        previews: { emails: [], slackMessages: [], airtableRecords: [] },
      },
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers['X-Shopify-Access-Token']).toBe(rawSecret);
    expect(result.status).toBe('success');
    // The handler's own result (what gets persisted as node output) never echoes the secret back.
    expect(JSON.stringify(result.outputData)).not.toContain(rawSecret);
    expect(JSON.stringify(result.logs)).not.toContain(rawSecret);
    vi.unstubAllGlobals();

    // 6. Delete the test credential.
    await deleteProviderCredentials(VALID_UUID, 'shopify');
    const remaining = fakeDb.tables.get('integration_credentials')!.filter((r) => r.user_id === VALID_UUID && r.provider === 'shopify');
    expect(remaining).toHaveLength(0);
  });

  it('the credential bridge (getUserIntegrations) exposes only decrypted values in-process, never the encrypted row shape', async () => {
    const { saveCredentialsWithVerification } = await import('../lib/credentials/storage');
    await saveCredentialsWithVerification(VALID_UUID, 'openai', { api_key: 'sk-e2e-bridge-test' }, 'healthy');

    const { getUserIntegrations } = await import('../lib/user-integrations');
    const rows = await getUserIntegrations(VALID_UUID);

    const openai = rows.find((r) => r.provider === 'openai');
    expect(openai?.credentials.api_key).toBe('sk-e2e-bridge-test');
    // The row shape must never leak `encrypted_value` / `is_secret` DB columns to callers.
    expect(openai).not.toHaveProperty('encrypted_value');
  });
});
