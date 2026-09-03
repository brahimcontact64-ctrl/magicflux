/**
 * Phase 9.5 Step F — found live against a real disposable-account pair:
 * DELETE /api/workflows/[id] correctly scoped its delete by
 * (id, user_id) so a cross-tenant delete attempt never actually removed
 * the other user's row (confirmed: the victim workflow was still present
 * and unmodified immediately after), but the route never checked how many
 * rows the delete actually affected, so it returned {success:true} / 200
 * regardless -- indistinguishable from a real deletion, and inconsistent
 * with every sibling route on this resource (GET/PATCH/integrations/test/
 * lifecycle/... all correctly 404 for someone else's or a nonexistent
 * workflow ID).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = { id: string; user_id: string };

let rows: Row[];

function makeFakeDb() {
  return {
    from(table: string) {
      if (table !== 'workflows') throw new Error(`unexpected table: ${table}`);
      return {
        delete() {
          const filters: Array<[string, unknown]> = [];
          const api = {
            eq(c: string, v: unknown) { filters.push([c, v]); return api; },
            select() {
              const matched = rows.filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
              const remaining = matched.map((r) => r.id);
              rows = rows.filter((r) => !remaining.includes(r.id));
              return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
            },
          };
          return api;
        },
      };
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  getUserFromRequest: vi.fn(),
}));

beforeEach(() => {
  rows = [{ id: 'wf-victim', user_id: 'victim-user' }];
  vi.clearAllMocks();
});

function makeReq(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/workflows/wf-victim'), { method: 'DELETE' });
}

describe('DELETE /api/workflows/[id] ownership', () => {
  it('a different user deleting someone else\'s workflow gets 404, and the row is untouched', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'attacker-user', email: 'a@test.local' } as never);

    const { DELETE } = await import('../app/api/workflows/[id]/route');
    const res = await DELETE(makeReq(), { params: { id: 'wf-victim' } });

    expect(res.status).toBe(404);
    expect(rows).toEqual([{ id: 'wf-victim', user_id: 'victim-user' }]); // untouched
  });

  it('a nonexistent workflow ID gets 404, not a false success', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'victim-user', email: 'v@test.local' } as never);

    const { DELETE } = await import('../app/api/workflows/[id]/route');
    const req = new NextRequest(new URL('http://localhost/api/workflows/does-not-exist'), { method: 'DELETE' });
    const res = await DELETE(req, { params: { id: 'does-not-exist' } });

    expect(res.status).toBe(404);
  });

  it('the real owner deleting their own workflow gets a genuine success and the row is actually removed', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'victim-user', email: 'v@test.local' } as never);

    const { DELETE } = await import('../app/api/workflows/[id]/route');
    const res = await DELETE(makeReq(), { params: { id: 'wf-victim' } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(rows).toEqual([]); // actually deleted
  });
});
