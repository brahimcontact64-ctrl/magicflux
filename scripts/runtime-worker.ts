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
import { cleanupExpiredRuntimeLocks, markOrphanExecutionsFailed, recoverOrphanExecutions } from '../runtime/hardening-layer';
import { closeRedisConnection } from '../lib/runtime/redis';
import { getPendingRestartRequests, performRestart } from '../lib/runtime/worker-lifecycle';
import { subscribeDrainSignal, markWorkerDraining } from '../lib/runtime/drain-signal';

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

  let workers: Array<{ close: () => Promise<void>; pause: () => Promise<void> }> = await startRuntimeWorkers(workerId, { explicitStart: true });

  if (workers.length === 0) {
    await markWorkerState(workerId, 'degraded', 'No workers started. Check Redis connection and worker configuration.');
    console.error('[runtime-worker] No workers started. Check Redis connection and worker configuration.');
    process.exit(1);
  }

  console.log(`[runtime-worker] started ${workers.length} workers`);
  console.log(`[runtime-worker] queues: ${RUNTIME_QUEUE_NAMES.join(', ')}`);

  let drainUnsubscribe: (() => void) | null = null;
  subscribeDrainSignal({
    workerId,
    onDrain: () => {
      console.log(`[runtime-worker] drain signal received for ${workerId}, pausing immediately`);
      markWorkerDraining(workerId);
      void Promise.allSettled(workers.map(w => w.pause()));
    },
  }).then(unsub => { drainUnsubscribe = unsub ?? null; }).catch(() => undefined);

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
    void markOrphanExecutionsFailed({ staleAfterMinutes: 10, limit: 100 });
  }, 30_000);

  let isRestarting = false;
  const restartCheckTimer = setInterval(() => {
    if (isRestarting) return;
    void (async () => {
      const pending = await getPendingRestartRequests().catch(() => []);
      const request = pending.find(r => r.worker_id === workerId);
      if (!request) return;
      isRestarting = true;
      const previousWorkers = workers;
      // Pause all workers immediately — stops new job pickup; active jobs continue.
      await Promise.allSettled(previousWorkers.map(w => w.pause()));
      try {
        const newWorkers = await performRestart({
          workerId,
          requestId: request.id,
          workers: previousWorkers,
          restartFn: () => startRuntimeWorkers(workerId, { explicitStart: true }),
        });
        workers = newWorkers as typeof workers;
        console.log(`[runtime-worker] restarted (${workers.length} workers active)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[runtime-worker] restart failed: ${msg}`);
        // performRestart closed previousWorkers before failing; restore reference
        // so shutdown can attempt close() on them (BullMQ close is idempotent).
        workers = previousWorkers;
        await markWorkerState(workerId, 'crashed', msg).catch(() => undefined);
      } finally {
        isRestarting = false;
      }
    })();
  }, 10_000);

  const shutdown = async (signal: string) => {
    console.log(`[runtime-worker] ${signal} received, shutting down...`);
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    clearInterval(restartCheckTimer);
    if (drainUnsubscribe) drainUnsubscribe();
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
