import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { attemptReviewResume } from '@/lib/runtime/review-resume';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

/**
 * POST /api/reviews/[id]/decide
 * Body: { decision: string }  -- one of the review item's own allowed_outcomes
 *
 * Authorization truth (Phase 9.9.2A): this is OWNER-ONLY. Every query is
 * scoped to `id` AND `user_id = the authenticated caller's own id` in the
 * same request -- there is no cross-tenant admin/founder path here. A row
 * owned by a different user 404s, never leaking existence. If a founder/
 * admin cross-tenant review surface is wanted later, it needs its own
 * explicit, separately-tested authorization check (e.g. an admin-role
 * lookup) -- it does not exist today and must not be implied by this
 * route's naming.
 *
 * No public unauthenticated approval URLs -- this route requires the same
 * session auth as every other authenticated API route in this app, never
 * a bearer token embedded in a link.
 *
 * Crash-safe lifecycle (see lib/runtime/review-resume.ts): pending's
 * compare-and-swap transition to resume_pending durably records the
 * decision atomically with reviewer/timestamp; ONLY THEN is resume
 * attempted. A request against an item already at resume_pending (a
 * duplicate submit, a retried request after a network failure, or the
 * founder reloading and clicking again) does not re-accept a new decision
 * -- it drives the SAME recovery path (attemptReviewResume) using the
 * decision already recorded, which itself refuses to call
 * resumeExecution() again if the execution has already moved past this
 * node (see that module for the duplicate-side-effect safety check).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { decision?: unknown };
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';

  const db = createServiceClient();

  const { data: item, error: lookupError } = await db
    .from('workflow_review_items')
    .select('id, user_id, workflow_id, execution_id, node_id, deployment_version_id, status, allowed_outcomes, mode, resume_attempts')
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

  // Already decided (resume_pending: decision recorded, resume not yet
  // confirmed -- possibly crashed mid-flight; resumed: fully done). A new
  // decision value in the request body is IGNORED past this point -- the
  // first decision is final; this call only drives recovery forward using
  // whatever was already recorded.
  if (item.status !== 'pending') {
    const outcome = await attemptReviewResume({
      id: item.id,
      user_id: item.user_id,
      workflow_id: item.workflow_id,
      execution_id: item.execution_id,
      node_id: item.node_id,
      deployment_version_id: item.deployment_version_id,
      mode: (item.mode ?? 'live') as 'test' | 'live',
      resume_attempts: item.resume_attempts,
    });
    return NextResponse.json({
      ok: true,
      alreadyDecided: true,
      resumed: outcome.resumed,
      warning: outcome.resumed ? undefined : `Decision already recorded; resume retry failed: ${outcome.error}`,
    });
  }

  if (!decision) return NextResponse.json({ error: 'decision is required' }, { status: 400 });
  if (!allowedOutcomes.includes(decision)) {
    return NextResponse.json({ error: `decision must be one of: ${allowedOutcomes.join(', ')}` }, { status: 400 });
  }

  const nowIso = new Date().toISOString();

  // Compare-and-swap: only succeeds if this is still the FIRST decision.
  // Decision + reviewer + timestamp are set atomically with the lifecycle
  // transition -- a 'pending' row never carries partial decision metadata
  // (also enforced by the migration's CHECK constraint).
  const { data: updated, error: updateError } = await db
    .from('workflow_review_items')
    .update({
      status: 'resume_pending',
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
    // Lost a race with a concurrent decide request -- treat exactly like
    // the already-decided path above rather than erroring.
    const { data: latest } = await db
      .from('workflow_review_items')
      .select('id, user_id, workflow_id, execution_id, node_id, deployment_version_id, mode, resume_attempts')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!latest) return NextResponse.json({ error: 'Review item not found' }, { status: 404 });
    const outcome = await attemptReviewResume({ ...latest, mode: (latest.mode ?? 'live') as 'test' | 'live' });
    return NextResponse.json({ ok: true, alreadyDecided: true, resumed: outcome.resumed });
  }

  const outcome = await attemptReviewResume({
    id: item.id,
    user_id: item.user_id,
    workflow_id: item.workflow_id,
    execution_id: item.execution_id,
    node_id: item.node_id,
    deployment_version_id: item.deployment_version_id,
    mode: (item.mode ?? 'live') as 'test' | 'live',
    resume_attempts: item.resume_attempts,
  });

  if (!outcome.resumed) {
    // Decision IS durably persisted (the CAS above already committed) --
    // only the resume attempt failed. The cron sweep (or a later retry of
    // this same endpoint) will recover it; report that honestly rather
    // than implying the decision itself failed.
    return NextResponse.json({
      ok: true,
      decision,
      resumed: false,
      warning: `Decision recorded, but resuming failed and will be retried: ${outcome.error}`,
    });
  }

  return NextResponse.json({ ok: true, resumed: true, decision });
}
