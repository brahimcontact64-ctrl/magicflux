import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { listActiveIncidents } from '@/lib/runtime/incident-manager';
import { getUserPermissions } from '@/lib/runtime/rbac';

type Ctx = { params: { executionId: string } };

// GET — full detail for a single execution: events, snapshots, commands, and incidents.
//
// Phase 9.9.14 -- Part-of-audit tenant-isolation fix: this route previously
// had NO RBAC permission check at all (not even view_runtime) and NO
// ownership check on the execution row -- any authenticated user who knew
// or guessed an executionId could read another tenant's full execution
// detail, event/command history, and incidents. Mirrors traces/route.ts's
// own "ownership confirmed before spans are queried" pattern exactly.
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const isAdmin = perms.includes('admin_runtime');

  const executionId = params.executionId?.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const db = createServiceClient();

  // Load the execution first to confirm it exists AND (for a non-admin
  // caller) that this user actually owns it -- ownership confirmed before
  // any related events/snapshots/commands/incidents are ever queried.
  let execQuery = db
    .from('workflow_executions_v2')
    .select('id, workflow_id, user_id, status, started_at, completed_at, retry_count, error_message, created_at')
    .eq('id', executionId);
  if (!isAdmin) execQuery = execQuery.eq('user_id', user.id);
  const execRes = await execQuery.maybeSingle();

  if (execRes.error || !execRes.data) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  const [eventsRes, snapshotsRes, commandsRes, allIncidents] = await Promise.all([
    db
      .from('runtime_execution_events')
      .select(
        'id, execution_id, workflow_id, user_id, worker_id, event_type, event_version, ' +
        'sequence_number, causation_id, correlation_id, parent_event_id, fencing_token, ' +
        'payload, metadata, created_at'
      )
      .eq('execution_id', executionId)
      .order('sequence_number', { ascending: true })
      .limit(200),
    db
      .from('runtime_execution_snapshots')
      .select(
        'id, execution_id, workflow_id, user_id, snapshot_type, snapshot_version, ' +
        'current_node_id, state_snapshot, pending_queue, metadata, created_at'
      )
      .eq('execution_id', executionId)
      .order('snapshot_version', { ascending: false })
      .limit(20),
    db
      .from('runtime_execution_commands')
      .select(
        'id, execution_id, workflow_id, command_type, command_version, sequence_number, ' +
        'status, retry_count, scheduled_for, payload, metadata, causation_id, ' +
        'processing_started_at, acknowledged_at, worker_id, created_at'
      )
      .eq('execution_id', executionId)
      .order('sequence_number', { ascending: true })
      .limit(100),
    listActiveIncidents({ limit: 100, userId: isAdmin ? undefined : user.id }),
  ]);

  const incidents = allIncidents.filter(i => i.executionId === executionId);

  return NextResponse.json({
    execution: execRes.data,
    events:    eventsRes.data    ?? [],
    snapshots: snapshotsRes.data ?? [],
    commands:  commandsRes.data  ?? [],
    incidents: incidents,
  });
}
