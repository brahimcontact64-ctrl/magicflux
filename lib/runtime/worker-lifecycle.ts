import { createServiceClient } from '@/lib/supabase-server';
import { markWorkerState } from './worker-registry';
import { publishDrainSignal, markWorkerActive } from './drain-signal';

export type WorkerRestartReason = 'anomaly_detected' | 'high_crash_rate' | 'manual';

export type WorkerRestartRequest = {
  id: string;
  worker_id: string;
  reason: string;
  requested_by: string;
  status: string;
};

export async function requestWorkerRestart(params: {
  workerId: string;
  reason: WorkerRestartReason;
  requestedBy?: string;
}): Promise<void> {
  const db = createServiceClient();

  const { data: existing } = await db
    .from('runtime_worker_restart_requests')
    .select('id')
    .eq('worker_id', params.workerId)
    .in('status', ['pending', 'acknowledged'])
    .limit(1)
    .maybeSingle();

  if (existing) return;

  const now = new Date().toISOString();
  await db.from('runtime_worker_restart_requests').insert({
    worker_id: params.workerId,
    reason: params.reason,
    requested_by: params.requestedBy ?? 'self_healer',
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
}

export async function drainWorker(workerId: string): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_workers')
    .update({
      status: 'draining',
      updated_at: new Date().toISOString(),
    })
    .eq('worker_id', workerId);
  await publishDrainSignal(workerId).catch(() => undefined);
}

export async function markRestarted(workerId: string): Promise<void> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_workers')
    .select('restart_count')
    .eq('worker_id', workerId)
    .limit(1)
    .maybeSingle();
  const restartCount = Number((data as { restart_count?: number } | null)?.restart_count ?? 0);
  const now = new Date().toISOString();
  await db
    .from('runtime_workers')
    .update({
      status: 'healthy',
      restart_count: restartCount + 1,
      heartbeat_at: now,
      updated_at: now,
    })
    .eq('worker_id', workerId);
}

export async function acknowledgeRestartRequest(requestId: string): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  await db
    .from('runtime_worker_restart_requests')
    .update({ status: 'acknowledged', acknowledged_at: now, updated_at: now })
    .eq('id', requestId)
    .eq('status', 'pending');
}

export async function completeRestartRequest(requestId: string): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  await db
    .from('runtime_worker_restart_requests')
    .update({ status: 'completed', completed_at: now, updated_at: now })
    .eq('id', requestId);
}

async function failRestartRequest(requestId: string): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  await db
    .from('runtime_worker_restart_requests')
    .update({ status: 'failed', failed_at: now, updated_at: now })
    .eq('id', requestId);
}

export async function cleanupExpiredRestartRequests(params?: {
  retainDays?: number;
}): Promise<number> {
  const db = createServiceClient();
  const retainDays = params?.retainDays ?? 7;
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await db
    .from('runtime_worker_restart_requests')
    .select('id')
    .in('status', ['completed', 'failed'])
    .lt('updated_at', cutoff)
    .limit(500);

  const ids = ((data ?? []) as Array<{ id: string }>).map(r => r.id);
  if (ids.length === 0) return 0;

  await db.from('runtime_worker_restart_requests').delete().in('id', ids);
  return ids.length;
}

export async function getPendingRestartRequests(): Promise<WorkerRestartRequest[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_worker_restart_requests')
    .select('id, worker_id, reason, requested_by, status')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);
  return (data ?? []) as WorkerRestartRequest[];
}

export async function performRestart(params: {
  workerId: string;
  requestId: string;
  workers: Array<{ close: () => Promise<void> }>;
  restartFn: () => Promise<Array<{ close: () => Promise<void> }>>;
}): Promise<Array<{ close: () => Promise<void> }>> {
  await acknowledgeRestartRequest(params.requestId);
  try {
    await markWorkerState(params.workerId, 'draining');
    // Close all BullMQ workers — waits for active jobs to finish before returning.
    await Promise.allSettled(params.workers.map(w => w.close()));
    await markWorkerState(params.workerId, 'restarting');
    const newWorkers = await params.restartFn();
    await markRestarted(params.workerId);
    markWorkerActive(params.workerId);
    await completeRestartRequest(params.requestId);
    return newWorkers;
  } catch (err) {
    await failRestartRequest(params.requestId).catch(() => undefined);
    throw err;
  }
}
