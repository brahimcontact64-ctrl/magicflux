import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { listActiveIncidents } from '@/lib/runtime/incident-manager';
import { getUserPermissions } from '@/lib/runtime/rbac';

// GET — structured replay data for the ReplayVisualizer component.
//
// Query params:
//   ?execution_id=<uuid>   — required
//   ?include_incidents=true — include active incidents for the execution
//
// Phase 9.9.14 -- Part-of-audit tenant-isolation fix: this route previously
// had NO RBAC permission check at all (not even view_runtime) and NO
// ownership check on the execution row -- any authenticated user who knew
// or guessed an executionId could view another tenant's full replay data,
// and every related query ran BEFORE the (missing) ownership check could
// have gated anything. Ownership is now confirmed FIRST, sequentially,
// before any event/snapshot/command data is ever queried -- mirrors
// traces/route.ts's own pattern.
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const isAdmin = perms.includes('admin_runtime');

  const sp          = req.nextUrl.searchParams;
  const executionId = sp.get('execution_id')?.trim();

  if (!executionId) {
    return NextResponse.json({ error: 'execution_id is required' }, { status: 400 });
  }

  const db = createServiceClient();

  let execQuery = db
    .from('workflow_executions_v2')
    .select('id, workflow_id, user_id, status, started_at, completed_at, retry_count, error_message, created_at')
    .eq('id', executionId);
  if (!isAdmin) execQuery = execQuery.eq('user_id', user.id);
  const execRes = await execQuery.maybeSingle();

  if (execRes.error || !execRes.data) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  const [eventsRes, snapshotsRes, commandsRes] = await Promise.all([
    db
      .from('runtime_execution_events')
      .select(
        'id, event_type, event_version, sequence_number, causation_id, ' +
        'correlation_id, parent_event_id, fencing_token, payload, metadata, created_at'
      )
      .eq('execution_id', executionId)
      .order('sequence_number', { ascending: true })
      .limit(500),
    db
      .from('runtime_execution_snapshots')
      .select(
        'id, snapshot_type, snapshot_version, current_node_id, ' +
        'state_snapshot, pending_queue, metadata, created_at'
      )
      .eq('execution_id', executionId)
      .order('snapshot_version', { ascending: true })
      .limit(50),
    db
      .from('runtime_execution_commands')
      .select(
        'id, command_type, command_version, sequence_number, status, ' +
        'retry_count, scheduled_for, payload, processing_started_at, ' +
        'acknowledged_at, worker_id, created_at'
      )
      .eq('execution_id', executionId)
      .order('sequence_number', { ascending: true })
      .limit(200),
  ]);

  // Build replay checkpoints: pair each snapshot with the events leading to it
  const events    = (eventsRes.data    ?? []) as unknown as Array<Record<string, unknown>>;
  const snapshots = (snapshotsRes.data ?? []) as unknown as Array<Record<string, unknown>>;
  const commands  = commandsRes.data  ?? [];

  // Sort snapshot creation times; assign event windows between them
  const checkpoints = snapshots.map((snap, idx) => {
    const prevSnap   = snapshots[idx - 1];
    const prevTime   = prevSnap ? new Date(String(prevSnap.created_at)).getTime() : 0;
    const snapTime   = new Date(String(snap.created_at)).getTime();
    const priorEvents = events.filter(e => {
      const t = new Date(String(e.created_at)).getTime();
      return t >= prevTime && t <= snapTime;
    });

    return {
      snapshotVersion: snap.snapshot_version,
      snapshotType:    snap.snapshot_type,
      currentNodeId:   snap.current_node_id ?? null,
      createdAt:       snap.created_at,
      eventCount:      priorEvents.length,
      eventTypes:      [...new Set(priorEvents.map(e => String(e.event_type)))],
    };
  });

  const includeIncidents = sp.get('include_incidents') === 'true';
  let incidents: unknown[] = [];
  if (includeIncidents) {
    const all = await listActiveIncidents({ limit: 50, userId: isAdmin ? undefined : user.id });
    incidents = all.filter(i => i.executionId === executionId);
  }

  return NextResponse.json({
    execution:   execRes.data,
    events,
    snapshots,
    commands,
    checkpoints,
    incidents,
    generatedAt: new Date().toISOString(),
  });
}
