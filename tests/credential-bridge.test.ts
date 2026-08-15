/**
 * Credential-system bridge tests.
 *
 * getUserIntegrations() is the single choke point every real node handler and
 * the workflow-runtime execution path read integration credentials through.
 * Before this fix it only ever read the legacy `user_integrations` table, so a
 * credential connected via the Credentials UI / OAuth flow (which write to the
 * newer `integration_credentials` table) would pass pre-flight validation and
 * then fail at every node with "integration not configured". These tests
 * verify the merge behaves correctly without hitting a live database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/credentials/storage', () => ({
  getAllConnectedProviders: vi.fn(),
  verifyProviderConnection: vi.fn(),
  getDecryptedProviderCredentials: vi.fn(),
}));

vi.mock('@/lib/credentials/oauth-providers', () => ({
  isOAuthProvider: vi.fn(),
}));

vi.mock('@/lib/credentials/oauth-refresh', () => ({
  getValidAccessToken: vi.fn(),
}));

function mockLegacyRows(rows: Array<Record<string, unknown>>) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  };
}

describe('getUserIntegrations — credential system bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns legacy rows unchanged when nothing is connected via the new system', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'slack', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('slack');
  });

  it('prefers a new-system (integration_credentials) row over a legacy row for the same provider', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders, verifyProviderConnection, getDecryptedProviderCredentials } =
      await import('@/lib/credentials/storage');
    const { isOAuthProvider } = await import('@/lib/credentials/oauth-providers');

    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'airtable', name: null, credentials: { airtable_token: 'legacy-stale' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['airtable']);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });
    vi.mocked(isOAuthProvider).mockReturnValue(false);
    vi.mocked(getDecryptedProviderCredentials).mockResolvedValue({ personal_access_token: 'pat-fresh', base_id: 'appXYZ' });

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('airtable');
    expect(result[0].credentials.personal_access_token).toBe('pat-fresh');
    expect(result[0].credentials.airtable_token).toBeUndefined();
  });

  it('resolves OAuth providers (gmail) to a ready-to-use access_token via getValidAccessToken', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders, verifyProviderConnection } = await import('@/lib/credentials/storage');
    const { isOAuthProvider } = await import('@/lib/credentials/oauth-providers');
    const { getValidAccessToken } = await import('@/lib/credentials/oauth-refresh');

    vi.mocked(createServiceClient).mockReturnValue(mockLegacyRows([]) as never);
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['gmail']);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });
    vi.mocked(isOAuthProvider).mockReturnValue(true);
    vi.mocked(getValidAccessToken).mockResolvedValue('ya29.fresh-token');

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('gmail');
    expect(result[0].credentials.access_token).toBe('ya29.fresh-token');
    // Refresh token / raw stored JSON must never reach the handler layer.
    expect(result[0].credentials.refresh_token).toBeUndefined();
  });

  it('falls back to the legacy row when the new-system provider fails to resolve', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders, verifyProviderConnection, getDecryptedProviderCredentials } =
      await import('@/lib/credentials/storage');
    const { isOAuthProvider } = await import('@/lib/credentials/oauth-providers');

    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'openai', name: null, credentials: { api_key: 'legacy-key' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['openai']);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });
    vi.mocked(isOAuthProvider).mockReturnValue(false);
    vi.mocked(getDecryptedProviderCredentials).mockRejectedValue(new Error('decrypt failed'));

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('openai');
    expect(result[0].credentials.api_key).toBe('legacy-key');
  });

  it('ignores new-system providers that have no corresponding runtime handler', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');

    vi.mocked(createServiceClient).mockReturnValue(mockLegacyRows([]) as never);
    // 'stripe' is a valid new-system provider but has no IntegrationProvider/handler counterpart.
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['stripe']);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(0);
  });
});
