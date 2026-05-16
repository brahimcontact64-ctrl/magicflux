import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  // Get PRO plan ID
  const { data: proPlan, error: planError } = await db
    .from('plans')
    .select('id')
    .eq('slug', 'pro')
    .maybeSingle();

  if (planError) return NextResponse.json({ error: planError.message }, { status: 500 });
  if (!proPlan) return NextResponse.json({ error: 'Pro plan not found. Run migrations first.' }, { status: 500 });

  // Assign pro plan via subscriptions table
  const { error: upsertError } = await db
    .from('subscriptions')
    .upsert(
      {
        user_id: user.id,
        plan_id: proPlan.id,
        plan: 'pro',
        status: 'active',
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    message: 'Pro plan assigned',
  });
}
