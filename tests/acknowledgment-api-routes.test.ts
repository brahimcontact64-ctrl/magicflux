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
function ackReq(token?: string, id: string = ACK_ID): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${id}/ack`);
  if (token !== undefined) url.searchParams.set('token', token);
  return new NextRequest(url);
}
/** A real <form method="POST"> submission -- application/x-www-form-urlencoded, token in the body, never the query string (Incident 9.9.17I). */
function ackPostReq(token: string | undefined, id: string = ACK_ID): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${id}/ack`);
  const body = new URLSearchParams();
  if (token !== undefined) body.set('token', token);
  return new NextRequest(url, { method: 'POST', body });
}
function headReq(id: string = ACK_ID): NextRequest {
  const url = new URL(`http://localhost/api/acknowledgments/${id}/ack`);
  return new NextRequest(url, { method: 'HEAD' });
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
//
// Incident 9.9.17I -- two independent live leads were acknowledged ~6.6s
// after their challenge was created, both times with the human stating
// they never clicked the link -- the GET handler performed the CAS
// mutation itself, so any automated fetch (a link scanner, a prefetcher,
// speculative navigation) silently consumed the one-time link. New
// contract: GET is READ-ONLY under every repetition/header/request-count;
// only an explicit <form method="POST"> submission may attempt the CAS.

function expectHtml(res: Response): void {
  expect(res.headers.get('content-type')).toContain('text/html');
}

describe('GET /api/acknowledgments/[id]/ack -- read-only, scanner-safe (Incident 9.9.17I)', () => {
  it('a missing token fails closed with the same 404 a nonexistent row would produce, zero mutation', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(undefined), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expectHtml(res);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('an invalid/wrong token fails closed -- 404, never distinguishes "wrong token" from "no such row", zero mutation', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq('totally-wrong-token'), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expectHtml(res);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('an expired-shaped/malformed token (different length) fails closed without throwing', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq('short'), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expectHtml(res);
  });

  it('an invalid-token page renders first-party HTML and never echoes the supplied token', async () => {
    const suppliedToken = 'totally-wrong-token-should-never-appear';
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(suppliedToken), { params: { id: ACK_ID } });
    const html = await res.text();
    expect(html).toContain('<html');
    expect(html).toContain('Link not valid');
    expect(html).not.toContain(suppliedToken);
    expect(html).not.toContain(REAL_TOKEN);
    expect(html).not.toContain(REAL_TOKEN_HASH);
  });

  it('the CORE fix: a valid token on a pending item renders the human-action page and performs ZERO mutation and ZERO resume call', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const html = await res.text();

    expect(res.status).toBe(200);
    expectHtml(res);
    expect(html).toContain('Hot Lead');
    expect(html).toContain('waiting for acknowledgment');
    expect(html).toContain('Acknowledge Lead');
    expect(html).toContain('<form method="POST"');
    // The token must carry through to the POST somehow -- it lives ONLY
    // inside the hidden input's value attribute (never rendered as VISIBLE
    // text a human reading the page would see, and never in the form's
    // action URL/query string) -- "never render the token visibly" means
    // never as displayed content, not "never present anywhere in the HTML
    // source", which would make the form impossible to submit correctly.
    expect(html).toContain(`<input type="hidden" name="token" value="${REAL_TOKEN}">`);
    const visibleText = html.replace(/<input[^>]*>/g, '').replace(/<[^>]+>/g, ' ');
    expect(visibleText).not.toContain(REAL_TOKEN);
    expect(html).not.toContain(`action="/api/acknowledgments/${ACK_ID}/ack?token=`); // never in the form's own action URL
    expect(html).not.toContain(REAL_TOKEN_HASH);
    // The whole point: still pending, no acknowledged_by/at, no resume call.
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
    expect(tables.workflow_acknowledgments[0].acknowledged_by).toBeNull();
    expect(tables.workflow_acknowledgments[0].acknowledged_at).toBeNull();
    expect(attemptResumeMock).not.toHaveBeenCalled();
  });

  it('20 repeated GETs never acknowledge -- proves scanner-safety is structural, not rate-limited or heuristic', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    for (let i = 0; i < 20; i++) {
      await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    }
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
    expect(attemptResumeMock).not.toHaveBeenCalled();
  });

  it('a GET carrying scanner-like headers (bot UA, Purpose: prefetch) still never acknowledges -- the safety property does not depend on inspecting headers at all', async () => {
    const url = new URL(`http://localhost/api/acknowledgments/${ACK_ID}/ack`);
    url.searchParams.set('token', REAL_TOKEN);
    const req = new NextRequest(url, {
      headers: {
        'user-agent': 'GoogleImageProxy/1.0 (+https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers)',
        purpose: 'prefetch',
        'sec-purpose': 'prefetch;prerender',
      },
    });
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    await GET(req, { params: { id: ACK_ID } });
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('has no exported HEAD handler -- Next.js itself returns 405 for HEAD, so zero application code (and therefore zero mutation) ever runs', async () => {
    const mod = await import('../app/api/acknowledgments/[id]/ack/route');
    expect((mod as Record<string, unknown>).HEAD).toBeUndefined();
  });

  it('GET on an already-acknowledged item renders the "already acknowledged" page and performs zero writes and zero resume call', async () => {
    tables.workflow_acknowledgments[0].status = 'acknowledged';
    tables.workflow_acknowledgments[0].acknowledged_at = new Date().toISOString();
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Already acknowledged');
    expect(attemptResumeMock).not.toHaveBeenCalled();
  });

  it('GET on a timed-out item renders the expired/escalated page and performs zero writes', async () => {
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Window expired');
    expect(html).toContain('SLA escalation has already started');
    expect(tables.workflow_acknowledgments[0].late_acknowledged_at).toBeNull();
  });

  it('GET followed by no POST at all: the row remains "pending" and eligible for the natural timeout branch', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } }); // "close page", "reopen", whatever -- still just reads
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('no Location header (or any redirect) is ever issued on any branch -- eliminates the open-redirect surface', async () => {
    const { GET } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } });
    expect(res.headers.get('location')).toBeNull();
    expect([301, 302, 303, 307, 308]).not.toContain(res.status);
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
    const res = await GET(ackReq(REAL_TOKEN), { params: { id: 'ack-2' } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[1].status).toBe('pending');
  });
});

describe('POST /api/acknowledgments/[id]/ack -- the ONLY path that may mutate (Incident 9.9.17I)', () => {
  it('missing token in the POST body fails closed, zero mutation', async () => {
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq(undefined), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('invalid token in the POST body fails closed, zero mutation', async () => {
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq('wrong-token'), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[0].status).toBe('pending');
  });

  it('GET then a real POST: acknowledges exactly once, triggers resume exactly once, renders the success page with no token in it', async () => {
    const { GET, POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    await GET(ackReq(REAL_TOKEN), { params: { id: ACK_ID } }); // the human opens the link first
    const res = await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } }); // then explicitly submits
    const html = await res.text();

    expect(res.status).toBe(200);
    expectHtml(res);
    expect(html).toContain('Lead acknowledged successfully');
    expect(html).not.toContain(REAL_TOKEN);
    expect(html).not.toContain(REAL_TOKEN_HASH);
    expect(tables.workflow_acknowledgments[0].status).toBe('acknowledged');
    expect(tables.workflow_acknowledgments[0].acknowledged_by).toBe(OWNER_ID);
    expect(attemptResumeMock).toHaveBeenCalledTimes(1);
  });

  it('a replayed (double) POST is idempotent, never an error, exactly one real resume call across both', async () => {
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } });
    attemptResumeMock.mockClear();
    const second = await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const html = await second.text();
    expect(second.status).toBe(200);
    expect(html).toContain('Already acknowledged');
    // attemptAcknowledgmentResume's own exactly-once guard (untouched by
    // this incident) is what prevents a second real resumeExecution call --
    // this route still safely calls it again on replay.
    expect(attemptResumeMock).toHaveBeenCalledTimes(1);
  });

  it('two concurrent POSTs of the same link: exactly one CAS wins, both render 200, row converges to exactly one acknowledged state', async () => {
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const [a, b] = await Promise.all([
      POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } }),
      POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(tables.workflow_acknowledgments[0].status).toBe('acknowledged');
    expect(attemptResumeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('POST after the item already timed out records a late acknowledgment, renders the expired page, never rewinds status (Part H)', async () => {
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Window expired');
    expect(tables.workflow_acknowledgments[0].status).toBe('timed_out');
    expect(tables.workflow_acknowledgments[0].late_acknowledged_at).toBeTruthy();
  });

  it('POST racing right at the deadline: if the row is ALREADY timed_out by the time the CAS runs, records a late acknowledgment instead of an error (Part E)', async () => {
    // Simulates the timeout dispatcher winning the race a moment before
    // this POST's own CAS attempt.
    tables.workflow_acknowledgments[0].status = 'timed_out';
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Window expired');
  });

  it('cross-tenant: a token cannot be reused against a DIFFERENT row id via POST either', async () => {
    tables.workflow_acknowledgments.push({
      id: 'ack-2', user_id: ATTACKER_ID, workflow_id: 'wf-2', execution_id: 'exec-2', node_id: 'node-2',
      node_name: 'Await acknowledgment', deployment_version_id: null, status: 'pending',
      deadline_at: new Date(Date.now() + 60_000).toISOString(), mode: 'live', resume_attempts: 0,
      acknowledgment_token_hash: createHash('sha256').update('different-token').digest('hex'),
      acknowledged_by: null, acknowledged_at: null, late_acknowledged_by: null, late_acknowledged_at: null,
    });
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq(REAL_TOKEN), { params: { id: 'ack-2' } });
    expect(res.status).toBe(404);
    expect(tables.workflow_acknowledgments[1].status).toBe('pending');
  });

  it('a token with no acknowledgment_token_hash configured on the row fails closed via POST too', async () => {
    tables.workflow_acknowledgments[0].acknowledgment_token_hash = null;
    const { POST } = await import('../app/api/acknowledgments/[id]/ack/route');
    const res = await POST(ackPostReq(REAL_TOKEN), { params: { id: ACK_ID } });
    expect(res.status).toBe(404);
  });
});

describe('HEAD /api/acknowledgments/[id]/ack (Incident 9.9.17I -- scanner-safety proof)', () => {
  it('exports no HEAD handler at all -- confirms Next.js\'s own method dispatch (405) is what protects this route, not application logic', async () => {
    const mod = await import('../app/api/acknowledgments/[id]/ack/route');
    expect(typeof (mod as Record<string, unknown>).GET).toBe('function');
    expect(typeof (mod as Record<string, unknown>).POST).toBe('function');
    expect((mod as Record<string, unknown>).HEAD).toBeUndefined();
  });
});
