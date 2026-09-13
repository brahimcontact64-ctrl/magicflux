/**
 * Phase 9.8.5 — email/gmail provider identity mismatch, part 1: the
 * canonical alias rule itself, and Builder readiness
 * (verifyProviderConnection with its REAL implementation).
 *
 * Root cause: 'gmail' is the one canonical provider id used everywhere a
 * workflow REQUESTS email-sending capability (generation, classification,
 * requiredProvidersFromWorkflow()). But the Settings UI's SMTP-only "Email"
 * card has always written user_integrations.provider = 'email' -- a real,
 * working, previously-connected credential under a DIFFERENT identifier.
 * verifyProviderConnection checked user_integrations for exactly 'gmail',
 * found nothing, and reported "Connect now" despite a real connected
 * 'email' row.
 *
 * Fix: one exported alias rule (lib/integrations.ts's getProviderStorageAliases
 * / canonicalizeProviderId), used here by verifyProviderConnection's legacy
 * fallback query. See provider-email-gmail-alias-runtime.test.ts for the
 * companion runtime-resolution coverage (getUserIntegrations /
 * resolveWorkflowIntegrations), kept in a separate file because that suite
 * needs @/lib/credentials/storage fully mocked, which would otherwise
 * clobber the real implementation this file exercises.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

describe('lib/integrations.ts — canonical alias rule', () => {
  it('getProviderStorageAliases: gmail and email both resolve to the same alias group', async () => {
    const { getProviderStorageAliases } = await import('../lib/integrations');
    expect(getProviderStorageAliases('gmail').sort()).toEqual(['email', 'gmail']);
    expect(getProviderStorageAliases('email').sort()).toEqual(['email', 'gmail']);
  });

  it('#5 & #8: unrelated/unknown providers map only to themselves -- no broad fuzzy aliasing', async () => {
    const { getProviderStorageAliases, canonicalizeProviderId } = await import('../lib/integrations');
    for (const provider of ['slack', 'airtable', 'shopify', 'openai', 'some_unknown_provider']) {
      expect(getProviderStorageAliases(provider)).toEqual([provider]);
      expect(canonicalizeProviderId(provider)).toBe(provider);
    }
  });

  it('#7: canonicalizeProviderId is idempotent on the canonical form', async () => {
    const { canonicalizeProviderId } = await import('../lib/integrations');
    expect(canonicalizeProviderId('gmail')).toBe('gmail');
    expect(canonicalizeProviderId('email')).toBe('gmail');
  });
});

// ─── Builder readiness: verifyProviderConnection (real implementation) ─────

function makeFakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  function builder(table: string) {
    const rows = tables[table] ?? [];
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      in(c: string, values: unknown[]) { inFilters.push([c, values]); return api; },
      limit: () => api,
      matched() {
        return rows.filter(
          (r) =>
            eqFilters.every(([c, v]) => r[c] === v) &&
            inFilters.every(([c, values]) => values.includes(r[c])),
        );
      },
      maybeSingle: async () => {
        const m = (api.matched as () => Array<Record<string, unknown>>)();
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then(resolve: (v: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
        const m = (api.matched as () => Array<Record<string, unknown>>)();
        return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), error: null }));
      },
    };
    return api;
  }
  return { from: (table: string) => builder(table) };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(),
}));

describe('verifyProviderConnection — Builder readiness recognizes the email/gmail alias', () => {
  beforeEach(() => vi.clearAllMocks());

  it('#1: a connected stored "email" row satisfies a request for "gmail"', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValue(
      makeFakeDb({
        integration_credentials: [], // nothing in the newer per-key OAuth table
        user_integrations: [{ user_id: VALID_UUID, provider: 'email', status: 'connected' }],
      }) as never,
    );

    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    const result = await verifyProviderConnection(VALID_UUID, 'gmail');

    expect(result.connected).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('#2: a stored "email" row that is NOT connected does not satisfy "gmail"', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValue(
      makeFakeDb({
        integration_credentials: [],
        user_integrations: [{ user_id: VALID_UUID, provider: 'email', status: 'invalid' }],
      }) as never,
    );

    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    const result = await verifyProviderConnection(VALID_UUID, 'gmail');

    expect(result.connected).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('#7: an exact-match connected "gmail" row still works unchanged', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValue(
      makeFakeDb({
        integration_credentials: [],
        user_integrations: [{ user_id: VALID_UUID, provider: 'gmail', status: 'connected' }],
      }) as never,
    );

    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    const result = await verifyProviderConnection(VALID_UUID, 'gmail');

    expect(result.connected).toBe(true);
  });

  it('#5: an unrelated provider (slack) is unaffected by the email/gmail alias', async () => {
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValue(
      makeFakeDb({
        integration_credentials: [],
        // A connected 'email' row must never satisfy a request for 'slack'.
        user_integrations: [{ user_id: VALID_UUID, provider: 'email', status: 'connected' }],
      }) as never,
    );

    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    const result = await verifyProviderConnection(VALID_UUID, 'slack');

    expect(result.connected).toBe(false);
  });
});
