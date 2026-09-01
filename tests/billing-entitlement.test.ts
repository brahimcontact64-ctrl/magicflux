/**
 * Phase 9.3.1 — Entitlement Integrity & Billing Foundation.
 *
 * Regression coverage for lib/billing/plan-limits.ts's resolveUserPlan()/
 * getUserPlan() (the canonical, security-sensitive server-side entitlement
 * resolver) and for the activation route (/api/workflows/[id]/lifecycle)
 * that depends on it.
 *
 * Root cause under test: the previous implementation selected
 * `plan!inner(...)` -- an alias ("plan", singular) matching neither the
 * real FK constraint name (subscriptions_plan_id_fkey) nor PostgREST's
 * auto-detected relationship name (the referenced table, "plans", plural).
 * Every call failed with PGRST200 ("Could not find a relationship"), so
 * the function silently returned the free default for every user, always
 * -- the entitlement gate could never recognize anyone as Pro/Business,
 * regardless of real subscription state. The fake DB below models
 * PostgREST's embedding behavior closely enough to catch a regression to
 * that (or any other) broken relationship selector.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type SubRow = {
  user_id: string;
  status: string;
  plan_id: string | null;
  plan?: string; // raw legacy text column -- must NEVER be trusted by the resolver
  current_period_end: string | null;
};

type PlanRow = {
  id: string;
  slug: string;
  name: string;
  price_monthly: number;
  integrations_limit: number;
  workflows_limit: number;
  executions_limit: number;
  deploy_enabled: boolean;
  created_at: string;
};

const FREE_PLAN_ID = 'plan-free';
const PRO_PLAN_ID = 'plan-pro';
const BUSINESS_PLAN_ID = 'plan-business';

const PLANS: PlanRow[] = [
  { id: FREE_PLAN_ID, slug: 'free', name: 'Free', price_monthly: 0, integrations_limit: 1, workflows_limit: 3, executions_limit: 20, deploy_enabled: false, created_at: '2026-01-01T00:00:00Z' },
  { id: PRO_PLAN_ID, slug: 'pro', name: 'Pro', price_monthly: 2900, integrations_limit: 3, workflows_limit: 20, executions_limit: 500, deploy_enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: BUSINESS_PLAN_ID, slug: 'business', name: 'Business', price_monthly: 9900, integrations_limit: -1, workflows_limit: -1, executions_limit: 5000, deploy_enabled: true, created_at: '2026-01-01T00:00:00Z' },
];

let subsTable: SubRow[];
let forceResolverError: boolean;
let lastSelectCols: string;
let subscriptionsQueryCount: number;

function resetFakeDb() {
  subsTable = [];
  forceResolverError = false;
  lastSelectCols = '';
  subscriptionsQueryCount = 0;
}

/**
 * Models just enough of PostgREST embedding semantics to catch a
 * regression to a broken relationship alias: the joined `plans` row only
 * resolves if the select string names the real, exact FK constraint
 * (`plans!subscriptions_plan_id_fkey`). Any other alias -- including the
 * historical bug's `plan!inner(...)` -- returns no joined row, exactly as
 * production PostgREST did (as an error there; here as a silent non-match,
 * which is the stricter/harder case for the resolver to fail safely on).
 */
function makeFakeDb() {
  return {
    from(table: string) {
      if (table !== 'subscriptions') {
        throw new Error(`unexpected table in fake db: ${table}`);
      }
      subscriptionsQueryCount++;
      return {
        select(cols: string) {
          lastSelectCols = cols;
          return {
            eq(col: string, val: unknown) {
              return {
                async maybeSingle() {
                  if (forceResolverError) {
                    return {
                      data: null,
                      error: { code: 'PGRST200', message: "Could not find a relationship between 'subscriptions' and 'plan' in the schema cache" },
                    };
                  }
                  const row = subsTable.find((r) => (r as Record<string, unknown>)[col] === val);
                  if (!row) return { data: null, error: null };

                  const joinsCorrectRelationship = /plans!subscriptions_plan_id_fkey/.test(cols);
                  const plan = joinsCorrectRelationship && row.plan_id
                    ? PLANS.find((p) => p.id === row.plan_id) ?? null
                    : null;

                  return {
                    data: { status: row.status, current_period_end: row.current_period_end, plan_id: row.plan_id, plan },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/workflow/lifecycle', () => ({
  loadWorkflow: vi.fn(),
  activateWorkflow: vi.fn(),
  pauseWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  deactivateWorkflow: vi.fn(),
  archiveWorkflow: vi.fn(),
}));

beforeEach(() => {
  resetFakeDb();
  vi.clearAllMocks();
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_ID = 'wf-entitlement-test';

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

// ─── resolveUserPlan() / getUserPlan() — the canonical resolver ───────────

describe('resolveUserPlan() / getUserPlan() — canonical server-side entitlement resolver', () => {
  it('1. resolves Free when no subscription row exists at all', async () => {
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.plan.deploy_enabled).toBe(false);
    expect(result.source).toBe('no_subscription');
  });

  it('2. resolves Pro for an active, unexpired Pro subscription', async () => {
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('pro');
    expect(result.plan.deploy_enabled).toBe(true);
    expect(result.source).toBe('active_subscription');
  });

  it('3. resolves Business for an active, unexpired Business subscription', async () => {
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: BUSINESS_PLAN_ID, plan: 'business', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('business');
    expect(result.plan.deploy_enabled).toBe(true);
    expect(result.source).toBe('active_subscription');
  });

  it('4a. a canceled subscription does not grant paid access', async () => {
    subsTable.push({ user_id: USER_A, status: 'canceled', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.source).toBe('inactive_subscription');
  });

  it('4b. an expired subscription (current_period_end in the past) does not grant paid access even if status is still "active"', async () => {
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: PAST });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.source).toBe('inactive_subscription');
  });

  it('5a. fails closed on a dangling FK (plan_id set but no matching plans row)', async () => {
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: 'plan-does-not-exist', plan: 'pro', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.source).toBe('inactive_subscription');
  });

  it('5b. fails closed on the exact real production anomaly shape: plan_id NULL, status active, raw plan text column says "pro" -- the resolver must NEVER trust that column', async () => {
    // This is the exact shape of the 25 dev/e2e-seeded production rows
    // found in the Phase 9.3.1 audit: status:'active', plan:'pro' (raw
    // text), plan_id: NULL. The client-only display badge (fetchPlan() in
    // lib/auth-context.tsx) falls back to this raw column and would show
    // "Pro" for these; the security-sensitive server resolver must not.
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: null, plan: 'pro', current_period_end: null });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.source).toBe('inactive_subscription');
  });

  it('6. a DB/relationship resolver failure fails safe to Free but is distinguishable from a legitimate free account', async () => {
    forceResolverError = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.source).toBe('resolution_error'); // NOT 'no_subscription' -- must be observable, not silently indistinguishable
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('7. cross-tenant: another user\'s active Pro subscription row cannot affect this user\'s resolution', async () => {
    subsTable.push({ user_id: USER_B, status: 'active', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
  });

  it('regression: the resolver queries the real, explicit FK relationship name -- not the historical broken alias', async () => {
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: FUTURE });
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    await resolveUserPlan(USER_A);
    expect(lastSelectCols).toMatch(/plans!subscriptions_plan_id_fkey/);
    expect(lastSelectCols).not.toMatch(/\bplan!inner\(/); // the exact historical bug
  });
});

// ─── Route-level: activation entitlement gate ──────────────────────────────

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

describe('POST /api/workflows/[id]/lifecycle — activation cannot be self-granted or bypassed', () => {
  it('8. a client-supplied plan field in the request body cannot alter entitlement for a genuinely Free account', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    const { loadWorkflow, activateWorkflow } = await import('@/lib/workflow/lifecycle');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    vi.mocked(loadWorkflow).mockResolvedValue({ id: WORKFLOW_ID, user_id: USER_A, workflow_json: {}, status: 'draft' } as never);
    // no subscription row seeded for USER_A -> genuinely free

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action: 'activate', plan: 'pro', planSlug: 'business', entitlement: 'pro', isPro: true }),
      }),
      { params: { id: WORKFLOW_ID } },
    );
    const payload = await res.json() as { error?: string };

    expect(res.status).toBe(403);
    expect(payload.error).toBe('PRO_REQUIRED');
    expect(activateWorkflow).not.toHaveBeenCalled();
  });

  it('9. a genuinely active Pro subscription passes the gate and reaches activateWorkflow()', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    const { loadWorkflow, activateWorkflow } = await import('@/lib/workflow/lifecycle');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    vi.mocked(loadWorkflow).mockResolvedValue({ id: WORKFLOW_ID, user_id: USER_A, workflow_json: {}, status: 'draft' } as never);
    vi.mocked(activateWorkflow).mockResolvedValue({ success: true, status: 'active', version: 1, deploymentVersionId: 'dv-1' } as never);
    subsTable.push({ user_id: USER_A, status: 'active', plan_id: PRO_PLAN_ID, plan: 'pro', current_period_end: FUTURE });

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'activate' }) }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(200);
    expect(activateWorkflow).toHaveBeenCalledWith(USER_A, WORKFLOW_ID);
  });

  it('10. ownership (404) is checked before entitlement (403) -- a non-owned workflow never reaches the entitlement resolver', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    const { loadWorkflow, activateWorkflow } = await import('@/lib/workflow/lifecycle');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    vi.mocked(loadWorkflow).mockResolvedValue(null); // not owned / doesn't exist
    // USER_A has no subscription seeded either way -- would be free regardless

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'activate' }) }),
      { params: { id: WORKFLOW_ID } },
    );
    const payload = await res.json() as { error?: string; errors?: string[] };

    expect(res.status).toBe(404);
    expect(payload.error).not.toBe('PRO_REQUIRED'); // never leaks the entitlement reason for a workflow the caller doesn't own
    expect(activateWorkflow).not.toHaveBeenCalled();
    expect(subscriptionsQueryCount).toBe(0); // entitlement resolver never even queried
  });
});
