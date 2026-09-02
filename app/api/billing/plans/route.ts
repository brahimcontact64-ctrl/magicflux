import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';
import { getStripeClient } from '@/lib/billing/stripe-client';
import { stripePriceIdForPlan } from '@/lib/billing/stripe-plans';

export async function GET() {
  const db = createServiceClient();

  const { data, error } = await db
    .from('plans')
    .select('slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled')
    .order('price_monthly', { ascending: true });

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  // Phase 9.5 Step C/D: lets every CTA know, from a request it already
  // makes, whether checkout can succeed BEFORE attempting one -- Stripe
  // being unconfigured is a known, standing state today, not a transient
  // outage, so the honest UI decision belongs before the network call,
  // not in a toast after a 503. Never exposes the key/price ID values
  // themselves, only whether they're present.
  const checkoutAvailable = Boolean(
    getStripeClient() && stripePriceIdForPlan('pro') && stripePriceIdForPlan('business'),
  );

  return NextResponse.json({ plans: data ?? [], checkoutAvailable });
}
