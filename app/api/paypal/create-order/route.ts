import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';

const AMOUNT = '29.00';
const CURRENCY = 'USD';
const DESCRIPTION = 'MagicFlux Pro Access';

function paypalBase() {
  return process.env.PAYPAL_SANDBOX === 'true'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function getAccessToken(): Promise<string> {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal token fetch failed.');
  const d = await res.json() as { access_token: string };
  return d.access_token;
}

export async function POST(req: NextRequest) {
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return NextResponse.json({ error: 'Payment system not configured.' }, { status: 503 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

  try {
    const token = await getAccessToken();
    const orderRes = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: CURRENCY, value: AMOUNT },
          description: DESCRIPTION,
          custom_id: authUser.id,
        }],
        application_context: {
          return_url: `${siteUrl}/payment/success`,
          cancel_url: `${siteUrl}/builder?payment=cancelled`,
          brand_name: 'MagicFlux',
          user_action: 'PAY_NOW',
        },
      }),
    });

    if (!orderRes.ok) {
      return NextResponse.json({ error: 'Failed to create PayPal order.' }, { status: 500 });
    }

    const order = await orderRes.json() as {
      id: string;
      links: Array<{ rel: string; href: string }>;
    };

    // Persist order before redirecting — server-side audit trail
    const db = createServiceClient();
    await db.from('paypal_orders').insert({
      user_id: authUser.id,
      paypal_order_id: order.id,
      amount_cents: 2900,
      currency: CURRENCY,
      status: 'created',
      plan_granted: 'pro',
    });

    const approvalLink = order.links.find(l => l.rel === 'approve');
    if (!approvalLink) {
      return NextResponse.json({ error: 'PayPal did not return an approval URL.' }, { status: 500 });
    }

    return NextResponse.json({ approvalUrl: approvalLink.href, orderId: order.id });
  } catch {
    return NextResponse.json({ error: 'Payment initiation failed. Please try again.' }, { status: 500 });
  }
}
