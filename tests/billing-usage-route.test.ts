/**
 * Phase 9.9.20 — GET /api/billing/usage must expose `plan_slug` alongside
 * the already-Beta-aware `deploy_enabled`/limits. This is the exact
 * endpoint lib/auth-context.tsx's client-side AuthUser now sources its
 * entitlement from (replacing a previous independent, non-Beta-aware
 * client-side query) -- if this route ever regresses to omitting
 * `plan_slug` or returning a stale/duplicated entitlement, every
 * `isPro`-style client check silently breaks again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequestMock = vi.fn();
const getUsageMetricsMock = vi.fn();
const getPlanLimitsMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('@/lib/billing/plan-limits', () => ({
  getUsageMetrics: getUsageMetricsMock,
  getPlanLimits: getPlanLimitsMock,
}));

function makeReq(): Request {
  return new Request('http://localhost/api/billing/usage');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/billing/usage', () => {
  it('401s with no authenticated user, never falling back to a default plan', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { GET } = await import('../app/api/billing/usage/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(401);
    expect(getPlanLimitsMock).not.toHaveBeenCalled();
  });

  it('returns plan_slug distinct from plan_name for a Beta-expanded Free account', async () => {
    getUserFromRequestMock.mockResolvedValue({ id: 'user-1', email: 'a@test.local' });
    getUsageMetricsMock.mockResolvedValue({ connected_integrations: 0, workflows: 0, executions_this_month: 0 });
    getPlanLimitsMock.mockResolvedValue({
      slug: 'free',
      name: 'Free (Beta)',
      integrations_limit: 3,
      workflows_limit: 10,
      executions_limit: 100,
      deploy_enabled: true,
    });

    const { GET } = await import('../app/api/billing/usage/route');
    const res = await GET(makeReq() as never);
    const body = await res.json();

    expect(body.plan_slug).toBe('free');
    expect(body.plan_name).toBe('Free (Beta)');
    expect(body.deploy_enabled).toBe(true);
  });

  it('returns the real slug/name for a genuine paid subscriber, unaffected by Beta', async () => {
    getUserFromRequestMock.mockResolvedValue({ id: 'user-2', email: 'b@test.local' });
    getUsageMetricsMock.mockResolvedValue({ connected_integrations: 2, workflows: 4, executions_this_month: 50 });
    getPlanLimitsMock.mockResolvedValue({
      slug: 'pro',
      name: 'Pro',
      integrations_limit: 3,
      workflows_limit: 20,
      executions_limit: 500,
      deploy_enabled: true,
    });

    const { GET } = await import('../app/api/billing/usage/route');
    const res = await GET(makeReq() as never);
    const body = await res.json();

    expect(body.plan_slug).toBe('pro');
    expect(body.plan_name).toBe('Pro');
  });
});
