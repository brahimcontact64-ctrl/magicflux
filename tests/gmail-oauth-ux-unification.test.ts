/**
 * Phase 9.9.7B — Unify Gmail OAuth Connection UX Across Settings and Builder.
 *
 * Root cause found in this phase's audit: /settings/integrations derives its
 * provider cards from /api/integrations/catalog, which merges the fixed
 * legacy providers (shopify/slack/airtable/email) with per-user
 * "provider_intelligence" memory rows created by the generic AI provider-
 * reasoning engine (lib/dynamic-providers/*) the first time an unrecognized
 * provider name is encountered. Gmail is not one of the fixed legacy
 * providers, so it fell into that generic path and got memoized with an
 * AI-inferred credential shape (a bare API_KEY field) -- completely
 * disconnected from Gmail's real credential, a Google OAuth grant stored in
 * integration_credentials. Settings' status for gmail was also read only
 * from the legacy user_integrations table, which never reflects a real OAuth
 * connection either. The Builder's connect modal (fixed in Phase 9.9.7A)
 * already had the correct "Continue with Google" UX, but read its own
 * separate provider config -- the two surfaces could disagree.
 *
 * Fix: /api/integrations/catalog now forces a fixed, field-free
 * authStrategy.type:'oauth2' card for 'gmail' after every merge step, so no
 * stale memory entry can ever reintroduce manual fields. /api/integrations
 * (GET) now derives gmail's status ONLY from a real integration_credentials
 * row (getAllConnectedProviders), never from user_integrations under either
 * 'gmail' or its legacy alias 'email' -- keeping the two cards visibly
 * independent per this phase's explicit requirement. The generic manual-
 * credential save/verify/test-action endpoints now reject 'gmail' outright
 * (defense in depth behind the UI change), and disconnecting 'gmail' now
 * revokes the real OAuth credential instead of no-op'ing against a table
 * gmail was never actually stored in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000e1';

beforeEach(() => {
  vi.resetModules();
  process.env.INTEGRATIONS_ENCRYPTION_KEY = 'd'.repeat(64);
});

function mockAuthenticated() {
  vi.doMock('@/lib/supabase-server', () => ({
    getBearerToken: () => 'valid-token',
    getUserFromAccessToken: vi.fn().mockResolvedValue({ id: OWNER_ID }),
    createServiceClient: vi.fn(),
  }));
}

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

// ─── Part 1: canonical OAuth catalog card ──────────────────────────────────────

describe('GET /api/integrations/catalog -- Gmail is a canonical, field-free OAuth card', () => {
  it('returns gmail with no credential fields and authStrategy.type "oauth2", even with no memory at all', async () => {
    mockAuthenticated();
    vi.doMock('@/lib/dynamic-providers/provider-memory-store', () => ({
      listProviderMemory: vi.fn().mockResolvedValue([]),
    }));

    const { getIntegrationCatalog } = await import('../app/api/integrations/shared');
    const res = await getIntegrationCatalog(makeReq('http://localhost/api/integrations/catalog'));
    const body = await res.json() as { providers: Array<{ provider: string; requiredCredentials: unknown[]; authStrategy: { type: string } }> };

    const gmail = body.providers.find((p) => p.provider === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.requiredCredentials).toEqual([]);
    expect(gmail!.authStrategy.type).toBe('oauth2');
  });

  it('a stale provider_intelligence memory row for gmail (the pre-fix AI-inferred API_KEY shape) can never override the canonical card', async () => {
    mockAuthenticated();
    vi.doMock('@/lib/dynamic-providers/provider-memory-store', () => ({
      listProviderMemory: vi.fn().mockResolvedValue([
        {
          provider: 'gmail',
          displayName: 'Gmail',
          providerType: 'other',
          capabilities: [],
          requiredCredentials: ['api_key'],
          docsUrl: null,
          logo: null,
          authStrategy: { type: 'bearer_token' },
          validationStrategy: 'ping_endpoint',
          endpointHints: [],
          confidence: 40,
          source: 'reasoning',
        },
      ]),
    }));

    const { getIntegrationCatalog } = await import('../app/api/integrations/shared');
    const res = await getIntegrationCatalog(makeReq('http://localhost/api/integrations/catalog'));
    const body = await res.json() as { providers: Array<{ provider: string; requiredCredentials: unknown[]; authStrategy: { type: string } }> };

    const gmail = body.providers.find((p) => p.provider === 'gmail');
    // The memory row's own shape (bearer_token / api_key) must be completely
    // discarded for this provider key -- this is the exact production bug
    // ("Connect on the Gmail card opens a modal asking for a generic API KEY").
    expect(gmail!.requiredCredentials).toEqual([]);
    expect(gmail!.authStrategy.type).toBe('oauth2');
  });

  it('legacy Email (SMTP) is untouched and keeps its own manual credential fields', async () => {
    mockAuthenticated();
    vi.doMock('@/lib/dynamic-providers/provider-memory-store', () => ({
      listProviderMemory: vi.fn().mockResolvedValue([]),
    }));

    const { getIntegrationCatalog } = await import('../app/api/integrations/shared');
    const res = await getIntegrationCatalog(makeReq('http://localhost/api/integrations/catalog'));
    const body = await res.json() as { providers: Array<{ provider: string; requiredCredentials: Array<{ key: string }> }> };

    const email = body.providers.find((p) => p.provider === 'email');
    expect(email).toBeDefined();
    expect(email!.requiredCredentials.map((f) => f.key)).toEqual(
      expect.arrayContaining(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'])
    );
  });
});

// ─── Part 2: authoritative, independent status ────────────────────────────────

describe('GET /api/integrations -- Gmail status is authoritative and independent from legacy Email/SMTP', () => {
  function mockLegacyRows(rows: Array<Record<string, unknown>>) {
    vi.doMock('@/lib/supabase-server', () => ({
      getBearerToken: () => 'valid-token',
      getUserFromAccessToken: vi.fn().mockResolvedValue({ id: OWNER_ID }),
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }));
  }

  it('gmail reports connected only when a real integration_credentials row exists (OAuth), not from a legacy user_integrations row', async () => {
    mockLegacyRows([
      { provider: 'gmail', credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]);
    vi.doMock('@/lib/security/encryption', () => ({
      decryptJson: vi.fn().mockReturnValue({}),
      encryptJson: vi.fn(),
      CredentialDecryptionError: class extends Error {},
    }));
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: vi.fn().mockResolvedValue([]), // no real OAuth grant
      getVerificationStatus: vi.fn().mockResolvedValue(null),
      deleteProviderCredentials: vi.fn(),
    }));

    const { listIntegrations } = await import('../app/api/integrations/shared');
    const res = await listIntegrations(makeReq('http://localhost/api/integrations'));
    const body = await res.json() as { integrations: Array<{ provider: string; status: string }> };

    const gmail = body.integrations.find((i) => i.provider === 'gmail');
    // A stale legacy row must not masquerade as a real OAuth connection.
    expect(gmail!.status).toBe('not_connected');
  });

  it('connecting legacy Email/SMTP alone does not mark the Gmail card connected (the two stay visibly independent)', async () => {
    mockLegacyRows([
      { provider: 'email', credentials: {}, status: 'connected', last_verified_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01' },
    ]);
    vi.doMock('@/lib/security/encryption', () => ({
      decryptJson: vi.fn().mockReturnValue({ smtp_host: 'smtp.gmail.com' }),
      encryptJson: vi.fn(),
      CredentialDecryptionError: class extends Error {},
    }));
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: vi.fn().mockResolvedValue([]), // no gmail OAuth row
      getVerificationStatus: vi.fn().mockResolvedValue(null),
      deleteProviderCredentials: vi.fn(),
    }));

    const { listIntegrations } = await import('../app/api/integrations/shared');
    const res = await listIntegrations(makeReq('http://localhost/api/integrations'));
    const body = await res.json() as { integrations: Array<{ provider: string; status: string }> };

    expect(body.integrations.find((i) => i.provider === 'email')!.status).toBe('connected');
    expect(body.integrations.find((i) => i.provider === 'gmail')!.status).toBe('not_connected');
  });

  it('a genuine Gmail OAuth connection reports connected:true, independent of Email/SMTP state', async () => {
    mockLegacyRows([]);
    vi.doMock('@/lib/security/encryption', () => ({
      decryptJson: vi.fn().mockReturnValue({}),
      encryptJson: vi.fn(),
      CredentialDecryptionError: class extends Error {},
    }));
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: vi.fn().mockResolvedValue(['gmail']),
      getVerificationStatus: vi.fn().mockResolvedValue({ provider: 'gmail', verifiedAt: '2026-02-01T00:00:00Z', status: 'healthy' }),
      deleteProviderCredentials: vi.fn(),
    }));

    const { listIntegrations } = await import('../app/api/integrations/shared');
    const res = await listIntegrations(makeReq('http://localhost/api/integrations'));
    const body = await res.json() as { integrations: Array<{ provider: string; status: string; last_verified_at: string | null }> };

    const gmail = body.integrations.find((i) => i.provider === 'gmail');
    expect(gmail!.status).toBe('connected');
    expect(gmail!.last_verified_at).toBe('2026-02-01T00:00:00Z');
    expect(body.integrations.find((i) => i.provider === 'email')!.status).toBe('not_connected');
  });
});

// ─── Part 3: the manual-credential path fails closed for gmail ────────────────

describe('The generic manual-credential endpoints reject gmail outright (defense in depth)', () => {
  it('POST /api/integrations/save rejects provider "gmail" with a clear error, never creating a row', async () => {
    mockAuthenticated();
    const { saveIntegration } = await import('../app/api/integrations/shared');
    const res = await saveIntegration(makeReq('http://localhost/api/integrations/save', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gmail', credentials: { API_KEY: 'attacker-or-confused-user-supplied-value' } }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('GMAIL_REQUIRES_OAUTH');
  });

  it('POST /api/integrations/verify rejects provider "gmail"', async () => {
    mockAuthenticated();
    const { verifyIntegration } = await import('../app/api/integrations/shared');
    const res = await verifyIntegration(makeReq('http://localhost/api/integrations/verify', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gmail', credentials: { API_KEY: 'x' } }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('GMAIL_REQUIRES_OAUTH');
  });

  it('POST /api/integrations/test-action rejects provider "gmail"', async () => {
    mockAuthenticated();
    const { runIntegrationAction } = await import('../app/api/integrations/shared');
    const res = await runIntegrationAction(makeReq('http://localhost/api/integrations/test-action', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gmail', action: 'send_test_email', destinationEmail: 'test@example.com' }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('GMAIL_REQUIRES_OAUTH');
  });

  it('legacy "email" provider is unaffected by the gmail rejection -- save still reaches the real code path', async () => {
    mockAuthenticated();
    vi.doMock('@/lib/integration-credentials', () => ({
      normalizeCredentials: vi.fn().mockReturnValue({ smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_user: 'u@example.com', smtp_pass: 'p', from_email: 'u@example.com' }),
      validateRequiredCredentials: vi.fn().mockReturnValue(null),
      maskIntegrationInfo: vi.fn().mockReturnValue('smtp_user: u@e***com'),
    }));
    vi.doMock('@/lib/integration-verifier', () => ({
      verifyIntegrationCredentials: vi.fn().mockResolvedValue({ ok: true }),
      runIntegrationTestAction: vi.fn(),
    }));
    vi.doMock('@/lib/billing/plan-limits', () => ({
      getIntegrationUsage: vi.fn().mockResolvedValue(0),
      getPlanLimits: vi.fn().mockResolvedValue({ integrations_limit: -1, name: 'Pro' }),
    }));
    vi.doMock('@/lib/security/encryption', () => ({
      decryptJson: vi.fn(),
      encryptJson: vi.fn().mockReturnValue({}),
      CredentialDecryptionError: class extends Error {},
    }));
    vi.doMock('@/lib/supabase-server', () => ({
      getBearerToken: () => 'valid-token',
      getUserFromAccessToken: vi.fn().mockResolvedValue({ id: OWNER_ID }),
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
            }),
          }),
          upsert: () => Promise.resolve({ error: null }),
        }),
      }),
    }));

    const { saveIntegration } = await import('../app/api/integrations/shared');
    const res = await saveIntegration(makeReq('http://localhost/api/integrations/save', {
      method: 'POST',
      body: JSON.stringify({ provider: 'email', credentials: { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_USER: 'u@example.com', SMTP_PASS: 'p', FROM_EMAIL: 'u@example.com' } }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; provider: string };
    expect(body.success).toBe(true);
    expect(body.provider).toBe('email');
  });
});

// ─── Part 4: disconnect actually revokes the real OAuth credential ────────────

describe('DELETE /api/integrations?provider=gmail -- disconnect revokes the real OAuth credential', () => {
  it('calls deleteProviderCredentials against integration_credentials, not a legacy user_integrations upsert', async () => {
    mockAuthenticated();
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: vi.fn(),
      getVerificationStatus: vi.fn(),
      deleteProviderCredentials: deleteMock,
    }));

    const { disconnectIntegration } = await import('../app/api/integrations/shared');
    const res = await disconnectIntegration(makeReq('http://localhost/api/integrations?provider=gmail', { method: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith(OWNER_ID, 'gmail');
  });
});

// ─── Part 5: OAuth returnTo -- Settings vs Builder round trip ─────────────────

describe('OAuth returnTo -- Settings-initiated connections return to Settings, not Builder', () => {
  it('isAllowedOAuthReturnTo only accepts the two known internal pages', async () => {
    const { isAllowedOAuthReturnTo } = await import('../lib/credentials/oauth-state');
    expect(isAllowedOAuthReturnTo('/settings/integrations')).toBe(true);
    expect(isAllowedOAuthReturnTo('/builder')).toBe(true);
    expect(isAllowedOAuthReturnTo('https://evil.example.com')).toBe(false);
    expect(isAllowedOAuthReturnTo('//evil.example.com')).toBe(false);
    expect(isAllowedOAuthReturnTo(undefined)).toBe(false);
    expect(isAllowedOAuthReturnTo(123)).toBe(false);
  });

  it('buildOAuthState embeds an allow-listed returnTo; an invalid one is silently dropped, never embedded', async () => {
    const { buildOAuthState, verifyOAuthState } = await import('../lib/credentials/oauth-state');

    const goodState = buildOAuthState(OWNER_ID, 'gmail', '/settings/integrations');
    const goodResult = verifyOAuthState(goodState);
    expect(goodResult.valid).toBe(true);
    if (goodResult.valid) expect(goodResult.payload.returnTo).toBe('/settings/integrations');

    const badState = buildOAuthState(OWNER_ID, 'gmail', 'https://evil.example.com');
    const badResult = verifyOAuthState(badState);
    expect(badResult.valid).toBe(true);
    if (badResult.valid) expect(badResult.payload.returnTo).toBeUndefined();
  });

  it('POST /api/oauth/start only accepts an allow-listed returnTo from the request body', async () => {
    vi.doMock('@/lib/supabase-server', () => ({
      getUserFromRequest: vi.fn().mockResolvedValue({ id: OWNER_ID, email: 'owner@magicflux.local' }),
    }));
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';

    const { POST } = await import('../app/api/oauth/start/route');
    const res = await POST(new NextRequest(new URL('http://localhost/api/oauth/start'), {
      method: 'POST',
      body: JSON.stringify({ provider: 'gmail', returnTo: '/settings/integrations' }),
    }));
    const { redirectUrl } = await res.json() as { redirectUrl: string };
    const state = new URL(redirectUrl).searchParams.get('state')!;

    const { verifyOAuthState } = await import('../lib/credentials/oauth-state');
    const result = verifyOAuthState(state);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.returnTo).toBe('/settings/integrations');
  });

  it('GET /api/oauth/callback success redirects to the returnTo embedded in the signed state', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';

    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: () => undefined,
      saveCredentialsWithVerification: vi.fn().mockResolvedValue(undefined),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    } as Response);

    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail', '/settings/integrations');

    const { GET } = await import('../app/api/oauth/callback/route');
    const url = new URL('http://localhost/api/oauth/callback');
    url.searchParams.set('code', 'real-code');
    url.searchParams.set('state', state);
    const res = await GET(new NextRequest(url));

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/integrations?oauth=success');
    fetchSpy.mockRestore();
  });

  it('GET /api/oauth/callback defaults to /builder when no returnTo was embedded (backward compatible)', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';

    vi.doMock('@/lib/credentials/storage', () => ({
      assertTrustedUserId: () => undefined,
      saveCredentialsWithVerification: vi.fn().mockResolvedValue(undefined),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    } as Response);

    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail'); // no returnTo

    const { GET } = await import('../app/api/oauth/callback/route');
    const url = new URL('http://localhost/api/oauth/callback');
    url.searchParams.set('code', 'real-code');
    url.searchParams.set('state', state);
    const res = await GET(new NextRequest(url));

    expect(res.headers.get('location') ?? '').toContain('/builder?oauth=success');
    fetchSpy.mockRestore();
  });

  it('GET /api/oauth/callback error path (Google consent denied) still honors returnTo, keeping the user on Settings', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.magicflux.ai';

    const { buildOAuthState } = await import('../lib/credentials/oauth-state');
    const state = buildOAuthState(OWNER_ID, 'gmail', '/settings/integrations');

    const { GET } = await import('../app/api/oauth/callback/route');
    const url = new URL('http://localhost/api/oauth/callback');
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('state', state);
    const res = await GET(new NextRequest(url));

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/integrations?oauth=error');
    expect(location).toContain('access_denied');
  });
});

// ─── Part 6: same canonical registry drives both surfaces ─────────────────────

describe('Settings and Builder key off the same canonical OAuth registry', () => {
  it('isOAuthProvider("gmail") is true -- the single signal both Settings (via the catalog authStrategy) and the Builder modal consult', async () => {
    const { isOAuthProvider } = await import('../lib/credentials/oauth-providers');
    expect(isOAuthProvider('gmail')).toBe(true);
    expect(isOAuthProvider('slack')).toBe(false);
  });
});

// ─── Part 7: no Google secrets ever reach a client-facing response ────────────

describe('No Google OAuth secret ever appears in a client-facing response', () => {
  it('the catalog response for gmail never contains a client_id/client_secret-shaped field', async () => {
    mockAuthenticated();
    vi.doMock('@/lib/dynamic-providers/provider-memory-store', () => ({
      listProviderMemory: vi.fn().mockResolvedValue([]),
    }));
    process.env.GOOGLE_CLIENT_SECRET = 'must-never-appear-in-any-response-body';

    const { getIntegrationCatalog } = await import('../app/api/integrations/shared');
    const res = await getIntegrationCatalog(makeReq('http://localhost/api/integrations/catalog'));
    const text = await res.text();
    expect(text).not.toContain('must-never-appear-in-any-response-body');
    expect(text).not.toContain('client_secret');
  });

  it('the integrations list response for a connected gmail row never contains the access/refresh token', async () => {
    vi.doMock('@/lib/supabase-server', () => ({
      getBearerToken: () => 'valid-token',
      getUserFromAccessToken: vi.fn().mockResolvedValue({ id: OWNER_ID }),
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/security/encryption', () => ({
      decryptJson: vi.fn(),
      encryptJson: vi.fn(),
      CredentialDecryptionError: class extends Error {},
    }));
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: vi.fn().mockResolvedValue(['gmail']),
      getVerificationStatus: vi.fn().mockResolvedValue({ provider: 'gmail', verifiedAt: '2026-02-01T00:00:00Z', status: 'healthy' }),
      deleteProviderCredentials: vi.fn(),
    }));

    const { listIntegrations } = await import('../app/api/integrations/shared');
    const res = await listIntegrations(makeReq('http://localhost/api/integrations'));
    const text = await res.text();
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('refresh_token');
    expect(text).not.toContain('oauth_google_gmail');
  });
});
