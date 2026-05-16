import { writeFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

import { enqueueRuntimeJob } from '../lib/runtime/queue';

type SoakThresholds = {
  maxMemoryGrowthMb: number;
  maxFailedJobRatio: number;
  maxDlqIncrease: number;
  maxHeartbeatGapMs: number;
  maxUnhandledExceptions: number;
  maxStalledJobs: number;
  maxZombieWorkers: number;
  maxRunawayRetries: number;
};

type Sample = {
  timestamp: string;
  queue: {
    queued: number;
    active: number;
    completed: number;
    failed: number;
  };
  stalledJobs: number;
  runawayRetries: number;
  runtimeEvents: number;
  workers: {
    count: number;
    maxHeartbeatGapMs: number;
    avgMemoryMb: number;
    zombieWorkers: number;
  };
  dlqCount: number;
};

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function parseIso(value: unknown): number {
  if (!value) return 0;
  const n = new Date(String(value)).getTime();
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const supabaseUrl = env('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

  const durationMs = numEnv('RUNTIME_SOAK_DURATION_MS', 5 * 60 * 1000);
  const sampleIntervalMs = numEnv('RUNTIME_SOAK_SAMPLE_INTERVAL_MS', 10_000);
  const enqueueBatch = numEnv('RUNTIME_SOAK_ENQUEUE_BATCH', 3);

  const thresholds: SoakThresholds = {
    maxMemoryGrowthMb: numEnv('RUNTIME_SOAK_MAX_MEMORY_GROWTH_MB', 150),
    maxFailedJobRatio: numEnv('RUNTIME_SOAK_MAX_FAILED_JOB_RATIO', 0.15),
    maxDlqIncrease: numEnv('RUNTIME_SOAK_MAX_DLQ_INCREASE', 5),
    maxHeartbeatGapMs: numEnv('RUNTIME_SOAK_MAX_HEARTBEAT_GAP_MS', 90_000),
    maxUnhandledExceptions: numEnv('RUNTIME_SOAK_MAX_UNHANDLED_EXCEPTIONS', 0),
    maxStalledJobs: numEnv('RUNTIME_SOAK_MAX_STALLED_JOBS', 0),
    maxZombieWorkers: numEnv('RUNTIME_SOAK_MAX_ZOMBIE_WORKERS', 0),
    maxRunawayRetries: numEnv('RUNTIME_SOAK_MAX_RUNAWAY_RETRIES', 0),
  };

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const runId = `runtime-soak-${Date.now()}`;
  const now = Date.now();
  const userEmail = `${runId}@magicflux.local`;
  const password = 'MagicFlux!123456';

  const userCreate = await db.auth.admin.createUser({
    email: userEmail,
    password,
    email_confirm: true,
  });

  if (userCreate.error || !userCreate.data.user?.id) {
    throw new Error(`Unable to create soak user: ${userCreate.error?.message ?? 'unknown'}`);
  }

  const userId = userCreate.data.user.id;
  const sessionId = `${runId}-session`;

  const readSnapshot = async () => {
    const [queueRowsRes, workerRowsRes, dlqRes, runtimeEventsRes] = await Promise.all([
      db
        .from('runtime_queue_jobs')
        .select('status, attempts, max_attempts, heartbeat_at, started_at, updated_at')
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .limit(10_000),
      db
        .from('runtime_workers')
        .select('worker_id, status, memory_mb, heartbeat_at')
        .order('heartbeat_at', { ascending: false })
        .limit(300),
      db
        .from('runtime_queue_dead_letters')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      db
        .from('runtime_events')
        .select('event_type, severity', { count: 'exact' })
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .limit(10_000),
    ]);

    const queueRows = queueRowsRes.data ?? [];
    const workerRows = workerRowsRes.data ?? [];
    const runtimeEvents = runtimeEventsRes.data ?? [];
    const nowTs = Date.now();

    const queueByStatus = queueRows.reduce(
      (acc, row) => {
        const status = String(row.status ?? 'queued');
        if (status === 'queued') acc.queued += 1;
        if (status === 'active') acc.active += 1;
        if (status === 'completed') acc.completed += 1;
        if (status === 'failed') acc.failed += 1;
        return acc;
      },
      { queued: 0, active: 0, completed: 0, failed: 0 }
    );

    const stalledJobs = queueRows.filter((row) => {
      if (String(row.status) !== 'active') return false;
      const heartbeat = parseIso(row.heartbeat_at);
      const started = parseIso(row.started_at);
      const marker = Math.max(heartbeat, started);
      if (!marker) return true;
      return nowTs - marker > thresholds.maxHeartbeatGapMs;
    }).length;

    const runawayRetries = queueRows.filter((row) => Number(row.attempts ?? 0) > Number(row.max_attempts ?? 0)).length;

    const activeWorkers = workerRows.filter((row) => ['healthy', 'degraded'].includes(String(row.status ?? '')));

    const heartbeatGaps = activeWorkers.map((row) => {
      const hb = parseIso(row.heartbeat_at);
      return hb ? nowTs - hb : Number.POSITIVE_INFINITY;
    });

    const maxHeartbeatGapMs = heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : Number.POSITIVE_INFINITY;
    const avgMemoryMb = activeWorkers.length > 0
      ? Number((activeWorkers.reduce((sum, row) => sum + Number(row.memory_mb ?? 0), 0) / activeWorkers.length).toFixed(2))
      : 0;
    const zombieWorkers = activeWorkers.filter((row) => {
      if (!['healthy', 'degraded'].includes(String(row.status))) return false;
      const hb = parseIso(row.heartbeat_at);
      if (!hb) return true;
      return nowTs - hb > thresholds.maxHeartbeatGapMs;
    }).length;

    const unhandledExceptions = runtimeEvents.filter((row) => {
      const eventType = String(row.event_type ?? '');
      return eventType.includes('unhandled') || eventType.includes('exception');
    }).length;

    return {
      sample: {
        timestamp: new Date().toISOString(),
        queue: queueByStatus,
        stalledJobs,
        runawayRetries,
        runtimeEvents: runtimeEvents.length,
        workers: {
          count: activeWorkers.length,
          maxHeartbeatGapMs: Number.isFinite(maxHeartbeatGapMs) ? maxHeartbeatGapMs : -1,
          avgMemoryMb,
          zombieWorkers,
        },
        dlqCount: dlqRes.count ?? 0,
      } as Sample,
      unhandledExceptions,
    };
  };

  const baseline = await readSnapshot();
  const baselineSample = baseline.sample;
  let totalUnhandledExceptions = baseline.unhandledExceptions;

  const samples: Sample[] = [baselineSample];
  const startedAt = Date.now();

  while (Date.now() - startedAt < durationMs) {
    const batch: Promise<unknown>[] = [];
    for (let i = 0; i < enqueueBatch; i += 1) {
      batch.push(
        enqueueRuntimeJob({
          queueName: 'planner_queue',
          taskType: 'planner_followup',
          payload: {
            userId,
            sessionId,
            workflowId: undefined,
            toolName: 'soak_noop',
            policyMode: 'staging',
            args: { runId, i, ts: Date.now() },
            correlationId: `${runId}-corr-${Date.now()}-${i}`,
            executionId: `${runId}-exec-${Date.now()}-${i}`,
          },
          attempts: 2,
        })
      );
    }

    await Promise.all(batch);
    await sleep(sampleIntervalMs);

    const next = await readSnapshot();
    samples.push(next.sample);
    totalUnhandledExceptions = Math.max(totalUnhandledExceptions, next.unhandledExceptions);
  }

  const finalSample = samples[samples.length - 1] ?? baselineSample;
  const memoryGrowthMb = Number((finalSample.workers.avgMemoryMb - baselineSample.workers.avgMemoryMb).toFixed(2));
  const failedDelta = Math.max(0, finalSample.queue.failed - baselineSample.queue.failed);
  const completedDelta = Math.max(0, finalSample.queue.completed - baselineSample.queue.completed);
  const failedJobRatio = ratio(failedDelta, failedDelta + completedDelta);
  const dlqDelta = Math.max(0, finalSample.dlqCount - baselineSample.dlqCount);
  const stalledJobs = finalSample.stalledJobs;
  const zombieWorkers = finalSample.workers.zombieWorkers;
  const runawayRetries = finalSample.runawayRetries;
  const heartbeatGapMs = finalSample.workers.maxHeartbeatGapMs;

  const checks = {
    unhandledExceptions: {
      value: totalUnhandledExceptions,
      threshold: thresholds.maxUnhandledExceptions,
      pass: totalUnhandledExceptions <= thresholds.maxUnhandledExceptions,
    },
    stalledJobs: {
      value: stalledJobs,
      threshold: thresholds.maxStalledJobs,
      pass: stalledJobs <= thresholds.maxStalledJobs,
    },
    zombieWorkers: {
      value: zombieWorkers,
      threshold: thresholds.maxZombieWorkers,
      pass: zombieWorkers <= thresholds.maxZombieWorkers,
    },
    memoryGrowthMb: {
      value: memoryGrowthMb,
      threshold: thresholds.maxMemoryGrowthMb,
      pass: memoryGrowthMb <= thresholds.maxMemoryGrowthMb,
    },
    failedJobRatio: {
      value: Number(failedJobRatio.toFixed(4)),
      threshold: thresholds.maxFailedJobRatio,
      pass: failedJobRatio <= thresholds.maxFailedJobRatio,
    },
    dlqDelta: {
      value: dlqDelta,
      threshold: thresholds.maxDlqIncrease,
      pass: dlqDelta <= thresholds.maxDlqIncrease,
    },
    heartbeatGapMs: {
      value: heartbeatGapMs,
      threshold: thresholds.maxHeartbeatGapMs,
      pass: heartbeatGapMs >= 0 && heartbeatGapMs <= thresholds.maxHeartbeatGapMs,
    },
    runawayRetries: {
      value: runawayRetries,
      threshold: thresholds.maxRunawayRetries,
      pass: runawayRetries <= thresholds.maxRunawayRetries,
    },
  };

  const pass = Object.values(checks).every((check) => check.pass);

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    durationMs,
    sampleIntervalMs,
    enqueueBatch,
    baseline: baselineSample,
    final: finalSample,
    deltas: {
      completedDelta,
      failedDelta,
      dlqDelta,
      memoryGrowthMb,
      failedJobRatio: Number(failedJobRatio.toFixed(4)),
      heartbeatGapMs,
      stalledJobs,
      zombieWorkers,
      runawayRetries,
      totalUnhandledExceptions,
    },
    thresholds,
    checks,
    samples,
    summary: {
      status: pass ? 'PASS' : 'FAIL',
      pass,
      checksPassed: Object.values(checks).filter((c) => c.pass).length,
      checksFailed: Object.values(checks).filter((c) => !c.pass).length,
      startedAt: new Date(now).toISOString(),
      endedAt: new Date().toISOString(),
    },
  };

  writeFileSync('runtime-soak-report.json', JSON.stringify(report, null, 2), 'utf8');

  if (!pass) {
    console.error('Runtime soak FAILED. See runtime-soak-report.json');
    process.exitCode = 1;
    return;
  }

  console.log('Runtime soak PASSED. Report written to runtime-soak-report.json');
}

main().catch((error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    summary: {
      status: 'FAIL',
      pass: false,
    },
    error: error instanceof Error ? error.message : String(error),
  };

  writeFileSync('runtime-soak-report.json', JSON.stringify(fallback, null, 2), 'utf8');
  console.error(error);
  process.exit(1);
});
