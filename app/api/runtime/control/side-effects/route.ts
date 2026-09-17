import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions, requirePermission } from '@/lib/runtime/rbac';
import { recordOperatorVerifiedOutcome } from '@/lib/runtime/side-effect-ledger';
import { recordOperatorAction } from '@/lib/runtime/incident-manager';
import { appendExecutionEvent } from '@/lib/runtime/event-store';

/**
 * Phase 9.9.14 -- Part H/I: the recovery control plane for a genuinely
 * indeterminate external side effect (a provider call whose outcome could
 * not be proven -- see lib/runtime/side-effect-ledger.ts). This is the ONE
 * place an operator can resolve such a row; deliberately NOT a generic
 * "retry" endpoint, and it NEVER calls a provider itself.
 *
 * GET  — lists this user's own indeterminate side effects (admin sees all).
 * POST — { action: 'verify_succeeded' | 'verify_failed', executionId,
 *          nodeId, effectKey?, note } records what the operator has
 *          ALREADY manually confirmed by checking the provider directly.
 *          Every action is written to runtime_operator_actions (actor,
 *          timestamp, action, payload/result) AND runtime_execution_events
 *          (execution-level audit trail) -- the same two mechanisms every
 *          other control-plane action in this codebase already uses; no
 *          new audit table was introduced for this.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const isAdmin = perms.includes('admin_runtime');

  const db = createServiceClient();
  let query = db
    .from('workflow_side_effects')
    .select('id, user_id, workflow_id, execution_id, node_id, effect_key, effect_type, status, attempts, provider_ref, last_error, created_at, updated_at')
    .eq('status', 'indeterminate')
    .order('updated_at', { ascending: true })
    .limit(100);
  if (!isAdmin) query = query.eq('user_id', user.id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load indeterminate side effects' }, { status: 500 });

  return NextResponse.json({ sideEffects: data ?? [], count: (data ?? []).length });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_executions');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const perms = await getUserPermissions(user.id).catch(() => null);
  const isAdmin = perms?.includes('admin_runtime') ?? false;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, executionId, nodeId, effectKey, note } = body as {
    action?: string; executionId?: unknown; nodeId?: unknown; effectKey?: unknown; note?: unknown;
  };

  if (action !== 'verify_succeeded' && action !== 'verify_failed') {
    return NextResponse.json({ error: "action must be 'verify_succeeded' or 'verify_failed'" }, { status: 400 });
  }
  if (typeof executionId !== 'string' || !executionId) {
    return NextResponse.json({ error: 'executionId is required' }, { status: 400 });
  }
  if (typeof nodeId !== 'string' || !nodeId) {
    return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  }
  if (typeof note !== 'string' || !note.trim()) {
    return NextResponse.json({ error: 'note is required -- describe what you confirmed directly with the provider (e.g. "checked Airtable, no duplicate record exists").' }, { status: 400 });
  }

  const db = createServiceClient();

  // Phase 9.9.14 -- tenant isolation: confirm this execution actually
  // belongs to the caller (or the caller is admin) before touching any
  // side-effect row for it -- mirrors every other mutating control-plane
  // route's own ownership check.
  let execQuery = db.from('workflow_executions_v2').select('id, workflow_id, user_id').eq('id', executionId);
  if (!isAdmin) execQuery = execQuery.eq('user_id', user.id);
  const execRow = await execQuery.maybeSingle();
  if (!execRow.data) return NextResponse.json({ error: 'Execution not found' }, { status: 404 });

  const verifiedStatus = action === 'verify_succeeded' ? 'succeeded' : 'failed';
  const result = await recordOperatorVerifiedOutcome({
    executionId,
    nodeId,
    effectKey: typeof effectKey === 'string' && effectKey ? effectKey : undefined,
    verifiedStatus,
    verifiedBy: user.id,
    note: note.trim(),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  const workflowId = String((execRow.data as { workflow_id: unknown }).workflow_id ?? '');

  await Promise.all([
    appendExecutionEvent({
      executionId,
      workflowId,
      userId: user.id,
      eventType: 'side_effect_verified',
      payload: { nodeId, previousStatus: result.previousStatus, verifiedStatus, note: note.trim(), operator_id: user.id },
      metadata: { source: 'operator_control_plane' },
    }),
    recordOperatorAction({
      actionType: `verify_side_effect_${verifiedStatus}`,
      operatorId: user.id,
      executionId,
      workflowId,
      payload: { nodeId, note: note.trim() },
      result: { previousStatus: result.previousStatus, newStatus: verifiedStatus },
    }).catch(() => undefined),
  ]);

  return NextResponse.json({ action, executionId, nodeId, previousStatus: result.previousStatus, newStatus: verifiedStatus });
}
