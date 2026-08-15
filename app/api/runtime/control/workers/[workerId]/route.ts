import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { listActiveIncidents } from '@/lib/runtime/incident-manager';

type Ctx = { params: { workerId: string } };

// GET — full detail for a single worker including restart history, recent commands, and incidents.
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workerId = params.workerId?.trim();
  if (!workerId) return NextResponse.json({ error: 'workerId is required' }, { status: 400 });

  const db = createServiceClient();

  const [workerRes, restartHistoryRes, commandsRes, allIncidents] = await Promise.all([
    db
      .from('runtime_workers')
      .select(
        'worker_id, hostname, pid, status, queues, capabilities, concurrency, ' +
        'cpu_load, memory_mb, jobs_processed, restart_count, ' +
        'heartbeat_at, last_error, updated_at'
      )
      .eq('worker_id', workerId)
      .single(),
    db
      .from('runtime_worker_restart_requests')
      .select('id, worker_id, reason, requested_by, status, created_at, acknowledged_at')
      .eq('worker_id', workerId)
      .order('created_at', { ascending: false })
      .limit(20),
    db
      .from('runtime_execution_commands')
      .select(
        'id, execution_id, workflow_id, command_type, command_version, sequence_number, ' +
        'status, retry_count, scheduled_for, payload, metadata, causation_id, ' +
        'processing_started_at, acknowledged_at, worker_id, created_at'
      )
      .eq('worker_id', workerId)
      .order('created_at', { ascending: false })
      .limit(20),
    listActiveIncidents({ limit: 100 }),
  ]);

  if (workerRes.error || !workerRes.data) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  const activeIncidents = allIncidents.filter(i => i.workerId === workerId);

  return NextResponse.json({
    worker:          workerRes.data,
    restartHistory:  restartHistoryRes.data ?? [],
    activeIncidents,
    recentCommands:  commandsRes.data ?? [],
  });
}
