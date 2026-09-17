/**
 * Phase 9.9.16 -- Part L: PATCH /api/workflows/[id]'s opt-in optimistic
 * concurrency retrofit. Proves both halves: a caller that sends
 * expectedUpdatedAt gets CAS protection (409 on a stale value, success on a
 * fresh one), and a caller that omits it keeps today's exact blind-update
 * behavior -- zero regression for every pre-existing call site that hasn't
 * been updated to send it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = { id: string; user_id: string; name: string; workflow_json: unknown; integrations: string[]; status: string; updated_at: string; [k: string]: unknown };

let table: Row[];

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private patch: Record<string, unknown> | null = null;
  private isUpdate = false;
  constructor(private getTable: () => Row[]) {}
  select(): this { return this; }
  update(patch: Record<string, unknown>): this { this.isUpdate = true; this.patch = patch; return this; }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  private matched(): Row[] { return this.getTable().filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.matched();
    if (!this.isUpdate) return { data: rows[0] ?? null, error: null };
    if (rows.length === 0) return { data: null, error: null };
    Object.assign(rows[0], this.patch);
    return { data: rows[0], error: null };
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (_n: string) => new FakeQuery(() => table) })),
  getUserFromRequest: vi.fn(),
}));

function req(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost/x'), { method: 'PATCH', body: JSON.stringify(body) });
}

beforeEach(async () => {
  table = [{ id: 'wf-1', user_id: 'owner', name: 'x', workflow_json: {}, integrations: [], status: 'draft', updated_at: 't1' }];
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'owner' } as never);
});

describe("PATCH /api/workflows/[id] -- Part L concurrency retrofit", () => {
  it('a stale expectedUpdatedAt is rejected with 409 and the current updated_at, and does not write', async () => {
    table[0].updated_at = 't2'; // someone else already saved
    const { PATCH } = await import('../app/api/workflows/[id]/route');
    const res = await PATCH(req({ name: 'clobber', expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.latestUpdatedAt).toBe('t2');
    expect(table[0].name).toBe('x'); // unchanged
  });

  it('a fresh expectedUpdatedAt succeeds', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/route');
    const res = await PATCH(req({ name: 'updated', expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(200);
    expect(table[0].name).toBe('updated');
  });

  it('omitting expectedUpdatedAt keeps the exact pre-existing blind-overwrite behavior (no regression)', async () => {
    table[0].updated_at = 't2'; // even though this "changed since" the caller's own last read
    const { PATCH } = await import('../app/api/workflows/[id]/route');
    const res = await PATCH(req({ name: 'still-writes' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(200);
    expect(table[0].name).toBe('still-writes');
  });
});
