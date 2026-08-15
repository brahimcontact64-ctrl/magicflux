import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import { retryCommand, deadLetterCommand } from '@/lib/runtime/command-bus';
import { recordOperatorAction } from '@/lib/runtime/incident-manager';

// GET — list commands across all executions with optional filters.
//
// Query params:
//   ?execution_id=<id>       — filter by execution
//   ?status=<s>              — filter by status (pending|processing|acknowledged|failed|dead_letter)
//   ?command_type=<t>        — filter by command type
//   ?from=<ISO>              — created_at >= from
//   ?limit=<n>               — max results (default 100, max 500)
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const executionId  = sp.get('execution_id');
  const status       = sp.get('status');
  const commandType  = sp.get('command_type');
  const from         = sp.get('from');
  const limitRaw     = parseInt(sp.get('limit') ?? '100', 10);
  const limit        = Math.min(500, Math.max(1, isNaN(limitRaw) ? 100 : limitRaw));

  let q = db
    .from('runtime_execution_commands')
    .select(
      'id, execution_id, workflow_id, command_type, command_version, sequence_number, ' +
      'status, retry_count, scheduled_for, payload, metadata, causation_id, ' +
      'processing_started_at, acknowledged_at, worker_id, created_at'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (executionId) q = q.eq('execution_id', executionId);
  if (status)      q = q.eq('status', status);
  if (commandType) q = q.eq('command_type', commandType);
  if (from && !isNaN(new Date(from).getTime())) q = q.gte('created_at', from);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 });

  return NextResponse.json({
    commands:    data ?? [],
    count:       (data ?? []).length,
    generatedAt: new Date().toISOString(),
  });
}

// POST — operator actions on commands (global, not scoped to a single execution).
//
// Body:
//   { action: 'retry';       commandId: string; executionId: string; retryCount: number; reason?: string }
//   { action: 'dead_letter'; commandId: string; executionId: string; reason?: string }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_commands');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action } = body as { action?: string };

  if (action === 'retry') {
    const { commandId, executionId, retryCount, reason } = body as {
      commandId?: unknown; executionId?: unknown; retryCount?: unknown; reason?: unknown;
    };
    if (typeof commandId !== 'string' || typeof executionId !== 'string') {
      return NextResponse.json({ error: 'commandId and executionId are required' }, { status: 400 });
    }
    const currentRetryCount = typeof retryCount === 'number' ? retryCount : 0;

    const result = await retryCommand({
      commandId,
      executionId,
      userId:            user.id,
      currentRetryCount,
      reason:            typeof reason === 'string' ? reason : 'operator_retry',
    });

    await recordOperatorAction({
      actionType:  'retry_command',
      operatorId:  user.id,
      executionId,
      payload:     { commandId, retryCount: currentRetryCount, reason },
      result:      result as Record<string, unknown>,
    }).catch(() => undefined);

    return NextResponse.json({ action, commandId, ...result });
  }

  if (action === 'dead_letter') {
    const { commandId, executionId, reason } = body as {
      commandId?: unknown; executionId?: unknown; reason?: unknown;
    };
    if (typeof commandId !== 'string' || typeof executionId !== 'string') {
      return NextResponse.json({ error: 'commandId and executionId are required' }, { status: 400 });
    }

    await deadLetterCommand({
      commandId,
      executionId,
      userId:   user.id,
      reason:   typeof reason === 'string' ? reason : 'operator_dead_letter',
    });

    await recordOperatorAction({
      actionType:  'dead_letter_command',
      operatorId:  user.id,
      executionId,
      payload:     { commandId, reason },
      result:      { deadLettered: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, commandId, deadLettered: true });
  }

  if (action === 'bulk_retry') {
    const items = (body as Record<string, unknown>).commands;
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'commands must be a non-empty array' }, { status: 400 });
    }

    let queued = 0;
    let deadLettered = 0;
    const errors: string[] = [];

    await Promise.all(
      (items as Array<Record<string, unknown>>).map(async (item) => {
        const cmdId  = String(item.commandId  ?? '');
        const execId = String(item.executionId ?? '');
        const retries = Number(item.retryCount ?? 0);
        if (!cmdId || !execId) return;
        try {
          const r = await retryCommand({
            commandId:         cmdId,
            executionId:       execId,
            userId:            user.id,
            currentRetryCount: retries,
            reason:            'operator_bulk_retry',
          });
          if (r?.queued)       queued++;
          else if (r?.deadLettered) deadLettered++;
        } catch (e) {
          errors.push(cmdId);
        }
      })
    );

    await recordOperatorAction({
      actionType: 'bulk_retry_commands',
      operatorId:  user.id,
      payload:     { count: items.length },
      result:      { queued, deadLettered, errors: errors.length },
    }).catch(() => undefined);

    return NextResponse.json({ action, queued, deadLettered, errors: errors.length, total: items.length });
  }

  if (action === 'bulk_dead_letter') {
    const items = (body as Record<string, unknown>).commands;
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'commands must be a non-empty array' }, { status: 400 });
    }

    let count = 0;
    const errors: string[] = [];

    await Promise.all(
      (items as Array<Record<string, unknown>>).map(async (item) => {
        const cmdId  = String(item.commandId  ?? '');
        const execId = String(item.executionId ?? '');
        if (!cmdId || !execId) return;
        try {
          await deadLetterCommand({
            commandId:   cmdId,
            executionId: execId,
            userId:      user.id,
            reason:      'operator_bulk_dead_letter',
          });
          count++;
        } catch (e) {
          errors.push(cmdId);
        }
      })
    );

    await recordOperatorAction({
      actionType: 'bulk_dead_letter_commands',
      operatorId:  user.id,
      payload:     { count: items.length },
      result:      { deadLettered: count, errors: errors.length },
    }).catch(() => undefined);

    return NextResponse.json({ action, deadLettered: count, errors: errors.length, total: items.length });
  }

  return NextResponse.json(
    { error: "action must be 'retry', 'dead_letter', 'bulk_retry', or 'bulk_dead_letter'" },
    { status: 400 }
  );
}
