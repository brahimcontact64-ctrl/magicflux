import os from 'os';

import { createServiceClient } from '@/lib/supabase-server';

export function buildWorkerId(prefix = 'runtime-worker'): string {
  return `${prefix}-${os.hostname()}-${process.pid}`;
}

export async function registerWorker(params: {
  workerId: string;
  queues: string[];
  capabilities: string[];
  concurrency: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_workers').upsert({
    worker_id: params.workerId,
    hostname: os.hostname(),
    pid: process.pid,
    queues: params.queues,
    capabilities: params.capabilities,
    concurrency: params.concurrency,
    status: 'healthy',
    heartbeat_at: new Date().toISOString(),
    cpu_load: os.loadavg()[0] ?? null,
    memory_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    metadata: params.metadata ?? {},
    updated_at: new Date().toISOString(),
  });
}

const LIFECYCLE_STATES = new Set(['draining', 'restarting', 'stopping', 'stopped', 'crashed']);

export async function heartbeatWorker(workerId: string): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data } = await db
    .from('runtime_workers')
    .select('status')
    .eq('worker_id', workerId)
    .limit(1)
    .maybeSingle();

  const currentStatus = (data as { status?: string } | null)?.status ?? '';

  const patch: Record<string, unknown> = {
    heartbeat_at: now,
    cpu_load: os.loadavg()[0] ?? null,
    memory_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    updated_at: now,
  };

  if (!LIFECYCLE_STATES.has(currentStatus)) {
    patch.status = 'healthy';
  }

  await db.from('runtime_workers').update(patch).eq('worker_id', workerId);
}

export async function incrementWorkerJobs(workerId: string): Promise<void> {
  const db = createServiceClient();

  const { data } = await db
    .from('runtime_workers')
    .select('jobs_processed')
    .eq('worker_id', workerId)
    .limit(1)
    .maybeSingle();

  const current = Number(data?.jobs_processed ?? 0);

  await db
    .from('runtime_workers')
    .update({
      jobs_processed: current + 1,
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('worker_id', workerId);
}

export async function markWorkerState(workerId: string, state: 'degraded' | 'draining' | 'restarting' | 'stopping' | 'stopped' | 'crashed', error?: string): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_workers')
    .update({
      status: state,
      last_error: error ?? null,
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('worker_id', workerId);
}

export async function cleanupStaleWorkers(params?: {
  staleSeconds?: number;
}): Promise<number> {
  const db = createServiceClient();
  const staleSeconds = params?.staleSeconds ?? 90;
  const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();

  const { data: staleWorkers } = await db
    .from('runtime_workers')
    .select('worker_id')
    .in('status', ['healthy', 'degraded'])
    .lt('heartbeat_at', cutoff)
    .limit(200);

  const workers = (staleWorkers ?? []) as Array<{ worker_id: string }>;
  for (const worker of workers) {
    await db
      .from('runtime_workers')
      .update({
        status: 'crashed',
        last_error: 'Worker marked stale by watchdog',
        updated_at: new Date().toISOString(),
      })
      .eq('worker_id', worker.worker_id);
  }

  return workers.length;
}

export async function cleanupHistoricalWorkers(params?: {
  retainDays?: number;
  statuses?: Array<'stopped' | 'crashed'>;
}): Promise<number> {
  const db = createServiceClient();
  const retainDays = params?.retainDays ?? 7;
  const statuses = params?.statuses ?? ['stopped', 'crashed'];
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: oldRows } = await db
    .from('runtime_workers')
    .select('worker_id')
    .in('status', statuses)
    .lt('updated_at', cutoff)
    .limit(1000);

  const workerIds = (oldRows ?? []).map((row) => String(row.worker_id));
  if (workerIds.length === 0) return 0;

  await db
    .from('runtime_workers')
    .delete()
    .in('worker_id', workerIds);

  return workerIds.length;
}
