import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, isAdminUser } from '@/lib/supabase-server';
import { getBetaFunnelMetrics } from '@/lib/analytics/beta-metrics';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/admin/beta-metrics
 *
 * Phase 9.6 Section 4 — admin-only aggregate Beta funnel metrics. Every
 * number is a COUNT/average over existing tables (see
 * lib/analytics/beta-metrics.ts for exact definitions); no user secrets,
 * workflow_json payloads, prompts, or credentials are ever read here.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await isAdminUser(user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const metrics = await getBetaFunnelMetrics();
    return NextResponse.json({ success: true, metrics });
  } catch (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }
}
