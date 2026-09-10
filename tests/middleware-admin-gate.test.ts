/**
 * Phase 9.6 P0 regression test — middleware.ts's /admin page gate
 * previously also trusted user_metadata.role and a (schema-absent)
 * user_profiles.role as admin signals, identically to isAdminUser() and
 * /api/admin/dev/assign-pro's own now-fixed duplicate checks. Confirmed
 * live: user_metadata is self-writable by any authenticated user via the
 * standard, unrestricted PUT /auth/v1/user endpoint, so this page gate
 * (and the API routes it fronts) was self-escalatable. Only
 * app_metadata.role is trusted now.
 *
 * Phase 9.6.1 fix — these mocks previously modeled the admin-lookup
 * response as { user: { app_metadata } }, the supabase-js SDK's wrapped
 * return shape. middleware.ts calls the raw GET
 * /auth/v1/admin/users/<id> REST endpoint directly via fetch(), which
 * returns the user object FLAT (app_metadata is a top-level field, no
 * `.user` wrapper) -- confirmed live via a disposable admin test account
 * and a raw dump of this exact endpoint. Because these mocks matched
 * middleware.ts's (wrong) expectation instead of the real endpoint, this
 * suite passed while the gate silently redirected every real admin to
 * /login in production. Mocks now match the real flat shape, and an
 * explicit case pins the previously-undetected regression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function makeReq(): NextRequest {
  const req = new NextRequest(new URL('http://localhost/admin/dashboard'));
  req.cookies.set('mf_access_token', 'a-real-looking-token');
  return req;
}

describe('middleware admin gate', () => {
  it('redirects to /login when app_metadata has no admin role, even if user_metadata claims admin (P0 self-escalation shape)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' })) // /auth/v1/user
      .mockResolvedValueOnce(jsonResponse({ app_metadata: {}, user_metadata: { role: 'admin' } })); // admin lookup (real, flat shape)

    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq());

    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get('location')).toContain('/login');
  });

  it('allows through when app_metadata.role === "admin"', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ app_metadata: { role: 'admin' } }));

    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq());

    // NextResponse.next() carries no redirect location and a 200-shaped response.
    expect(res.headers.get('location')).toBeNull();
  });

  it('Phase 9.6.1 regression: does NOT require a `user` wrapper around app_metadata (the real REST endpoint is flat, unlike the supabase-js SDK shape this code previously assumed)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ user: { app_metadata: { role: 'admin' } }, app_metadata: {} })); // if a `.user` key is ever present again, it must NOT be read

    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq());

    // Correct behavior reads the flat app_metadata ({}), not the nested
    // one -- so this must redirect. A regression back to `.user.app_metadata`
    // would let this through, which is exactly the shape confusion that
    // shipped.
    expect(res.headers.get('location')).toContain('/login');
  });

  it('redirects to /login with no cookie at all', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest(new URL('http://localhost/admin/dashboard'));
    const res = await middleware(req);
    expect(res.headers.get('location')).toContain('/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
