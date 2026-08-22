/**
 * Phase 8.4 — GET /api/cron/self-heal: CRON_SECRET bearer auth.
 *
 * This route is a thin GET wrapper around the existing, unchanged
 * lib/runtime/self-healer.ts's runSelfHeal() — added because Vercel Cron
 * always issues GET requests, and the pre-existing self-heal endpoint
 * (POST /api/runtime/self-heal, used by the runtime control UI for manual
 * triggers) only accepts POST. Mirrors the exact auth pattern already
 * proven for the other two cron routes
 * (see tests/control-plane.security.test.ts's dispatch-schedules suite).
 *
 * The underlying recovery mechanisms this wraps (orphan-execution
 * recovery, expired-concurrency-reservation reclaim) were already proven
 * live against a real Postgres instance in Phase 8.4's Step 4 (TTL
 * recovery test) — this file only proves the NEW route's auth gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const runSelfHealMock = vi.fn(async (_params: Record<string, unknown>) => ({ recoveredOrphans: 0, recoveredJobs: 0, reclaimedReservations: 0 }));
vi.mock('@/lib/runtime/self-healer', () => ({
  runSelfHeal: (params: Record<string, unknown>) => runSelfHealMock(params),
}));

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  runSelfHealMock.mockClear();
});

describe('GET /api/cron/self-heal — CRON_SECRET auth', () => {
  it('rejects with 401 when no Authorization header is present', async () => {
    const { GET } = await import('../app/api/cron/self-heal/route');
    const res = await GET(makeReq('http://localhost/api/cron/self-heal'));
    expect(res.status).toBe(401);
    expect(runSelfHealMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the bearer token is wrong', async () => {
    const { GET } = await import('../app/api/cron/self-heal/route');
    const res = await GET(makeReq('http://localhost/api/cron/self-heal', { headers: { authorization: 'Bearer wrong-secret' } }));
    expect(res.status).toBe(401);
    expect(runSelfHealMock).not.toHaveBeenCalled();
  });

  it('accepts and runs self-heal when the bearer token matches CRON_SECRET', async () => {
    const { GET } = await import('../app/api/cron/self-heal/route');
    const res = await GET(makeReq('http://localhost/api/cron/self-heal', { headers: { authorization: 'Bearer test-cron-secret' } }));
    expect(res.status).toBe(200);
    expect(runSelfHealMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.report).toBeTruthy();
  });

  it('returns 500 (not a silent no-op) when CRON_SECRET is not configured at all', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('../app/api/cron/self-heal/route');
    const res = await GET(makeReq('http://localhost/api/cron/self-heal', { headers: { authorization: 'Bearer anything' } }));
    expect(res.status).toBe(500);
    expect(runSelfHealMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });
});
