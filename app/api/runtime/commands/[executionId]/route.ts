import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import {
  retryCommand,
  deadLetterCommand,
  type ExecutionCommand,
} from '@/lib/runtime/command-bus';

type Ctx = { params: { executionId: string } };

function mapRow(r: Record<string, unknown>): ExecutionCommand {
  return {
    id:                  String(r.id),
    executionId:         String(r.execution_id),
    workflowId:          r.workflow_id != null ? String(r.workflow_id) : null,
    userId:              r.user_id != null ? String(r.user_id) : null,
    commandType:         String(r.command_type),
    commandVersion:      Number(r.command_version ?? 1),
    sequenceNumber:      Number(r.sequence_number),
    causationId:         r.causation_id != null ? String(r.causation_id) : null,
    correlationId:       r.correlation_id != null ? String(r.correlation_id) : null,
    parentCommandId:     r.parent_command_id != null ? String(r.parent_command_id) : null,
    payload:             (r.payload as Record<string, unknown>) ?? {},
    metadata:            (r.metadata as Record<string, unknown>) ?? {},
    status:              String(r.status) as ExecutionCommand['status'],
    retryCount:          Number(r.retry_count ?? 0),
    scheduledFor:        r.scheduled_for != null ? String(r.scheduled_for) : null,
    processingStartedAt: r.processing_started_at != null ? String(r.processing_started_at) : null,
    acknowledgedAt:      r.acknowledged_at != null ? String(r.acknowledged_at) : null,
    workerId:            r.worker_id != null ? String(r.worker_id) : null,
    createdAt:           String(r.created_at),
  };
}

// GET — list commands for an execution with optional filters.
// Supports: ?status, ?from_seq, ?to_seq, ?causation_id, ?limit
// Returns causation chain metadata for each command.
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp           = req.nextUrl.searchParams;
  const statusFilter = sp.get('status');
  const fromSeqRaw   = sp.get('from_seq');
  const toSeqRaw     = sp.get('to_seq');
  const causationId  = sp.get('causation_id');
  const limitRaw     = sp.get('limit');
  const limit        = limitRaw ? Math.min(2000, Math.max(1, parseInt(limitRaw, 10))) : 500;

  const db = createServiceClient();
  let query = db
    .from('runtime_execution_commands')
    .select(
      'id, execution_id, workflow_id, user_id, command_type, command_version, sequence_number, ' +
      'causation_id, correlation_id, parent_command_id, payload, metadata, ' +
      'status, retry_count, scheduled_for, processing_started_at, acknowledged_at, worker_id, created_at'
    )
    .eq('execution_id', executionId)
    .eq('user_id', user.id)
    .order('sequence_number', { ascending: true })
    .limit(limit);

  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0]);
    } else if (statuses.length > 1) {
      query = query.in('status', statuses);
    }
  }
  if (fromSeqRaw !== null && !isNaN(parseInt(fromSeqRaw, 10))) {
    query = query.gte('sequence_number', parseInt(fromSeqRaw, 10));
  }
  if (toSeqRaw !== null && !isNaN(parseInt(toSeqRaw, 10))) {
    query = query.lte('sequence_number', parseInt(toSeqRaw, 10));
  }
  if (causationId) {
    query = query.eq('causation_id', causationId);
  }

  const { data } = await query;
  const commands = (data ?? []).map((r) => mapRow(r as unknown as Record<string, unknown>));

  // Annotate each command with the type of its causing command (causation chain)
  const commandIndex = new Map(commands.map((c) => [c.id, c]));
  const annotated = commands.map((cmd) => ({
    ...cmd,
    causedByType: cmd.causationId
      ? (commandIndex.get(cmd.causationId)?.commandType ?? null)
      : null,
  }));

  return NextResponse.json({
    executionId,
    totalCommands: annotated.length,
    commands: annotated,
  });
}

// POST — act on a specific command (retry dead-letter or manually dead-letter).
// Body: { commandId: string; action: 'retry' | 'dead_letter'; reason?: string }
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_commands');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { commandId, action, reason } = body as {
    commandId?: string;
    action?: string;
    reason?: string;
  };

  if (!commandId || typeof commandId !== 'string') {
    return NextResponse.json({ error: 'commandId is required' }, { status: 400 });
  }
  if (action !== 'retry' && action !== 'dead_letter') {
    return NextResponse.json({ error: "action must be 'retry' or 'dead_letter'" }, { status: 400 });
  }

  // Verify the command belongs to this execution and user
  const db = createServiceClient();
  const { data: existing } = await db
    .from('runtime_execution_commands')
    .select('id, status, retry_count')
    .eq('id', commandId)
    .eq('execution_id', executionId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: 'Command not found' }, { status: 404 });
  }

  const cmd = existing as unknown as Record<string, unknown>;

  if (action === 'retry') {
    const result = await retryCommand({
      commandId,
      executionId,
      userId:            user.id,
      currentRetryCount: Number(cmd.retry_count ?? 0),
      reason:            typeof reason === 'string' ? reason : undefined,
    });
    return NextResponse.json({ executionId, commandId, ...result });
  }

  // action === 'dead_letter'
  await deadLetterCommand({
    commandId,
    executionId,
    userId:  user.id,
    reason:  typeof reason === 'string' ? reason : 'Manually dead-lettered via API',
  });
  return NextResponse.json({ executionId, commandId, deadLettered: true });
}
