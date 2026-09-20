/**
 * Incident 9.9.17G -- a real Sigma Plus Hot lead failed immediately with
 * "SETUP_REQUIRED:gmail" on the Railway worker, even after
 * NEXT_PUBLIC_SITE_URL/GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET were reportedly
 * added there. That error message is thrown generically whenever gmail
 * resolves to zero available integrations
 * (lib/user-integrations.ts:resolveWorkflowIntegrations) -- it collapses
 * every distinct failure mode (no credential row, decrypt-key mismatch,
 * missing OAuth client config, a rejected Google refresh) into one
 * undifferentiated string, which is exactly why three separate live
 * incidents could not be told apart from the error alone.
 *
 * This test exercises the REAL dual-FK resolution chain end to end --
 * workflow_integrations -> credential_id -> integration_credentials ->
 * real AES-256-GCM decryption -> real OAuth provider config lookup -> a
 * real (mocked-at-fetch) Google token refresh call -- with only Supabase
 * and global fetch mocked. It does NOT mock getUserIntegrations() itself,
 * per the phase's explicit requirement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptSecretValue } from '../lib/security/encryption';

const USER_ID = '00000000-0000-4000-8000-0000000000ad';
const WORKFLOW_ID = 'wf-9917g-gmail-test';
const CREDENTIAL_ID = 'cred-gmail-9917g';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTableHandle(this.tables.get(name)!);
  }
  // getValidAccessToken() persists a successful refresh via
  // saveCredentialsWithVerification(), which calls this atomic RPC
  // (lib/credentials/storage.ts) -- not under test here, so it just succeeds.
  async rpc(_name: string, _params: unknown): Promise<{ error: null }> {
    return { error: null };
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function gmailWorkflow(): unknown {
  return {
    name: 'Hot Lead (9917G test)',
    nodes: [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'gmail', name: 'Send Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'x@example.com', subject: 's', text: 't' } },
    ],
    connections: { 'Webhook Trigger': { main: [[{ node: 'Send Gmail' }]] } },
  };
}

/** Seeds a real, correctly dual-FK-shaped Gmail OAuth attachment: workflow_integrations.credential_id -> integration_credentials, exactly like the real Sigma Plus workflow. */
function seedDualFkAttachment(tokenJson: Record<string, unknown>, opts?: { encryptWithKey?: string }) {
  fakeDb.tables.clear();
  const encryptionKeyBefore = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (opts?.encryptWithKey) process.env.INTEGRATIONS_ENCRYPTION_KEY = opts.encryptWithKey;
  const encrypted = encryptSecretValue(JSON.stringify(tokenJson));
  if (opts?.encryptWithKey) process.env.INTEGRATIONS_ENCRYPTION_KEY = encryptionKeyBefore;

  fakeDb.tables.set('integration_credentials', [
    { id: CREDENTIAL_ID, user_id: USER_ID, provider: 'gmail', credential_key: 'oauth_google_gmail', encrypted_value: encrypted, is_secret: true },
  ]);
  fakeDb.tables.set('workflow_integrations', [
    { id: 'wi-1', workflow_id: WORKFLOW_ID, user_id: USER_ID, provider: 'gmail', integration_id: null, credential_id: CREDENTIAL_ID },
  ]);
  fakeDb.tables.set('user_integrations', []); // no legacy fallback row -- purely dual-FK, like the real workflow
}

function freshToken(): Record<string, unknown> {
  return {
    access_token: 'live-access-token-not-a-real-secret',
    refresh_token: 'live-refresh-token-not-a-real-secret',
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600, // not due for refresh
  };
}

function expiredToken(): Record<string, unknown> {
  return {
    access_token: 'stale-access-token-not-a-real-secret',
    refresh_token: 'refresh-token-not-a-real-secret',
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) - 3600, // already expired -- forces a real refresh attempt
  };
}

function googleRefreshResponse(ok: boolean, body: Record<string, unknown>, status?: number) {
  return { ok, status: status ?? (ok ? 200 : 400), json: async () => body };
}

describe('Incident 9.9.17G -- worker-side dual-FK Gmail credential resolution (real chain, not a mocked readiness check)', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubEnv('INTEGRATIONS_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret-not-real');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a valid, unexpired token resolves without ever calling Google (no refresh needed)', async () => {
    seedDualFkAttachment(freshToken());
    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');

    const result = await resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow());
    expect(result.resolved.has('gmail')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an expired token triggers a REAL refresh call to Google, and a successful response resolves gmail correctly (proves the dual-FK chain end to end)', async () => {
    seedDualFkAttachment(expiredToken());
    fetchMock.mockResolvedValue(googleRefreshResponse(true, { access_token: 'new-access-token', expires_in: 3600, token_type: 'Bearer' }));

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    const result = await resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow());

    expect(result.resolved.has('gmail')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = String((init as { body: string }).body);
    expect(body).toContain('grant_type=refresh_token');
    // The gmail integration's resolved credential is the ready-to-use
    // access_token from Google's response, not the raw stored token JSON.
    expect(result.resolved.get('gmail')?.credentials.access_token).toBe('new-access-token');
  });

  it('Google rejecting the refresh (invalid_grant) surfaces SETUP_REQUIRED:gmail, and the new diagnostic log names the real, safe reason -- never a secret', async () => {
    seedDualFkAttachment(expiredToken());
    fetchMock.mockResolvedValue(googleRefreshResponse(false, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow())).rejects.toThrow('SETUP_REQUIRED:gmail');

    const loggedLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const relevant = loggedLines.find((l) => l.includes('credential_resolve_failed'));
    expect(relevant).toBeTruthy();
    // Incident 9.9.17J -- both the RFC 6749 error CODE and its description
    // must survive into the log; the pre-fix `??` chain discarded whichever
    // one it didn't pick, which is exactly what turned a real production
    // failure into an uninformative bare "Unauthorized".
    expect(relevant).toContain('invalid_grant');
    expect(relevant).toContain('Token has been expired or revoked');
    expect(relevant).toMatch(/HTTP \d+/);
    // Never the access/refresh token strings themselves.
    expect(relevant).not.toContain('stale-access-token-not-a-real-secret');
    expect(relevant).not.toContain('refresh-token-not-a-real-secret');
    expect(relevant).not.toContain('test-client-secret-not-real');

    warnSpy.mockRestore();
  });

  it('a decryption-key mismatch (simulating a Railway/Vercel INTEGRATIONS_ENCRYPTION_KEY divergence) is DISTINGUISHABLE in the diagnostic log from an OAuth/network failure', async () => {
    // Encrypted with a DIFFERENT key than what's active for this test run --
    // simulates exactly Part 6's concern: Railway holding a different
    // logical encryption key than whatever encrypted this credential.
    seedDualFkAttachment(freshToken(), { encryptWithKey: 'b'.repeat(64) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow())).rejects.toThrow('SETUP_REQUIRED:gmail');

    // Never even reaches Google -- decryption fails before any refresh is attempted.
    expect(fetchMock).not.toHaveBeenCalled();

    const loggedLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const relevant = loggedLines.find((l) => l.includes('credential_resolve_failed'));
    expect(relevant).toBeTruthy();
    expect(relevant).toContain('CredentialDecryptionError');
    expect(relevant).not.toContain('invalid_grant');

    warnSpy.mockRestore();
  });

  it('missing GOOGLE_CLIENT_ID/SECRET at refresh time is ALSO distinguishable from a decrypt or a Google-side rejection', async () => {
    seedDualFkAttachment(expiredToken());
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow())).rejects.toThrow('SETUP_REQUIRED:gmail');

    expect(fetchMock).not.toHaveBeenCalled(); // never reaches Google without client credentials

    const loggedLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const relevant = loggedLines.find((l) => l.includes('credential_resolve_failed'));
    expect(relevant).toBeTruthy();
    expect(relevant).toContain('OAuth credentials not configured for provider: gmail');

    warnSpy.mockRestore();
  });

  it('Incident 9.9.17J: an invalid_client rejection (Google\'s literal error_description "Unauthorized" for a client id/secret mismatch) preserves BOTH the error code and description and the HTTP status -- the previous `??` chain silently dropped the error code, leaving only the uninformative "Unauthorized" string a real production log showed', async () => {
    seedDualFkAttachment(expiredToken());
    fetchMock.mockResolvedValue(googleRefreshResponse(false, { error: 'invalid_client', error_description: 'Unauthorized' }, 401));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { resolveWorkflowIntegrations } = await import('../lib/user-integrations');
    await expect(resolveWorkflowIntegrations(USER_ID, WORKFLOW_ID, gmailWorkflow())).rejects.toThrow('SETUP_REQUIRED:gmail');

    const loggedLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const relevant = loggedLines.find((l) => l.includes('credential_resolve_failed'));
    expect(relevant).toBeTruthy();
    // The previously-lost signal: 'invalid_client' now survives alongside
    // 'Unauthorized', instead of the description alone swallowing it.
    expect(relevant).toContain('invalid_client');
    expect(relevant).toContain('Unauthorized');
    expect(relevant).toContain('HTTP 401');

    warnSpy.mockRestore();
  });
});
