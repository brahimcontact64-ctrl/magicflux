/**
 * Phase 9.3.1 P0 regression test, updated for the Phase 9.6 P0 fix.
 *
 * POST /api/admin/dev/assign-pro was found, during Phase 9.3.1's audit, to
 * be reachable and fully functional for ANY authenticated user -- not just
 * admins -- because it had no server-side authorization check of its own
 * (only page-level gating via middleware.ts, which is not a substitute).
 * A check was added, but it duplicated a THIRD inline copy of an admin
 * determination that (like isAdminUser() and middleware.ts's own copy)
 * trusted user_metadata.role and a non-existent user_profiles.role column
 * as admin signals. Confirmed live, Phase 9.6: user_metadata is writable
 * by any authenticated user on their own account via the standard,
 * unrestricted PUT /auth/v1/user endpoint (exactly what the client-side
 * supabase.auth.updateUser() call does) -- so any signed-up user could
 * self-escalate to "admin" and then self-grant a real, persisted
 * `subscriptions` row with status:'active', plan:'pro', completely
 * bypassing Stripe. Fixed by routing through the single, now-corrected
 * isAdminUser() (app_metadata.role only -- the one source that was ever
 * actually non-self-writable) instead of a third copy of the broken logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let upsertCalls: Array<{ row: Record<string, unknown>; options: Record<string, unknown> }>;

function resetFakeDb() {
  upsertCalls = [];
}

function makeFakeDb() {
  return {
    from(table: string) {
      if (table === 'plans') {
        return { select: () => ({ eq: () => ({ async maybeSingle() { return { data: { id: 'plan-pro' }, error: null }; } }) }) };
      }
      if (table === 'subscriptions') {
        return {
          upsert(row: Record<string, unknown>, options: Record<string, unknown>) {
            upsertCalls.push({ row, options });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  getUserFromRequest: vi.fn(),
  isAdminUser: vi.fn(),
}));

beforeEach(() => {
  resetFakeDb();
  vi.clearAllMocks();
});

function makeReq(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/dev/assign-pro'), { method: 'POST' });
}

const CALLER_ID = '00000000-0000-4000-8000-0000000000c1';

describe('POST /api/admin/dev/assign-pro', () => {
  it('returns 401 with no authenticated user', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  it('P0 regression: an authenticated but non-admin user cannot self-grant Pro', async () => {
    const { getUserFromRequest, isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'ordinary-user@test.local' } as never);
    vi.mocked(isAdminUser).mockResolvedValue(false);

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0); // the critical assertion: no entitlement row was ever written
  });

  it('Phase 9.6 P0 regression: a user cannot self-escalate via user_metadata.role and then self-grant Pro', async () => {
    // This is exactly the confirmed-live exploit: the route now delegates
    // entirely to isAdminUser(), which (post-fix) never returns true for a
    // user_metadata-only role claim -- so this must still be 403 even
    // though it once wasn't.
    const { getUserFromRequest, isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'self-escalated@test.local' } as never);
    vi.mocked(isAdminUser).mockResolvedValue(false); // isAdminUser's own tests prove user_metadata never yields true

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  it('allows a genuine admin (isAdminUser() true) to assign Pro', async () => {
    const { getUserFromRequest, isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'admin@test.local' } as never);
    vi.mocked(isAdminUser).mockResolvedValue(true);

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.user_id).toBe(CALLER_ID);
  });
});
