import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import { appendExecutionEvent, saveExecutionSnapshot } from '@/lib/runtime/event-store';
import { appendCommand, getExecutionOwnerUserId } from '@/lib/runtime/command-bus';
import { recordOperatorAction, openIncident } from '@/lib/runtime/incident-manager';

// GET — list executions with optional filters for operator inspection.
//
// Query params:
//   ?status=<s>      — filter by execution status
//   ?workflow_id=<id>
//   ?from=<ISO>      — started_at >= from
//   ?limit=<n>       — default 50, max 200
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const status     = sp.get('status');
  const workflowId = sp.get('workflow_id');
  const from       = sp.get('from');
  const limitRaw   = parseInt(sp.get('limit') ?? '50', 10);
  const limit      = Math.min(200, Math.max(1, isNaN(limitRaw) ? 50 : limitRaw));

  let q = db
    .from('workflow_executions_v2')
    .select(
      'id, workflow_id, user_id, status, started_at, completed_at, ' +
      'retry_count, error_message, created_at'
    )
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (status)     q = q.eq('status', status);
  if (workflowId) q = q.eq('workflow_id', workflowId);
  if (from && !isNaN(new Date(from).getTime())) q = q.gte('started_at', from);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 });

  return NextResponse.json({
    executions:  data ?? [],
    count:       (data ?? []).length,
    generatedAt: new Date().toISOString(),
  });
}

// POST — safe operator actions on executions. All actions append events + commands for full audit.
//
// Body variants:
//   { action: 'pause';          executionId: string; workflowId: string; reason?: string }
//   { action: 'resume';         executionId: string; workflowId: string; reason?: string }
//   { action: 'cancel';         executionId: string; workflowId: string; reason?: string }
//   { action: 'force_snapshot'; executionId: string; workflowId: string; stateSnapshot?: object }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_executions');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, executionId, workflowId } = body as {
    action?: string; executionId?: unknown; workflowId?: unknown;
  };

  if (typeof executionId !== 'string' || !executionId) {
    return NextResponse.json({ error: 'executionId is required' }, { status: 400 });
  }
  if (typeof workflowId !== 'string' || !workflowId) {
    return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });
  }

  const reason = typeof (body as Record<string, unknown>).reason === 'string'
    ? String((body as Record<string, unknown>).reason)
    : `operator_${action}`;

  // Execution ownership check — verify the authenticated user owns this execution.
  // getExecutionOwnerUserId returns null for executions not in workflow_executions_v2
  // (e.g. legacy/system executions). Those are allowed through; the command-bus will
  // apply its own guard when the command is appended.
  const executionOwnerId = await getExecutionOwnerUserId(executionId);
  if (executionOwnerId !== null && executionOwnerId !== user.id) {
    void openIncident({
      incidentType: 'command_dead_letter',
      severity:     'high',
      title:        'Cross-tenant execution command attempt',
      description:  `User ${user.id.slice(0, 8)} attempted ${action} on execution owned by ${executionOwnerId.slice(0, 8)}`,
      executionId,
      workflowId,
      userId:       executionOwnerId,
      details: {
        attacker_user_id:    user.id,
        execution_owner_id:  executionOwnerId,
        action,
      },
    }).catch(() => undefined);
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  if (action === 'pause') {
    // Append event first (audit trail), then dispatch command.
    const [eventResult, commandResult] = await Promise.all([
      appendExecutionEvent({
        executionId,
        workflowId,
        userId:    user.id,
        eventType: 'execution_paused',
        payload:   { reason, operator_id: user.id },
        metadata:  { source: 'operator_control_plane' },
      }),
      appendCommand({
        executionId,
        workflowId,
        userId:      user.id,
        commandType: 'pause_execution',
        payload:     { reason, operator_id: user.id },
        metadata:    { source: 'operator_control_plane' },
      }),
    ]);

    await recordOperatorAction({
      actionType:  'pause_execution',
      operatorId:  user.id,
      executionId,
      workflowId,
      payload:     { reason },
      result:      { eventId: eventResult?.eventId ?? null, commandId: commandResult?.commandId ?? null },
    }).catch(() => undefined);

    return NextResponse.json({ action, executionId, paused: true,
      eventSequence: eventResult?.sequenceNumber ?? null,
      commandSequence: commandResult?.sequenceNumber ?? null,
    });
  }

  if (action === 'resume') {
    const [eventResult, commandResult] = await Promise.all([
      appendExecutionEvent({
        executionId,
        workflowId,
        userId:    user.id,
        eventType: 'execution_resumed',
        payload:   { reason, operator_id: user.id },
        metadata:  { source: 'operator_control_plane' },
      }),
      appendCommand({
        executionId,
        workflowId,
        userId:      user.id,
        commandType: 'resume_execution',
        payload:     { reason, operator_id: user.id },
        metadata:    { source: 'operator_control_plane' },
      }),
    ]);

    await recordOperatorAction({
      actionType:  'resume_execution',
      operatorId:  user.id,
      executionId,
      workflowId,
      payload:     { reason },
      result:      { eventId: eventResult?.eventId ?? null, commandId: commandResult?.commandId ?? null },
    }).catch(() => undefined);

    return NextResponse.json({ action, executionId, resumed: true,
      eventSequence: eventResult?.sequenceNumber ?? null,
      commandSequence: commandResult?.sequenceNumber ?? null,
    });
  }

  if (action === 'cancel') {
    const [eventResult, commandResult] = await Promise.all([
      appendExecutionEvent({
        executionId,
        workflowId,
        userId:    user.id,
        eventType: 'execution_cancelled',
        payload:   { reason, operator_id: user.id },
        metadata:  { source: 'operator_control_plane' },
      }),
      appendCommand({
        executionId,
        workflowId,
        userId:      user.id,
        commandType: 'cancel_execution',
        payload:     { reason, operator_id: user.id },
        metadata:    { source: 'operator_control_plane' },
      }),
    ]);

    await recordOperatorAction({
      actionType:  'cancel_execution',
      operatorId:  user.id,
      executionId,
      workflowId,
      payload:     { reason },
      result:      { eventId: eventResult?.eventId ?? null, commandId: commandResult?.commandId ?? null },
    }).catch(() => undefined);

    return NextResponse.json({ action, executionId, cancelled: true,
      eventSequence: eventResult?.sequenceNumber ?? null,
      commandSequence: commandResult?.sequenceNumber ?? null,
    });
  }

  if (action === 'force_snapshot') {
    const rawState = (body as Record<string, unknown>).stateSnapshot;
    const stateSnapshot = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? (rawState as Record<string, unknown>)
      : {};

    // Save snapshot then append audit event.
    const snapshotResult = await saveExecutionSnapshot({
      executionId,
      workflowId,
      userId:        user.id,
      snapshotType:  'manual',
      stateSnapshot,
      metadata:      { operator_id: user.id, reason },
    });

    const eventResult = await appendExecutionEvent({
      executionId,
      workflowId,
      userId:    user.id,
      eventType: 'side_effect_completed',
      payload:   {
        operation:       'force_snapshot',
        snapshot_version: snapshotResult?.snapshotVersion ?? null,
        operator_id:     user.id,
        reason,
      },
      metadata:  { source: 'operator_control_plane' },
    });

    await recordOperatorAction({
      actionType:  'force_snapshot',
      operatorId:  user.id,
      executionId,
      workflowId,
      payload:     { reason },
      result:      {
        snapshotVersion: snapshotResult?.snapshotVersion ?? null,
        eventId:         eventResult?.eventId ?? null,
      },
    }).catch(() => undefined);

    return NextResponse.json({ action, executionId,
      snapshotVersion: snapshotResult?.snapshotVersion ?? null,
      eventSequence:   eventResult?.sequenceNumber ?? null,
    });
  }

  return NextResponse.json(
    { error: "action must be 'pause', 'resume', 'cancel', or 'force_snapshot'" },
    { status: 400 }
  );
}
