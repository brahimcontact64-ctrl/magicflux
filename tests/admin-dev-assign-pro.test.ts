/**
 * Phase 9.3.1 P0 regression test.
 *
 * POST /api/admin/dev/assign-pro was found, during this phase's audit, to
 * be reachable and fully functional for ANY authenticated user -- not just
 * admins. It is only ever surfaced through the /admin page, which
 * middleware.ts gates on app_metadata/user_metadata role or
 * user_profiles.role === 'admin' -- but the API route itself had no
 * server-side authorization check of its own, so any signed-up user could
 * call it directly and self-grant a real, persisted `subscriptions` row
 * with status:'active', plan:'pro'. Confirmed live-exploitable in
 * production against a disposable test account before the fix. These
 * tests lock in the fix: the route must now perform the same admin
 * determination middleware.ts does, server-side, before mutating anything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type AdminUser = { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null;

let adminLookupUser: AdminUser;
let profileRole: string | null;
let upsertCalls: Array<{ row: Record<string, unknown>; options: Record<string, unknown> }>;

function resetFakeDb() {
  adminLookupUser = null;
  profileRole = null;
  upsertCalls = [];
}

function makeFakeDb() {
  return {
    auth: {
      admin: {
        async getUserById(_id: string) {
          return { data: { user: adminLookupUser }, error: null };
        },
      },
    },
    from(table: string) {
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ async maybeSingle() { return { data: profileRole != null ? { role: profileRole } : null, error: null }; } }) }) };
      }
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

  it('P0 regression: an authenticated but non-admin user cannot self-grant Pro (previously succeeded with 200)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'ordinary-user@test.local' } as never);
    adminLookupUser = { app_metadata: {}, user_metadata: {} }; // no admin role anywhere
    profileRole = null;

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0); // the critical assertion: no entitlement row was ever written
  });

  it('allows a user with app_metadata.role === "admin" to assign Pro', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'admin@test.local' } as never);
    adminLookupUser = { app_metadata: { role: 'admin' } };
    profileRole = null;

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.user_id).toBe(CALLER_ID);
  });

  it('allows a user recognized as admin only via user_profiles.role (middleware.ts fallback path) to assign Pro', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: CALLER_ID, email: 'admin2@test.local' } as never);
    adminLookupUser = { app_metadata: {}, user_metadata: {} };
    profileRole = 'admin';

    const { POST } = await import('../app/api/admin/dev/assign-pro/route');
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
  });
});
