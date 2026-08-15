/**
 * Phase 21 — Redis Failure Chaos Test
 *
 * Verifies that the runtime handles Redis unavailability, disconnects, and
 * reconnect storms safely. This is a code-analysis test: it reads source files
 * and asserts that the required safety properties are implemented. No live Redis
 * connection is required.
 *
 * Scenarios covered:
 *   1. Redis unavailable at startup     — workers must not start; queues must degrade gracefully
 *   2. Redis unavailable during enqueue — enqueueRuntimeJob must return enqueued:false, not throw
 *   3. Reconnect storm protection       — exponential back-off caps in redis.ts
 *   4. Transient error classification   — ECONNRESET/ECONNABORTED/ECONNREFUSED logged as warn
 *   5. BullMQ worker error handling     — worker.on('error') attaches logger, not unhandled
 *   6. Queue events error handling      — events.on('error') attaches logger, not unhandled
 *   7. Drain signal during disconnect   — drain respects in-memory flag before queue lookup
 *   8. Dead-letter on unrecoverable err — BullUnrecoverableError used for isolated/quarantined
 *   9. Build-phase guard                — canUseRuntimeRedis() returns false during build
 *  10. Edge-runtime guard               — canUseRuntimeRedis() returns false for edge runtime
 *
 * Run: npx tsx scripts/redis-chaos-test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve }      from 'node:path';

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

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

function containsAll(src: string, patterns: string[]): void {
  for (const p of patterns) {
    assert(src.includes(p), `Expected pattern not found: ${p}`);
  }
}

// ============================================================================
// Scenario 1: Redis unavailable at startup
// ============================================================================

test('startup-unavailable', 'canUseRuntimeRedis checks window (client guard)', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes("typeof window === 'undefined'"), 'Must guard against browser runtime');
});

test('startup-unavailable', 'canUseRuntimeRedis checks NEXT_RUNTIME edge guard', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes("NEXT_RUNTIME") && src.includes("'edge'"), 'Must reject edge runtime');
});

test('startup-unavailable', 'canUseRuntimeRedis checks REDIS_URL presence', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes('process.env.REDIS_URL'), 'Must check REDIS_URL env var');
  assert(src.includes('Boolean(process.env.REDIS_URL)'), 'Must return bool not string');
});

test('startup-unavailable', 'startRuntimeWorkers returns empty array when canStartWorkers is false', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('canStartWorkers'), 'startRuntimeWorkers must call canStartWorkers');
  assert(src.includes('if (!canStartWorkers()) return []'), 'Must return [] immediately');
});

test('startup-unavailable', 'startRuntimeWorkers returns empty array when redis connection is null', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('if (!redis) return []'), 'Must early-exit when redis is null');
});

// ============================================================================
// Scenario 2: Redis unavailable during enqueue (graceful degradation)
// ============================================================================

test('enqueue-degradation', 'enqueueRuntimeJob detects !queueEnabled and returns enqueued:false', () => {
  const src = readSrc('lib/runtime/queue.ts');
  containsAll(src, [
    'isQueueEnabled',
    'enqueued: false',
    'Queue subsystem disabled (REDIS_URL missing)',
  ]);
});

test('enqueue-degradation', 'enqueueRuntimeJob emits execution.failed event when queue is disabled', () => {
  const src = readSrc('lib/runtime/queue.ts');
  assert(src.includes("'execution.failed'"), 'Must emit execution.failed when queue disabled');
  assert(src.includes('Queue subsystem disabled'), 'event payload must include reason');
});

test('enqueue-degradation', 'getQueueHandle throws with clear message when Redis is not configured', () => {
  const src = readSrc('lib/runtime/queue.ts');
  assert(
    src.includes('REDIS_URL is not configured. Queue subsystem is disabled.'),
    'getQueueHandle must throw descriptive error'
  );
});

test('enqueue-degradation', 'getRedisStatus returns missing when connection is null', () => {
  const src = readSrc('lib/runtime/queue.ts');
  assert(src.includes("return 'missing'"), 'getRedisStatus must return missing');
  assert(src.includes("return 'connected'"), 'getRedisStatus must return connected on ping success');
  assert(src.includes("return 'error'"), 'getRedisStatus must return error on ping failure');
});

// ============================================================================
// Scenario 3: Reconnect storm protection
// ============================================================================

test('reconnect-storm', 'redis.ts uses exponential back-off with cap', () => {
  const src = readSrc('lib/runtime/redis.ts');
  containsAll(src, [
    'retryStrategy',
    'Math.min',
    '30_000',
  ]);
});

test('reconnect-storm', 'retry strategy caps at 30 seconds', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(
    src.includes('30_000') || src.includes('30000'),
    'Cap of 30 000ms must be present in retry strategy'
  );
});

test('reconnect-storm', 'maxRetriesPerRequest set to null (never give up per request)', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes('maxRetriesPerRequest: null'), 'maxRetriesPerRequest must be null for BullMQ compatibility');
});

// ============================================================================
// Scenario 4: Transient error classification
// ============================================================================

test('transient-errors', 'redis.ts classifies ECONNRESET/ECONNREFUSED as warn', () => {
  const src = readSrc('lib/runtime/redis.ts');
  containsAll(src, [
    'ECONNRESET',
    'ECONNREFUSED',
    "logger.warn('redis_connection_error'",
  ]);
});

test('transient-errors', 'queue.ts classifies transient errors as warn, non-transient as error', () => {
  const src = readSrc('lib/runtime/queue.ts');
  containsAll(src, [
    'ECONNRESET',
    'ECONNABORTED',
    'ECONNREFUSED',
    "isTransient ? 'warn' : 'error'",
    "'queue_error'",
  ]);
});

test('transient-errors', 'worker.ts classifies transient BullMQ errors as warn', () => {
  const src = readSrc('lib/runtime/worker.ts');
  containsAll(src, [
    'ECONNRESET',
    "'worker_error'",
    "isTransient ? 'warn' : 'error'",
  ]);
});

// ============================================================================
// Scenario 5: BullMQ worker error handling — no unhandled rejections
// ============================================================================

test('worker-error-handling', 'worker.on error handler is registered', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes("worker.on('error'"), "worker.on('error') handler must be registered");
});

test('worker-error-handling', 'worker error handler uses structured logger', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes("logger[isTransient ? 'warn' : 'error']('worker_error'"), 'Must use structured logger in worker error handler');
});

test('worker-error-handling', 'no raw console calls remain in worker.ts', () => {
  const src = readSrc('lib/runtime/worker.ts');
  const consoleMatches = src.match(/console\.(log|warn|error|info)/g) ?? [];
  assert(consoleMatches.length === 0, `Found ${consoleMatches.length} raw console call(s): ${consoleMatches.join(', ')}`);
});

// ============================================================================
// Scenario 6: Queue events error handling
// ============================================================================

test('queue-events-errors', 'events.on error handler is registered in queue.ts', () => {
  const src = readSrc('lib/runtime/queue.ts');
  assert(src.includes("events.on('error'"), "events.on('error') handler must be registered");
});

test('queue-events-errors', 'queue events error uses structured logger', () => {
  const src = readSrc('lib/runtime/queue.ts');
  assert(src.includes("'queue_events_error'"), 'Must emit queue_events_error event name');
});

test('queue-events-errors', 'no raw console calls remain in queue.ts', () => {
  const src = readSrc('lib/runtime/queue.ts');
  const consoleMatches = src.match(/console\.(log|warn|error|info)/g) ?? [];
  assert(consoleMatches.length === 0, `Found ${consoleMatches.length} raw console call(s): ${consoleMatches.join(', ')}`);
});

// ============================================================================
// Scenario 7: Drain signal during disconnect
// ============================================================================

test('drain-signal', 'worker checks in-memory drain flag before queue operations', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('isWorkerDraining'), 'Must call isWorkerDraining');
  assert(
    src.includes('isWorkerDrainingInMemory') || src.includes("'drain_signal_received'"),
    'Drain check must be present before job processing'
  );
});

test('drain-signal', 'drain cache uses in-memory and process-level fallback', () => {
  const src = readSrc('lib/runtime/worker.ts');
  containsAll(src, [
    'getDrainCache',
    'setDrainCache',
    "'drain_cache_hit'",
    "'drain_cache_miss'",
  ]);
});

test('drain-signal', 'drain causes job to be re-queued not silently dropped', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(
    src.includes('is draining, requeueing job'),
    'Worker must throw to requeue when draining'
  );
});

// ============================================================================
// Scenario 8: Dead-letter on unrecoverable errors
// ============================================================================

test('dead-letter', 'BullUnrecoverableError used for isolated executions', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('BullUnrecoverableError'), 'Must import and use BullUnrecoverableError');
  assert(src.includes('is isolated'), 'Must throw UnrecoverableError for isolated executions');
});

test('dead-letter', 'BullUnrecoverableError used for quarantined nodes', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('has a quarantined node'), 'Must throw UnrecoverableError for quarantined nodes');
});

test('dead-letter', 'deadLetterExecutionCommands imported and available', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(src.includes('deadLetterExecutionCommands'), 'deadLetterExecutionCommands must be imported');
});

// ============================================================================
// Scenario 9: Build-phase guard
// ============================================================================

test('build-guard', 'canUseRuntimeRedis returns false during NEXT_PHASE build', () => {
  const src = readSrc('lib/runtime/redis.ts');
  containsAll(src, [
    'NEXT_PHASE',
    'phase-production-build',
    'isBuildPhase',
  ]);
});

test('build-guard', 'canStartWorkers in worker.ts also guards against build phase', () => {
  const src = readSrc('lib/runtime/worker.ts');
  assert(
    src.includes("NEXT_PHASE") && src.includes('phase-production-build'),
    'worker.ts canStartWorkers must check NEXT_PHASE'
  );
});

// ============================================================================
// Scenario 10: Shutdown hook — connections closed on process exit
// ============================================================================

test('shutdown-hooks', 'registerShutdownHooks is called on first Redis connection', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes('registerShutdownHooks'), 'Must call registerShutdownHooks()');
});

test('shutdown-hooks', 'SIGINT and SIGTERM close all Redis connections', () => {
  const src = readSrc('lib/runtime/redis.ts');
  containsAll(src, ["'SIGINT'", "'SIGTERM'", "'beforeExit'", 'client.quit()']);
});

test('shutdown-hooks', 'redis clients map is cleared on shutdown', () => {
  const src = readSrc('lib/runtime/redis.ts');
  assert(src.includes('redisClients.clear()'), 'Must clear the clients map on shutdown');
});

// ============================================================================
// Results
// ============================================================================

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log('\n=== Redis Failure Chaos Test ===\n');

const bySection = results.reduce<Record<string, TestResult[]>>((acc, r) => {
  (acc[r.section] ??= []).push(r);
  return acc;
}, {});

for (const [section, tests] of Object.entries(bySection)) {
  const sectionFail = tests.filter((t) => !t.ok).length;
  const status = sectionFail === 0 ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${section}`);
  for (const t of tests) {
    const icon = t.ok ? '  ✓' : '  ✗';
    console.log(`${icon} ${t.name}`);
    if (!t.ok && t.message) {
      console.log(`      → ${t.message}`);
    }
  }
  console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exitCode = 1;
}
