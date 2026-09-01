import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getStripeClient } from '@/lib/billing/stripe-client';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

/**
 * POST /api/billing/portal
 *
 * Phase 9.3.2 Step J — Stripe Customer Portal for self-service payment
 * method changes, cancellation, and invoice history. Secondary to
 * checkout/webhook/entitlement; deliberately minimal (no configurable
 * return behavior, no plan-switching UI beyond what Stripe's own portal
 * provides by default).
 *
 * Requires the caller to already have a Stripe customer on file (i.e. to
 * have completed checkout at least once) -- there is nothing to manage
 * otherwise.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: 'Billing portal is not configured yet.' }, { status: 503 });
  }

  const db = createServiceClient();
  const { data: sub } = await db
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const customerId = (sub as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
  if (!customerId) {
    return NextResponse.json({ error: 'No billing account found yet.' }, { status: 404 });
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${SITE_URL}/pricing`,
    });
    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    console.error('[billing:portal] Stripe error', err);
    return NextResponse.json({ error: 'Could not open billing portal' }, { status: 502 });
  }
}
