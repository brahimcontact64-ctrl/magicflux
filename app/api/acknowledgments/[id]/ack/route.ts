import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { attemptAcknowledgmentResume } from '@/lib/runtime/acknowledgment-resume';

type Ctx = { params: { id: string } };

/**
 * GET /api/acknowledgments/[id]/ack?token=...
 *
 * The UNAUTHENTICATED, token-based acknowledgment link (Part D) -- meant
 * to be clicked directly from a reminder/escalation notification without
 * requiring a dashboard session. Authorization here is ENTIRELY the
 * token's own unguessability (Part J: "workflow/execution IDs alone are
 * insufficient authorization" -- knowing this row's `id` from the URL path
 * proves nothing on its own; only a correct token does).
 *
 * Security:
 *   - The token is never stored in plaintext (wait-for-acknowledgment.ts
 *     only ever persists its SHA-256 hash) -- compared here by hashing the
 *     supplied value and comparing digests in constant time
 *     (timingSafeEqual), never a plain `===` string compare, to avoid a
 *     timing side-channel on the hash bytes.
 *   - A missing/malformed/wrong-length/incorrect token, or a row with no
 *     token configured at all, fails closed with the exact same 404 a
 *     nonexistent row would produce -- never distinguishes "row exists but
 *     wrong token" from "row doesn't exist" (no existence leak).
 *   - A replayed (already-used) token is idempotent, never an error (Part
 *     J) -- re-clicking an already-acknowledged link just confirms it.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const token = req.nextUrl.searchParams.get('token')?.trim();
  if (!token) return NextResponse.json({ error: 'Missing or invalid acknowledgment link.' }, { status: 404 });

  const db = createServiceClient();

  const { data: item } = await db
    .from('workflow_acknowledgments')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts, acknowledgment_token_hash')
    .eq('id', params.id)
    .maybeSingle();

  if (!item || !item.acknowledgment_token_hash) {
    return NextResponse.json({ error: 'Missing or invalid acknowledgment link.' }, { status: 404 });
  }

  const suppliedHash = createHash('sha256').update(token).digest();
  const storedHash = Buffer.from(String(item.acknowledgment_token_hash), 'hex');
  const validToken = suppliedHash.length === storedHash.length && timingSafeEqual(suppliedHash, storedHash);

  if (!validToken) {
    return NextResponse.json({ error: 'Missing or invalid acknowledgment link.' }, { status: 404 });
  }

  if (item.status === 'acknowledged') {
    const outcome = await attemptAcknowledgmentResume({ ...item, mode: (item.mode ?? 'live') as 'test' | 'live' });
    return NextResponse.json({ ok: true, alreadyAcknowledged: true, resumed: outcome.resumed });
  }

  if (item.status === 'timed_out') {
    // Part H -- late acknowledgment via the link. Never rewinds `status`.
    const nowIso = new Date().toISOString();
    const { data: lateUpdated } = await db
      .from('workflow_acknowledgments')
      .update({ late_acknowledged_by: item.user_id, late_acknowledged_at: nowIso, updated_at: nowIso })
      .eq('id', params.id)
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

  // The token is scoped to exactly this row's own tenant (item.user_id) --
  // a valid token can never acknowledge on behalf of a different tenant,
  // since it only ever validates against THIS row's own stored hash.
  const { data: updated, error: updateError } = await db
    .from('workflow_acknowledgments')
    .update({ status: 'acknowledged', acknowledged_by: item.user_id, acknowledged_at: nowIso, updated_at: nowIso })
    .eq('id', params.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to record acknowledgment.' }, { status: 500 });
  }

  if (!updated) {
    // Lost a race with a concurrent timeout/decide (Part E).
    const { data: latest } = await db
      .from('workflow_acknowledgments')
      .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts')
      .eq('id', params.id)
      .maybeSingle();
    if (!latest) return NextResponse.json({ error: 'Missing or invalid acknowledgment link.' }, { status: 404 });

    if (latest.status === 'timed_out') {
      const lateNowIso = new Date().toISOString();
      await db
        .from('workflow_acknowledgments')
        .update({ late_acknowledged_by: latest.user_id, late_acknowledged_at: lateNowIso, updated_at: lateNowIso })
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

  return NextResponse.json({ ok: true, acknowledged: true, resumed: outcome.resumed });
}
