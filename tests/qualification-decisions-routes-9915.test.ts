/**
 * Phase 9.9.15 -- API route tests for the lead lifecycle/outcome endpoints:
 *   POST /api/qualification-decisions/[id]/outcome
 *   GET  /api/qualification-decisions/[id]
 *   GET  /api/qualification-decisions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = 'user-owner';
const ATTACKER_ID = 'user-attacker';
const DECISION_ID = 'decision-1';

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
  createServiceClient: vi.fn(),
}));

const recordLeadOutcomeMock = vi.fn();
const getLeadLifecycleHistoryMock = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/runtime/lead-lifecycle', () => ({
  recordLeadOutcome: (...args: unknown[]) => recordLeadOutcomeMock(...args),
  getLeadLifecycleHistory: (...args: unknown[]) => getLeadLifecycleHistoryMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getLeadLifecycleHistoryMock.mockResolvedValue([]);
});

describe('POST /api/qualification-decisions/[id]/outcome', () => {
  it('requires authentication', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'won' }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid action', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'nonsense' }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(400);
    expect(recordLeadOutcomeMock).not.toHaveBeenCalled();
  });

  it('passes the authenticated user as BOTH userId and actorId -- never a client-supplied id', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    recordLeadOutcomeMock.mockResolvedValue({ ok: true, alreadyInState: false, previousStatus: null, newStatus: 'contacted' });

    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), {
      method: 'POST',
      body: JSON.stringify({ action: 'contacted', userId: ATTACKER_ID, actorId: ATTACKER_ID }), // attempted spoof
    });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(200);
    expect(recordLeadOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER_ID, actorId: OWNER_ID }));
  });

  it('returns 404 for "not found"', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    recordLeadOutcomeMock.mockResolvedValue({ ok: false, reason: 'Qualification decision not found.' });

    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'won' }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(404);
  });

  it('returns 409 for a terminal-state conflict', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    recordLeadOutcomeMock.mockResolvedValue({ ok: false, reason: 'already won', currentStatus: 'won' });

    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'lost' }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(409);
  });

  it('returns 400 for a pure validation error (no currentStatus)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    recordLeadOutcomeMock.mockResolvedValue({ ok: false, reason: 'currency must be a 3-letter code' });

    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'won', revenue: 100 }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(400);
  });

  it('Phase 9.9.15A Part G: rejects a raw NUMBER for revenue at the route boundary -- must be the exact decimal string the user typed, never a pre-parsed float', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/qualification-decisions/[id]/outcome/route');
    const req = new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify({ action: 'won', revenue: 100 }) });
    const res = await POST(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(400);
    expect(recordLeadOutcomeMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/qualification-decisions/[id] and list route -- tenant isolation', () => {
  type Row = Record<string, unknown>;
  class FakeQuery {
    private filters: Array<[string, unknown]> = [];
    constructor(private rows: Row[]) {}
    eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
    select(): this { return this; }
    order(): this { return this; }
    limit(): this { return this; }
    or(): this { return this; }
    private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
    async maybeSingle(): Promise<{ data: Row | null; error: null }> { return { data: this.matched()[0] ?? null, error: null }; }
    then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> { return Promise.resolve(resolve({ data: this.matched(), error: null })); }
  }

  let tables: Record<string, Row[]>;

  beforeEach(async () => {
    tables = {
      workflow_qualification_decisions: [{ id: DECISION_ID, user_id: OWNER_ID, workflow_id: 'wf-1', execution_id: 'exec-1', ai_classification: 'Hot', ai_confidence: 0.9, human_review_occurred: false, human_classification: null, final_classification: 'Hot', overridden: false, outcome_status: null, outcome_revenue: null, outcome_currency: null, created_at: '2026-01-01T00:00:00.000Z' }],
      workflow_acknowledgments: [],
    };
    const { createServiceClient } = await import('@/lib/supabase-server');
    vi.mocked(createServiceClient).mockReturnValue({ from: (name: string) => new FakeQuery(tables[name] ?? []) } as never);
  });

  it('GET detail: owner can read their own decision', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/qualification-decisions/[id]/route');
    const req = new NextRequest(new URL(`http://localhost/api/qualification-decisions/${DECISION_ID}`));
    const res = await GET(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.id).toBe(DECISION_ID);
    expect(body.acknowledgment).toBeNull();
  });

  it('GET detail: a different tenant gets 404, never the decision', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { GET } = await import('../app/api/qualification-decisions/[id]/route');
    const req = new NextRequest(new URL(`http://localhost/api/qualification-decisions/${DECISION_ID}`));
    const res = await GET(req, { params: { id: DECISION_ID } });
    expect(res.status).toBe(404);
  });

  it('GET list: requires workflow_id', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/qualification-decisions/route');
    const req = new NextRequest(new URL('http://localhost/api/qualification-decisions'));
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('GET list: returns only the owner\'s own decisions for the given workflow', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/qualification-decisions/route');
    const req = new NextRequest(new URL('http://localhost/api/qualification-decisions?workflow_id=wf-1'));
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toHaveLength(1);
  });
});
