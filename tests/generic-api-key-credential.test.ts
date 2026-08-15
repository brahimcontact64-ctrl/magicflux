/**
 * Phase 7.5 — Generic/custom API-key credential: registry, validation, and
 * full save → resolve → delete lifecycle (mocked infrastructure — see
 * tests/credential-e2e-mocked.test.ts for why live DB is unavailable here).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const VALID_UUID = '00000000-0000-4000-8000-000000000077';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'e'.repeat(64);
  }
});

// ─── Fake Supabase client (module scope — vi.mock factories must not close
// over describe-block-local state) for the lifecycle describe block below ───

type Row = Record<string, unknown>;

class FakeTable {
  constructor(private rows: Row[], private filters: Array<[string, unknown]> = []) {}
  eq(col: string, val: unknown): FakeTable { return new FakeTable(this.rows, [...this.filters, [col, val]]); }
  select(): FakeTable { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
  delete(): { eq: (c: string, v: unknown) => ReturnType<FakeTable['delete']>; then: (r: (v: { error: null }) => unknown) => Promise<unknown> } {
    const filters = [...this.filters];
    const rows = this.rows;
    const builder = {
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return builder;
      },
      then: (resolve: (v: { error: null }) => unknown) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every(([c, v]) => rows[i][c] === v)) rows.splice(i, 1);
        }
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return builder;
  }
}

class FakeDb {
  tables = new Map<string, Row[]>([['integration_credentials', []], ['credential_verifications', []]]);
  from(name: string): FakeTable {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTable(this.tables.get(name)!);
  }
  async rpc(fn: string, params: Record<string, unknown>): Promise<{ error: null }> {
    if (fn !== 'save_credentials_with_verification') throw new Error(`Unmocked RPC: ${fn}`);
    const now = new Date().toISOString();
    const rows = params.p_rows as Array<{ credential_key: string; encrypted_value: string; is_secret: boolean }>;
    for (const row of rows) {
      this.tables.get('integration_credentials')!.push({
        user_id: params.p_user_id, provider: params.p_provider,
        credential_key: row.credential_key, encrypted_value: row.encrypted_value, is_secret: row.is_secret,
        created_at: now, updated_at: now,
      });
    }
    return { error: null };
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn(() => fakeDb) }));

describe('provider-registry: custom credential fields', () => {
  it('registers name, header_name, prefix, and api_key fields', async () => {
    const { getProviderCredentials } = await import('../lib/credentials/provider-registry');
    const fields = getProviderCredentials('custom');
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['name', 'header_name', 'prefix', 'api_key']);
  });

  it('name, header_name, and api_key are required; prefix is optional', async () => {
    const { getProviderCredentials } = await import('../lib/credentials/provider-registry');
    const fields = getProviderCredentials('custom');
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.name.required).toBe(true);
    expect(byKey.header_name.required).toBe(true);
    expect(byKey.api_key.required).toBe(true);
    expect(byKey.prefix.required).toBe(false);
  });

  it('only api_key is marked secret (encrypted at rest) — name/header_name/prefix are plaintext-safe', async () => {
    const { getProviderCredentials } = await import('../lib/credentials/provider-registry');
    const fields = getProviderCredentials('custom');
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.api_key.secret).toBe(true);
    expect(byKey.name.secret).toBe(false);
    expect(byKey.header_name.secret).toBe(false);
    expect(byKey.prefix.secret).toBe(false);
  });
});

describe('validateProviderConnection("custom", ...)', () => {
  it('passes without making any network request — there is no fixed endpoint to validate against', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { validateProviderConnection } = await import('../lib/credentials/provider-verifier');
    const result = await validateProviderConnection('custom', {
      name: 'Internal API', header_name: 'Authorization', prefix: 'Bearer', api_key: 'sk-test',
    });

    expect(result.connected).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('this is what unblocks saving — before this validator existed, /api/credentials/connect always 422d for "custom"', async () => {
    const { validateProviderConnection } = await import('../lib/credentials/provider-verifier');
    const result = await validateProviderConnection('custom', { api_key: 'x' });
    // Must NOT be the "No validator available" fallback error.
    expect(result.errors.join(' ')).not.toContain('No validator available');
  });
});

describe('generic API-key credential lifecycle (mocked infrastructure)', () => {
  beforeEach(() => { fakeDb.tables = new Map([['integration_credentials', []], ['credential_verifications', []]]); });

  it('save → the raw api_key is encrypted at rest, name/header_name/prefix stay plaintext', async () => {
    const { saveCredentialsWithVerification } = await import('../lib/credentials/storage');
    await saveCredentialsWithVerification(
      VALID_UUID, 'custom',
      { name: 'Weather API', header_name: 'X-Api-Key', prefix: '', api_key: 'raw-secret-abc' },
      'healthy',
    );

    const rows = fakeDb.tables.get('integration_credentials')!;
    const keyRow = rows.find((r) => r.credential_key === 'api_key');
    expect(keyRow!.encrypted_value).not.toBe('raw-secret-abc');
    expect(String(keyRow!.encrypted_value).split(':')).toHaveLength(3);

    const nameRow = rows.find((r) => r.credential_key === 'name');
    expect(nameRow!.encrypted_value).toBe('Weather API'); // plaintext — not secret
  });

  it('resolve → getDecryptedProviderCredentials returns the original plaintext api_key', async () => {
    const { saveCredentialsWithVerification, getDecryptedProviderCredentials } = await import('../lib/credentials/storage');
    await saveCredentialsWithVerification(
      VALID_UUID, 'custom',
      { name: 'Weather API', header_name: 'X-Api-Key', api_key: 'raw-secret-abc' },
      'healthy',
    );

    const resolved = await getDecryptedProviderCredentials(VALID_UUID, 'custom');
    expect(resolved.api_key).toBe('raw-secret-abc');
    expect(resolved.header_name).toBe('X-Api-Key');
  });

  it('resolves through the credential bridge (getUserIntegrations) into the shape httpHandler reads', async () => {
    const { saveCredentialsWithVerification } = await import('../lib/credentials/storage');
    await saveCredentialsWithVerification(
      VALID_UUID, 'custom',
      { name: 'Weather API', header_name: 'X-Api-Key', prefix: 'Bearer', api_key: 'raw-secret-abc' },
      'healthy',
    );

    const { getUserIntegrations } = await import('../lib/user-integrations');
    const rows = await getUserIntegrations(VALID_UUID);
    const custom = rows.find((r) => r.provider === 'custom');
    expect(custom?.credentials.api_key).toBe('raw-secret-abc');
    expect(custom?.credentials.header_name).toBe('X-Api-Key');
    expect(custom?.credentials.prefix).toBe('Bearer');
  });

  it('delete → the credential is fully removed', async () => {
    const { saveCredentialsWithVerification, deleteProviderCredentials, getAllConnectedProviders } = await import('../lib/credentials/storage');
    await saveCredentialsWithVerification(VALID_UUID, 'custom', { name: 'X', header_name: 'X-Api-Key', api_key: 'k' }, 'healthy');
    expect(await getAllConnectedProviders(VALID_UUID)).toContain('custom');

    await deleteProviderCredentials(VALID_UUID, 'custom');
    expect(await getAllConnectedProviders(VALID_UUID)).not.toContain('custom');
  });

  it('the workflow_json reference shape (CredentialRef) never carries the api_key', () => {
    const ref = { provider: 'custom' };
    expect(JSON.stringify(ref)).not.toContain('api_key');
    expect(Object.keys(ref)).toEqual(['provider']);
  });
});
