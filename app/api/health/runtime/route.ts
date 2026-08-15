import { NextResponse } from 'next/server';

import { createServiceClient } from '@/lib/supabase-server';
import { getRedisStatus, RUNTIME_QUEUE_NAMES } from '@/lib/runtime/queue';

export async function GET() {
  const db = createServiceClient();
  const redis = await getRedisStatus();
  const now = new Date();
  const staleWorkerCutoff = new Date(now.getTime() - 90_000).toISOString();
  const stalledJobCutoff = new Date(now.getTime() - 10 * 60_000).toISOString();

  const [workersAliveRes, stalledJobsRes, failedJobsRes, deadLettersRes, orphanRes, staleWorkersRes] =
    await Promise.all([
      db
        .from('runtime_workers')
        .select('worker_id', { count: 'exact', head: true })
        .in('status', ['healthy', 'degraded'])
        .gte('heartbeat_at', staleWorkerCutoff),
      db
        .from('runtime_queue_jobs')
        .select('job_id', { count: 'exact', head: true })
        .eq('status', 'active')
        .lt('heartbeat_at', stalledJobCutoff),
      db
        .from('runtime_queue_jobs')
        .select('job_id', { count: 'exact', head: true })
        .eq('status', 'failed'),
      db
        .from('runtime_queue_dead_letters')
        .select('id', { count: 'exact', head: true }),
      db
        .from('runtime_execution_ownership')
        .select('execution_id', { count: 'exact', head: true })
        .eq('state', 'active')
        .lt('lease_expires_at', now.toISOString()),
      db
        .from('runtime_workers')
        .select('worker_id', { count: 'exact', head: true })
        .in('status', ['healthy', 'degraded'])
        .lt('heartbeat_at', staleWorkerCutoff),
    ]);

  const ok = redis === 'connected' && Number(staleWorkersRes.count ?? 0) === 0;

  return NextResponse.json({
    ok,
    redis,
    queues: RUNTIME_QUEUE_NAMES,
    workers_alive: Number(workersAliveRes.count ?? 0),
    stalled_jobs: Number(stalledJobsRes.count ?? 0),
    failed_jobs: Number(failedJobsRes.count ?? 0),
    dead_jobs: Number(deadLettersRes.count ?? 0),
    orphan_executions: Number(orphanRes.count ?? 0),
  });
}
