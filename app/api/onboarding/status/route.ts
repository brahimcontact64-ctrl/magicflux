import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { shouldUserOnboard } from '@/lib/onboarding';

export const dynamic = 'force-dynamic';

/**
 * GET /api/onboarding/status
 *
 * Server-authoritative "should this user see onboarding" check (Phase 9.2).
 * Auth-scoped to the requester only — never accepts a userId from the
 * client, so there is no way to query another user's onboarding state.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  const [profileRes, workflowCountRes] = await Promise.all([
    db.from('user_profiles').select('onboarding_complete, created_at').eq('id', user.id).maybeSingle(),
    db.from('workflows').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
  ]);

  const shouldOnboard = shouldUserOnboard(
    profileRes.data ?? null,
    (workflowCountRes.count ?? 0) > 0,
  );

  return NextResponse.json({ shouldOnboard });
}
