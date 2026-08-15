/**
 * Phase 6 — Queue / Runtime Reliability Hardening Tests
 * Tests the dead-letter queue, orphan execution repair, worker heartbeat,
 * health metrics endpoint, and watchdog wiring.
 * Run: npx ts-node --project tsconfig.scripts.json scripts/test-queue-reliability.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TestResult = {
  name: string;
  section: string;
  ok: boolean;
  message?: string;
};

const results: TestResult[] = [];

function test(section: string, name: string, fn: () => void): void {
  try {
    fn();
    results.push({ section, name, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ section, name, ok: false, message });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function readFile(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

function containsAll(content: string, patterns: string[]): void {
  for (const p of patterns) {
    assert(content.includes(p), `Expected to find '${p}' but it was absent`);
  }
}

// ============================================================================
// Section 1: Health endpoint live metrics
// ============================================================================

test('health-endpoint', 'route.ts imports createServiceClient for live DB queries', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes("from '@/lib/supabase-server'"), 'Missing supabase-server import');
  assert(src.includes('createServiceClient'), 'Missing createServiceClient call');
});

test('health-endpoint', 'route returns workers_alive as a live count', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes('workers_alive'), 'Missing workers_alive field');
  assert(src.includes("'runtime_workers'"), 'Must query runtime_workers table');
  assert(src.includes('heartbeat_at'), 'Must filter by heartbeat_at for liveness');
});

test('health-endpoint', 'route returns stalled_jobs count', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes('stalled_jobs'), 'Missing stalled_jobs field');
  assert(src.includes("'runtime_queue_jobs'"), 'Must query runtime_queue_jobs');
  assert(src.includes("'active'"), 'Must filter active queue jobs for stall detection');
});

test('health-endpoint', 'route returns failed_jobs count', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes('failed_jobs'), 'Missing failed_jobs field');
  assert(src.includes("'failed'"), 'Must filter by status=failed');
});

test('health-endpoint', 'route returns dead_jobs count from dead letters table', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes('dead_jobs'), 'Missing dead_jobs field');
  assert(src.includes("'runtime_queue_dead_letters'"), 'Must query runtime_queue_dead_letters');
});

test('health-endpoint', 'route returns orphan_executions count', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes('orphan_executions'), 'Missing orphan_executions field');
  assert(src.includes("'runtime_execution_ownership'"), 'Must query runtime_execution_ownership');
  assert(src.includes('lease_expires_at'), 'Must filter by expired lease_expires_at');
});

test('health-endpoint', 'ok flag depends on redis and stale-worker check', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes("redis === 'connected'"), 'ok must require redis connected');
  assert(src.includes('staleWorkersRes') || src.includes('stale_workers'), 'ok must check stale workers');
});

test('health-endpoint', 'route uses count:exact head queries for efficiency', () => {
  const src = readFile('app/api/health/runtime/route.ts');
  assert(src.includes("count: 'exact'"), 'Must use count:exact for counter queries');
  assert(src.includes('head: true'), 'Must use head:true to avoid fetching rows');
});

// ============================================================================
// Section 2: markOrphanExecutionsFailed function
// ============================================================================

test('orphan-repair', 'markOrphanExecutionsFailed is exported from hardening-layer.ts', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes('export async function markOrphanExecutionsFailed'), 'Function must be exported');
});

test('orphan-repair', 'function queries workflow_executions_v2 with status=running', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  assert(idx !== -1, 'Function not found');
  const body = src.slice(idx);
  assert(body.includes("'workflow_executions_v2'"), 'Must query workflow_executions_v2');
  assert(body.includes(".eq('status', 'running')"), "Must filter status = 'running'");
});

test('orphan-repair', 'function filters by updated_at < cutoff for stale detection', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes(".lt('updated_at', cutoff)"), 'Must use lt(updated_at, cutoff)');
  assert(body.includes('staleAfterMinutes'), 'Must have staleAfterMinutes parameter');
});

test('orphan-repair', 'function marks executions status=failed', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes("status: 'failed'"), "Must set status = 'failed'");
});

test('orphan-repair', "function sets error_message='worker timeout'", () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes("error_message: 'worker timeout'"), "Must set error_message = 'worker timeout'");
});

test('orphan-repair', 'function has limit parameter to prevent unbounded scans', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes('.limit('), 'Must have .limit() to cap rows processed');
  assert(body.includes('params?.limit'), 'limit must be configurable via params');
});

test('orphan-repair', 'function updates with user_id tenant isolation guard', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes(".eq('user_id', row.user_id)"), 'Must include user_id in update filter');
});

test('orphan-repair', 'function also guards update with eq(status, running) to prevent double-mark', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('markOrphanExecutionsFailed');
  const body = src.slice(idx);
  assert(body.includes(".eq('status', 'running')"), 'Update filter must re-check status=running');
});

// ============================================================================
// Section 3: Watchdog wiring in runtime-worker.ts
// ============================================================================

test('watchdog-wiring', 'runtime-worker.ts imports markOrphanExecutionsFailed', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('markOrphanExecutionsFailed'), 'Import missing: markOrphanExecutionsFailed');
  assert(src.includes("from '../runtime/hardening-layer'"), 'Must import from hardening-layer');
});

test('watchdog-wiring', 'watchdog timer calls markOrphanExecutionsFailed', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('void markOrphanExecutionsFailed('), 'Watchdog must call markOrphanExecutionsFailed');
});

test('watchdog-wiring', 'watchdog also calls recoverOrphanExecutions', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('void recoverOrphanExecutions('), 'Watchdog must call recoverOrphanExecutions');
});

test('watchdog-wiring', 'watchdog also calls recoverStuckQueueJobs', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('void recoverStuckQueueJobs('), 'Watchdog must call recoverStuckQueueJobs');
});

test('watchdog-wiring', 'watchdog also calls cleanupStaleWorkers', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('void cleanupStaleWorkers('), 'Watchdog must call cleanupStaleWorkers');
});

test('watchdog-wiring', 'watchdog fires every 30 seconds', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('watchdogTimer'), 'Must have watchdogTimer interval');
  assert(src.includes('30_000') || src.includes('30000'), 'Watchdog interval must be 30s');
});

// ============================================================================
// Section 4: Dead-letter queue wiring
// ============================================================================

test('dead-letter-queue', 'recordQueueDeadLetter writes to runtime_queue_dead_letters', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('recordQueueDeadLetter'), 'Function must exist');
  assert(src.includes("'runtime_queue_dead_letters'"), 'Must write to runtime_queue_dead_letters');
});

test('dead-letter-queue', 'DLQ entry includes replay_status=pending', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes("replay_status: 'pending'"), "DLQ entries must have replay_status='pending'");
});

test('dead-letter-queue', 'DLQ is only written when willRetry === false (final failure)', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('willRetry'), 'Must use willRetry flag');
  assert(src.includes('if (!willRetry)'), 'DLQ write must be guarded by !willRetry');
});

test('dead-letter-queue', 'willRetry correctly computed as attemptsMade + 1 < maxAttempts', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(
    src.includes('willRetry = job.attemptsMade + 1 < maxAttempts'),
    'willRetry formula must be: attemptsMade + 1 < maxAttempts'
  );
});

test('dead-letter-queue', 'replayDeadLetterJob function exists for DLQ replay', () => {
  const src = readFile('lib/runtime/replay.ts');
  assert(src.includes('export async function replayDeadLetterJob'), 'replayDeadLetterJob must be exported');
});

test('dead-letter-queue', 'DLQ replay updates replay_status to replayed on success', () => {
  const src = readFile('lib/runtime/replay.ts');
  assert(src.includes("replay_status: queued.enqueued ? 'replayed' : 'failed'"), 'Must update replay_status on replay');
});

// ============================================================================
// Section 5: Worker heartbeat system
// ============================================================================

test('worker-heartbeat', 'heartbeatWorker function exists in worker-registry.ts', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  assert(src.includes('export async function heartbeatWorker'), 'heartbeatWorker must be exported');
});

test('worker-heartbeat', 'heartbeat fires every 30 seconds in runtime-worker.ts', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('heartbeatTimer'), 'Must have heartbeatTimer');
  assert(src.includes('void heartbeatWorker('), 'Must call heartbeatWorker in timer');
  assert(
    (src.match(/heartbeatTimer[\s\S]{0,300}30_?000/) || src.match(/heartbeatWorker[\s\S]{0,300}30_?000/)) !== null,
    'heartbeat interval must be 30s'
  );
});

test('worker-heartbeat', 'cleanupStaleWorkers uses 90-second threshold', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('staleSeconds: 90'), 'cleanupStaleWorkers must use staleSeconds:90');
});

test('worker-heartbeat', 'cleanupHistoricalWorkers retains 7 days of history', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('retainDays: 7'), 'cleanupHistoricalWorkers must use retainDays:7');
});

test('worker-heartbeat', 'worker gracefully marks itself stopped on shutdown', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes("markWorkerState(workerId, 'stopped')"), 'Shutdown must mark worker stopped');
  assert(src.includes("markWorkerState(workerId, 'stopping')"), 'Shutdown must first mark worker stopping');
});

// ============================================================================
// Section 6: Queue backoff / BullMQ configuration
// ============================================================================

test('queue-config', 'enqueueRuntimeJob defaults to 3 attempts', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('attempts: params.attempts ?? 3'), 'Default attempts must be 3');
});

test('queue-config', 'backoff type is exponential', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes("type: 'exponential'"), "Backoff type must be 'exponential'");
});

test('queue-config', 'backoff base delay is 1000ms', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('delay: 1000') || src.includes('delay:1000'), 'Backoff delay must be 1000ms');
});

test('queue-config', 'removeOnFail limits memory growth (BullMQ job retention)', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('removeOnFail'), 'Must set removeOnFail to cap Redis memory usage');
  assert(src.includes('removeOnComplete'), 'Must set removeOnComplete to cap Redis memory usage');
});

test('queue-config', 'recoverStuckQueueJobs uses 10-minute stale threshold', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('staleMinutes: 10'), 'recoverStuckQueueJobs must use staleMinutes:10');
});

// ============================================================================
// Print results
// ============================================================================

let currentSection = '';
let passed = 0;
let failed = 0;

for (const r of results) {
  if (r.section !== currentSection) {
    currentSection = r.section;
    console.log(`\n--- ${currentSection} ---`);
  }
  const mark = r.ok ? '✓' : '✗';
  console.log(`  ${mark} ${r.name}`);
  if (!r.ok && r.message) {
    console.log(`      → ${r.message}`);
  }
  if (r.ok) passed += 1;
  else failed += 1;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed (${results.length} total) ===\n`);

if (failed > 0) {
  process.exit(1);
}
