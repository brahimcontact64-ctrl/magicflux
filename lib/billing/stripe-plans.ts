import 'server-only';

/**
 * Phase 9.3.2 — canonical, server-only plan <-> Stripe Price ID mapping.
 *
 * This is the ONLY place a plan slug resolves to a Stripe price. The
 * client may send a plan slug ("pro" / "business") when starting
 * checkout, but never an amount or a Stripe price ID directly -- see
 * app/api/billing/checkout/route.ts. Price IDs live in server env vars,
 * not in the `plans` table, so there is exactly one source of truth for
 * "what does this checkout actually charge" and it is not reachable from
 * the client or from a database row a future feature could edit.
 */

export type CheckoutablePlan = 'pro' | 'business';

const PRICE_ENV: Record<CheckoutablePlan, string | undefined> = {
  pro: process.env.STRIPE_PRICE_ID_PRO,
  business: process.env.STRIPE_PRICE_ID_BUSINESS,
};

export function isCheckoutablePlan(value: string): value is CheckoutablePlan {
  return value === 'pro' || value === 'business';
}

/** The configured Stripe price ID for a plan, or null if not yet configured. */
export function stripePriceIdForPlan(plan: CheckoutablePlan): string | null {
  return PRICE_ENV[plan] ?? null;
}

/**
 * Reverse lookup used by webhook processing: map a Stripe price ID back to
 * our plan slug. Deliberately does NOT trust event.metadata.plan or any
 * client-supplied value for this -- the price actually on the Stripe
 * subscription is the only thing trusted to determine what plan a webhook
 * event grants. Returns null for an unrecognized price (fails closed;
 * callers must not guess a plan for a price they don't recognize).
 */
export function planSlugForStripePrice(priceId: string | null | undefined): CheckoutablePlan | null {
  if (!priceId) return null;
  for (const plan of Object.keys(PRICE_ENV) as CheckoutablePlan[]) {
    if (PRICE_ENV[plan] && PRICE_ENV[plan] === priceId) return plan;
  }
  return null;
}
