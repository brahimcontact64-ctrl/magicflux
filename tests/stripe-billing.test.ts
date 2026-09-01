/**
 * Phase 9.3.2 — Stripe Subscription Billing security tests.
 *
 * Covers checkout (server-resolved price only, never client input),
 * webhook (signature verification, idempotency, out-of-order protection,
 * cross-user isolation), and the end-to-end apply -> canonical resolver
 * path (an "active Pro subscription" written by the webhook handler must
 * be exactly what lib/billing/plan-limits.ts's resolver recognizes as Pro
 * -- there is only one entitlement mapping, not two that could drift).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

type SubRow = {
  user_id: string;
  status: string;
  plan: string | null;
  plan_id: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  cancel_at_period_end: boolean;
  stripe_synced_at: string | null;
  updated_at?: string;
};

const FREE_PLAN_ID = 'plan-free';
const PRO_PLAN_ID = 'plan-pro';
const BUSINESS_PLAN_ID = 'plan-business';
const PRICE_PRO = 'price_test_pro';
const PRICE_BUSINESS = 'price_test_business';

const PLANS: PlanRow[] = [
  { id: FREE_PLAN_ID, slug: 'free', name: 'Free', price_monthly: 0, integrations_limit: 1, workflows_limit: 3, executions_limit: 20, deploy_enabled: false, created_at: '2026-01-01T00:00:00Z' },
  { id: PRO_PLAN_ID, slug: 'pro', name: 'Pro', price_monthly: 2900, integrations_limit: 3, workflows_limit: 20, executions_limit: 500, deploy_enabled: true, created_at: '2026-01-01T00:00:00Z' },
  { id: BUSINESS_PLAN_ID, slug: 'business', name: 'Business', price_monthly: 9900, integrations_limit: -1, workflows_limit: -1, executions_limit: 5000, deploy_enabled: true, created_at: '2026-01-01T00:00:00Z' },
];

let subsTable: Map<string, SubRow>; // keyed by user_id
let webhookEventIds: Set<string>;
let stripeSubscriptionsRetrieveImpl: (id: string) => any;

function resetFakeDb() {
  subsTable = new Map();
  webhookEventIds = new Set();
}

/** Models the two real tables + the FK-join semantics the app relies on. */
function makeFakeDb() {
  return {
    from(table: string) {
      if (table === 'plans') {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              async maybeSingle() {
                const row = PLANS.find((p) => p.slug === val);
                return { data: row ?? null, error: null };
              },
            }),
          }),
        };
      }
      if (table === 'subscriptions') {
        return {
          select(cols: string) {
            return {
              eq: (col: string, val: unknown) => ({
                async maybeSingle() {
                  if (col !== 'user_id') throw new Error(`fake db only supports .eq('user_id', ...) on subscriptions, got ${col}`);
                  const row = subsTable.get(val as string);
                  if (!row) return { data: null, error: null };
                  const joinsPlan = /plans!subscriptions_plan_id_fkey/.test(cols);
                  const plan = joinsPlan && row.plan_id ? PLANS.find((p) => p.id === row.plan_id) ?? null : null;
                  return {
                    data: {
                      status: row.status,
                      current_period_end: row.current_period_end,
                      plan_id: row.plan_id,
                      stripe_customer_id: row.stripe_customer_id,
                      stripe_synced_at: row.stripe_synced_at,
                      plan,
                    },
                    error: null,
                  };
                },
              }),
            };
          },
          upsert(row: Partial<SubRow> & { user_id: string }, _opts: Record<string, unknown>) {
            const existing = subsTable.get(row.user_id) ?? ({} as SubRow);
            subsTable.set(row.user_id, { ...existing, ...row } as SubRow);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'stripe_webhook_events') {
        return {
          insert(row: { event_id: string; event_type: string }) {
            if (webhookEventIds.has(row.event_id)) {
              return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
            }
            webhookEventIds.add(row.event_id);
            return Promise.resolve({ error: null });
          },
          delete() {
            return {
              eq: (_col: string, val: string) => {
                webhookEventIds.delete(val);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  };
}

const stripeCheckoutCreateMock = vi.fn();
const stripeSubscriptionsRetrieveMock = vi.fn(async (id: string) => stripeSubscriptionsRetrieveImpl(id));
const stripeConstructEventMock = vi.fn();

function makeFakeStripe() {
  return {
    checkout: { sessions: { create: stripeCheckoutCreateMock } },
    subscriptions: { retrieve: stripeSubscriptionsRetrieveMock },
    webhooks: { constructEvent: stripeConstructEventMock },
    billingPortal: { sessions: { create: vi.fn() } },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/billing/stripe-client', () => ({
  getStripeClient: vi.fn(() => makeFakeStripe()),
}));

beforeEach(() => {
  resetFakeDb();
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_only';
  process.env.STRIPE_PRICE_ID_PRO = PRICE_PRO;
  process.env.STRIPE_PRICE_ID_BUSINESS = PRICE_BUSINESS;
});

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const FUTURE_UNIX = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
const PAST_UNIX = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

function fakeStripeSubscription(overrides: Partial<{ id: string; status: string; priceId: string; userId: string; customer: string; currentPeriodEnd: number; cancelAtPeriodEnd: boolean }>) {
  const {
    id = 'sub_test_1',
    status = 'active',
    priceId = PRICE_PRO,
    userId = USER_A,
    customer = 'cus_test_1',
    currentPeriodEnd = FUTURE_UNIX,
    cancelAtPeriodEnd = false,
  } = overrides;
  return {
    id,
    status,
    customer,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: { user_id: userId },
    items: { data: [{ price: { id: priceId }, current_period_end: currentPeriodEnd }] },
  };
}

// ─── Checkout: server-resolved price only ──────────────────────────────────

describe('POST /api/billing/checkout', () => {
  it('1. rejects an unauthenticated request', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { POST } = await import('../app/api/billing/checkout/route');
    const res = await POST(makeReq('http://localhost/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro' }) }));
    expect(res.status).toBe(401);
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it('2. ignores a client-supplied Stripe price ID / amount and always uses the server-configured price', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    stripeCheckoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.com/fake' });

    const { POST } = await import('../app/api/billing/checkout/route');
    await POST(makeReq('http://localhost/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: 'pro', priceId: 'price_ATTACKER_SUPPLIED', amount: 1, unit_amount: 1 }),
    }));

    expect(stripeCheckoutCreateMock).toHaveBeenCalledTimes(1);
    const args = stripeCheckoutCreateMock.mock.calls[0][0];
    expect(args.line_items).toEqual([{ price: PRICE_PRO, quantity: 1 }]);
    expect(JSON.stringify(args)).not.toContain('price_ATTACKER_SUPPLIED');
  });

  it('3. rejects an unsupported plan slug (including "free", which has no checkout)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);

    const { POST } = await import('../app/api/billing/checkout/route');
    for (const plan of ['free', 'enterprise', '', 'PRO; DROP TABLE subscriptions;']) {
      const res = await POST(makeReq('http://localhost/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) }));
      expect(res.status).toBe(400);
    }
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it('12. a client cannot self-write plan/status/period-end via checkout -- extra body fields are never forwarded anywhere, and checkout never itself grants entitlement', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_A, email: 'a@test.local' } as never);
    stripeCheckoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.com/fake' });

    const { POST } = await import('../app/api/billing/checkout/route');
    await POST(makeReq('http://localhost/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: 'pro', status: 'active', current_period_end: '2099-01-01', deploy_enabled: true }),
    }));

    const args = stripeCheckoutCreateMock.mock.calls[0][0];
    expect(JSON.stringify(args)).not.toContain('2099-01-01');
    expect(JSON.stringify(args)).not.toContain('deploy_enabled');
    // checkout only ever creates a Stripe Checkout Session -- the fake db's
    // 'subscriptions' table has no row for this user, proving no entitlement
    // was written by the checkout call itself (only the webhook ever does).
    expect(subsTable.has(USER_A)).toBe(false);
  });
});

// ─── Webhook: signature, idempotency, correctness ──────────────────────────

describe('POST /api/billing/webhook', () => {
  it('5. rejects a forged/invalid-signature payload without applying anything', async () => {
    stripeConstructEventMock.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const { POST } = await import('../app/api/billing/webhook/route');
    const res = await POST(makeReq('http://localhost/api/billing/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'customer.subscription.updated', data: { object: fakeStripeSubscription({}) } }),
      headers: { 'stripe-signature': 'forged' },
    }));

    expect(res.status).toBe(400);
    expect(subsTable.size).toBe(0);
  });

  it('4. a request with no stripe-signature header at all is rejected the same way (forged success redirect has nothing to replay against)', async () => {
    const { POST } = await import('../app/api/billing/webhook/route');
    const res = await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
    expect(stripeConstructEventMock).not.toHaveBeenCalled();
  });

  it('6. a validly-signed subscription.updated event updates only the correct user', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_1', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    const res = await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    expect(res.status).toBe(200);
    expect(subsTable.get(USER_A)?.status).toBe('active');
    expect(subsTable.get(USER_A)?.plan).toBe('pro');
    expect(subsTable.has(USER_B)).toBe(false);
  });

  it('7. a duplicate delivery of the same event id is a no-op the second time', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO });
    const event = { id: 'evt_dup', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), data: { object: sub } };
    stripeConstructEventMock.mockReturnValue(event);

    const { POST } = await import('../app/api/billing/webhook/route');
    const res1 = await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));
    expect(res1.status).toBe(200);
    expect((await res1.json()).duplicate).toBeFalsy();

    const res2 = await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));
    expect(res2.status).toBe(200);
    expect((await res2.json()).duplicate).toBe(true);

    // still exactly one row, not duplicated / corrupted by reprocessing
    expect(subsTable.size).toBe(1);
  });

  it('8. cross-user isolation: an event for user A never touches an existing row belonging to user B', async () => {
    subsTable.set(USER_B, {
      user_id: USER_B, status: 'active', plan: 'business', plan_id: BUSINESS_PLAN_ID,
      current_period_end: new Date(FUTURE_UNIX * 1000).toISOString(), stripe_customer_id: 'cus_b',
      stripe_subscription_id: 'sub_b', stripe_price_id: PRICE_BUSINESS, cancel_at_period_end: false,
      stripe_synced_at: new Date().toISOString(),
    });

    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_2', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    expect(subsTable.get(USER_B)?.plan).toBe('business');
    expect(subsTable.get(USER_B)?.stripe_subscription_id).toBe('sub_b');
  });

  it('an out-of-order (older) event does not overwrite a newer already-applied state', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newerEvent = { id: 'evt_newer', type: 'customer.subscription.updated', created: now, data: { object: fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO }) } };
    const olderEvent = { id: 'evt_older', type: 'customer.subscription.updated', created: now - 3600, data: { object: fakeStripeSubscription({ userId: USER_A, status: 'canceled', priceId: PRICE_PRO }) } };

    const { POST } = await import('../app/api/billing/webhook/route');

    stripeConstructEventMock.mockReturnValue(newerEvent);
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));
    expect(subsTable.get(USER_A)?.status).toBe('active');

    stripeConstructEventMock.mockReturnValue(olderEvent);
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));
    // the older, already-superseded "canceled" event must NOT regress the row
    expect(subsTable.get(USER_A)?.status).toBe('active');
  });

  it('11. a payment-failure event (subscription now past_due) does not grant paid access', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'past_due', priceId: PRICE_PRO });
    stripeSubscriptionsRetrieveImpl = () => sub;
    stripeConstructEventMock.mockReturnValue({
      id: 'evt_invoice_failed',
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { parent: { subscription_details: { subscription: sub.id } } } },
    });

    const { POST } = await import('../app/api/billing/webhook/route');
    const res = await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));
    expect(res.status).toBe(200);
    expect(subsTable.get(USER_A)?.status).toBe('past_due');

    // and the canonical resolver must not treat past_due as entitling
    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
  });
});

// ─── End-to-end: webhook write -> canonical resolver agreement ────────────

describe('applyStripeSubscription -> canonical resolver agreement', () => {
  it('9. a canceled Stripe subscription resolves to no paid entitlement through the real resolver', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'canceled', priceId: PRICE_PRO });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_cancel', type: 'customer.subscription.deleted', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
    expect(result.plan.deploy_enabled).toBe(false);
  });

  it('10a. a genuinely active Pro Stripe subscription resolves to Pro through the real canonical resolver', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_pro', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('pro');
    expect(result.plan.deploy_enabled).toBe(true);
  });

  it('10b. a genuinely active Business Stripe subscription resolves to Business through the real canonical resolver', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_BUSINESS });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_biz', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('business');
    expect(result.plan.deploy_enabled).toBe(true);
  });

  it('an expired (current_period_end in the past) Stripe-sourced subscription resolves to no paid entitlement even if status is stale-active', async () => {
    const sub = fakeStripeSubscription({ userId: USER_A, status: 'active', priceId: PRICE_PRO, currentPeriodEnd: PAST_UNIX });
    stripeConstructEventMock.mockReturnValue({ id: 'evt_expired', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), data: { object: sub } });

    const { POST } = await import('../app/api/billing/webhook/route');
    await POST(makeReq('http://localhost/api/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'valid' } }));

    const { resolveUserPlan } = await import('@/lib/billing/plan-limits');
    const result = await resolveUserPlan(USER_A);
    expect(result.plan.slug).toBe('free');
  });
});
