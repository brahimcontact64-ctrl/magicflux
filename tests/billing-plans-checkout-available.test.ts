/**
 * Phase 9.5 Step C/D — GET /api/billing/plans must expose whether checkout
 * can actually succeed (`checkoutAvailable`), computed server-side from
 * whether Stripe is genuinely configured (client + both price IDs), so
 * every Upgrade CTA can render an honest state *before* attempting a
 * checkout call that would otherwise 503. Never exposes the underlying
 * key/price ID values -- only presence/absence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const PLAN_ROWS = [
  { slug: 'free', name: 'Free', price_monthly: 0, integrations_limit: 1, workflows_limit: 3, executions_limit: 20, deploy_enabled: false },
  { slug: 'pro', name: 'Pro', price_monthly: 2900, integrations_limit: 3, workflows_limit: 20, executions_limit: 500, deploy_enabled: true },
  { slug: 'business', name: 'Business', price_monthly: 9900, integrations_limit: -1, workflows_limit: -1, executions_limit: 5000, deploy_enabled: true },
];

function makeFakeDb() {
  return {
    from(table: string) {
      if (table !== 'plans') throw new Error(`unexpected table in fake db: ${table}`);
      return {
        select: () => ({
          order: async () => ({ data: PLAN_ROWS, error: null }),
        }),
      };
    },
  };
}

const getStripeClientMock = vi.fn();
const stripePriceIdForPlanMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
}));

vi.mock('@/lib/billing/stripe-client', () => ({
  getStripeClient: getStripeClientMock,
}));

vi.mock('@/lib/billing/stripe-plans', () => ({
  stripePriceIdForPlan: stripePriceIdForPlanMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/billing/plans -- checkoutAvailable', () => {
  it('is true only when a real Stripe client AND both price IDs are configured', async () => {
    getStripeClientMock.mockReturnValue({ checkout: {} } as never);
    stripePriceIdForPlanMock.mockImplementation((plan: string) => (plan === 'pro' ? 'price_pro' : 'price_business'));

    const { GET } = await import('../app/api/billing/plans/route');
    const res = await GET();
    const body = await res.json();

    expect(body.checkoutAvailable).toBe(true);
    expect(body.plans).toHaveLength(3);
  });

  it('is false when Stripe is unconfigured (no client) -- today\'s actual standing state', async () => {
    getStripeClientMock.mockReturnValue(null);
    stripePriceIdForPlanMock.mockReturnValue(null);

    const { GET } = await import('../app/api/billing/plans/route');
    const res = await GET();
    const body = await res.json();

    expect(body.checkoutAvailable).toBe(false);
  });

  it('is false when the client exists but the Pro price ID is missing', async () => {
    getStripeClientMock.mockReturnValue({ checkout: {} } as never);
    stripePriceIdForPlanMock.mockImplementation((plan: string) => (plan === 'business' ? 'price_business' : null));

    const { GET } = await import('../app/api/billing/plans/route');
    const res = await GET();
    const body = await res.json();

    expect(body.checkoutAvailable).toBe(false);
  });

  it('is false when the client exists but the Business price ID is missing', async () => {
    getStripeClientMock.mockReturnValue({ checkout: {} } as never);
    stripePriceIdForPlanMock.mockImplementation((plan: string) => (plan === 'pro' ? 'price_pro' : null));

    const { GET } = await import('../app/api/billing/plans/route');
    const res = await GET();
    const body = await res.json();

    expect(body.checkoutAvailable).toBe(false);
  });

  it('never leaks the underlying price ID or client details, only the boolean', async () => {
    getStripeClientMock.mockReturnValue({ checkout: {}, secretKeySentinel: 'sk_test_should_never_appear' } as never);
    stripePriceIdForPlanMock.mockImplementation((plan: string) => (plan === 'pro' ? 'price_SECRET_pro' : 'price_SECRET_business'));

    const { GET } = await import('../app/api/billing/plans/route');
    const res = await GET();
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toContain('price_SECRET');
    expect(raw).not.toContain('sk_test_should_never_appear');
  });
});
