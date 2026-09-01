import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  // Phase 9.3.1 P0 fix — this route was previously reachable and fully
  // functional for ANY authenticated user, not just admins. It is only
  // ever surfaced through /admin, which middleware.ts gates on
  // app_metadata/user_metadata role or user_profiles.role === 'admin' —
  // but page-level gating in the browser is not a substitute for
  // server-side authorization on the API route itself, and this route had
  // none. Confirmed live-exploitable in production against a disposable
  // test account before this fix (any signed-up user could self-grant a
  // real, persisted `subscriptions` row with status:'active', plan:'pro').
  // This check mirrors middleware.ts's own admin determination exactly.
  const { data: adminLookup } = await db.auth.admin.getUserById(user.id);
  const appRole = adminLookup?.user?.app_metadata?.role;
  const userRole = adminLookup?.user?.user_metadata?.role;
  let isAdmin = appRole === 'admin' || userRole === 'admin';
  if (!isAdmin) {
    const { data: profile } = await db.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
    isAdmin = profile?.role === 'admin';
  }
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
