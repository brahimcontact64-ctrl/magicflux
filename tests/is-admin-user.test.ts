/**
 * Phase 9.6 P0 regression test — isAdminUser() previously also trusted
 * user_metadata.role and a (schema-absent) user_profiles.role as admin
 * signals. Confirmed live against a disposable test account: any
 * authenticated user can set their own user_metadata.role to 'admin' via
 * the standard, unrestricted PUT /auth/v1/user endpoint (exactly what the
 * client-side supabase.auth.updateUser() call does) -- self-escalating
 * past every caller of isAdminUser() (including
 * /api/admin/dev/assign-pro, which grants a real persisted Pro
 * subscription). app_metadata is only ever writable via the
 * service-role/Admin API, never by the user's own session -- it's the
 * only source that was ever actually admin-only, and is now the only one
 * this function trusts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let getUserByIdResult: { data: { user: unknown }; error: unknown };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        getUserById: vi.fn(async () => getUserByIdResult),
      },
    },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAdminUser', () => {
  it('returns true for app_metadata.role === "admin" (the only legitimate, non-self-writable source)', async () => {
    getUserByIdResult = { data: { user: { app_metadata: { role: 'admin' }, user_metadata: {} } }, error: null };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('user-1')).toBe(true);
  });

  it('P0: returns false for a user_metadata.role === "admin" self-escalation attempt, even though app_metadata is empty', async () => {
    // This is exactly the confirmed-live exploit shape: a user who called
    // the standard, unrestricted PUT /auth/v1/user endpoint to set their
    // own user_metadata.role, with no privileged access at all.
    getUserByIdResult = { data: { user: { app_metadata: {}, user_metadata: { role: 'admin' } } }, error: null };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('self-escalated-user')).toBe(false);
  });

  it('returns false for a plain authenticated user with no role claims anywhere', async () => {
    getUserByIdResult = { data: { user: { app_metadata: {}, user_metadata: {} } }, error: null };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('ordinary-user')).toBe(false);
  });

  it('fails closed (false) when the user lookup errors or returns no user', async () => {
    getUserByIdResult = { data: { user: null }, error: { message: 'not found' } };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('missing-user')).toBe(false);
  });

  it('app_metadata.role of anything other than the literal "admin" string does not grant access', async () => {
    getUserByIdResult = { data: { user: { app_metadata: { role: 'Admin' }, user_metadata: {} } }, error: null };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('case-mismatch-user')).toBe(false);
  });
});
