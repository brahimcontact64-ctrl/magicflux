import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions, requirePermission } from '@/lib/runtime/rbac';
import { requestWorkerRestart, drainWorker } from '@/lib/runtime/worker-lifecycle';
import { recordOperatorAction } from '@/lib/runtime/incident-manager';

// GET — worker liveness, heartbeat status, and pending restart requests.
//
// Query params:
//   ?status=<s>    — filter by worker status
//   ?limit=<n>     — default 100
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const status    = sp.get('status');
  const limitRaw  = parseInt(sp.get('limit') ?? '100', 10);
  const limit     = Math.min(500, Math.max(1, isNaN(limitRaw) ? 100 : limitRaw));
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();

  let workersQ = db
    .from('runtime_workers')
    .select(
      'worker_id, hostname, pid, status, queues, capabilities, concurrency, ' +
      'cpu_load, memory_mb, jobs_processed, restart_count, ' +
      'heartbeat_at, last_error, updated_at'
    )
    .order('heartbeat_at', { ascending: false })
    .limit(limit);

  if (status) workersQ = workersQ.eq('status', status);

  const [workersRes, restartRequestsRes] = await Promise.all([
    workersQ,
    db
      .from('runtime_worker_restart_requests')
      .select('id, worker_id, reason, requested_by, status, created_at, acknowledged_at')
      .in('status', ['pending', 'acknowledged'])
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const workers = (workersRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  // Classify liveness
  const liveWorkers   = workers.filter(w => new Date(String(w.heartbeat_at)).getTime() > new Date(staleWorkerCutoff).getTime());
  const stalledWorkers = workers.filter(w => new Date(String(w.heartbeat_at)).getTime() <= new Date(staleWorkerCutoff).getTime());

  const statusSummary = workers.reduce<Record<string, number>>((acc, w) => {
    const s = String(w.status ?? 'unknown');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  // Strip requested_by (contains other users' UUIDs) for non-admin callers.
  const rawRequests = (restartRequestsRes.data ?? []) as Array<Record<string, unknown>>;
  const restartRequests = isAdmin
    ? rawRequests
    : rawRequests.map(({ requested_by: _rb, ...rest }) => rest);

  return NextResponse.json({
    workers:          workers,
    liveCount:        liveWorkers.length,
    stalledCount:     stalledWorkers.length,
    statusSummary,
    restartRequests,
    generatedAt:      new Date().toISOString(),
  });
}

// POST — operator actions on workers.
//
// Body variants:
//   { action: 'drain';   workerId: string; reason?: string }
//   { action: 'restart'; workerId: string; reason?: string }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_workers');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, workerId } = body as { action?: string; workerId?: unknown };
  if (typeof workerId !== 'string' || !workerId) {
    return NextResponse.json({ error: 'workerId is required' }, { status: 400 });
  }

  const reason = typeof (body as Record<string, unknown>).reason === 'string'
    ? String((body as Record<string, unknown>).reason)
    : 'manual';

  if (action === 'drain') {
    await drainWorker(workerId);

    await recordOperatorAction({
      actionType: 'drain_worker',
      operatorId: user.id,
      workerId,
      payload:    { reason },
      result:     { drained: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, workerId, drained: true });
  }

  if (action === 'restart') {
    await requestWorkerRestart({ workerId, reason: 'manual', requestedBy: user.id });

    await recordOperatorAction({
      actionType: 'restart_worker',
      operatorId: user.id,
      workerId,
      payload:    { reason },
      result:     { restartRequested: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, workerId, restartRequested: true });
  }

  return NextResponse.json(
    { error: "action must be 'drain' or 'restart'" },
    { status: 400 }
  );
}
