import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { getCostSummary, getTopCostlyWorkflows } from '@/lib/runtime/cost-engine';

// GET — cost analytics summary and top costly workflows.
//
// Query params:
//   ?window=<days>   — look-back window in days (1–365), default 30
//   ?top=<n>         — number of top workflows to return, default 10
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const scopedUserId = isAdmin ? undefined : user.id;

  const sp         = req.nextUrl.searchParams;
  const windowDays = parseInt(sp.get('window') ?? '30', 10);
  const safeDays   = Math.min(365, Math.max(1, isNaN(windowDays) ? 30 : windowDays));
  const topN       = parseInt(sp.get('top') ?? '10', 10);
  const safeTop    = Math.min(50, Math.max(1, isNaN(topN) ? 10 : topN));

  const [summary, topWorkflows] = await Promise.all([
    getCostSummary(safeDays, scopedUserId),
    getTopCostlyWorkflows(safeTop, scopedUserId),
  ]);

  return NextResponse.json({
    summary,
    topWorkflows,
    generatedAt: new Date().toISOString(),
  });
}
