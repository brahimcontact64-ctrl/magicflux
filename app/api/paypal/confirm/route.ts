import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient, upgradePlan } from '@/lib/supabase-server';

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

  const body = await req.json().catch(() => ({})) as { orderId?: string };
  const { orderId } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.length > 50) {
    return NextResponse.json({ error: 'Invalid order ID.' }, { status: 400 });
  }

  const db = createServiceClient();

  try {
    // 1. Verify order belongs to this user in our DB
    const { data: rec } = await db
      .from('paypal_orders')
      .select('id, status, plan_granted, user_id')
      .eq('paypal_order_id', orderId)
      .eq('user_id', authUser.id)
      .maybeSingle();

    if (!rec) {
      return NextResponse.json(
        { error: 'Order not found or does not belong to your account.' },
        { status: 404 }
      );
    }

    // Idempotent — already processed
    if (rec.status === 'completed') {
      await upgradePlan(authUser.id, rec.plan_granted);
      return NextResponse.json({ success: true, plan: rec.plan_granted, alreadyProcessed: true });
    }

    // 2. Capture payment server-side
    const token = await getAccessToken();
    const captureRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (!captureRes.ok) {
      console.error('[PayPal confirm] capture failed', captureRes.status);
      return NextResponse.json(
        { error: 'Payment capture failed. Contact support if money was deducted.' },
        { status: 502 }
      );
    }

    const capture = await captureRes.json() as {
      status: string;
      purchase_units?: Array<{ payments?: { captures?: Array<{ status: string }> } }>;
    };

    const captureStatus = capture.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (capture.status !== 'COMPLETED' || captureStatus !== 'COMPLETED') {
      return NextResponse.json({ error: 'Payment was not completed.' }, { status: 402 });
    }

    // 3. Upgrade plan
    await upgradePlan(authUser.id, rec.plan_granted);

    // 4. Mark order complete
    await db
      .from('paypal_orders')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', rec.id);

    return NextResponse.json({ success: true, plan: rec.plan_granted });
  } catch {
    return NextResponse.json(
      { error: 'An error occurred while confirming your payment. Contact support.' },
      { status: 500 }
    );
  }
}
