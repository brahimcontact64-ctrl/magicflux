import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest, isAdminUser } from '@/lib/supabase-server';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  // Phase 9.3.1 P0 fix — this route was previously reachable and fully
  // functional for ANY authenticated user, not just admins. It is only
  // ever surfaced through /admin, which middleware.ts gates on admin
  // status — but page-level gating in the browser is not a substitute for
  // server-side authorization on the API route itself, and this route had
  // none.
  //
  // Phase 9.6 P0 fix — the admin check added above had its own bug: it
  // duplicated (a third time, alongside isAdminUser() and middleware.ts)
  // an inline check that also trusted user_metadata.role and
  // user_profiles.role, both of which turned out to be self-escalatable
  // or non-functional (see isAdminUser()'s own fix notes). Confirmed
  // live-exploitable against a disposable test account: any signed-up
  // user could self-grant a real, persisted `subscriptions` row with
  // status:'active', plan:'pro' by first setting their own
  // user_metadata.role to 'admin' via the standard, unrestricted
  // PUT /auth/v1/user endpoint. Now calls the single, fixed,
  // app_metadata-only isAdminUser() instead of a third copy of the same
  // logic that could drift out of sync again.
  const isAdmin = await isAdminUser(user.id);
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
