/**
 * Phase 9.9.7A — Gmail OAuth One-Click Production Path.
 *
 * The full pipeline (Settings/Builder -> /api/oauth/start -> Google ->
 * /api/oauth/callback -> encrypted token persistence -> refresh -> runtime
 * resolution -> emailHandler -> Gmail API HTTPS) was already fully built
 * server-side, with zero test coverage. This phase wires the one missing
 * piece (a real "Continue with Google" button in the live Builder connect
 * modal, replacing a dead-end manual client_id/client_secret/refresh_token
 * form) and fixes one real correctness gap found during the audit: a
 * broken/expired OAuth credential could previously fall through to an old
 * legacy SMTP row silently instead of failing closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000d1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000d2';

beforeEach(() => {
  vi.resetModules();
  process.env.INTEGRATIONS_ENCRYPTION_KEY = 'c'.repeat(64);
});

// ─── Part 1: OAuth state / CSRF protection ─────────────────────────────────────

describe('OAuth state token -- CSRF + replay protection', () => {
  it('a freshly built state verifies successfully and carries the exact userId/provider', async () => {
    const { buildOAuthState, verifyOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');
    const result = verifyOAuthState(state);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe(OWNER_ID);
      expect(result.payload.provider).toBe('gmail');
    }
  });

  it('a tampered signature is rejected', async () => {
    const { buildOAuthState, verifyOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');
    const [b64] = state.split('.');
    const tampered = `${b64}.${'0'.repeat(64)}`;
    expect(verifyOAuthState(tampered).valid).toBe(false);
  });

  it('a tampered payload (different userId spliced in) invalidates the signature', async () => {
    const { buildOAuthState, verifyOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');
    const [, sig] = state.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: ATTACKER_ID, provider: 'gmail', nonce: 'x', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    expect(verifyOAuthState(`${forgedPayload}.${sig}`).valid).toBe(false);
  });

  it('an expired state (older than the replay window) is rejected', async () => {
    const { buildOAuthState, verifyOAuthState, STATE_MAX_AGE_SECONDS } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');
    const nowPastExpiry = Math.floor(Date.now() / 1000) + STATE_MAX_AGE_SECONDS + 1;
    const result = verifyOAuthState(state, nowPastExpiry);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('a state signed under a different key is rejected -- unforgeable without INTEGRATIONS_ENCRYPTION_KEY', async () => {
    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');

    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'f'.repeat(64);
    vi.resetModules();
    const { verifyOAuthState } = await import('../lib/credentials/oauth-state');
    expect(verifyOAuthState(state).valid).toBe(false);
  });

  it('malformed state strings are rejected without throwing', async () => {
    const { verifyOAuthState } = await import('../lib/credentials/oauth-state');
    expect(verifyOAuthState('').valid).toBe(false);
    expect(verifyOAuthState('not-a-real-state').valid).toBe(false);
    expect(verifyOAuthState('..').valid).toBe(false);
  });
});

// ─── Part 2: /api/oauth/start -- platform-level secrets, never user-supplied ──

function makeOAuthStartReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL('http://localhost/api/oauth/start'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/oauth/start -- unauthenticated', () => {
  it('requires authentication', async () => {
    vi.resetModules();
    vi.doMock('@/lib/supabase-server', () => ({ getUserFromRequest: vi.fn().mockResolvedValue(null) }));
    const { POST } = await import('../app/api/oauth/start/route');
    const res = await POST(makeOAuthStartReq({ provider: 'gmail' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/oauth/start -- authenticated', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/supabase-server', () => ({
      getUserFromRequest: vi.fn().mockResolvedValue({ id: OWNER_ID, email: 'owner@magicflux.local' }),
    }));
  });

  const makeReq = makeOAuthStartReq;

  it('returns 503 (never a client-facing prompt for client_id/secret) when GOOGLE_CLIENT_ID is not configured', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';
    const { POST } = await import('../app/api/oauth/start/route');
    const res = await POST(makeReq({ provider: 'gmail' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).not.toContain('GOOGLE_CLIENT_SECRET');
  });

  it('builds a redirect URL using ONLY the platform-level GOOGLE_CLIENT_ID -- never a client-supplied value, never the client secret', async () => {
    process.env.GOOGLE_CLIENT_ID = 'platform-google-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'platform-google-client-secret-should-never-appear-anywhere';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';

    const { POST } = await import('../app/api/oauth/start/route');
    // Attacker-supplied client_id in the body must be ignored entirely --
    // the route never even reads a client_id/client_secret field from the request body.
    const res = await POST(makeReq({ provider: 'gmail', client_id: 'attacker-supplied-id', client_secret: 'attacker-secret' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { redirectUrl: string };

    expect(body.redirectUrl).toContain('accounts.google.com');
    expect(body.redirectUrl).toContain(encodeURIComponent('platform-google-client-id.apps.googleusercontent.com'));
    expect(body.redirectUrl).not.toContain('attacker-supplied-id');
    expect(body.redirectUrl).not.toContain('platform-google-client-secret-should-never-appear-anywhere');
    expect(body.redirectUrl).toContain(encodeURIComponent('https://www.magicflux.ai/api/oauth/callback'));
  });

  it('embeds the authenticated userId in the signed state, never as a raw query parameter', async () => {
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';

    const { POST } = await import('../app/api/oauth/start/route');
    const res = await POST(makeReq({ provider: 'gmail' }));
    const body = await res.json() as { redirectUrl: string };
    // The raw UUID must never appear in plaintext in the redirect URL --
    // only inside the opaque, HMAC-signed state token.
    expect(body.redirectUrl).not.toContain(OWNER_ID);

    const url = new URL(body.redirectUrl);
    const state = url.searchParams.get('state')!;
    const { verifyOAuthState } = await import('../lib/credentials/oauth-state');
    const verified = verifyOAuthState(state);
    expect(verified.valid).toBe(true);
    if (verified.valid) expect(verified.payload.userId).toBe(OWNER_ID);
  });
});

// ─── Part 3: /api/oauth/callback -- ownership, no secret leakage on failure ───

describe('GET /api/oauth/callback', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'super-secret-value-must-never-leak';
  });

  function callbackUrl(params: Record<string, string>): NextRequest {
    const url = new URL('http://localhost/api/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new NextRequest(url);
  }

  it('provider-side denial redirects to a safe error page without ever calling the token endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await import('../app/api/oauth/callback/route');
    const res = await GET(callbackUrl({ error: 'access_denied' }));
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get('location')).toContain('oauth=error');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects a tampered/invalid state before ever exchanging the code (ownership cannot be forged)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await import('../app/api/oauth/callback/route');
    const res = await GET(callbackUrl({ code: 'real-auth-code', state: 'forged.deadbeef' }));
    expect(res.headers.get('location')).toContain('oauth=error');
    expect(res.headers.get('location')).toContain('invalid_state');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('the userId that receives the saved credential comes from the signed state, never from a spoofable query param', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: (id: string) => { if (id !== OWNER_ID) throw new Error('untrusted'); },
      saveCredentialsWithVerification: vi.fn().mockResolvedValue(undefined),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'real-access-token', refresh_token: 'real-refresh-token', expires_in: 3600 }),
    } as Response);

    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const { saveCredentialsWithVerification } = await import('@/lib/credentials/storage');
    const state = buildOAuthState(OWNER_ID, 'gmail');

    // Attacker tries to override userId via a query param -- must be ignored.
    const { GET } = await import('../app/api/oauth/callback/route');
    const res = await GET(callbackUrl({ code: 'real-auth-code', state, userId: ATTACKER_ID }));

    expect(res.headers.get('location')).toContain('oauth=success');
    expect(vi.mocked(saveCredentialsWithVerification)).toHaveBeenCalledWith(
      OWNER_ID, // from the signed state, not the ATTACKER_ID query param
      'gmail',
      expect.any(Object),
      'healthy'
    );
    fetchSpy.mockRestore();
  });

  it('a token-exchange failure redirects with a generic reason -- never the client secret or the real error body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'invalid_grant', error_description: `client_secret=${process.env.GOOGLE_CLIENT_SECRET} rejected` }),
    } as Response);

    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail');
    const { GET } = await import('../app/api/oauth/callback/route');
    const res = await GET(callbackUrl({ code: 'real-auth-code', state }));

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('oauth=error');
    expect(location).toContain('token_exchange_failed');
    expect(location).not.toContain('super-secret-value-must-never-leak');
    fetchSpy.mockRestore();
  });
});

// ─── Part 4: encrypted persistence, tenant isolation, refresh ─────────────────

describe('OAuth token storage -- encrypted, tenant-isolated', () => {
  it('serializeOAuthTokens never includes the client secret, only the token response fields', async () => {
    const { serializeOAuthTokens } = await import('../lib/credentials/oauth-providers');
    const serialized = serializeOAuthTokens({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' });
    expect(serialized).not.toContain('GOOGLE_CLIENT_SECRET');
    expect(JSON.parse(serialized)).toMatchObject({ access_token: 'a', refresh_token: 'r' });
  });

  it('buildCredentialRows encrypts the OAuth token blob (never stores it as plaintext)', async () => {
    // Earlier describe blocks in this file vi.doMock() '@/lib/credentials/storage'
    // with partial shapes for their own narrow purposes -- doMock persists across
    // tests in the same file regardless of vi.resetModules(), so restore the real
    // module explicitly here rather than depending on suite ordering.
    vi.doUnmock('@/lib/credentials/storage');
    vi.resetModules();
    const { buildCredentialRows } = await import('../lib/credentials/storage');
    const rows = buildCredentialRows(OWNER_ID, 'gmail', { oauth_google_gmail: JSON.stringify({ access_token: 'real-token-value' }) }, new Date().toISOString());
    expect(rows[0].is_secret).toBe(true);
    expect(rows[0].encrypted_value).not.toContain('real-token-value');
  });
});

describe('getValidAccessToken -- refresh semantics', () => {
  const baseCreds = (overrides: Partial<{ access_token: string; refresh_token: string | null; expires_at: number | null }> = {}) => ({
    oauth_google_gmail: JSON.stringify({
      access_token: 'current-access-token',
      refresh_token: 'current-refresh-token',
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    }),
  });

  it('returns the existing token unchanged when it is not near expiry', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: () => undefined,
      getDecryptedProviderCredentials: vi.fn().mockResolvedValue(baseCreds()),
      saveCredentialsWithVerification: vi.fn(),
    }));
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    const token = await getValidAccessToken(OWNER_ID, 'gmail');
    expect(token).toBe('current-access-token');
  });

  it('refreshes and persists a new token when within the refresh buffer, preserving the refresh_token if the provider omits one', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: () => undefined,
      getDecryptedProviderCredentials: vi.fn().mockResolvedValue(baseCreds({ expires_at: Math.floor(Date.now() / 1000) + 10 })),
      saveCredentialsWithVerification: saveMock,
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'refreshed-access-token', expires_in: 3600 }),
    } as Response);

    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    const token = await getValidAccessToken(OWNER_ID, 'gmail');

    expect(token).toBe('refreshed-access-token');
    expect(saveMock).toHaveBeenCalledOnce();
    const savedBlob = JSON.parse((saveMock.mock.calls[0][2] as Record<string, string>).oauth_google_gmail);
    expect(savedBlob.refresh_token).toBe('current-refresh-token'); // preserved, not dropped
    fetchSpy.mockRestore();
  });

  it('throws (fails closed) when the refresh request itself fails -- caller must treat this as reconnect-required', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: () => undefined,
      getDecryptedProviderCredentials: vi.fn().mockResolvedValue(baseCreds({ expires_at: Math.floor(Date.now() / 1000) - 10 })),
      saveCredentialsWithVerification: vi.fn(),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'invalid_grant' }),
    } as Response);

    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';
    const { getValidAccessToken } = await import('../lib/credentials/oauth-refresh');
    await expect(getValidAccessToken(OWNER_ID, 'gmail')).rejects.toThrow();
    fetchSpy.mockRestore();
  });
});

// ─── Part 5: bridgeNewCredentialSystem -- fail-closed, no silent identity switch ──

describe('Phase 9.9.7A fix -- a broken OAuth credential never silently falls back to legacy SMTP', () => {
  beforeEach(() => {
    vi.doMock('@/lib/supabase-server', () => ({
      createServiceClient: () => ({
        from: (table: string) => {
          if (table === 'user_integrations') {
            return {
              select: () => ({
                eq: () => Promise.resolve({
                  data: [{
                    id: 'legacy-email-1', user_id: OWNER_ID, provider: 'email', name: null,
                    credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01',
                  }],
                  error: null,
                }),
              }),
            };
          }
          throw new Error(`unexpected table: ${table}`);
        },
      }),
    }));
  });

  it('gmail OAuth resolves successfully: the OAuth credential is used, the legacy row is excluded', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: async () => ['gmail'],
      verifyProviderConnection: async () => ({ connected: true }),
      getDecryptedProviderCredentials: async () => ({}),
      getCredentialRowId: async () => 'cred-row-gmail-1',
    }));
    vi.doMock('@/lib/credentials/oauth-providers', () => ({
      isOAuthProvider: () => true,
      getOAuthProviderConfig: () => ({ credentialKey: 'oauth_google_gmail' }),
    }));
    vi.doMock('@/lib/credentials/oauth-refresh', () => ({ getValidAccessToken: async () => 'real-access-token' }));

    const { getUserIntegrations } = await import('../lib/user-integrations');
    const all = await getUserIntegrations(OWNER_ID, { connectedOnly: false });
    const gmailRows = all.filter((i) => i.provider === 'gmail');
    expect(gmailRows).toHaveLength(1);
    expect(gmailRows[0].credentials.access_token).toBe('real-access-token');
  });

  it('gmail OAuth token refresh fails: gmail is reported as UNAVAILABLE, never silently resolved via the coexisting legacy SMTP row', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: async () => ['gmail'],
      verifyProviderConnection: async () => ({ connected: true }),
      getDecryptedProviderCredentials: async () => ({}),
    }));
    vi.doMock('@/lib/credentials/oauth-providers', () => ({ isOAuthProvider: () => true }));
    vi.doMock('@/lib/credentials/oauth-refresh', () => ({
      getValidAccessToken: async () => { throw new Error('refresh_token revoked'); },
    }));

    const { getUserIntegrations } = await import('../lib/user-integrations');
    const all = await getUserIntegrations(OWNER_ID, { connectedOnly: false });
    // The old bug: this would have returned the legacy 'email' row here,
    // silently switching identity/transport. It must not appear at all.
    expect(all.find((i) => i.provider === 'gmail' || i.provider === 'email')).toBeUndefined();
  });

  it('no OAuth attempt exists at all: the legacy SMTP row is used normally (backward compatibility preserved)', async () => {
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: async () => [],
      verifyProviderConnection: async () => ({ connected: false }),
      getDecryptedProviderCredentials: async () => ({}),
    }));
    vi.doMock('@/lib/credentials/oauth-providers', () => ({ isOAuthProvider: () => true }));
    vi.doMock('@/lib/credentials/oauth-refresh', () => ({ getValidAccessToken: async () => { throw new Error('never called'); } }));

    const { getUserIntegrations } = await import('../lib/user-integrations');
    const all = await getUserIntegrations(OWNER_ID, { connectedOnly: false });
    expect(all.find((i) => i.provider === 'gmail')).toBeTruthy();
  });
});

// ─── Part 6: emailHandler -- Gmail API selection, no silent SMTP fallback ─────

describe('emailHandler -- OAuth selects the Gmail API HTTPS transport, never silently falls back to SMTP', () => {
  it('when a real OAuth access_token is present, the Gmail API is used (not SMTP), even for a straightforward success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'gmail-msg-1' }),
    } as Response);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node = { id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', text: 'Body' } };
    const context = {
      mode: 'live' as const,
      integrations: [{ provider: 'gmail' as const, credentials: { access_token: 'real-oauth-token' }, status: 'connected' as const }],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await emailHandler(node as never, {}, context as never);
    expect(result.status).toBe('success');
    expect(fetchSpy).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.any(Object));
    fetchSpy.mockRestore();
  });

  it('when the Gmail API call fails, the node fails -- it does NOT fall through to an SMTP credential that happens to also be present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    } as Response);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node = { id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', text: 'Body' } };
    // Both an OAuth credential AND a coexisting legacy SMTP-shaped credential
    // are present -- explicit OAuth selection must win, and its failure
    // must never trigger an SMTP attempt.
    const context = {
      mode: 'live' as const,
      integrations: [
        { provider: 'gmail' as const, credentials: { access_token: 'real-oauth-token' }, status: 'connected' as const },
        { provider: 'email' as const, credentials: { smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'u@gmail.com' }, status: 'connected' as const },
      ],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await emailHandler(node as never, {}, context as never);
    expect(result.status).toBe('failed');
    // Exactly one call -- the Gmail API attempt. No SMTP connection was ever opened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.any(Object));
    fetchSpy.mockRestore();
  });
});

// ─── Part 7: secret/token redaction ────────────────────────────────────────────

describe('Secret/token redaction across the OAuth pipeline', () => {
  it('the redact() utility scrubs an OAuth token blob before it could ever reach persisted logs', async () => {
    const { redact } = await import('../lib/security/redact');
    const scrubbed = redact({
      access_token: 'ya29.real-access-token-value',
      refresh_token: '1//real-refresh-token-value',
      client_secret: 'GOCSPX-real-client-secret',
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain('ya29.real-access-token-value');
    expect(serialized).not.toContain('1//real-refresh-token-value');
    expect(serialized).not.toContain('GOCSPX-real-client-secret');
  });

  it('a Gmail API failure surfaced by emailHandler never contains the access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'the request had an invalid authentication header',
    } as Response);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node = { id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', text: 'Body' } };
    const context = {
      mode: 'live' as const,
      integrations: [{ provider: 'gmail' as const, credentials: { access_token: 'ya29.super-secret-token-must-not-leak' }, status: 'connected' as const }],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await emailHandler(node as never, {}, context as never);
    expect(result.error).not.toContain('ya29.super-secret-token-must-not-leak');
    expect(JSON.stringify(result.logs)).not.toContain('ya29.super-secret-token-must-not-leak');
    fetchSpy.mockRestore();
  });
});
