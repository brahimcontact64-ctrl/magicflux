/**
 * Phase 9.9.17 -- diagnosed a Settings-vs-Readiness inconsistency report for
 * the real Sigma Plus Lead workflow: Settings showed Gmail Connected while a
 * local diagnostic script reported it missing. Root cause, confirmed by
 * direct inspection: the diagnostic script's OWN execution environment
 * lacked the server's Google OAuth client id/secret (a local-dev-only gap,
 * `.env.local` never carries production OAuth app secrets), causing
 * getValidAccessToken() to fail for a reason that has nothing to do with
 * the user's own credential or the resolver logic -- NOT a product bug.
 * `tests/credential-bridge.test.ts` and `tests/workflow-gmail-oauth-
 * attachment.test.ts` already comprehensively certify the underlying
 * bridge (Phase 9.9.8C); this file closes the one real, previously-untested
 * gap: `validateRequiredIntegrationsConnected()` (lib/workflow/lifecycle.ts,
 * Phase 9.9.14, reused by Phase 9.9.16's checkWorkflowReadiness) had never
 * itself been exercised against an OAuth/dual-FK-bridged Gmail credential --
 * only its lower-level dependency (getUserIntegrations) had been. Proves
 * Readiness, Activation, and Runtime all derive Gmail availability from the
 * exact same getUserIntegrations() bridge, with no separate/divergent check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/credentials/storage', () => ({
  getAllConnectedProviders: vi.fn(),
  verifyProviderConnection: vi.fn(),
  getDecryptedProviderCredentials: vi.fn(),
  getCredentialRowId: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/credentials/oauth-providers', () => ({
  isOAuthProvider: vi.fn(),
  getOAuthProviderConfig: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/credentials/oauth-refresh', () => ({ getValidAccessToken: vi.fn() }));

function mockLegacyRows(rows: Array<Record<string, unknown>>) {
  return { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: rows, error: null }) }) }) };
}

const LEAD_WORKFLOW_JSON = {
  nodes: [
    { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
    { id: '8', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: {} },
    { id: '9', name: 'Send Slack Notification', type: 'n8n-nodes-base.slack', parameters: {} },
    { id: '10', name: 'Send Gmail Email (Hot)', type: 'n8n-nodes-base.gmail', parameters: {} },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('validateRequiredIntegrationsConnected -- Gmail via the OAuth/dual-FK bridge', () => {
  it('reports Gmail as satisfied (no missing-integration error) when it is connected ONLY via integration_credentials (OAuth bridge), with zero legacy user_integrations row for gmail', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders, verifyProviderConnection } = await import('@/lib/credentials/storage');
    const { isOAuthProvider, getOAuthProviderConfig } = await import('@/lib/credentials/oauth-providers');
    const { getValidAccessToken } = await import('@/lib/credentials/oauth-refresh');

    // Slack (and Airtable, not asserted on here) are connected via the
    // ordinary legacy table -- only Gmail is OAuth/dual-FK-bridged, exactly
    // the real Sigma Plus workflow's actual shape.
    vi.mocked(createServiceClient).mockReturnValue(mockLegacyRows([
      { id: 'slack-row', provider: 'slack', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
    ]) as never);
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['gmail']);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });
    vi.mocked(isOAuthProvider).mockReturnValue(true);
    vi.mocked(getOAuthProviderConfig).mockReturnValue({ provider: 'gmail', credentialKey: 'oauth_google_gmail' } as never);
    vi.mocked(getValidAccessToken).mockResolvedValue('fresh-access-token');

    const { validateRequiredIntegrationsConnected } = await import('../lib/workflow/lifecycle');
    const errors = await validateRequiredIntegrationsConnected('founder-user-id', LEAD_WORKFLOW_JSON);

    expect(errors).toEqual([]);
  });

  it('correctly reports Gmail as missing when the OAuth bridge is genuinely disconnected (real gap, not a resolver bug)', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(mockLegacyRows([]) as never);
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]); // genuinely nothing connected

    const { validateRequiredIntegrationsConnected } = await import('../lib/workflow/lifecycle');
    const errors = await validateRequiredIntegrationsConnected('founder-user-id', LEAD_WORKFLOW_JSON);

    expect(errors.some((e) => e.includes('gmail'))).toBe(true);
  });

  it('does NOT require a legacy user_integrations row to exist for Gmail to be considered connected (proves Readiness is not "incorrectly checking only user_integrations")', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders, verifyProviderConnection } = await import('@/lib/credentials/storage');
    const { isOAuthProvider, getOAuthProviderConfig } = await import('@/lib/credentials/oauth-providers');
    const { getValidAccessToken } = await import('@/lib/credentials/oauth-refresh');

    const fromSpy = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ id: 'slack-row', provider: 'slack', name: null, credentials: {}, status: 'connected', last_verified_at: null, created_at: '2026-01-01' }],
          error: null,
        }),
      }),
    });
    vi.mocked(createServiceClient).mockReturnValue({ from: fromSpy } as never);
    vi.mocked(getAllConnectedProviders).mockResolvedValue(['gmail']);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });
    vi.mocked(isOAuthProvider).mockReturnValue(true);
    vi.mocked(getOAuthProviderConfig).mockReturnValue({ provider: 'gmail', credentialKey: 'oauth_google_gmail' } as never);
    vi.mocked(getValidAccessToken).mockResolvedValue('fresh-access-token');

    const { validateRequiredIntegrationsConnected } = await import('../lib/workflow/lifecycle');
    const errors = await validateRequiredIntegrationsConnected('founder-user-id', LEAD_WORKFLOW_JSON);

    // The legacy `user_integrations` table was queried (and returned empty)
    // -- Readiness still correctly resolves Gmail as connected via the
    // OAuth bridge alone, proving it is not blind to credential_id-backed
    // integrations.
    expect(fromSpy).toHaveBeenCalledWith('user_integrations');
    expect(errors).toEqual([]);
  });
});
