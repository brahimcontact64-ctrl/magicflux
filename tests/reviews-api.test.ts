/**
 * Phase 9.9.2A — /api/reviews/[id]/decide authorization & idempotency.
 *
 * Covers the security requirements explicit in this phase: no public
 * unauthenticated approval (401 without a session), cross-tenant access
 * blocked (a review item scoped to a different user comes back 404, never
 * leaking existence), and idempotent decisions (a compare-and-swap update
 * into 'resume_pending' means a second decide request for an
 * already-decided item never re-accepts a new decision value -- it only
 * drives the SAME recovery path forward via attemptReviewResume(), which
 * is mocked here so this file tests the ROUTE's own auth/ownership/CAS
 * logic in isolation from resume/engine internals (see
 * tests/review-resume-crash-safety.test.ts for those).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000e1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000e2';
const REVIEW_ID = 'review-1';
const WORKFLOW_ID = 'wf-1';
const EXECUTION_ID = 'exec-1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  update(patch: Row): this {
    this.pendingPatch = patch;
    return this;
  }
}

function freshTables(): Record<string, Row[]> {
  return {
    workflow_review_items: [
      {
        id: REVIEW_ID,
        user_id: OWNER_ID,
        workflow_id: WORKFLOW_ID,
        execution_id: EXECUTION_ID,
        node_id: 'node-1',
        deployment_version_id: null,
        status: 'pending',
        allowed_outcomes: ['approve', 'reject'],
        mode: 'live',
        resume_attempts: 0,
      },
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

const attemptReviewResumeMock = vi.fn().mockResolvedValue({ resumed: true });
vi.mock('@/lib/runtime/review-resume', () => ({
  attemptReviewResume: (...args: unknown[]) => attemptReviewResumeMock(...args),
}));

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/reviews/${REVIEW_ID}/decide`), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tables = freshTables();
  attemptReviewResumeMock.mockClear();
  attemptReviewResumeMock.mockResolvedValue({ resumed: true });
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
});

describe('POST /api/reviews/[id]/decide', () => {
  it('unauthorized: no session -> 401, never touches the review item or attempts resume', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(401);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(attemptReviewResumeMock).not.toHaveBeenCalled();
  });

  it('cross-tenant: a different user cannot see or decide someone else\'s review item -> 404, unchanged, no resume attempt', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(404);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(tables.workflow_review_items[0].user_id).toBe(OWNER_ID); // never reassigned/leaked
    expect(attemptReviewResumeMock).not.toHaveBeenCalled();
  });

  it('the real owner can approve: CAS transitions pending -> resume_pending with decision metadata, then resume is attempted', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.resumed).toBe(true);
    expect(tables.workflow_review_items[0].status).toBe('resume_pending');
    expect(tables.workflow_review_items[0].decision_outcome).toBe('approve');
    expect(tables.workflow_review_items[0].reviewed_by).toBe(OWNER_ID);
    expect(tables.workflow_review_items[0].reviewed_at).toBeTruthy();
    expect(attemptReviewResumeMock).toHaveBeenCalledTimes(1);
    expect(attemptReviewResumeMock).toHaveBeenCalledWith(expect.objectContaining({ execution_id: EXECUTION_ID, user_id: OWNER_ID }));
  });

  it('duplicate decision request: a second decide call for an item already at resume_pending does NOT re-accept a new decision value -- it only drives recovery', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const first = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    expect((await first.json()).resumed).toBe(true);

    // Attempt to flip the decision on the second call -- must be ignored.
    const second = await POST(makeReq({ decision: 'reject' }), { params: { id: REVIEW_ID } });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.alreadyDecided).toBe(true);
    expect(tables.workflow_review_items[0].decision_outcome).toBe('approve'); // unchanged by the later reject attempt
    expect(attemptReviewResumeMock).toHaveBeenCalledTimes(2); // once per request, but never re-CAS'd the decision
  });

  it('a decide request for an already-resumed item is a pure idempotent no-op that still reports success', async () => {
    tables.workflow_review_items[0].status = 'resumed';
    tables.workflow_review_items[0].decision_outcome = 'approve';
    tables.workflow_review_items[0].reviewed_by = OWNER_ID;
    tables.workflow_review_items[0].reviewed_at = new Date().toISOString();

    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyDecided).toBe(true);
    expect(attemptReviewResumeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a decision value that is not one of the item\'s own allowed_outcomes', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'maybe' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(400);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(attemptReviewResumeMock).not.toHaveBeenCalled();
  });

  it('when attemptReviewResume fails, the decision is still reported as recorded (not lost), with a retry warning', async () => {
    attemptReviewResumeMock.mockResolvedValueOnce({ resumed: false, error: 'boom' });
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.resumed).toBe(false);
    expect(body.warning).toMatch(/boom/);
    // The decision itself is still durably persisted despite the resume failure.
    expect(tables.workflow_review_items[0].status).toBe('resume_pending');
    expect(tables.workflow_review_items[0].decision_outcome).toBe('approve');
  });
});
