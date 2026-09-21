/**
 * Incident 9.9.17M -- a controlled, admin-only diagnostic endpoint that
 * triggers exactly one real getValidAccessToken()/refreshOAuthToken() call
 * for the CALLER's own Gmail credential from Vercel, so a Vercel-side
 * refresh attempt can be observed directly. Certifies: auth required,
 * admin_runtime required, provider hard-coded to 'gmail' only, correct
 * outcome classification for each case, and zero secret/token leakage in
 * the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000fb';

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/runtime/rbac', () => ({
  getUserPermissions: vi.fn(),
}));

vi.mock('@/lib/credentials/storage', () => ({
  getDecryptedProviderCredentials: vi.fn(),
}));

vi.mock('@/lib/credentials/oauth-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials/oauth-refresh')>();
  return { ...actual, getValidAccessToken: vi.fn() };
});

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';
import { ClassifiedOAuthError } from '../lib/credentials/oauth-errors';

function req(body: unknown) {
  return new Request('http://localhost/api/runtime/control/oauth-refresh-test', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof import('../app/api/runtime/control/oauth-refresh-test/route').POST>[0];
}

function freshToken() {
  return JSON.stringify({
    access_token: 'a', refresh_token: 'stable-refresh-token-not-real', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}
function expiredToken() {
  return JSON.stringify({
    access_token: 'a', refresh_token: 'stable-refresh-token-not-real', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  });
}

describe('POST /api/runtime/control/oauth-refresh-test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'real-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'real-client-secret-not-real');
  });

  it('rejects unauthenticated callers', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(null);
    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    expect(res.status).toBe(401);
  });

  it('rejects a caller without admin_runtime', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime'] as never);
    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    expect(res.status).toBe(403);
  });

  it('rejects any provider other than gmail -- hard-coded, no arbitrary value accepted', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'slack' }));
    expect(res.status).toBe(400);
  });

  it('reports no_refresh_needed and never calls refreshOAuthToken-level logic when the stored token is still fresh', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    vi.mocked(getDecryptedProviderCredentials).mockResolvedValue({ oauth_google_gmail: freshToken() });
    vi.mocked(getValidAccessToken).mockResolvedValue('a');

    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    const json = await res.json();
    expect(json.outcome).toBe('no_refresh_needed');
    expect(json.preCheck.attemptedNetworkCall).toBe(false);
  });

  it('reports refresh_succeeded with fingerprints (never raw tokens) when the token was due and the call succeeds', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    vi.mocked(getDecryptedProviderCredentials)
      .mockResolvedValueOnce({ oauth_google_gmail: expiredToken() })
      .mockResolvedValueOnce({ oauth_google_gmail: freshToken() });
    vi.mocked(getValidAccessToken).mockResolvedValue('new-access-token');

    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    const json = await res.json();
    expect(json.outcome).toBe('refresh_succeeded');
    expect(json.preCheck.attemptedNetworkCall).toBe(true);
    expect(json.refreshTokenRotated).toBe(false); // same refresh token in both fixtures
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('new-access-token');
    expect(serialized).not.toContain('stable-refresh-token-not-real');
    expect(serialized).not.toContain('real-client-secret-not-real');
  });

  it('reports config_fault classification (this incident\'s exact case) with safe HTTP status/error code, never a secret', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    vi.mocked(getDecryptedProviderCredentials).mockResolvedValue({ oauth_google_gmail: expiredToken() });
    vi.mocked(getValidAccessToken).mockRejectedValue(
      new ClassifiedOAuthError('OAuth token refresh rejected for gmail (HTTP 401): unauthorized_client: Unauthorized', {
        provider: 'gmail', errorClass: 'config_fault', httpStatus: 401, oauthErrorCode: 'unauthorized_client', oauthErrorDescription: 'Unauthorized',
      })
    );

    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    const json = await res.json();
    expect(json.outcome).toBe('config_fault');
    expect(json.httpStatus).toBe(401);
    expect(json.oauthErrorCode).toBe('unauthorized_client');
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('real-client-secret-not-real');
    expect(serialized).not.toContain('stable-refresh-token-not-real');
  });

  it('reports reconnect_required classification distinctly from config_fault', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    vi.mocked(getDecryptedProviderCredentials).mockResolvedValue({ oauth_google_gmail: expiredToken() });
    vi.mocked(getValidAccessToken).mockRejectedValue(
      new ClassifiedOAuthError('OAuth token refresh rejected for gmail (HTTP 400): invalid_grant: Token has been expired or revoked.', {
        provider: 'gmail', errorClass: 'reconnect_required', httpStatus: 400, oauthErrorCode: 'invalid_grant', oauthErrorDescription: 'Token has been expired or revoked.',
      })
    );

    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    const json = await res.json();
    expect(json.outcome).toBe('reconnect_required');
  });

  it('reports a generic error outcome (never crashing) for a non-classified failure, e.g. no stored credential', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime'] as never);
    vi.mocked(getDecryptedProviderCredentials).mockResolvedValue({});
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error('No valid OAuth credentials stored for provider: gmail'));

    const { POST } = await import('../app/api/runtime/control/oauth-refresh-test/route');
    const res = await POST(req({ provider: 'gmail' }));
    const json = await res.json();
    expect(json.outcome).toBe('error');
    expect(res.status).toBe(200);
  });
});
