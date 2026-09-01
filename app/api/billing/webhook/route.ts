import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripeClient } from '@/lib/billing/stripe-client';
import { createServiceClient } from '@/lib/supabase-server';
import { applyStripeSubscription } from '@/lib/billing/apply-stripe-subscription';

// Raw-body signature verification requires the framework not to parse the
// body first.
export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/webhook
 *
 * Phase 9.3.2 Step D/E/F — the only path that ever grants or revokes paid
 * entitlement. Never trust anything the client returns from a checkout
 * redirect; only a signature-verified event landing here writes to
 * `subscriptions`.
 *
 * Idempotency (Step F): `stripe_webhook_events.event_id` is a claim/lock,
 * not just a log. The event id is inserted BEFORE processing; a unique-
 * constraint conflict means this exact event was already handled (or is
 * concurrently being handled) and this delivery is a safe no-op. If
 * processing then throws, the claim row is deleted before returning 5xx,
 * so Stripe's automatic retry can re-claim and actually apply the event
 * instead of being silently swallowed as "already processed" by a claim
 * that was never followed by a real write.
 */
export async function POST(req: NextRequest) {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    return NextResponse.json({ error: 'Stripe webhook is not configured.' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('[billing:webhook] signature verification failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const db = createServiceClient();

  const { error: claimError } = await db
    .from('stripe_webhook_events')
    .insert({ event_id: event.id, event_type: event.type });

  if (claimError) {
    if (claimError.code === '23505') {
      // Genuine duplicate delivery (or a concurrent delivery already
      // in-flight) -- already handled, or about to be. Acknowledge
      // without reprocessing so Stripe stops retrying.
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('[billing:webhook] failed to claim event id', claimError);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  try {
    await handleEvent(db, stripe, event);
  } catch (err) {
    console.error('[billing:webhook] handler error', event.type, event.id, err);
    // Release the claim so a Stripe retry can actually reprocess this
    // event instead of finding it "already handled" forever.
    await db.from('stripe_webhook_events').delete().eq('event_id', event.id);
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(
  db: ReturnType<typeof createServiceClient>,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // The Managed Setup one-time-payment flow (app/api/stripe/checkout)
      // also produces checkout.session.completed events once it has a
      // webhook of its own; mode discriminates cleanly so this handler
      // never has to guess which product line a session belongs to.
      if (session.mode !== 'subscription') return;

      const userId = session.client_reference_id || (session.metadata?.user_id as string | undefined);
      if (!userId) {
        console.error('[billing:webhook] checkout.session.completed with no user_id', session.id);
        return;
      }

      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (!subscriptionId) return;

      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await applyStripeSubscription(db, { userId, subscription, customerId, eventCreated: event.created });
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      if (!userId) {
        console.error(`[billing:webhook] ${event.type} with no user_id metadata`, subscription.id);
        return;
      }
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;
      await applyStripeSubscription(db, { userId, subscription, customerId, eventCreated: event.created });
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subRef = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subRef === 'string' ? subRef : subRef?.id;
      if (!subscriptionId) return;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const userId = subscription.metadata?.user_id;
      if (!userId) {
        console.error(`[billing:webhook] ${event.type} with no user_id metadata on subscription`, subscriptionId);
        return;
      }
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;
      // Stripe's own subscription.status already reflects payment_failed
      // (-> past_due/unpaid) or a successful renewal (-> active); applying
      // the subscription's current state covers both events with the one
      // canonical mapping rather than inventing invoice-specific logic.
      await applyStripeSubscription(db, { userId, subscription, customerId, eventCreated: event.created });
      return;
    }

    default:
      // Unsupported event type -- acknowledged, not processed. Safe no-op;
      // Stripe stops retrying once it sees a 2xx.
      return;
  }
}
