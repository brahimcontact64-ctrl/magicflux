import 'server-only';
import Stripe from 'stripe';

/**
 * Phase 9.3.2 — lazy Stripe client singleton.
 *
 * Returns null (never throws) when STRIPE_SECRET_KEY is unset, so every
 * caller fails closed with an honest 503 rather than crashing the route.
 * Mirrors the existing app/api/stripe/checkout/route.ts's own
 * "unconfigured -> 503" convention.
 */
let cached: Stripe | null | undefined;

export function getStripeClient(): Stripe | null {
  if (cached !== undefined) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    cached = null;
    return null;
  }

  cached = new Stripe(secretKey, {
    typescript: true,
  });
  return cached;
}
