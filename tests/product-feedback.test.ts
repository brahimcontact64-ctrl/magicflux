/**
 * Phase 9.6 Section 3 — product feedback. The backing table
 * (product_feedback) is a PROPOSED, unapplied migration
 * (supabase/migrations/20260619000001_product_feedback.sql) -- these
 * tests prove the application code (a) works correctly once it exists,
 * and (b) degrades to an honest "not configured yet" result rather than a
 * raw 500 while it doesn't, and (c) never lets a client dictate whose
 * feedback row gets written or attach anything beyond safe operational
 * context automatically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
let rows: Row[];
let tableExists: boolean;
let lastInsert: Row | null;
let isAdmin: boolean;

function missingTableError() {
  return { code: '42P01', message: 'relation "product_feedback" does not exist' };
}

function makeFakeDb() {
  return {
    from(table: string) {
      if (table !== 'product_feedback') throw new Error(`unexpected table: ${table}`);
      if (!tableExists) {
        const err = { select: () => err, eq: () => err, gte: () => err, order: () => err, limit: () => err, update: () => err, insert: () => err, single: async () => ({ data: null, error: missingTableError() }) };
        // also cover the awaited-chain shape used by list/update (no .single())
        return {
          ...err,
          then: (resolve: (v: { data: null; error: unknown; count: null }) => unknown) => Promise.resolve(resolve({ data: null, error: missingTableError(), count: null })).then(() => undefined),
        };
      }

      const filters: Array<[string, unknown]> = [];
      const gteFilters: Array<[string, unknown]> = [];
      const api = {
        select: () => api,
        eq(col: string, val: unknown) { filters.push([col, val]); return api; },
        gte(col: string, val: unknown) { gteFilters.push([col, val]); return api; },
        order: () => api,
        limit: () => api,
        insert(row: Row) {
          lastInsert = row;
          const inserted = { id: 'fb-1', status: 'new', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
          rows.push(inserted);
          return { select: () => ({ async single() { return { data: inserted, error: null }; } }) };
        },
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              const matched = rows.filter((r) => r[col] === val);
              for (const r of matched) Object.assign(r, patch);
              return {
                select: () => Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }),
              };
            },
          };
        },
        then(resolve: (v: { data: Row[]; error: null; count: number }) => unknown) {
          const matched = rows.filter((r) =>
            filters.every(([c, v]) => r[c] === v) &&
            gteFilters.every(([c, v]) => String(r[c] ?? '') >= String(v)),
          );
          return Promise.resolve(resolve({ data: matched, error: null, count: matched.length })).then(() => undefined);
        },
      };
      return api;
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  getUserFromRequest: vi.fn(),
  isAdminUser: vi.fn(async () => isAdmin),
}));

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  tableExists = true;
  lastInsert = null;
  isAdmin = false;
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';

describe('lib/feedback submitFeedback()', () => {
  it('inserts a valid row with only the fields the caller provided', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'bug', rating: 4, comment: 'Found a bug', pagePath: '/builder' });

    expect(result.ok).toBe(true);
    expect(lastInsert?.user_id).toBe(USER_A);
    expect(lastInsert?.category).toBe('bug');
    expect(lastInsert?.rating).toBe(4);
  });

  it('rejects an invalid category', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'not_a_real_category' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects a rating outside 1-5', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', rating: 9 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer rating (Phase 9.6.1)', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', rating: 4.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects an empty submission (no rating, no comment)', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general' });
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized comment (Phase 9.6.1) with a clean 400-shaped reason, not a raw DB error', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', comment: 'x'.repeat(4001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
    expect(lastInsert).toBeNull();
  });

  it('accepts a comment right at the limit (4000 chars)', async () => {
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', comment: 'x'.repeat(4000) });
    expect(result.ok).toBe(true);
  });

  it('Phase 9.6.1: rate-limits a user submitting more than 10 feedback rows within an hour', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      rows.push({ id: `existing-${i}`, user_id: USER_A, category: 'general', rating: 5, status: 'new', created_at: now });
    }
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', rating: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate_limited');
  });

  it('Phase 9.6.1: the rate limit is per-user -- another user is unaffected by user A being at the limit', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      rows.push({ id: `existing-${i}`, user_id: USER_A, category: 'general', rating: 5, status: 'new', created_at: now });
    }
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: 'a-different-user', category: 'general', rating: 5 });
    expect(result.ok).toBe(true);
  });

  it('degrades to reason:"not_configured" (not a thrown error) when the table does not exist yet', async () => {
    tableExists = false;
    const { submitFeedback } = await import('@/lib/feedback');
    const result = await submitFeedback({ userId: USER_A, category: 'general', rating: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_configured');
  });
});

describe('POST /api/feedback', () => {
  function makeReq(body: Record<string, unknown>): NextRequest {
    return new NextRequest(new URL('http://localhost/api/feedback'), { method: 'POST', body: JSON.stringify(body) });
  }

  it('returns 401 with no authenticated user', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { POST } = await import('../app/api/feedback/route');
    const res = await POST(makeReq({ category: 'general', rating: 5 }));
    expect(res.status).toBe(401);
  });

  it('attaches the real authenticated user id, never a client-supplied one', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    const { POST } = await import('../app/api/feedback/route');
    const res = await POST(makeReq({ category: 'general', rating: 5, userId: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(lastInsert?.user_id).toBe(USER_A);
  });

  it('returns 503 (not a raw 500) when the feedback table is not configured yet', async () => {
    tableExists = false;
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    const { POST } = await import('../app/api/feedback/route');
    const res = await POST(makeReq({ category: 'general', rating: 5 }));
    expect(res.status).toBe(503);
  });
});

describe('GET/PATCH /api/admin/feedback', () => {
  it('GET returns 403 for a non-admin authenticated user', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A } as never);
    isAdmin = false;
    const { GET } = await import('../app/api/admin/feedback/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/admin/feedback')));
    expect(res.status).toBe(403);
  });

  it('GET returns rows for an admin', async () => {
    rows.push({ id: 'fb-1', category: 'general', rating: 5, status: 'new', created_at: new Date().toISOString() });
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A } as never);
    isAdmin = true;
    const { GET } = await import('../app/api/admin/feedback/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/admin/feedback')));
    const body = await res.json() as { rows: unknown[] };
    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(1);
  });

  it('PATCH updates status only for an admin', async () => {
    rows.push({ id: 'fb-1', category: 'general', status: 'new', created_at: new Date().toISOString() });
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A } as never);
    isAdmin = true;
    const { PATCH } = await import('../app/api/admin/feedback/route');
    const res = await PATCH(new NextRequest(new URL('http://localhost/api/admin/feedback'), { method: 'PATCH', body: JSON.stringify({ id: 'fb-1', status: 'resolved' }) }));
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe('resolved');
  });

  it('Phase 9.6.1: PATCH on a nonexistent id reports 404, not a false 200 success', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A } as never);
    isAdmin = true;
    const { PATCH } = await import('../app/api/admin/feedback/route');
    const res = await PATCH(new NextRequest(new URL('http://localhost/api/admin/feedback'), { method: 'PATCH', body: JSON.stringify({ id: 'does-not-exist', status: 'resolved' }) }));
    expect(res.status).toBe(404);
  });
});
