import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getStripeClient } from '@/lib/billing/stripe-client';
import { isCheckoutablePlan, stripePriceIdForPlan } from '@/lib/billing/stripe-plans';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

/**
 * POST /api/billing/checkout
 *
 * Phase 9.3.2 Step C — the canonical Free -> Pro/Business subscription
 * checkout endpoint. Replaces the old builder-page PayPal CTA (which
 * called /api/paypal/create-order, a one-time payment, and is not the V1
 * provider).
 *
 * Body: { plan: 'pro' | 'business' }
 *
 * The client sends only a plan SLUG. The Stripe price actually charged is
 * resolved exclusively from server env config (lib/billing/stripe-plans.ts)
 * -- there is no field on this request that can influence amount, price
 * ID, or currency. No entitlement is granted here or by the success
 * redirect; only the signed webhook (app/api/billing/webhook/route.ts)
 * ever writes to `subscriptions`.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: 'Checkout is not configured yet. Please try again later.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const planSlug = String(body?.plan ?? '').toLowerCase().trim();

  if (!isCheckoutablePlan(planSlug)) {
    return NextResponse.json({ error: 'Unsupported plan. Choose "pro" or "business".' }, { status: 400 });
  }

  const priceId = stripePriceIdForPlan(planSlug);
  if (!priceId) {
    return NextResponse.json({ error: `Checkout for the ${planSlug} plan is not configured yet.` }, { status: 503 });
  }

  const db = createServiceClient();
  const { data: existingSub } = await db
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const existingCustomerId = (existingSub as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Reuse the existing Stripe Customer for this user when we already
      // have one on file (from a prior checkout/subscription), so a
      // returning customer doesn't accumulate duplicate Customer objects.
      ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: user.email }),
      client_reference_id: user.id,
      metadata: { user_id: user.id, plan: planSlug },
      // Stamped onto the resulting Subscription object itself, so every
      // subsequent customer.subscription.*/invoice.* webhook event about
      // this subscription carries the user_id directly -- no reliance on
      // a stripe_customer_id -> user_id lookup that could race with
      // out-of-order event delivery.
      subscription_data: { metadata: { user_id: user.id, plan: planSlug } },
      success_url: `${SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}&plan=${planSlug}`,
      cancel_url: `${SITE_URL}/pricing?checkout=cancelled`,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Could not start checkout' }, { status: 502 });
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('[billing:checkout] Stripe error', err);
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 502 });
  }
}
