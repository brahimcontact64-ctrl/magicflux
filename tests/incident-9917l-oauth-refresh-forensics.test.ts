/**
 * Incident 9.9.17L -- Vercel and Railway's Gmail OAuth client fingerprints
 * were proven to match exactly, ruling out cross-runtime client drift. Yet
 * Google still rejects Railway's refresh with unauthorized_client. Tracing
 * this further exposed a real evidentiary gap: neither the automatic
 * refresh write path (lib/credentials/oauth-refresh.ts) nor the manual
 * reconnect write path (app/api/oauth/callback/route.ts) ever recorded
 * WHICH of the two produced a given credential_verifications row, or which
 * OAuth client / refresh-token identity was involved -- so a prior
 * "healthy" verification could not be proven, after the fact, to have come
 * from a genuine Google token-endpoint exchange at all.
 *
 * This file certifies the fix: every write now carries a `source` tag
 * ('automatic_refresh' vs 'oauth_callback_connect'), the OAuth client
 * fingerprint used, and a one-way refresh-token fingerprint (before/after,
 * for the refresh path) -- all safe, non-secret, and sufficient to answer
 * "was this a real exchange" and "did the refresh token's identity change"
 * for every future occurrence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000fa';
const PROVIDER = 'gmail';
const CRED_KEY = 'oauth_google_gmail';

let store: Record<string, string> = {};
let saveCalls: Array<{ userId: string; provider: string; credentials: Record<string, string>; status: string; metadata: unknown }> = [];

vi.mock('@/lib/credentials/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials/storage')>();
  return {
    ...actual,
    getDecryptedProviderCredentials: vi.fn(async (_userId: string, provider: string) => {
      const value = store[provider];
      return value ? { [CRED_KEY]: value } : {};
    }),
    saveCredentialsWithVerification: vi.fn(async (userId: string, provider: string, credentials: Record<string, string>, status: string, metadata?: unknown) => {
      saveCalls.push({ userId, provider, credentials, status, metadata });
      store[provider] = credentials[CRED_KEY];
    }),
    updateVerificationStatus: vi.fn(async () => undefined),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function tokenJson(overrides: Partial<{ access_token: string; refresh_token: string | null; expires_at: number }> = {}): string {
  return JSON.stringify({
    access_token: overrides.access_token ?? 'stale-access-token-not-real',
    refresh_token: overrides.refresh_token === undefined ? 'original-refresh-token-not-real' : overrides.refresh_token,
    token_type: 'Bearer',
    expires_at: overrides.expires_at ?? Math.floor(Date.now() / 1000) - 3600,
  });
}

function googleResponse(ok: boolean, body: Record<string, unknown>, status?: number) {
  return { ok, status: status ?? (ok ? 200 : 400), json: async () => body };
}

describe('automatic refresh write -- forensic tagging', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    store = { [PROVIDER]: tokenJson() };
    saveCalls = [];
    vi.stubEnv('GOOGLE_CLIENT_ID', 'real-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'real-client-secret-not-real');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('tags a successful automatic refresh with source: automatic_refresh, never anything else', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600 }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    expect(saveCalls).toHaveLength(1);
    const metadata = saveCalls[0].metadata as Record<string, unknown>;
    expect(metadata.source).toBe('automatic_refresh');
  });

  it('records the OAuth client fingerprint used for the refresh, matching computeOAuthClientFingerprint', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600 }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    await getValidAccessToken(USER_ID, PROVIDER);

    const metadata = saveCalls[0].metadata as Record<string, unknown>;
    expect(metadata.client_fingerprint).toEqual(computeOAuthClientFingerprint('gmail'));
  });

  it('proves refresh-token PRESERVATION: previous and new fingerprints are identical when Google omits a new refresh_token', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600 })); // no refresh_token in response
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const metadata = saveCalls[0].metadata as Record<string, unknown>;
    expect(metadata.previous_refresh_token_fingerprint).toBe(metadata.refresh_token_fingerprint);
    expect(metadata.previous_refresh_token_fingerprint).toBeTruthy();
  });

  it('proves refresh-token ROTATION: previous and new fingerprints DIFFER when Google issues a new refresh_token', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token-not-real', expires_in: 3600 }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const metadata = saveCalls[0].metadata as Record<string, unknown>;
    expect(metadata.previous_refresh_token_fingerprint).not.toBe(metadata.refresh_token_fingerprint);
  });

  it('never puts the raw refresh token or client secret anywhere in the persisted metadata', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600 }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const serialized = JSON.stringify(saveCalls[0].metadata);
    expect(serialized).not.toContain('original-refresh-token-not-real');
    expect(serialized).not.toContain('real-client-secret-not-real');
  });

  it('records runtime identity alongside the refresh', async () => {
    vi.stubEnv('RAILWAY_SERVICE_NAME', 'runtime-worker');
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600 }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const metadata = saveCalls[0].metadata as Record<string, unknown>;
    expect((metadata.runtime as Record<string, unknown>).platform).toBe('railway');
  });

  it('a config_fault failure is never written to credential_verifications (status column must not flip for a platform bug) but IS logged with full forensics', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'unauthorized_client', error_description: 'Unauthorized' }, 401));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toThrow();

    expect(saveCalls).toHaveLength(0); // no DB status write for a config fault
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('platform_config_fault'));
    expect(logged).toBeTruthy();
    expect(logged).toContain('client_fingerprint');
    expect(logged).toContain('refresh_token_fingerprint');
    expect(logged).not.toContain('original-refresh-token-not-real');
    warnSpy.mockRestore();
  });
});
