/**
 * Phase 9.9.2 — /api/reviews/[id]/decide authorization & idempotency.
 *
 * Covers the security requirements explicit in this phase: no public
 * unauthenticated approval (401 without a session), cross-tenant access
 * blocked (a review item scoped to a different user comes back 404, never
 * leaking existence), and idempotent decisions (a compare-and-swap update
 * means a second decide request for an already-decided item never resumes
 * the execution again -- "execution resumes exactly once").
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
        deployment_version_id: null,
        status: 'pending',
        allowed_outcomes: ['approve', 'reject'],
        mode: 'live',
      },
    ],
    workflows: [{ id: WORKFLOW_ID, user_id: OWNER_ID, workflow_json: { nodes: [], connections: {} } }],
    deployment_versions: [],
  };
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
  getUserFromRequest: vi.fn(),
}));

const resumeExecutionMock = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('@/runtime/execution-manager', () => ({
  ExecutionManager: class {
    resumeExecution(...args: unknown[]) { return resumeExecutionMock(...args); }
  },
}));

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/reviews/${REVIEW_ID}/decide`), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tables = freshTables();
  resumeExecutionMock.mockClear();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
});

describe('POST /api/reviews/[id]/decide', () => {
  it('unauthorized: no session -> 401, never touches the review item or resumes anything', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(401);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });

  it('cross-tenant: a different user cannot see or decide someone else\'s review item -> 404, unchanged, no resume', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(404);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(tables.workflow_review_items[0].user_id).toBe(OWNER_ID); // never reassigned/leaked
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });

  it('the real owner can approve, which resumes the execution exactly once', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.resumed).toBe(true);
    expect(tables.workflow_review_items[0].status).toBe('approved');
    expect(tables.workflow_review_items[0].decision_outcome).toBe('approve');
    expect(tables.workflow_review_items[0].reviewed_by).toBe(OWNER_ID);
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
    expect(resumeExecutionMock).toHaveBeenCalledWith(expect.objectContaining({ executionId: EXECUTION_ID, userId: OWNER_ID }));
  });

  it('duplicate decision does not resume twice: a second decide request for an already-decided item is a no-op', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const first = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    expect((await first.json()).resumed).toBe(true);

    const second = await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.alreadyDecided).toBe(true);
    // The critical assertion: resumeExecution was called exactly once total,
    // not once per decide request.
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('a conflicting decision (reject) after an approve is also a no-op -- the FIRST decision wins', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    await POST(makeReq({ decision: 'approve' }), { params: { id: REVIEW_ID } });
    const conflicting = await POST(makeReq({ decision: 'reject' }), { params: { id: REVIEW_ID } });

    expect((await conflicting.json()).alreadyDecided).toBe(true);
    expect(tables.workflow_review_items[0].decision_outcome).toBe('approve'); // unchanged by the later reject attempt
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a decision value that is not one of the item\'s own allowed_outcomes', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/reviews/[id]/decide/route');
    const res = await POST(makeReq({ decision: 'maybe' }), { params: { id: REVIEW_ID } });

    expect(res.status).toBe(400);
    expect(tables.workflow_review_items[0].status).toBe('pending');
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });
});
