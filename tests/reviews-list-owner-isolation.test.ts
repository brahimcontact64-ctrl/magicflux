/**
 * Phase 9.9.5 — GET /api/reviews owner isolation.
 *
 * The Dashboard's new Pending Reviews indicator (app/dashboard/page.tsx)
 * consumes this exact endpoint client-side. Before relying on it to decide
 * what a signed-in owner sees, pin down what the route's comment already
 * claims: every query is filtered by the authenticated caller's own
 * user_id, with no cross-tenant or Founder/admin-wide view -- a second
 * user (including one who happens to be an admin) never sees another
 * tenant's pending review count or items through this route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000f2';

type Row = Record<string, unknown>;

class FakeQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  select(): this { return this; }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const result = { data: this.matched().map((r) => ({ ...r })), error: null as null };
    return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
  }
}

function freshTables(): Record<string, Row[]> {
  return {
    workflow_review_items: [
      { id: 'review-owner-1', user_id: OWNER_ID, workflow_id: 'wf-owner', execution_id: 'exec-owner', node_id: 'n1', node_name: 'Human Review', status: 'pending', allowed_outcomes: ['approve', 'reject'], decision_outcome: null, instruction: null, review_context: {}, reviewed_at: null, created_at: '2026-09-14T00:00:00Z' },
      { id: 'review-other-1', user_id: OTHER_USER_ID, workflow_id: 'wf-other', execution_id: 'exec-other', node_id: 'n1', node_name: 'Human Review', status: 'pending', allowed_outcomes: ['approve', 'reject'], decision_outcome: null, instruction: null, review_context: {}, reviewed_at: null, created_at: '2026-09-14T00:00:00Z' },
    ],
  };
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
  getUserFromRequest: vi.fn(),
}));

function makeReq(status = 'pending'): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/reviews?status=${status}`));
}

beforeEach(async () => {
  tables = freshTables();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
});

describe('GET /api/reviews -- owner isolation', () => {
  it('unauthorized: no session -> 401, no items returned', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const { GET } = await import('../app/api/reviews/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('the owner sees only their own pending review, never another tenant\'s', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID, email: 'owner@magicflux.local' });

    const { GET } = await import('../app/api/reviews/route');
    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('review-owner-1');
    expect(body.items.some((item: { id: string }) => item.id === 'review-other-1')).toBe(false);
  });

  it('a different (even non-owner) authenticated user sees only their own tenant\'s reviews, not the owner\'s', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OTHER_USER_ID, email: 'other@magicflux.local' });

    const { GET } = await import('../app/api/reviews/route');
    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('review-other-1');
    expect(body.items.some((item: { id: string }) => item.id === 'review-owner-1')).toBe(false);
  });

  it('a user with zero pending reviews gets an empty array, not another tenant\'s data or an error', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: '00000000-0000-4000-8000-0000000000f3', email: 'nobody@magicflux.local' });

    const { GET } = await import('../app/api/reviews/route');
    const res = await GET(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });
});
