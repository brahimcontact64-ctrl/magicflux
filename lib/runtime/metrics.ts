import "server-only";

import { createServiceClient } from '@/lib/supabase-server';

export type RuntimeMetrics = {
  queue_latency: number;
  worker_load: number;
  retry_rate: number;
  failure_rate: number;
  runtime_health_score: number;
};

export async function computeRuntimeMetrics(params?: {
  windowMinutes?: number;
}): Promise<RuntimeMetrics> {
  const db = createServiceClient();
  const windowMinutes = params?.windowMinutes ?? 60;
  const windowStart = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const now = new Date();
  const staleWorkerCutoff = new Date(now.getTime() - 90_000).toISOString();
  const stalledJobCutoff = new Date(now.getTime() - 10 * 60_000).toISOString();

  const [queueJobsRes, workersRes, stalledRes, orphanRes, dlqRes] = await Promise.all([
    db
      .from('runtime_queue_jobs')
      .select('attempts, status, queued_at, started_at')
      .gte('created_at', windowStart)
      .limit(5000),
    db
      .from('runtime_workers')
      .select('concurrency, status')
      .in('status', ['healthy', 'degraded'])
      .gte('heartbeat_at', staleWorkerCutoff),
    db
      .from('runtime_queue_jobs')
      .select('job_id', { count: 'exact', head: true })
      .eq('status', 'active')
      .lt('heartbeat_at', stalledJobCutoff),
    db
      .from('runtime_execution_ownership')
      .select('execution_id', { count: 'exact', head: true })
      .eq('state', 'active')
      .lt('lease_expires_at', now.toISOString()),
    db
      .from('runtime_queue_dead_letters')
      .select('id', { count: 'exact', head: true })
      .gte('failed_at', windowStart),
  ]);

  const jobs = queueJobsRes.data ?? [];
  const workers = workersRes.data ?? [];

  // queue_latency: average milliseconds from queued to processing start
  const latencies = jobs
    .filter(j => j.queued_at && j.started_at)
    .map(j => {
      const queued = new Date(String(j.queued_at)).getTime();
      const started = new Date(String(j.started_at)).getTime();
      return Math.max(0, started - queued);
    });
  const queue_latency = latencies.length > 0
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  // worker_load: active job count / total worker concurrency capacity (0-100)
  const activeJobs = jobs.filter(j => String(j.status) === 'active').length;
  const totalConcurrency = workers.reduce((s, w) => s + Number(w.concurrency ?? 1), 0);
  const worker_load = totalConcurrency > 0
    ? Math.min(100, Math.round((activeJobs / totalConcurrency) * 100))
    : 0;

  // retry_rate: percentage of jobs that required more than one attempt
  const totalJobs = jobs.length;
  const retriedJobs = jobs.filter(j => Number(j.attempts ?? 0) > 1).length;
  const retry_rate = totalJobs > 0
    ? Math.round((retriedJobs / totalJobs) * 100)
    : 0;

  // failure_rate: percentage of terminal jobs that failed
  const failedJobs = jobs.filter(j => String(j.status) === 'failed').length;
  const completedJobs = jobs.filter(j => String(j.status) === 'completed').length;
  const terminalJobs = failedJobs + completedJobs;
  const failure_rate = terminalJobs > 0
    ? Math.round((failedJobs / terminalJobs) * 100)
    : 0;

  // runtime_health_score: composite 0-100 (100 = fully healthy)
  const stalledCount = Number(stalledRes.count ?? 0);
  const orphanCount = Number(orphanRes.count ?? 0);
  const dlqCount = Number(dlqRes.count ?? 0);

  let score = 100;
  score -= Math.min(25, stalledCount * 5);
  score -= Math.min(25, failure_rate / 2);
  score -= Math.min(15, retry_rate / 3);
  score -= Math.min(15, orphanCount * 5);
  score -= Math.min(10, dlqCount * 2);
  if (worker_load > 80) score -= Math.min(10, (worker_load - 80) / 2);

  const runtime_health_score = Math.max(0, Math.round(score));

  return {
    queue_latency,
    worker_load,
    retry_rate,
    failure_rate,
    runtime_health_score,
  };
}
