/**
 * Phase 9.8.5 — email/gmail provider identity mismatch, part 2: runtime
 * integration resolution (getUserIntegrations / resolveWorkflowIntegrations).
 *
 * Before this fix, lib/user-integrations.ts's getUserIntegrations() returned
 * a legacy user_integrations row labeled exactly as stored ('email'), so
 * resolveWorkflowIntegrations() -- called for every LIVE execution -- built
 * its provider map keyed by 'email', never matched a workflow's required
 * 'gmail', and threw SETUP_REQUIRED:gmail before lib/workflow-runtime/
 * node-handlers/email.ts's own 'email' fallback ever got a chance to run.
 *
 * Fix: getUserIntegrations() now canonicalizes a stored 'email' row to
 * provider 'gmail' at load time via lib/integrations.ts's
 * canonicalizeProviderId() -- the same rule Builder readiness uses (see
 * provider-email-gmail-alias.test.ts). Kept in its own file because this
 * suite needs @/lib/credentials/storage fully mocked away, which would
 * otherwise clobber the real verifyProviderConnection() implementation the
 * companion file exercises.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(),
}));
vi.mock('@/lib/credentials/storage', () => ({
  getAllConnectedProviders: vi.fn(),
  verifyProviderConnection: vi.fn(),
  getDecryptedProviderCredentials: vi.fn(),
}));
vi.mock('@/lib/credentials/oauth-providers', () => ({ isOAuthProvider: vi.fn() }));
vi.mock('@/lib/credentials/oauth-refresh', () => ({ getValidAccessToken: vi.fn() }));

function mockLegacyRows(rows: Array<Record<string, unknown>>) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  };
}

describe('getUserIntegrations — canonicalizes legacy "email" rows to "gmail"', () => {
  beforeEach(() => vi.clearAllMocks());

  it('#3: a legacy "email" row is returned labeled "gmail", carrying its original SMTP credentials unchanged', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        {
          id: '1',
          provider: 'email',
          name: null,
          credentials: { smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_user: 'brahim@example.com', smtp_pass: 'x', from_email: 'brahim@example.com' },
          status: 'connected',
          last_verified_at: null,
          created_at: '2026-01-01',
        },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('gmail');
    expect(result[0].credentials.smtp_host).toBe('smtp.gmail.com');
  });

  it('#6: canonicalization creates no duplicate row -- exactly one integration returned, not two', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'email', name: null, credentials: { smtp_host: 'smtp.gmail.com' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
  });

  it('an exact-match "gmail" row (e.g. real OAuth) is unaffected -- still labeled "gmail"', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'gmail', name: null, credentials: { access_token: 'ya29.x' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('gmail');
    expect(result[0].credentials.access_token).toBe('ya29.x');
  });

  it('an unrelated provider (slack) is returned unchanged, never remapped', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(
      mockLegacyRows([
        { id: '1', provider: 'slack', name: null, credentials: { bot_token: 'xoxb-x' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' },
      ]) as never,
    );
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { getUserIntegrations } = await import('@/lib/user-integrations');
    const result = await getUserIntegrations(VALID_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('slack');
  });
});

describe('resolveWorkflowIntegrations — resolves a legacy "email" credential for a workflow requiring "gmail"', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDbWithWorkflowSelections() {
    return {
      from: vi.fn((table: string) => {
        if (table === 'user_integrations') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'row-1', provider: 'email', name: null, credentials: { smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_user: 'u', smtp_pass: 'p', from_email: 'u@x.com' }, status: 'connected', last_verified_at: null, created_at: '2026-01-01' }],
                error: null,
              }),
            }),
          };
        }
        if (table === 'workflow_integrations') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
    };
  }

  it('#3 & #4: resolves the stored "email" credential and does NOT throw SETUP_REQUIRED:gmail', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(mockDbWithWorkflowSelections() as never);
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { resolveWorkflowIntegrations } = await import('@/lib/user-integrations');
    const workflowJson = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.manualTrigger' },
        { id: '2', type: 'n8n-nodes-base.gmail' },
      ],
    };

    const { resolved, warnings } = await resolveWorkflowIntegrations(VALID_UUID, 'wf-1', workflowJson);

    expect(warnings).toEqual([]);
    expect(resolved.has('gmail')).toBe(true);
    expect(resolved.get('gmail')?.credentials.smtp_host).toBe('smtp.gmail.com');
  });

  it('#8: a workflow requiring an unrelated provider that is not connected still fails closed (SETUP_REQUIRED)', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    const { getAllConnectedProviders } = await import('@/lib/credentials/storage');
    vi.mocked(createServiceClient).mockReturnValue(mockDbWithWorkflowSelections() as never); // only 'email' connected
    vi.mocked(getAllConnectedProviders).mockResolvedValue([]);

    const { resolveWorkflowIntegrations } = await import('@/lib/user-integrations');
    const workflowJson = { nodes: [{ id: '1', type: 'n8n-nodes-base.slack' }] };

    await expect(resolveWorkflowIntegrations(VALID_UUID, 'wf-1', workflowJson)).rejects.toThrow('SETUP_REQUIRED:slack');
  });
});
