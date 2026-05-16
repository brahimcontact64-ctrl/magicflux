/**
 * GET /api/billing/usage
 * Returns current usage metrics for the authenticated user
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import {
  getUsageMetrics,
  getPlanLimits,
} from '@/lib/billing/plan-limits';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [usage, plan] = await Promise.all([
    getUsageMetrics(user.id),
    getPlanLimits(user.id),
  ]);

  return NextResponse.json({
    plan_name: plan.name,
    connected_integrations: usage.connected_integrations,
    integrations_limit: plan.integrations_limit,
    workflows: usage.workflows,
    workflows_limit: plan.workflows_limit,
    executions_this_month: usage.executions_this_month,
    executions_limit: plan.executions_limit,
    deploy_enabled: plan.deploy_enabled,
  });
}
