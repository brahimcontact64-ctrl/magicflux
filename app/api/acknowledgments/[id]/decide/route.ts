import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { attemptAcknowledgmentResume } from '@/lib/runtime/acknowledgment-resume';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

/**
 * POST /api/acknowledgments/[id]/decide
 *
 * The AUTHENTICATED dashboard "Acknowledge" action (Part D/L) -- the
 * counterpart to app/api/acknowledgments/[id]/ack/route.ts's
 * unauthenticated, token-based link (meant for a notification a human may
 * not be logged in when they see). Mirrors app/api/reviews/[id]/decide's
 * exact authorization/CAS/crash-safety shape (Phase 9.9.2A) -- OWNER-ONLY,
 * every query scoped to `id` AND `user_id` in the same request, a row
 * owned by a different user 404s, never leaking existence (Part J: "tenant
 * A cannot acknowledge tenant B's item", "workflow/execution IDs alone are
 * insufficient authorization" -- here, the SESSION is the authorization;
 * the token route below relies on the token instead, never on the row id
 * alone).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  const { data: item, error: lookupError } = await db
    .from('workflow_acknowledgments')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (lookupError) {
    const safe = classifyError(lookupError);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }
  if (!item) return NextResponse.json({ error: 'Acknowledgment item not found' }, { status: 404 });

  if (item.status === 'acknowledged') {
    // Idempotent replay (Part J) -- the SAME outcome as before, never an error.
    const outcome = await attemptAcknowledgmentResume({ ...item, mode: (item.mode ?? 'live') as 'test' | 'live' });
    return NextResponse.json({ ok: true, alreadyAcknowledged: true, resumed: outcome.resumed });
  }

  if (item.status === 'timed_out') {
    // Part H -- late acknowledgment: the SLA already breached and
    // escalation already won. Never rewind `status` back to
    // 'acknowledged' -- record the late acknowledgment separately,
    // preserving the historical fact that the breach occurred.
    const nowIso = new Date().toISOString();
    const { data: lateUpdated } = await db
      .from('workflow_acknowledgments')
      .update({ late_acknowledged_by: user.id, late_acknowledged_at: nowIso, updated_at: nowIso })
      .eq('id', params.id)
      .eq('user_id', user.id)
      .eq('status', 'timed_out')
      .is('late_acknowledged_at', null)
      .select('id')
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      lateAcknowledgment: true,
      alreadyBreached: true,
      recordedNow: Boolean(lateUpdated),
      message: 'This item already breached its SLA and was escalated. Your acknowledgment has been recorded, but the breach remains on record.',
    });
  }

  const nowIso = new Date().toISOString();

  // Compare-and-swap: only succeeds if this is still genuinely pending.
  const { data: updated, error: updateError } = await db
    .from('workflow_acknowledgments')
    .update({ status: 'acknowledged', acknowledged_by: user.id, acknowledged_at: nowIso, updated_at: nowIso })
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
    // Lost a race with a concurrent decide/timeout (Part E) -- re-read the
    // now-authoritative state rather than assuming which side won.
    const { data: latest } = await db
      .from('workflow_acknowledgments')
      .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!latest) return NextResponse.json({ error: 'Acknowledgment item not found' }, { status: 404 });

    if (latest.status === 'timed_out') {
      const lateNowIso = new Date().toISOString();
      await db
        .from('workflow_acknowledgments')
        .update({ late_acknowledged_by: user.id, late_acknowledged_at: lateNowIso, updated_at: lateNowIso })
        .eq('id', params.id)
        .eq('status', 'timed_out')
        .is('late_acknowledged_at', null);
      return NextResponse.json({
        ok: true,
        lateAcknowledgment: true,
        alreadyBreached: true,
        message: 'The SLA timed out at essentially the same instant. Your acknowledgment has been recorded, but the breach remains on record.',
      });
    }

    const outcome = await attemptAcknowledgmentResume({ ...latest, mode: (latest.mode ?? 'live') as 'test' | 'live' });
    return NextResponse.json({ ok: true, alreadyAcknowledged: true, resumed: outcome.resumed });
  }

  const outcome = await attemptAcknowledgmentResume({
    id: item.id,
    user_id: item.user_id,
    workflow_id: item.workflow_id,
    execution_id: item.execution_id,
    node_id: item.node_id,
    node_name: item.node_name,
    deployment_version_id: item.deployment_version_id,
    mode: (item.mode ?? 'live') as 'test' | 'live',
    resume_attempts: item.resume_attempts,
  });

  return NextResponse.json({
    ok: true,
    resumed: outcome.resumed,
    warning: outcome.resumed ? undefined : `Acknowledgment recorded; resume retry failed: ${outcome.resumed === false ? outcome.error : ''}`,
  });
}
