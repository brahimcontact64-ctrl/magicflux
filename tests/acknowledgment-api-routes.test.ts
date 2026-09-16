/**
 * Phase 9.9.12 -- Part D/E/H/J: the acknowledgment API routes.
 *   - POST /api/acknowledgments/[id]/decide -- authenticated dashboard action.
 *   - GET  /api/acknowledgments/[id]/ack?token=... -- unauthenticated,
 *     cryptographically-scoped-token link (meant for a notification).
 *
 * Mirrors tests/reviews-api.test.ts's exact authorization/CAS/concurrency
 * proof shape for the structurally equivalent Human Review decide route.
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000f2';
const ACK_ID = 'ack-1';
const WORKFLOW_ID = 'wf-1';
const EXECUTION_ID = 'exec-1';
const REAL_TOKEN = 'a'.repeat(43); // base64url-shaped, arbitrary for tests
const REAL_TOKEN_HASH = createHash('sha256').update(REAL_TOKEN).digest('hex');

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private nullFilters: string[] = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  is(col: string, _val: null): this { this.nullFilters.push(col); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v) && this.nullFilters.every((c) => r[c] === null || r[c] === undefined));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
}

function freshTables(): Record<string, Row[]> {
  return {
    workflow_acknowledgments: [
      {
        id: ACK_ID,
        user_id: OWNER_ID,
        workflow_id: WORKFLOW_ID,
        execution_id: EXECUTION_ID,
        node_id: 'node-1',
        node_name: 'Await acknowledgment',
        deployment_version_id: null,
        status: 'pending',
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        mode: 'live',
        resume_attempts: 0,
        acknowledgment_token_hash: REAL_TOKEN_HASH,
        acknowledged_by: null,
        acknowledged_at: null,
        late_acknowledged_by: null,
        late_acknowledged_at: null,
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

const attemptResumeMock = vi.fn().mockResolvedValue({ resumed: true });
vi.mock('@/lib/runtime/acknowledgment-resume', () => ({
  attemptAcknowledgmentResume: (...args: unknown[]) => attemptResumeMock(...args),
}));

beforeEach(async () => {
  tables = freshTables();
  attemptResumeMock.mockClear();
  attemptResumeMock.mockResolvedValue({ resumed: true });
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
});

function decideReq(): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/acknowledgments/${ACK_ID}/decide`), { method: 'POST' });
}
function ackReq(token?: string): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${ACK_ID}/ack`);
  if (token !== undefined) url.searchParams.set('token', token);
  return new NextRequest(url);
}

// ─── Authenticated dashboard route ──────────────────────────────────────────

describe('POST /api/acknowledgments/[id]/decide', () => {
  it('unauthorized: no session -> 401, never touches the item', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const res = await POST(decideReq(), { params: { id: ACK_ID } });
    expect(res.status).toBe(401);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('cross-tenant: a different user cannot see or acknowledge someone else\'s item -> 404, unchanged (Part J)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const res = await POST(decideReq(), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('the real owner can acknowledge: CAS pending -> acknowledged, then resume is attempted', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const res = await POST(decideReq(), { params: { id: ACK_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.resumed).toBe(true);
    expect(tables.workflow_acknowledgments[0].status).toBe('acknowledged');
    expect(tables.workflow_acknowledgments[0].acknowledged_by).toBe(OWNER_ID);
    expect(tables.workflow_acknowledgments[0].acknowledged_at).toBeTruthy();
    expect(attemptResumeMock).toHaveBeenCalledTimes(1);
  });

  it('double acknowledgment (replayed request): idempotent, never an error, never re-CAS\'d', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    await POST(decideReq(), { params: { id: ACK_ID } });
    const second = await POST(decideReq(), { params: { id: ACK_ID } });
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body.alreadyAcknowledged).toBe(true);
  });

  it('late acknowledgment: item already timed_out -> recorded separately, status never rewound (Part H)', async () => {
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const res = await POST(decideReq(), { params: { id: ACK_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.lateAcknowledgment).toBe(true);
    expect(tables.workflow_acknowledgments[0].status).toBe('timed_out'); // never rewound
    expect(tables.workflow_acknowledgments[0].late_acknowledged_by).toBe(OWNER_ID);
    expect(tables.workflow_acknowledgments[0].late_acknowledged_at).toBeTruthy();
  });

  it('two concurrent actors deciding at once: exactly one CAS wins, the other is treated as already-decided', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const [a, b] = await Promise.all([POST(decideReq(), { params: { id: ACK_ID } }), POST(decideReq(), { params: { id: ACK_ID } })]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);

    const winners = [bodyA, bodyB].filter((x) => !x.alreadyAcknowledged);
    const losers = [bodyA, bodyB].filter((x) => x.alreadyAcknowledged);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(tables.workflow_acknowledgments[0].status).toBe('acknowledged');
  });

  it('acknowledgment exactly racing timeout: if the row is ALREADY timed_out by the time the CAS runs, records a late acknowledgment instead of erroring', async () => {
    // Simulates the timeout side winning the race a moment before this
    // request's CAS -- the route's own lost-race branch re-reads and finds
    // 'timed_out'.
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { POST } = await import('../app/api/acknowledgments/[id]/decide/route');
    const res = await POST(decideReq(), { params: { id: ACK_ID } });
    const body = await res.json();
    expect(body.lateAcknowledgment).toBe(true);
  });
});

// ─── Unauthenticated token-based link ───────────────────────────────────────

describe('GET /api/acknowledgments/[id]/ack -- token-based link', () => {
  it('a missing token fails closed with the same 404 a nonexistent row would produce', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(undefined), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('an invalid/wrong token fails closed -- 404, never distinguishes "wrong token" from "no such row"', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq('totally-wrong-token'), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('an expired-shaped/malformed token (different length) fails closed without throwing', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq('short'), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
  });

  it('the correct token acknowledges the item and triggers resume', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.acknowledged).toBe(true);
    expect(tables.workflow_acknowledgments[0].status).toBe('acknowledged');
    expect(tables.workflow_acknowledgments[0].acknowledged_by).toBe(OWNER_ID); // scoped to the row's own tenant
    expect(attemptResumeMock).toHaveBeenCalledTimes(1);
  });

  it('a replayed (already-used) token is idempotent, never an error', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const second = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const body = await second.json();
    expect(second.status).toBe(200);
    expect(body.alreadyAcknowledged).toBe(true);
  });

  it('a valid token used AFTER the SLA already timed out records a late acknowledgment, never rewinds status (Part H)', async () => {
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.lateAcknowledgment).toBe(true);
    expect(tables.workflow_acknowledgments[0].status).toBe('timed_out');
    expect(tables.workflow_acknowledgments[0].late_acknowledged_at).toBeTruthy();
  });

  it('a token with no acknowledgment_token_hash configured on the row fails closed (never falls back to trusting the id alone)', async () => {
    tables.workflow_acknowledgments[0].acknowledgment_token_hash = null;
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: a token cannot be reused against a DIFFERENT row id -- workflow/execution IDs alone are insufficient authorization (Part J)', async () => {
    tables.workflow_acknowledgments.push({
      id: 'ack-2', user_id: ATTACKER_ID, workflow_id: 'wf-2', execution_id: 'exec-2', node_id: 'node-2',
      node_name: 'Await acknowledgment', deployment_version_id: null, status: 'pending',
      deadline_at: new Date(Date.now() + 60_000).toISOString(), mode: 'live', resume_attempts: 0,
      acknowledgment_token_hash: createHash('sha256').update('different-token').digest('hex'),
      acknowledged_by: null, acknowledged_at: null, late_acknowledged_by: null, late_acknowledged_at: null,
    });
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    // Using OWNER's real token against the ATTACKER's row id.
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: 'ack-2' } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[1].status).toBe('pending');
  });

  it('two concurrent clicks of the same link: exactly one CAS wins', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const [a, b] = await Promise.all([GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } }), GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } })]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    const winners = [bodyA, bodyB].filter((x) => x.acknowledged);
    const losers = [bodyA, bodyB].filter((x) => x.alreadyAcknowledged);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });
});
