import 'server-only';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase-server';
import { planSlugForStripePrice } from './stripe-plans';

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Phase 9.3.2 Step E — maps a Stripe subscription status onto this app's
 * canonical `subscriptions.status` vocabulary (lib/billing/plan-limits.ts's
 * SubscriptionStatus). Only 'active' is treated as entitling by the
 * canonical resolver. 'trialing' is stored as-is (for observability/future
 * use) but is NOT entitling today -- no trial-granting feature exists
 * anywhere in the product, so treating it as paid access would be an
 * invented behavior ahead of a real feature. Every other Stripe status
 * (canceled, unpaid, incomplete, incomplete_expired, paused) maps to
 * 'canceled', which the resolver already treats as non-entitling.
 */
function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): 'active' | 'trialing' | 'past_due' | 'canceled' {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:
      return 'canceled';
  }
}

export type ApplyResult =
  | { applied: true }
  | { applied: false; reason: 'unrecognized_price' | 'stale_event' };

/**
 * Writes a Stripe subscription's real state into the canonical
 * `subscriptions` row for one user. This is the ONLY function that should
 * ever translate a Stripe object into our entitlement model -- both the
 * checkout.session.completed and customer.subscription.* / invoice.*
 * webhook handlers call through here, so there is one mapping, not
 * several that could drift.
 *
 * Out-of-order protection (Step F): Stripe does not guarantee webhook
 * delivery order. `stripe_synced_at` records the Stripe event `created`
 * timestamp that produced the row's current state; an event older than
 * what's already been applied is a safe no-op rather than a regression.
 *
 * Fails closed (Step B/E): if the subscription's price doesn't map to a
 * known plan (only possible via direct Stripe dashboard/API misuse, since
 * checkout only ever creates the two configured prices), the row is not
 * silently granted an unrecognized entitlement -- plan/plan_id are written
 * as the free defaults and the mismatch is logged.
 */
export async function applyStripeSubscription(
  db: ServiceClient,
  params: { userId: string; subscription: Stripe.Subscription; customerId: string | null; eventCreated: number },
): Promise<ApplyResult> {
  const { userId, subscription, customerId, eventCreated } = params;

  const priceId = subscription.items.data[0]?.price?.id ?? null;
  const planSlug = planSlugForStripePrice(priceId);

  if (priceId && !planSlug) {
    console.error('[billing:applyStripeSubscription] subscription price does not match any configured plan', {
      userId,
      subscriptionId: subscription.id,
      priceId,
    });
  }

  let planId: string | null = null;
  if (planSlug) {
    const { data: planRow } = await db.from('plans').select('id').eq('slug', planSlug).maybeSingle();
    planId = (planRow as { id?: string } | null)?.id ?? null;
  }

  const status = mapStripeStatus(subscription.status);
  const currentPeriodEnd = subscription.items.data[0]?.current_period_end
    ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
    : null;

  const { data: existing } = await db
    .from('subscriptions')
    .select('stripe_synced_at')
    .eq('user_id', userId)
    .maybeSingle();

  const existingSyncedAt = (existing as { stripe_synced_at?: string | null } | null)?.stripe_synced_at;
  if (existingSyncedAt && new Date(existingSyncedAt).getTime() > eventCreated * 1000) {
    return { applied: false, reason: 'stale_event' };
  }

  await db.from('subscriptions').upsert(
    {
      user_id: userId,
      plan: planSlug ?? 'free',
      plan_id: planId,
      status,
      current_period_end: currentPeriodEnd,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      stripe_synced_at: new Date(eventCreated * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  return planSlug ? { applied: true } : { applied: false, reason: 'unrecognized_price' };
}
