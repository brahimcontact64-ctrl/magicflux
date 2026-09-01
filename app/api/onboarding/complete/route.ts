import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/onboarding/complete
 *
 * Marks the authenticated user's onboarding as complete — used by both the
 * "finish" and "skip" actions (Phase 9.2 Step D: skipping must not leave
 * the user seeing onboarding again). Scoped exclusively to the caller's own
 * verified id from getUserFromRequest() — the request body is never trusted
 * for identity, so there is no way to complete another user's onboarding by
 * supplying a different id.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  // Update-first: every current account already has a user_profiles row
  // (created at signup), so this is the normal path. The upsert fallback
  // below only matters for a future edge case where the row is missing —
  // it mirrors signup's own insert shape (plan: 'free') so it can never
  // violate a not-null constraint that column already satisfies elsewhere.
  const { data: updated, error: updateError } = await db
    .from('user_profiles')
    .update({ onboarding_complete: true, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('id')
    .maybeSingle();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  if (!updated) {
    const { error: insertError } = await db
      .from('user_profiles')
      .upsert(
        { id: user.id, plan: 'free', onboarding_complete: true, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      );
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
