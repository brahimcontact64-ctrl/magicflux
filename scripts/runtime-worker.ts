import { recoverStuckQueueJobs, startRuntimeWorkers } from '../lib/runtime/worker';
import { RUNTIME_QUEUE_NAMES } from '../lib/runtime/queue';
import {
  buildWorkerId,
  cleanupHistoricalWorkers,
  cleanupStaleWorkers,
  heartbeatWorker,
  markWorkerState,
  registerWorker,
} from '../lib/runtime/worker-registry';
import { cleanupExpiredRuntimeLocks, recoverOrphanExecutions } from '../runtime/hardening-layer';
import { closeRedisConnection } from '../lib/runtime/redis';

async function main() {
  console.log('[runtime-worker] booting...');
  process.env.RUNTIME_WORKER_ENABLED = process.env.RUNTIME_WORKER_ENABLED ?? 'true';

  if (!process.env.REDIS_URL) {
    console.error('[runtime-worker] REDIS_URL is missing. Runtime queues are disabled.');
    process.exit(1);
  }

  const workerId = buildWorkerId();
  await registerWorker({
    workerId,
    queues: RUNTIME_QUEUE_NAMES,
    capabilities: ['deploy_workflow', 'activate_workflow', 'test_workflow', 'monitoring', 'replay', 'ai_reasoning'],
    concurrency: 5,
    metadata: { service: 'runtime-worker' },
  });

  const workers = await startRuntimeWorkers(workerId, { explicitStart: true });

  if (workers.length === 0) {
    await markWorkerState(workerId, 'degraded', 'No workers started. Check Redis connection and worker configuration.');
    console.error('[runtime-worker] No workers started. Check Redis connection and worker configuration.');
    process.exit(1);
  }

  console.log(`[runtime-worker] started ${workers.length} workers`);
  console.log(`[runtime-worker] queues: ${RUNTIME_QUEUE_NAMES.join(', ')}`);

  const heartbeatTimer = setInterval(() => {
    void heartbeatWorker(workerId);
    console.log(`[runtime-worker] alive ${new Date().toISOString()}`);
  }, 30_000);

  const watchdogTimer = setInterval(() => {
    void cleanupStaleWorkers({ staleSeconds: 90 });
    void cleanupHistoricalWorkers({ retainDays: 7 });
    void cleanupExpiredRuntimeLocks();
    void recoverOrphanExecutions({ staleAfterMinutes: 3, limit: 100 });
    void recoverStuckQueueJobs({ staleMinutes: 10, limit: 100 });
  }, 30_000);

  const shutdown = async (signal: string) => {
    console.log(`[runtime-worker] ${signal} received, shutting down...`);
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    await markWorkerState(workerId, 'stopping');
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await closeRedisConnection();
    await markWorkerState(workerId, 'stopped');
    console.log('[runtime-worker] shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[runtime-worker] fatal: ${message}`);
  const workerId = buildWorkerId();
  await markWorkerState(workerId, 'crashed', message).catch(() => undefined);
  process.exit(1);
});
