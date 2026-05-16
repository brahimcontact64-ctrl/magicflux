import { NextResponse } from 'next/server';

import { createServiceClient } from '@/lib/supabase-server';
import { getRedisStatus, RUNTIME_QUEUE_NAMES } from '@/lib/runtime/queue';

function staleCutoffIso(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

export async function GET() {
  const db = createServiceClient();
  const redis = await getRedisStatus();

  const [
    workersRes,
    staleWorkersRes,
    queueRes,
    dlqRes,
    ownershipRes,
    orphanOwnershipRes,
    tracesRes,
  ] = await Promise.all([
    db
      .from('runtime_workers')
      .select('worker_id, status, heartbeat_at, jobs_processed, memory_mb')
      .order('heartbeat_at', { ascending: false })
      .limit(100),
    db
      .from('runtime_workers')
      .select('worker_id, status, heartbeat_at', { count: 'exact' })
      .lt('heartbeat_at', staleCutoffIso(90))
      .in('status', ['healthy', 'degraded'])
      .limit(200),
    db
      .from('runtime_queue_jobs')
      .select('status, queue_name, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1000),
    db
      .from('runtime_queue_dead_letters')
      .select('id, replay_status, failed_at', { count: 'exact' })
      .order('failed_at', { ascending: false })
      .limit(200),
    db
      .from('runtime_execution_ownership')
      .select('execution_id, state, heartbeat_at, lease_expires_at')
      .order('heartbeat_at', { ascending: false })
      .limit(500),
    db
      .from('runtime_execution_ownership')
      .select('execution_id, state, heartbeat_at, lease_expires_at', { count: 'exact' })
      .eq('state', 'active')
      .lt('lease_expires_at', new Date().toISOString())
      .limit(500),
    db
      .from('runtime_traces')
      .select('status')
      .order('created_at', { ascending: false })
      .limit(500),
  ]);

  const errors = [
    workersRes.error,
    staleWorkersRes.error,
    queueRes.error,
    dlqRes.error,
    ownershipRes.error,
    orphanOwnershipRes.error,
    tracesRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        redis,
        error: errors.map((e) => String(e?.message ?? 'Unknown query error')).join('; '),
      },
      { status: 500 }
    );
  }

  const queueRows = queueRes.data ?? [];
  const queueByStatus = queueRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const queueByName = queueRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.queue_name ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const tracesByStatus = (tracesRes.data ?? []).reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const ownershipRows = ownershipRes.data ?? [];
  const activeOwnership = ownershipRows.filter((row) => String(row.state) === 'active');
  const activeWorkers = (workersRes.data ?? []).filter((row) => {
    const status = String(row.status ?? 'unknown');
    if (!['healthy', 'degraded', 'starting'].includes(status)) return false;
    const hb = row.heartbeat_at ? new Date(String(row.heartbeat_at)).getTime() : 0;
    return hb > 0 && Date.now() - hb < 90_000;
  });

  const ok = redis === 'connected' && Number(staleWorkersRes.count ?? 0) === 0;

  return NextResponse.json({
    ok,
    timestamp: new Date().toISOString(),
    redis,
    configuredQueues: RUNTIME_QUEUE_NAMES,
    workers: {
      total: (workersRes.data ?? []).length,
      activeRecent90s: activeWorkers.length,
      stale: Number(staleWorkersRes.count ?? 0),
      retentionPolicy: {
        historicalRows: {
          statuses: ['stopped', 'crashed'],
          retainDays: 7,
        },
      },
      recent: (workersRes.data ?? []).slice(0, 10),
    },
    queue: {
      total: queueRows.length,
      byStatus: queueByStatus,
      byQueue: queueByName,
    },
    deadLetters: {
      total: Number(dlqRes.count ?? 0),
      pendingReplay: (dlqRes.data ?? []).filter((row) => String(row.replay_status ?? 'pending') === 'pending').length,
    },
    ownership: {
      total: ownershipRows.length,
      active: activeOwnership.length,
      orphanCandidates: Number(orphanOwnershipRes.count ?? 0),
    },
    traces: {
      total: (tracesRes.data ?? []).length,
      byStatus: tracesByStatus,
    },
  });
}
