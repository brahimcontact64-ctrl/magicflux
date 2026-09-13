import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { ExecutionManager } from '@/runtime/execution-manager';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

/**
 * POST /api/reviews/[id]/decide
 * Body: { decision: string }  -- one of the review item's own allowed_outcomes
 *
 * Owner/admin-only (no public unauthenticated approval URLs -- this route
 * requires the same session auth as every other authenticated API route in
 * this app, never a bearer token embedded in a link). Idempotent: a
 * compare-and-swap UPDATE ... WHERE status = 'pending' means only the FIRST
 * decide request for a given review item ever transitions it and resumes
 * the execution; every later request (a duplicate, a race, a retried
 * network call) finds zero rows to update and returns an "already decided"
 * response without touching the execution again -- this is what makes
 * "execution resumes exactly once" true, not a separate lock.
 *
 * Cross-tenant isolation: the review item is fetched scoped to
 * `id` AND `user_id = the authenticated caller's id` in the SAME query --
 * a row owned by a different user comes back as not-found (404), never
 * leaking whether it exists.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { decision?: unknown };
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
  if (!decision) return NextResponse.json({ error: 'decision is required' }, { status: 400 });

  const db = createServiceClient();

  const { data: item, error: lookupError } = await db
    .from('workflow_review_items')
    .select('id, user_id, workflow_id, execution_id, deployment_version_id, status, allowed_outcomes, mode')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (lookupError) {
    const safe = classifyError(lookupError);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }
  if (!item) return NextResponse.json({ error: 'Review item not found' }, { status: 404 });

  const allowedOutcomes = Array.isArray(item.allowed_outcomes) && item.allowed_outcomes.length > 0
    ? (item.allowed_outcomes as string[])
    : ['approve', 'reject'];

  if (!allowedOutcomes.includes(decision)) {
    return NextResponse.json({ error: `decision must be one of: ${allowedOutcomes.join(', ')}` }, { status: 400 });
  }

  const statusForOutcome = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'decided';
  const nowIso = new Date().toISOString();

  // Compare-and-swap: only succeeds if this is still the FIRST decision.
  const { data: updated, error: updateError } = await db
    .from('workflow_review_items')
    .update({
      status: statusForOutcome,
      decision_outcome: decision,
      reviewed_by: user.id,
      reviewed_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', params.id)
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (updateError) {
    const safe = classifyError(updateError);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }

  if (!updated) {
    // Already decided (by an earlier request, or a concurrent duplicate) --
    // idempotent no-op, not an error.
    return NextResponse.json({ ok: true, alreadyDecided: true });
  }

  // Resolve the frozen workflow_json snapshot this execution actually
  // started with -- exactly like scheduler.ts / execution-dispatch.ts /
  // the manual resume route already do -- never whatever is live now.
  const { data: workflow } = await db
    .from('workflows')
    .select('id, workflow_json')
    .eq('id', item.workflow_id)
    .eq('user_id', user.id)
    .maybeSingle();

  let workflowJson: unknown = workflow?.workflow_json;
  if (item.deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', item.deployment_version_id)
      .maybeSingle();
    if (version?.workflow_data) workflowJson = version.workflow_data;
  }

  if (!workflowJson) {
    return NextResponse.json({ ok: true, resumed: false, decision, warning: 'Decision recorded, but the workflow could not be found to resume.' });
  }

  const executionManager = new ExecutionManager();
  try {
    await executionManager.resumeExecution({
      executionId: item.execution_id,
      userId: user.id,
      workflowJson,
      workflowId: item.workflow_id,
      mode: (item.mode ?? 'live') as 'test' | 'live',
      inputData: {},
    });
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ ok: true, resumed: false, decision, warning: `Decision recorded, but resuming failed: ${safe.message}` });
  }

  return NextResponse.json({ ok: true, resumed: true, decision });
}
