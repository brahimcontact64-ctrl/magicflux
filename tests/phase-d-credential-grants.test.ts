import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertLocalSupabaseTarget } from '../scripts/phase-d/production-guard';

/**
 * Workflow #2 Phase D.2A -- regression test for the missing service_role
 * table-grant defect discovered during real Gmail OAuth certification
 * (20260926000001_backfill_credential_service_role_grants.sql).
 *
 * Unlike tests/phase-d-staging.test.ts (which exercises pure logic against
 * a hand-rolled fake DB), a missing GRANT can ONLY be caught by hitting a
 * real Postgres instance -- RLS/grant enforcement does not exist in a
 * mock. This suite therefore talks to the real local Supabase database and
 * self-skips (rather than failing) whenever that instance is not the
 * target -- e.g. a bare `npx vitest run` with no .env.staging.local
 * exported, or a clean checkout with no local Supabase running -- so the
 * full suite still passes in every other environment. Run it for real via:
 *
 *   set -a; source .env.staging.local; set +a; npx vitest run tests/phase-d-credential-grants.test.ts
 *
 * Uses only synthetic, clearly-marked data -- never a real Gmail token.
 */

const TEST_PROVIDER = 'phase-d-grant-smoke-test';
const STAGING_EMAIL = 'magicflux_phase_d_staging@magicflux.local';

let db: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>;
let storage: typeof import('@/lib/credentials/storage');
let userId: string;
let targetIsLocal = false;

beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return;
  try {
    assertLocalSupabaseTarget(url);
  } catch {
    return; // not local -- leave targetIsLocal false, all tests skip
  }

  const { createServiceClient } = await import('@/lib/supabase-server');
  db = createServiceClient();

  // Reachability check -- a fresh checkout with no `supabase start` yet
  // would otherwise hang/throw deep inside the test body.
  const { data: users, error } = await db.auth.admin.listUsers().catch((e) => ({ data: null, error: e }));
  if (error || !users) return;

  const existing = users.users.find((u) => u.email === STAGING_EMAIL);
  if (!existing) return; // Phase D.1 seed not present -- skip rather than create a parallel fixture here

  userId = existing.id;
  storage = await import('@/lib/credentials/storage');
  targetIsLocal = true;
});

afterAll(async () => {
  if (!targetIsLocal) return;
  // integration_credentials: deleted via the exact code path under test
  // (deleteProviderCredentials), proving service_role's new DELETE grant.
  await storage.deleteProviderCredentials(userId, TEST_PROVIDER).catch(() => {});
  // credential_verifications: service_role deliberately has NO delete grant
  // (least privilege -- no production code path ever deletes this table,
  // see the migration's own comment), so the fixture is left in place as a
  // single, stably-keyed (user_id, provider) row that every re-run
  // upserts in place rather than accumulating.
});

describe('Phase D.2A -- integration_credentials / credential_verifications service_role grants', () => {
  it('service_role can INSERT a credential row', async () => {
    if (!targetIsLocal) return;
    await expect(
      storage.saveProviderCredentials(userId, TEST_PROVIDER, { test_field: 'synthetic-insert' })
    ).resolves.not.toThrow();
  });

  it('service_role can SELECT the credential row back', async () => {
    if (!targetIsLocal) return;
    const rows = await storage.getProviderCredentialsForUser(userId, TEST_PROVIDER);
    const row = rows.find((r) => r.credential_key === 'test_field');
    expect(row?.value).toBe('synthetic-insert');
  });

  it('service_role can UPDATE the credential row (upsert on conflict)', async () => {
    if (!targetIsLocal) return;
    await storage.saveProviderCredentials(userId, TEST_PROVIDER, { test_field: 'synthetic-updated' });
    const rows = await storage.getProviderCredentialsForUser(userId, TEST_PROVIDER);
    const row = rows.find((r) => r.credential_key === 'test_field');
    expect(row?.value).toBe('synthetic-updated');
  });

  it('saveCredentialsWithVerification() succeeds end-to-end (the exact failing call from the OAuth callback)', async () => {
    if (!targetIsLocal) return;
    await expect(
      storage.saveCredentialsWithVerification(
        userId,
        TEST_PROVIDER,
        { test_field: 'synthetic-rpc-value' },
        'healthy',
        { source: 'phase_d_grant_regression_test' }
      )
    ).resolves.not.toThrow();
  });

  it('credential_verifications reflects the status written by saveCredentialsWithVerification()', async () => {
    if (!targetIsLocal) return;
    const verification = await storage.getVerificationStatus(userId, TEST_PROVIDER);
    expect(verification.status).toBe('healthy');
    expect(verification.verifiedAt).not.toBeNull();
  });

  it('service_role can DELETE the credential row', async () => {
    if (!targetIsLocal) return;
    await storage.deleteProviderCredentials(userId, TEST_PROVIDER);
    const rows = await storage.getProviderCredentialsForUser(userId, TEST_PROVIDER);
    expect(rows).toHaveLength(0);
  });
});
