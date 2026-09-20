/**
 * Incident 9.9.17K -- Google confirmed the exact rejection for the new
 * production failure (execution 255bd971-25b8-487b-9795-b18e6a8ee31d,
 * 2026-09-20T19:21:48Z): "OAuth token refresh rejected for gmail (HTTP 401):
 * unauthorized_client: Unauthorized". That is a platform OAuth-client
 * identity problem (Google rejects the client_id/client_secret pair
 * itself), never something the end user can fix by reconnecting Gmail --
 * yet before this incident every OAuth refresh failure (config fault,
 * genuinely dead grant, transient provider outage) collapsed into the same
 * undifferentiated SETUP_REQUIRED:gmail three layers up.
 *
 * This file certifies:
 *  - classifyOAuthRejection()'s pure classification table
 *  - getValidAccessToken() propagating that classification correctly for
 *    each Google error code, including automatic refresh with zero
 *    classification error on the happy path
 *  - the credential_verifications side effect: 'invalid' ONLY for a
 *    genuinely dead grant, never for a config fault or transient failure
 *  - refresh_token preservation/rotation
 *  - concurrent refreshes cannot corrupt stored token state
 *  - whitespace-only env corruption is normalized away before use
 *  - no secret/token material ever reaches a log line
 *  - OAuth client fingerprints: deterministic, whitespace-insensitive,
 *    non-secret, and sensitive to a genuine client id/secret change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyOAuthRejection, ClassifiedOAuthError } from '../lib/credentials/oauth-errors';

const USER_ID = '00000000-0000-4000-8000-0000000000fe';
const PROVIDER = 'gmail';
const CRED_KEY = 'oauth_google_gmail';

// ── classifyOAuthRejection: pure function, no mocking needed ──────────────

describe('classifyOAuthRejection', () => {
  it('classifies unauthorized_client as config_fault -- the exact code this incident is about', () => {
    expect(classifyOAuthRejection('unauthorized_client', 401)).toBe('config_fault');
  });
  it('classifies invalid_client as config_fault', () => {
    expect(classifyOAuthRejection('invalid_client', 401)).toBe('config_fault');
  });
  it('classifies invalid_grant as reconnect_required', () => {
    expect(classifyOAuthRejection('invalid_grant', 400)).toBe('reconnect_required');
  });
  it('classifies HTTP 429 as transient regardless of error code', () => {
    expect(classifyOAuthRejection('unauthorized_client', 429)).toBe('transient');
  });
  it('classifies any 5xx as transient regardless of error code', () => {
    expect(classifyOAuthRejection(null, 503)).toBe('transient');
    expect(classifyOAuthRejection('invalid_grant', 500)).toBe('transient');
  });
  it('classifies an unrecognized code as unknown, never silently as config_fault or reconnect_required', () => {
    expect(classifyOAuthRejection('some_new_google_error', 400)).toBe('unknown');
    expect(classifyOAuthRejection(null, 400)).toBe('unknown');
  });
});

// ── getValidAccessToken() -- real refreshOAuthToken/classification chain,
//    only the DB-touching storage functions mocked (in-memory, mutable, so
//    concurrency/rotation/preservation can be genuinely exercised). ──────

let store: Record<string, string> = {};
let verificationCalls: Array<{ userId: string; provider: string; status: string; metadata: unknown }> = [];
let saveCalls: Array<{ userId: string; provider: string; credentials: Record<string, string> }> = [];

vi.mock('@/lib/credentials/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials/storage')>();
  return {
    ...actual,
    getDecryptedProviderCredentials: vi.fn(async (_userId: string, provider: string) => {
      const value = store[provider];
      return value ? { [CRED_KEY]: value } : {};
    }),
    saveCredentialsWithVerification: vi.fn(async (userId: string, provider: string, credentials: Record<string, string>) => {
      saveCalls.push({ userId, provider, credentials });
      store[provider] = credentials[CRED_KEY];
    }),
    updateVerificationStatus: vi.fn(async (userId: string, provider: string, status: string, metadata?: unknown) => {
      verificationCalls.push({ userId, provider, status, metadata });
    }),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function tokenJson(overrides: Partial<{ access_token: string; refresh_token: string | null; expires_at: number }> = {}): string {
  return JSON.stringify({
    access_token: overrides.access_token ?? 'stale-access-token-not-real',
    refresh_token: overrides.refresh_token === undefined ? 'stable-refresh-token-not-real' : overrides.refresh_token,
    token_type: 'Bearer',
    expires_at: overrides.expires_at ?? Math.floor(Date.now() / 1000) - 3600, // already expired
  });
}

function googleResponse(ok: boolean, body: Record<string, unknown>, status?: number) {
  return { ok, status: status ?? (ok ? 200 : 400), json: async () => body };
}

describe('getValidAccessToken -- classification, verification-status side effects, no false revocation', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    store = {};
    verificationCalls = [];
    saveCalls = [];
    vi.stubEnv('GOOGLE_CLIENT_ID', 'real-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'real-client-secret-not-real');
    store[PROVIDER] = tokenJson();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a fresh, unexpired token requires zero operator/network involvement -- returns immediately, no fetch', async () => {
    store[PROVIDER] = tokenJson({ expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    const token = await getValidAccessToken(USER_ID, PROVIDER);
    expect(token).toBe('stale-access-token-not-real');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an expired token refreshes fully automatically and persists the new state -- the required SaaS lifecycle behavior', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer' }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    const token = await getValidAccessToken(USER_ID, PROVIDER);
    expect(token).toBe('fresh-access-token');
    expect(saveCalls).toHaveLength(1);
    expect(verificationCalls).toHaveLength(0); // no reconnect-required signal on a healthy refresh
  });

  it('unauthorized_client (this incident\'s exact new failure) is classified config_fault and does NOT mark the credential invalid', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'unauthorized_client', error_description: 'Unauthorized' }, 401));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    let caught: unknown;
    try { await getValidAccessToken(USER_ID, PROVIDER); } catch (e) { caught = e; }

    // Note: caught here comes from a module instance re-imported after
    // vi.resetModules(), so it is not `instanceof` the ClassifiedOAuthError
    // class captured by this file's top-level static import (a different
    // module-registry copy of the same class) -- name/property checks are
    // the correct way to assert its shape across that boundary.
    expect((caught as Error).name).toBe('ClassifiedOAuthError');
    expect((caught as ClassifiedOAuthError).errorClass).toBe('config_fault');
    expect((caught as ClassifiedOAuthError).oauthErrorCode).toBe('unauthorized_client');
    expect((caught as ClassifiedOAuthError).httpStatus).toBe(401);
    // The one behavior this incident's Part D explicitly prohibits: never
    // tell the user to reconnect for a platform config fault.
    expect(verificationCalls).toHaveLength(0);
  });

  it('invalid_client is also classified config_fault, never reconnect_required', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toMatchObject({ errorClass: 'config_fault' });
    expect(verificationCalls).toHaveLength(0);
  });

  it('invalid_grant (a genuinely dead/revoked grant) is classified reconnect_required AND marks credential_verifications invalid', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    let caught: unknown;
    try { await getValidAccessToken(USER_ID, PROVIDER); } catch (e) { caught = e; }

    expect((caught as ClassifiedOAuthError).errorClass).toBe('reconnect_required');
    expect(verificationCalls).toHaveLength(1);
    expect(verificationCalls[0].status).toBe('invalid');
    expect(verificationCalls[0].provider).toBe(PROVIDER);
  });

  it('a 429 rate-limit response is classified transient and never marks the credential invalid', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'temporarily_unavailable' }, 429));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toMatchObject({ errorClass: 'transient' });
    expect(verificationCalls).toHaveLength(0);
  });

  it('a 5xx response is classified transient and never marks the credential invalid', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'internal_error' }, 503));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toMatchObject({ errorClass: 'transient' });
    expect(verificationCalls).toHaveLength(0);
  });

  it('a network-level failure (fetch itself throws) is classified transient, not a credential problem', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: getaddrinfo ENOTFOUND oauth2.googleapis.com'));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toMatchObject({ errorClass: 'transient' });
    expect(verificationCalls).toHaveLength(0);
  });

  it('a non-JSON response body (e.g. an HTML outage page) is classified by HTTP status, never assumed to be a bad credential', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toMatchObject({ errorClass: 'transient' });
    expect(verificationCalls).toHaveLength(0);
  });

  it('preserves the existing refresh_token when Google\'s response omits one (the normal case for this Web-application OAuth client type)', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer' }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const persisted = JSON.parse(store[PROVIDER]);
    expect(persisted.refresh_token).toBe('stable-refresh-token-not-real');
  });

  it('persists a ROTATED refresh_token when Google\'s response includes a new one', async () => {
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600, token_type: 'Bearer' }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await getValidAccessToken(USER_ID, PROVIDER);

    const persisted = JSON.parse(store[PROVIDER]);
    expect(persisted.refresh_token).toBe('rotated-refresh-token');
  });

  it('a refresh that reaches Google after a concurrent refresh for the same (user, provider) has already completed defers to the newer stored state instead of overwriting it', async () => {
    // Deterministic, controlled interleaving (rather than relying on
    // natural microtask race ordering, which isn't a reliable way to force
    // a specific interleave): both calls start and read the SAME original
    // stored token before either has refreshed, exactly like two workflow
    // executions for the same account dispatched together. Call A's
    // provider round trip is let run to full completion (including its
    // write) BEFORE call B's provider round trip is allowed to resolve --
    // reproducing "B's refresh_token fallback is now stale relative to
    // storage" without depending on scheduler timing.
    let resolveFetchA: (v: unknown) => void = () => undefined;
    let resolveFetchB: (v: unknown) => void = () => undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFetchA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFetchB = resolve; }));

    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    const promiseA = getValidAccessToken(USER_ID, PROVIDER);
    const promiseB = getValidAccessToken(USER_ID, PROVIDER);

    // Flush microtasks so both calls have read the original stored token
    // and reached their fetch() call before either provider response lands.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    resolveFetchA(googleResponse(true, { access_token: 'access-token-A', expires_in: 3600, token_type: 'Bearer' }));
    const resultA = await promiseA;

    resolveFetchB(googleResponse(true, { access_token: 'access-token-B', expires_in: 3600, token_type: 'Bearer' }));
    const resultB = await promiseB;

    // B's own round trip succeeded (it is NOT an error, NOT a wasted
    // network call becoming a failure) -- it just correctly declines to
    // clobber A's already-fresher write with its own now-stale result.
    expect(saveCalls).toHaveLength(1);
    expect(resultA).toBe('access-token-A');
    expect(resultB).toBe('access-token-A');
  });

  it('never logs the access token, refresh token, or client secret on any failure path', async () => {
    fetchMock.mockResolvedValue(googleResponse(false, { error: 'unauthorized_client', error_description: 'Unauthorized' }, 401));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');

    await expect(getValidAccessToken(USER_ID, PROVIDER)).rejects.toThrow();

    const allLogged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0])).join('\n');
    expect(allLogged).not.toContain('stale-access-token-not-real');
    expect(allLogged).not.toContain('stable-refresh-token-not-real');
    expect(allLogged).not.toContain('real-client-secret-not-real');

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ── Whitespace normalization ────────────────────────────────────────────

describe('OAuth env value normalization', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('readOAuthClientCredentials trims surrounding whitespace/newlines from a dashboard copy-paste, never touching interior characters', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '  client-id-with-padding.apps.googleusercontent.com\n');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '\tsecret-with-tab-and-newline\n');
    const { getOAuthProviderConfig, readOAuthClientCredentials } = await import('../lib/credentials/oauth-providers');
    const config = getOAuthProviderConfig('gmail')!;
    const { clientId, clientSecret } = readOAuthClientCredentials(config);
    expect(clientId).toBe('client-id-with-padding.apps.googleusercontent.com');
    expect(clientSecret).toBe('secret-with-tab-and-newline');
  });

  it('a whitespace-only value normalizes to empty string -- must fail closed as "not configured", never as a corrupted-but-truthy value', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '   \n\t  ');
    const { getOAuthProviderConfig, readOAuthClientCredentials } = await import('../lib/credentials/oauth-providers');
    const config = getOAuthProviderConfig('gmail')!;
    expect(readOAuthClientCredentials(config).clientId).toBe('');
  });

  it('the actual HTTP request to Google carries the TRIMMED client_id, not the raw whitespace-padded env value', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '  padded-client-id  ');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
    fetchMock.mockResolvedValue(googleResponse(true, { access_token: 'a', expires_in: 3600 }));
    const { getOAuthProviderConfig, refreshOAuthToken } = await import('../lib/credentials/oauth-providers');
    await refreshOAuthToken(getOAuthProviderConfig('gmail')!, 'some-refresh-token');

    const [, init] = fetchMock.mock.calls[0];
    const body = String((init as { body: string }).body);
    expect(body).toContain('client_id=padded-client-id');
    expect(body).not.toContain('client_id=++padded');
  });
});

// ── OAuth client fingerprints ────────────────────────────────────────────

describe('OAuth client fingerprints -- Vercel/Railway consistency evidence', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('is deterministic: the same client id/secret always fingerprints identically', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'same-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'same-client-secret');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    const a = computeOAuthClientFingerprint('gmail');
    const b = computeOAuthClientFingerprint('gmail');
    expect(a?.clientIdFingerprint).toBe(b?.clientIdFingerprint);
    expect(a?.clientSecretFingerprint).toBe(b?.clientSecretFingerprint);
  });

  it('is whitespace-insensitive: a value differing only by padding fingerprints the SAME as its trimmed form -- this is what lets a real dashboard copy/paste artifact NOT look like a mismatch', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'exact-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'exact-client-secret');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    const clean = computeOAuthClientFingerprint('gmail');

    vi.resetModules();
    vi.stubEnv('GOOGLE_CLIENT_ID', '  exact-client-id\n');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'exact-client-secret\t');
    const { computeOAuthClientFingerprint: computeAgain } = await import('../lib/credentials/oauth-fingerprint');
    const padded = computeAgain('gmail');

    expect(padded?.clientIdFingerprint).toBe(clean?.clientIdFingerprint);
    expect(padded?.clientSecretFingerprint).toBe(clean?.clientSecretFingerprint);
  });

  it('DOES detect a genuine client identity mismatch -- a different client_id changes the fingerprint (the property this incident needed)', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'vercel-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'shared-secret');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    const vercelSide = computeOAuthClientFingerprint('gmail');

    vi.resetModules();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'railway-different-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'shared-secret');
    const { computeOAuthClientFingerprint: computeAgain } = await import('../lib/credentials/oauth-fingerprint');
    const railwaySide = computeAgain('gmail');

    expect(vercelSide?.clientIdFingerprint).not.toBe(railwaySide?.clientIdFingerprint);
    expect(vercelSide?.clientSecretFingerprint).toBe(railwaySide?.clientSecretFingerprint); // secret matched in this scenario
  });

  it('reports configured:false and null fingerprints when the client id/secret are entirely unset -- never a fingerprint of an empty string standing in for "configured"', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    const fp = computeOAuthClientFingerprint('gmail');
    expect(fp?.configured).toBe(false);
    expect(fp?.clientIdFingerprint).toBeNull();
    expect(fp?.clientSecretFingerprint).toBeNull();
  });

  it('never contains the raw client id or secret anywhere in its output', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'super-secret-client-id-value');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'super-secret-client-secret-value');
    const { computeOAuthClientFingerprint } = await import('../lib/credentials/oauth-fingerprint');
    const fp = computeOAuthClientFingerprint('gmail');
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain('super-secret-client-id-value');
    expect(serialized).not.toContain('super-secret-client-secret-value');
  });

  it('computeAllOAuthClientFingerprints covers every registered OAuth provider', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'x');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'y');
    const { computeAllOAuthClientFingerprints } = await import('../lib/credentials/oauth-fingerprint');
    const { listOAuthProviders } = await import('../lib/credentials/oauth-providers');
    const fps = computeAllOAuthClientFingerprints();
    expect(fps.map((f) => f.provider).sort()).toEqual(listOAuthProviders().sort());
  });
});
