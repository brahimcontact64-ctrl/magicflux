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
    // Phase 9.9.20 -- plan_slug is the real, un-expanded paid-tier identity
    // ('free'/'pro'/'business'), distinct from plan_name (which becomes
    // "Free (Beta)" etc. under applyBetaExpansion()). Clients need the slug
    // for the honest "did you actually pay" cosmetic badge, and deploy_enabled
    // (already returned below) for the real, Beta-aware capability check --
    // never derive capability from the slug.
    plan_slug: plan.slug,
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
