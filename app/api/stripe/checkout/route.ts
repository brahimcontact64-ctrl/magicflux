import { NextRequest, NextResponse } from 'next/server';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

const PRICE_MAP: Record<string, { amount: number; label: string }> = {
  managed_setup: { amount: 9700, label: 'Managed Automation Setup' },
  custom_modification: { amount: 4700, label: 'Custom Workflow Modification' },
  monthly_support: { amount: 2900, label: 'Monthly Automation Support' },
  additional_automation: { amount: 7900, label: 'Additional Managed Automation' },
};

export async function POST(req: NextRequest) {
  if (!STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: 'Stripe is not configured. Please add STRIPE_SECRET_KEY.' },
      { status: 503 }
    );
  }

  try {
    const body = await req.json();
    const { priceKey, templateName, contactEmail, requestId } = body;

    const priceInfo = PRICE_MAP[priceKey] ?? PRICE_MAP.managed_setup;

    const params = new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': priceInfo.label,
      'line_items[0][price_data][product_data][description]': templateName
        ? `Automation: ${templateName}`
        : 'MagicFlux Managed Service',
      'line_items[0][price_data][unit_amount]': String(priceInfo.amount),
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: `${SITE_URL}/?payment=success&request=${requestId ?? ''}`,
      cancel_url: `${SITE_URL}/?payment=cancelled`,
      ...(contactEmail ? { customer_email: contactEmail } : {}),
      'metadata[request_id]': requestId ?? '',
      'metadata[price_key]': priceKey,
    });

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: session.error?.message ?? 'Stripe error' }, { status: 400 });
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
