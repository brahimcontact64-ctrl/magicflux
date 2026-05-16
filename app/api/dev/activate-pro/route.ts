/**
 * DEV ONLY — Activate Pro subscription for the current user without payment.
 *
 * ⚠️  REMOVE BEFORE PRODUCTION  ⚠️
 *
 * Only active when:
 *   NODE_ENV !== "production"
 *   OR ENABLE_DEV_PRO_BUTTON === "true"
 */

import { NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient, upgradePlan } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const isDevAllowed =
    process.env.NODE_ENV !== 'production' ||
    process.env.ENABLE_DEV_PRO_BUTTON === 'true';

  if (!isDevAllowed) {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }

  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await upgradePlan(user.id, 'pro');

  return NextResponse.json({ ok: true, message: 'Pro activated for testing' });
}
