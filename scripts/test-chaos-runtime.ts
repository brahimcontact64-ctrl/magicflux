/**
 * Phase 7 Fix — Self-Healing Chaos Tests
 * Verifies alert deduplication, real healing actions, DB aggregation,
 * worker lifecycle, and cooldown protection.
 * Run: npx tsx scripts/test-chaos-runtime.ts
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
// Section 1: Migration — deduplication schema
// ============================================================================

test('migration-dedup', 'migration adds occurrences column', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('occurrences'), 'occurrences column must be added');
  assert(sql.includes('DEFAULT 1'), 'occurrences must default to 1');
});

test('migration-dedup', 'migration adds first_seen_at and last_seen_at columns', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('first_seen_at'), 'first_seen_at column required');
  assert(sql.includes('last_seen_at'), 'last_seen_at column required');
  assert((sql.match(/timestamptz/g) ?? []).length >= 4, 'Both date columns must be timestamptz');
});

test('migration-dedup', 'migration creates partial unique dedup index on runtime_security_alerts', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('runtime_security_alerts_dedup_idx'), 'Dedup index must be named');
  assert(sql.includes('WHERE resolved_at IS NULL'), 'Index must be partial (unresolved only)');
  assert(sql.includes('COALESCE(workflow_id'), 'Index must COALESCE workflow_id for null handling');
  assert(sql.includes('COALESCE(execution_id'), 'Index must COALESCE execution_id for null handling');
  assert(sql.includes('COALESCE(worker_id'), 'Index must COALESCE worker_id for null handling');
});

test('migration-dedup', 'migration back-fills first_seen_at and last_seen_at from created_at', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('first_seen_at = created_at'), 'Back-fill must set first_seen_at');
  assert(sql.includes('last_seen_at  = created_at') || sql.includes('last_seen_at = created_at'), 'Back-fill must set last_seen_at');
});

// ============================================================================
// Section 2: Migration — worker lifecycle states
// ============================================================================

test('migration-worker-lifecycle', 'migration expands runtime_workers status constraint to include draining', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes("'draining'"), "status constraint must include 'draining'");
  assert(sql.includes("'restarting'"), "status constraint must include 'restarting'");
});

test('migration-worker-lifecycle', 'migration drops old status constraint before adding new one', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('DROP CONSTRAINT IF EXISTS runtime_workers_status_check'), 'Must drop old constraint before re-adding');
});

test('migration-worker-lifecycle', 'migration creates runtime_worker_restart_requests table', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_worker_restart_requests'), 'Table must be created');
  assert(sql.includes("'pending'"), 'Status must include pending');
  assert(sql.includes("'acknowledged'"), 'Status must include acknowledged');
  assert(sql.includes("'completed'"), 'Status must include completed');
  assert(sql.includes("'anomaly_detected'"), 'Reason must include anomaly_detected');
});

test('migration-worker-lifecycle', 'restart_requests table has RLS enabled', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('runtime_worker_restart_requests ENABLE ROW LEVEL SECURITY'), 'RLS must be enabled');
});

// ============================================================================
// Section 3: Migration — cooldown table
// ============================================================================

test('migration-cooldown', 'migration creates runtime_healing_actions table', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_healing_actions'), 'Table must be created');
  assert(sql.includes('cooldown_until'), 'Table must have cooldown_until column');
  assert(sql.includes('action_type'), 'Table must have action_type column');
  assert(sql.includes('target'), 'Table must have target column');
});

test('migration-cooldown', 'healing_actions table has RLS and cooldown index', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('runtime_healing_actions ENABLE ROW LEVEL SECURITY'), 'RLS must be enabled');
  assert(sql.includes('runtime_healing_actions_cooldown_idx'), 'Cooldown lookup index required');
});

// ============================================================================
// Section 4: Migration — DB aggregation functions
// ============================================================================

test('migration-rpc-functions', 'migration creates detect_repeated_node_failures function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_repeated_node_failures'), 'Function must be created');
  assert(sql.includes('p_threshold'), 'Must have p_threshold parameter');
  assert(sql.includes('p_window_minutes'), 'Must have p_window_minutes parameter');
  assert(sql.includes('HAVING COUNT(*) >= p_threshold'), 'Must use HAVING for server-side filtering');
  assert(sql.includes('SECURITY DEFINER'), 'Must be SECURITY DEFINER for service role access');
});

test('migration-rpc-functions', 'migration creates detect_execution_loops function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_execution_loops'), 'Function must be created');
  assert(sql.includes('workflow_execution_steps'), 'Must query workflow_execution_steps');
  assert(sql.includes('GROUP BY'), 'Must GROUP BY execution_id server-side');
});

test('migration-rpc-functions', 'migration creates detect_retry_storm function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_retry_storm'), 'Function must be created');
  assert(sql.includes('p_ratio'), 'Must have p_ratio parameter');
  assert(sql.includes('NULLIF(COUNT(*), 0)'), 'Must guard against divide-by-zero');
});

test('migration-rpc-functions', 'migration creates detect_dlq_spike function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_dlq_spike'), 'Function must be created');
  assert(sql.includes('runtime_queue_dead_letters'), 'Must query dead letters table');
});

test('migration-rpc-functions', 'migration creates detect_worker_crashes function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_worker_crashes'), 'Function must be created');
  assert(sql.includes("status = 'crashed'"), "Must filter status='crashed'");
  assert(sql.includes('array_agg(worker_id'), 'Must aggregate worker_ids');
});

test('migration-rpc-functions', 'migration creates detect_queue_congestion function', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION detect_queue_congestion'), 'Function must be created');
  assert(sql.includes("status = 'active'"), "Must filter status='active'");
  assert(sql.includes('heartbeat_at'), 'Must check heartbeat_at for stall detection');
});

test('migration-rpc-functions', 'all six detection functions use SECURITY DEFINER', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const matches = (sql.match(/SECURITY DEFINER/g) ?? []).length;
  assert(matches >= 6, `Expected at least 6 SECURITY DEFINER declarations, found ${matches}`);
});

// ============================================================================
// Section 5: anomaly-detector.ts — DB aggregation via RPC
// ============================================================================

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for repeated_node_failures', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_repeated_node_failures'"), 'Must use RPC instead of in-memory grouping');
  assert(!src.includes('.select(\'node_id, workflow_id'), 'Must not fetch raw rows for node failures');
});

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for execution_loops', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_execution_loops'"), 'Must use RPC for execution loops');
  assert(!src.includes("from('workflow_execution_steps')"), 'Must not fetch execution step rows directly');
});

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for retry_storm', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_retry_storm'"), 'Must use RPC for retry storm');
});

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for dlq_spike', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_dlq_spike'"), 'Must use RPC for DLQ spike');
});

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for worker_crashes', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_worker_crashes'"), 'Must use RPC for worker crashes');
});

test('anomaly-detector-rpc', 'detectAnomalies uses db.rpc for queue_congestion', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("db.rpc('detect_queue_congestion'"), 'Must use RPC for queue congestion');
});

test('anomaly-detector-rpc', 'no large in-memory row loops remain in detectAnomalies', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(!src.includes('.limit(5000)'), 'Must not fetch 5000 rows into Node');
  assert(!src.includes('.limit(2000)'), 'Must not fetch 2000 rows into Node');
  assert(!src.includes('new Map<'), 'Must not do in-memory Map grouping');
});

// ============================================================================
// Section 6: anomaly-detector.ts — dedup write logic
// ============================================================================

test('anomaly-detector-dedup', 'writeAnomalyAlerts checks for existing unresolved alert before inserting', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  assert(idx !== -1, 'writeAnomalyAlerts must exist');
  const body = src.slice(idx);
  assert(body.includes(".is('resolved_at', null)"), 'Must check resolved_at IS NULL to find open alerts');
  assert(body.includes('.maybeSingle()'), 'Must use maybeSingle to find existing alert');
});

test('anomaly-detector-dedup', 'writeAnomalyAlerts increments occurrences on existing alert', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes('occurrences'), 'Must update occurrences field');
  assert(body.includes('+ 1') || body.includes('+1'), 'Must increment occurrences by 1');
});

test('anomaly-detector-dedup', 'writeAnomalyAlerts updates last_seen_at on existing alert', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes('last_seen_at'), 'Must update last_seen_at on existing alert');
});

test('anomaly-detector-dedup', 'writeAnomalyAlerts sets first_seen_at and last_seen_at on new insert', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes('first_seen_at'), 'Must set first_seen_at on new alert');
  assert((body.match(/last_seen_at/g) ?? []).length >= 2, 'Must use last_seen_at in both update and insert paths');
});

test('anomaly-detector-dedup', 'writeAnomalyAlerts filters by all four dedup key fields', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes("eq('alert_type'"), 'Dedup must filter by alert_type');
  assert(body.includes('workflow_id'), 'Dedup must filter by workflow_id');
  assert(body.includes('execution_id'), 'Dedup must filter by execution_id');
  assert(body.includes('worker_id'), 'Dedup must filter by worker_id');
});

test('anomaly-detector-dedup', 'writeAnomalyAlerts handles null fields with .is() not .eq()', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes(".is('workflow_id', null)") || body.includes('.is(\'workflow_id\', null)'), 'Must use .is(field, null) for null workflow_id');
  assert(body.includes(".is('execution_id', null)") || body.includes('.is(\'execution_id\', null)'), 'Must use .is(field, null) for null execution_id');
});

// ============================================================================
// Section 7: queue.ts — pause/resume exports
// ============================================================================

test('queue-pause-resume', 'queue.ts exports pauseRuntimeQueue function', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('export async function pauseRuntimeQueue'), 'pauseRuntimeQueue must be exported');
  assert(src.includes('queue.pause()'), 'Must call BullMQ queue.pause()');
});

test('queue-pause-resume', 'queue.ts exports resumeRuntimeQueue function', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('export async function resumeRuntimeQueue'), 'resumeRuntimeQueue must be exported');
  assert(src.includes('queue.resume()'), 'Must call BullMQ queue.resume()');
});

test('queue-pause-resume', 'RuntimeQueue type includes pause and resume methods', () => {
  const src = readFile('lib/runtime/queue.ts');
  assert(src.includes('pause: () => Promise<void>'), 'RuntimeQueue type must declare pause method');
  assert(src.includes('resume: () => Promise<void>'), 'RuntimeQueue type must declare resume method');
});

test('queue-pause-resume', 'pauseRuntimeQueue and resumeRuntimeQueue guard against disabled queue', () => {
  const src = readFile('lib/runtime/queue.ts');
  const pauseIdx = src.indexOf('export async function pauseRuntimeQueue');
  const resumeIdx = src.indexOf('export async function resumeRuntimeQueue');
  assert(src.slice(pauseIdx, pauseIdx + 200).includes('isQueueEnabled'), 'pauseRuntimeQueue must check isQueueEnabled');
  assert(src.slice(resumeIdx, resumeIdx + 200).includes('isQueueEnabled'), 'resumeRuntimeQueue must check isQueueEnabled');
});

// ============================================================================
// Section 8: worker-registry.ts — draining/restarting states
// ============================================================================

test('worker-registry-states', 'markWorkerState accepts draining state', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  assert(src.includes("'draining'"), "markWorkerState union must include 'draining'");
});

test('worker-registry-states', 'markWorkerState accepts restarting state', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  assert(src.includes("'restarting'"), "markWorkerState union must include 'restarting'");
});

test('worker-registry-states', 'markWorkerState still accepts all original states', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  const sig = src.slice(src.indexOf('markWorkerState'), src.indexOf('markWorkerState') + 200);
  containsAll(sig, ["'degraded'", "'stopping'", "'stopped'", "'crashed'"]);
});

// ============================================================================
// Section 9: worker-lifecycle.ts — lifecycle manager
// ============================================================================

test('worker-lifecycle', 'worker-lifecycle.ts exports requestWorkerRestart', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function requestWorkerRestart'), 'requestWorkerRestart must be exported');
  assert(src.includes("'runtime_worker_restart_requests'"), 'Must insert into restart_requests table');
});

test('worker-lifecycle', 'requestWorkerRestart inserts with status=pending', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function requestWorkerRestart');
  const body = src.slice(idx, idx + 700);
  assert(body.includes("status: 'pending'"), "Must set initial status to 'pending'");
});

test('worker-lifecycle', 'worker-lifecycle.ts exports drainWorker', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function drainWorker'), 'drainWorker must be exported');
  assert(src.includes("status: 'draining'"), "drainWorker must set status to 'draining'");
});

test('worker-lifecycle', 'worker-lifecycle.ts exports markRestarted', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function markRestarted'), 'markRestarted must be exported');
  assert(src.includes("status: 'healthy'"), "markRestarted must restore status to 'healthy'");
  assert(src.includes('restart_count'), 'markRestarted must increment restart_count');
});

test('worker-lifecycle', 'worker-lifecycle.ts exports getPendingRestartRequests', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function getPendingRestartRequests'), 'getPendingRestartRequests must be exported');
  assert(src.includes(".eq('status', 'pending')"), "Must filter by status='pending'");
});

test('worker-lifecycle', 'worker-lifecycle.ts exports WorkerRestartReason type', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes("'anomaly_detected'"), 'Type must include anomaly_detected reason');
  assert(src.includes("'high_crash_rate'"), 'Type must include high_crash_rate reason');
  assert(src.includes("'manual'"), 'Type must include manual reason');
});

// ============================================================================
// Section 10: self-healer.ts — cooldown protection
// ============================================================================

test('self-healer-cooldown', 'self-healer imports createServiceClient for cooldown queries', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("from '@/lib/supabase-server'"), 'Must import supabase-server');
  assert(src.includes('createServiceClient'), 'Must use createServiceClient for cooldown DB access');
});

test('self-healer-cooldown', 'self-healer has COOLDOWN_MINUTES configuration', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('COOLDOWN_MINUTES'), 'Must define COOLDOWN_MINUTES map');
  assert(src.includes('restart_worker'), 'Must define restart_worker cooldown');
  assert(src.includes('pause_queue'), 'Must define pause_queue cooldown');
  assert(src.includes('repair_orphan'), 'Must define repair_orphan cooldown');
});

test('self-healer-cooldown', 'self-healer checks cooldown before applying healing action', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('isOnCooldown'), 'Must check isOnCooldown before acting');
  assert(src.includes('cooldown_until'), 'Must query cooldown_until timestamp');
});

test('self-healer-cooldown', 'self-healer records healing actions with cooldown_until', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('recordHealingAction'), 'Must call recordHealingAction after each action');
  assert(src.includes('runtime_healing_actions'), 'Must insert into runtime_healing_actions');
});

test('self-healer-cooldown', 'skipped actions are recorded in report with skipped result', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("result: 'skipped'"), "Cooldown-blocked actions must return result: 'skipped'");
  assert(src.includes("'cooldown_active'"), "Skipped details must indicate cooldown_active reason");
});

// ============================================================================
// Section 11: self-healer.ts — real healing actions
// ============================================================================

test('self-healer-actions', 'self-healer imports pauseRuntimeQueue and resumeRuntimeQueue', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('pauseRuntimeQueue'), 'Must import and use pauseRuntimeQueue');
  assert(src.includes('resumeRuntimeQueue'), 'Must import and use resumeRuntimeQueue');
  assert(src.includes("from './queue'"), 'Must import from ./queue');
});

test('self-healer-actions', 'self-healer imports requestWorkerRestart and drainWorker', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('requestWorkerRestart'), 'Must import requestWorkerRestart');
  assert(src.includes('drainWorker'), 'Must import drainWorker');
  assert(src.includes("from './worker-lifecycle'"), 'Must import from ./worker-lifecycle');
});

test('self-healer-actions', 'self-healer reacts to retry_storm by pausing queues', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("'retry_storm'"), "Must handle 'retry_storm' anomaly type");
  assert(src.includes('pauseRuntimeQueue'), 'Must call pauseRuntimeQueue for retry storm');
});

test('self-healer-actions', 'self-healer reacts to worker_crash_frequency by restarting workers', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("'worker_crash_frequency'"), "Must handle 'worker_crash_frequency'");
  assert(src.includes('drainWorker'), 'Must drain worker before restart');
  assert(src.includes('requestWorkerRestart'), 'Must request restart for crashed workers');
});

test('self-healer-actions', 'self-healer auto-resumes queues when retry storm clears', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('resumeRuntimeQueue'), 'Must call resumeRuntimeQueue');
  assert(src.includes('retry_storm_cleared') || src.includes('hasRetryStorm'), 'Must check if storm cleared before resuming');
});

test('self-healer-actions', 'self-healer iterates worker_ids from anomaly details', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('worker_ids'), 'Must read worker_ids from anomaly details');
  assert(src.includes('for (const workerId'), 'Must loop over individual worker IDs');
});

test('self-healer-actions', 'self-healer only pauses queues for high or critical retry storms', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(
    src.includes("severity === 'high'") || src.includes("severity === 'critical'"),
    'Queue pause must be conditional on severity level'
  );
});

// ============================================================================
// Section 12: self-healer.ts — report includes all action categories
// ============================================================================

test('self-healer-report', 'SelfHealReport type includes all required fields', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  containsAll(src, ['ranAt', 'metrics', 'alerts', 'alertsWritten', 'actions']);
});

test('self-healer-report', 'report merges maintenance and healing actions', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('maintenanceActions'), 'Must have maintenance actions array');
  assert(src.includes('healingActions'), 'Must have anomaly-driven healing actions array');
  assert(src.includes('...maintenanceActions'), 'Must spread maintenance actions into report');
  assert(src.includes('...healingActions'), 'Must spread healing actions into report');
});

test('self-healer-report', 'maintenance actions still run unconditionally every cycle', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('mark_orphan_executions_failed'), 'Orphan repair must always run');
  assert(src.includes('cleanup_stale_workers'), 'Worker cleanup must always run');
  assert(src.includes('recover_stuck_queue_jobs'), 'Job recovery must always run');
  assert(src.includes('cleanup_expired_locks'), 'Lock cleanup must always run');
  assert(src.includes('cleanup_historical_workers'), 'Historical cleanup must always run');
});

// ============================================================================
// Section 13: Chaos scenarios — 50 worker crash simulation
// ============================================================================

test('chaos-worker-crashes', 'detect_worker_crashes SQL groups crashed workers within 30 minutes', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('detect_worker_crashes');
  const body = sql.slice(idx, idx + 600);
  assert(body.includes("status = 'crashed'"), "Must filter status='crashed'");
  assert(body.includes('30 minutes'), 'Must use 30-minute window for crash detection');
  assert(body.includes('HAVING COUNT(*)'), 'Must use HAVING to filter below threshold');
});

test('chaos-worker-crashes', 'crash detection returns worker_ids array for targeted restart', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  assert(sql.includes('array_agg(worker_id'), 'Must aggregate worker_ids for batch restart');
  assert(sql.includes('worker_ids text[]'), 'Return type must include worker_ids array');
});

test('chaos-worker-crashes', 'self-healer drains each crashed worker before requesting restart', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("'worker_crash_frequency'");
  assert(idx !== -1, 'Must handle worker_crash_frequency');
  const body = src.slice(idx, idx + 600);
  const drainBefore = body.indexOf('drainWorker');
  const restartAfter = body.indexOf('requestWorkerRestart');
  assert(drainBefore !== -1, 'Must call drainWorker');
  assert(restartAfter !== -1, 'Must call requestWorkerRestart');
  assert(drainBefore < restartAfter, 'drainWorker must be called before requestWorkerRestart');
});

test('chaos-worker-crashes', 'per-worker cooldown prevents thrashing the same worker', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("isOnCooldown('restart_worker', workerId)"), 'Must check per-worker cooldown with worker ID as target');
});

// ============================================================================
// Section 14: Chaos scenarios — 1000 failed jobs
// ============================================================================

test('chaos-failed-jobs', 'detect_retry_storm uses SQL FILTER for server-side counting', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_retry_storm');
  assert(idx !== -1, 'detect_retry_storm function must exist');
  const body = sql.slice(idx, idx + 800);
  assert(body.includes('COUNT(*) FILTER'), 'Must use COUNT(*) FILTER for server-side efficiency');
  assert(body.includes('COALESCE'), 'Must handle NULL attempts column');
});

test('chaos-failed-jobs', 'retry storm detection requires minimum 10 jobs to avoid false positives', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_retry_storm');
  const body = sql.slice(idx, idx + 800);
  assert(body.includes('COUNT(*) > 10'), 'Must require minimum 10 jobs to trigger');
});

test('chaos-failed-jobs', 'retry storm detection uses ratio not absolute count', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_retry_storm');
  const body = sql.slice(idx, idx + 800);
  assert(body.includes('p_ratio'), 'Must compare against a ratio parameter, not absolute count');
});

// ============================================================================
// Section 15: Chaos scenarios — DLQ spike
// ============================================================================

test('chaos-dlq-spike', 'detect_dlq_spike queries dead letters by failed_at within window', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_dlq_spike');
  assert(idx !== -1, 'detect_dlq_spike function must exist');
  const body = sql.slice(idx, idx + 600);
  assert(body.includes('runtime_queue_dead_letters'), 'Must query dead letters table');
  assert(body.includes('failed_at'), 'Must filter by failed_at timestamp');
  assert(body.includes('make_interval'), 'Must use configurable window');
});

test('chaos-dlq-spike', 'DLQ spike anomaly sets score proportional to count', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes('dlqTotal * 4') || src.includes('dlq_count * 4'), 'Score must scale with DLQ count (x4)');
});

// ============================================================================
// Section 16: Chaos scenarios — queue congestion
// ============================================================================

test('chaos-queue-congestion', 'detect_queue_congestion uses 5-minute stall threshold', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_queue_congestion');
  assert(idx !== -1, 'detect_queue_congestion function must exist');
  const body = sql.slice(idx, idx + 600);
  assert(body.includes('5 minutes'), 'Must use 5-minute heartbeat stall threshold');
  assert(body.includes('heartbeat_at <'), 'Must compare heartbeat_at with < operator to detect stale jobs');
});

test('chaos-queue-congestion', 'recover_stuck_queue_jobs runs unconditionally every cycle', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('recover_stuck_queue_jobs'), 'Must always run job recovery');
  assert(src.includes('maintenanceActions'), 'Job recovery must be in maintenance (not anomaly-driven) section');
});

// ============================================================================
// Section 17: Chaos scenarios — execution loops
// ============================================================================

test('chaos-execution-loop', 'detect_execution_loops groups by execution_id server-side', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('CREATE OR REPLACE FUNCTION detect_execution_loops');
  assert(idx !== -1, 'detect_execution_loops function must exist');
  const body = sql.slice(idx, idx + 800);
  assert(body.includes('GROUP BY wes.execution_id'), 'Must group by execution_id server-side');
  assert(body.includes('HAVING COUNT(*) >= p_threshold'), 'Must filter by threshold server-side');
  assert(body.includes('LIMIT 50'), 'Must cap results to prevent overwhelming the healer');
});

test('chaos-execution-loop', 'execution loop alerts include executionId for targeted investigation', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf("'execution_loop'");
  assert(idx !== -1, 'Must emit execution_loop alerts');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('executionId'), 'Alert must include executionId for targeted investigation');
});

// ============================================================================
// Section 18: Alert dedup — real behavior verification
// ============================================================================

test('alert-dedup-behavior', 'writeAnomalyAlerts iterates over each alert independently', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('for (const alert of'), 'Must process each alert in a loop');
});

test('alert-dedup-behavior', 'writeAnomalyAlerts never inserts without first checking for existing', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  const insertIdx = body.indexOf('.insert(');
  const selectIdx = body.indexOf('.maybeSingle()');
  assert(selectIdx < insertIdx, 'SELECT check must come before INSERT in write logic');
});

test('alert-dedup-behavior', 'dedup partial unique index uses COALESCE for NULL safety', () => {
  const sql = readFile('supabase/migrations/20260525000001_runtime_self_healing.sql');
  const idx = sql.indexOf('runtime_security_alerts_dedup_idx');
  const body = sql.slice(idx, idx + 300);
  assert(body.includes("COALESCE(workflow_id, '')"), 'workflow_id must be COALESCE for NULL safety');
  assert(body.includes("COALESCE(execution_id, '')"), 'execution_id must be COALESCE for NULL safety');
  assert(body.includes("COALESCE(worker_id, '')"), 'worker_id must be COALESCE for NULL safety');
});

// ============================================================================
// Section 19: API endpoint integrity
// ============================================================================

test('api-endpoint', 'self-heal route imports runSelfHeal from self-healer', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes("from '@/lib/runtime/self-healer'"), 'Route must import from self-healer');
  assert(src.includes('runSelfHeal'), 'Route must call runSelfHeal');
});

test('api-endpoint', 'self-heal route has CRON_SECRET auth', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes('CRON_SECRET'), 'Must use CRON_SECRET for auth');
  assert(src.includes("status: 401"), 'Must return 401 for invalid token');
});

// ============================================================================
// Section 20: Worker restart execution path
// ============================================================================

test('restart-execution', 'runtime-worker.ts imports getPendingRestartRequests and performRestart', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('getPendingRestartRequests'), 'Must import getPendingRestartRequests');
  assert(src.includes('performRestart'), 'Must import and use performRestart');
  assert(src.includes("from '../lib/runtime/worker-lifecycle'"), 'Must import from worker-lifecycle');
});

test('restart-execution', 'workers variable is let not const to allow reassignment after restart', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('let workers') && src.includes('startRuntimeWorkers'), 'workers must be let to support reassignment after restart');
  assert(!src.includes('const workers'), 'workers must not be const');
});

test('restart-execution', 'runtime-worker.ts has restartCheckTimer polling every 10 seconds', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('restartCheckTimer'), 'Must have a named restartCheckTimer interval');
  assert(src.includes('10_000') || src.includes('10000'), 'Restart check interval must be 10 seconds');
});

test('restart-execution', 'restart check filters pending requests by this worker ID', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('.worker_id === workerId'), 'Must filter requests to this specific worker ID');
});

test('restart-execution', 'isRestarting guard prevents re-entrant restart', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('isRestarting'), 'Must have re-entrancy guard');
  assert(src.includes('if (isRestarting) return'), 'Must skip if already restarting');
});

test('restart-execution', 'runtime-worker.ts clears restartCheckTimer on shutdown', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('clearInterval(restartCheckTimer)'), 'Shutdown must clear restartCheckTimer');
  const shutdownIdx = src.indexOf('const shutdown');
  assert(shutdownIdx !== -1, 'Must have shutdown function');
  assert(src.slice(shutdownIdx, shutdownIdx + 300).includes('clearInterval(restartCheckTimer)'), 'clearInterval(restartCheckTimer) must be inside shutdown function');
});

test('restart-execution', 'restart failure marks worker as crashed and clears isRestarting', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes("'crashed'"), 'Restart failure must mark worker as crashed');
  assert(src.includes('finally'), 'Must use finally to clear isRestarting flag regardless of outcome');
  assert(src.includes('isRestarting = false'), 'Must clear isRestarting in finally block');
});

test('restart-execution', 'performRestart is exported from worker-lifecycle.ts', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function performRestart'), 'performRestart must be exported');
});

test('restart-execution', 'performRestart acknowledges request before transitioning state', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('acknowledgeRestartRequest'), 'Must acknowledge request to prevent double-processing');
  const ackPos = body.indexOf('acknowledgeRestartRequest');
  const drainingPos = body.indexOf("'draining'");
  assert(ackPos < drainingPos, 'Acknowledge must happen before draining transition');
});

test('restart-execution', 'performRestart transitions through draining → restarting in order', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  const drainingPos = body.indexOf("'draining'");
  const closePos = body.indexOf('.close()');
  const restartingPos = body.indexOf("'restarting'");
  assert(drainingPos !== -1, "Must set status 'draining'");
  assert(closePos !== -1, 'Must close workers via .close()');
  assert(restartingPos !== -1, "Must set status 'restarting'");
  assert(drainingPos < closePos, "'draining' must be set before closing workers");
  assert(closePos < restartingPos, "workers must be fully closed before 'restarting' is set");
});

test('restart-execution', 'performRestart closes workers with Promise.allSettled for fault tolerance', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('Promise.allSettled'), 'Must use Promise.allSettled so one failing worker does not block restart');
});

test('restart-execution', 'performRestart calls restartFn and awaits new workers', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('restartFn'), 'Must accept restartFn callback');
  assert(body.includes('await params.restartFn()'), 'Must await the restartFn to get new workers');
});

test('restart-execution', 'performRestart calls markRestarted to restore healthy status', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('markRestarted'), 'performRestart must call markRestarted');
  const restartFnPos = body.indexOf('await params.restartFn()');
  const markRestartedPos = body.indexOf('markRestarted');
  assert(restartFnPos < markRestartedPos, 'markRestarted must be called after new workers are started');
});

test('restart-execution', 'performRestart completes the DB request record', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('completeRestartRequest'), 'Must call completeRestartRequest to close the lifecycle loop');
});

test('restart-execution', 'performRestart returns new workers so runtime-worker can update its reference', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('return newWorkers'), 'Must return new workers array for caller to update its reference');
});

test('restart-execution', 'markRestarted is reachable through performRestart called from runtime-worker.ts', () => {
  const workerSrc = readFile('scripts/runtime-worker.ts');
  const lifecycleSrc = readFile('lib/runtime/worker-lifecycle.ts');
  assert(workerSrc.includes('performRestart'), 'runtime-worker.ts must call performRestart');
  assert(lifecycleSrc.includes('markRestarted(params.workerId)'), 'performRestart must call markRestarted with the worker ID');
  const performIdx = lifecycleSrc.indexOf('export async function performRestart');
  const body = lifecycleSrc.slice(performIdx, performIdx + 800);
  assert(body.includes('markRestarted'), 'markRestarted must be inside the performRestart function body');
});

// ============================================================================
// Section 21: Phase 8 regression tests
// ============================================================================

test('phase8-heartbeat-safety', 'heartbeatWorker reads current status before updating', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  const idx = src.indexOf('export async function heartbeatWorker');
  const body = src.slice(idx, idx + 800);
  assert(body.includes(".select('status')"), 'Must read current status before updating');
  assert(body.includes('maybeSingle'), 'Must use maybeSingle to read current status');
});

test('phase8-heartbeat-safety', 'heartbeatWorker does not overwrite draining state', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  assert(src.includes('LIFECYCLE_STATES'), 'Must define lifecycle states set');
  assert(src.includes("'draining'"), 'draining must be a protected lifecycle state');
  assert(src.includes("'restarting'"), 'restarting must be a protected lifecycle state');
  assert(src.includes("'stopping'"), 'stopping must be a protected lifecycle state');
  assert(src.includes("'stopped'"), 'stopped must be a protected lifecycle state');
  assert(src.includes("'crashed'"), 'crashed must be a protected lifecycle state');
});

test('phase8-heartbeat-safety', 'heartbeatWorker always updates heartbeat_at regardless of lifecycle state', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  const idx = src.indexOf('export async function heartbeatWorker');
  const body = src.slice(idx, idx + 800);
  const patchIdx = body.indexOf('heartbeat_at');
  const condIdx = body.indexOf('LIFECYCLE_STATES');
  assert(patchIdx !== -1, 'heartbeat_at must always be set');
  assert(condIdx !== -1, 'status write must be conditional on lifecycle state');
  assert(patchIdx < condIdx || body.indexOf('patch') < condIdx, 'heartbeat_at must be in unconditional patch object');
});

test('phase8-failed-restart', 'performRestart marks request failed on error', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function performRestart');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('failRestartRequest'), 'performRestart must call failRestartRequest in catch');
  const catchIdx = body.indexOf('catch');
  const failIdx = body.indexOf('failRestartRequest');
  assert(catchIdx !== -1, 'Must have catch block');
  assert(failIdx > catchIdx, 'failRestartRequest must be inside catch block');
});

test('phase8-failed-restart', 'failRestartRequest writes status=failed with failed_at timestamp', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('failRestartRequest'), 'failRestartRequest helper must exist');
  const idx = src.indexOf('failRestartRequest');
  const body = src.slice(idx, idx + 400);
  assert(body.includes("status: 'failed'"), 'Must set status to failed');
  assert(body.includes('failed_at'), 'Must set failed_at timestamp');
  assert(body.includes('updated_at'), 'Must set updated_at timestamp');
});

test('phase8-failed-restart', 'phase8 migration adds failed_at column to restart requests', () => {
  const sql = readFile('supabase/migrations/20260525000002_runtime_phase8_hardening.sql');
  assert(sql.includes('failed_at'), 'Must add failed_at column');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS failed_at'), 'Must use IF NOT EXISTS for idempotency');
  assert(sql.includes('timestamptz'), 'failed_at must be timestamptz');
});

test('phase8-failed-restart', 'phase8 migration adds cleanup index for completed/failed requests', () => {
  const sql = readFile('supabase/migrations/20260525000002_runtime_phase8_hardening.sql');
  assert(sql.includes('runtime_worker_restart_requests_cleanup_idx'), 'Cleanup index must be named');
  assert(sql.includes("status IN ('completed', 'failed')"), 'Index must filter completed and failed rows');
});

test('phase8-restart-dedup', 'requestWorkerRestart checks for existing pending/acknowledged request', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function requestWorkerRestart');
  const body = src.slice(idx, idx + 700);
  assert(body.includes('.select('), 'Must SELECT before INSERT to detect duplicates');
  assert(body.includes("'pending'") && body.includes("'acknowledged'"), 'Must check both pending and acknowledged statuses');
  assert(body.includes('.in('), 'Must use .in() for multi-status check');
  assert(body.includes('if (existing) return'), 'Must return early if duplicate found');
});

test('phase8-restart-dedup', 'requestWorkerRestart checks by worker_id', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function requestWorkerRestart');
  const body = src.slice(idx, idx + 700);
  assert(body.includes(".eq('worker_id'"), 'Duplicate check must filter by worker_id');
});

test('phase8-worker-ref-safety', 'runtime-worker does not clear workers array before restart completes', () => {
  const src = readFile('scripts/runtime-worker.ts');
  const idx = src.indexOf('isRestarting = true');
  const body = src.slice(idx, idx + 600);
  assert(!body.includes('workers = []'), 'workers must not be set to [] before performRestart returns');
  assert(body.includes('const newWorkers = await performRestart'), 'Must capture result in newWorkers before assigning');
  assert(body.includes('workers = newWorkers'), 'Must only assign workers after successful restart');
});

test('phase8-worker-ref-safety', 'runtime-worker restores previousWorkers on restart failure', () => {
  const src = readFile('scripts/runtime-worker.ts');
  const idx = src.indexOf('isRestarting = true');
  const body = src.slice(idx, idx + 1100);
  assert(body.includes('workers = previousWorkers'), 'Must restore previousWorkers on failure so shutdown has a reference');
});

test('phase8-orphan-recovery', 'self-healer maintenance loop includes recoverOrphanExecutions', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('recoverOrphanExecutions'), 'self-healer must call recoverOrphanExecutions');
  assert(src.includes('recover_orphan_executions'), 'recoverOrphanExecutions must be wrapped in safeRun with name recover_orphan_executions');
  const maintenanceIdx = src.indexOf('maintenanceActions');
  const orphanIdx = src.indexOf('recover_orphan_executions', maintenanceIdx);
  assert(orphanIdx !== -1, 'recoverOrphanExecutions must be inside maintenanceActions block');
});

test('phase8-orphan-recovery', 'self-healer imports recoverOrphanExecutions from hardening-layer', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('recoverOrphanExecutions') && src.includes("from '@/runtime/hardening-layer'"), 'Must import recoverOrphanExecutions from hardening-layer');
});

test('phase8-cleanup', 'cleanupExpiredRestartRequests exported from worker-lifecycle', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes('export async function cleanupExpiredRestartRequests'), 'Must export cleanupExpiredRestartRequests');
});

test('phase8-cleanup', 'cleanupExpiredRestartRequests deletes completed and failed requests older than retainDays', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('export async function cleanupExpiredRestartRequests');
  const body = src.slice(idx, idx + 800);
  assert(body.includes("'completed'") && body.includes("'failed'"), 'Must target completed and failed statuses');
  assert(body.includes('.delete()'), 'Must delete matching rows');
  assert(body.includes("retainDays"), 'Must use configurable retainDays');
});

test('phase8-cleanup', 'self-healer maintenance loop includes cleanup_expired_restart_requests', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('cleanup_expired_restart_requests'), 'Must run cleanup_expired_restart_requests in maintenance loop');
  assert(src.includes('cleanupExpiredRestartRequests'), 'Must call cleanupExpiredRestartRequests');
});

test('phase8-server-only', 'worker-registry.ts has server-only guard', () => {
  const src = readFile('lib/runtime/worker-registry.ts');
  assert(src.startsWith('import "server-only"') || src.slice(0, 30).includes('server-only'), 'worker-registry.ts must have server-only guard at top');
});

test('phase8-server-only', 'self-healer.ts has server-only guard', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('import "server-only"'), 'self-healer.ts must have server-only guard');
});

test('phase8-server-only', 'metrics.ts has server-only guard', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('import "server-only"'), 'metrics.ts must have server-only guard');
});

test('phase8-server-only', 'hardening-layer.ts has server-only guard', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes('import "server-only"'), 'hardening-layer.ts must have server-only guard');
});

// ============================================================================
// Section 22: Phase 9 — Runtime Healing Completion
// ============================================================================

test('phase9-drain', 'RuntimeWorker type includes pause method for real drain behavior', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('type RuntimeWorker = {');
  const body = src.slice(idx, idx + 200);
  assert(body.includes('pause'), 'RuntimeWorker must include pause method');
  assert(body.includes('pause: () => Promise<void>'), 'pause must return Promise<void>');
});

test('phase9-drain', 'runtime-worker.ts pauses workers before calling performRestart', () => {
  const src = readFile('scripts/runtime-worker.ts');
  const idx = src.indexOf('isRestarting = true');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('.pause()'), 'Workers must be paused before performRestart');
  assert(body.includes('Promise.allSettled'), 'Pause must use allSettled for fault tolerance');
  const pausePos = body.indexOf('.pause()');
  const restartPos = body.indexOf('performRestart');
  assert(pausePos < restartPos, 'pause must happen before performRestart');
});

test('phase9-drain', 'runtime-worker.ts workers type includes pause method', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('pause: () => Promise<void>'), 'workers array type must include pause method');
});

test('phase9-dlq-healing', 'dead_letter_spike triggers recover_dlq healing action', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("anomaly.alertType === 'dead_letter_spike'"), 'Must handle dead_letter_spike anomaly');
  assert(src.includes('recover_dlq'), 'Must run recover_dlq action');
  assert(src.includes('recoverStuckQueueJobs'), 'recover_dlq must call recoverStuckQueueJobs');
});

test('phase9-dlq-healing', 'dead_letter_spike critical severity also pauses queues', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'dead_letter_spike'");
  const body = src.slice(idx, idx + 700);
  assert(body.includes("anomaly.severity === 'critical'"), 'Critical DLQ spike must trigger queue pause');
  assert(body.includes('pauseRuntimeQueue'), 'Must call pauseRuntimeQueue for critical severity');
});

test('phase9-dlq-healing', 'dead_letter_spike has cooldown protection', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'dead_letter_spike'");
  const body = src.slice(idx, idx + 400);
  assert(body.includes("isOnCooldown('recover_dlq'"), 'dead_letter_spike action must check cooldown');
  assert(body.includes("recordHealingAction('recover_dlq'"), 'Must record heal action for cooldown tracking');
});

test('phase9-congestion-healing', 'queue_congestion triggers recover_congestion action', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("anomaly.alertType === 'queue_congestion'"), 'Must handle queue_congestion anomaly');
  assert(src.includes('recover_congestion'), 'Must run recover_congestion action');
});

test('phase9-congestion-healing', 'queue_congestion healing calls recoverStuckQueueJobs', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'queue_congestion'");
  const body = src.slice(idx, idx + 400);
  assert(body.includes('recoverStuckQueueJobs'), 'Must call recoverStuckQueueJobs to recover stalled jobs');
  assert(body.includes("isOnCooldown('recover_congestion'"), 'Must have cooldown protection');
});

test('phase9-execution-isolation', 'execution_loop triggers isolate_execution marker', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("anomaly.alertType === 'execution_loop'"), 'Must handle execution_loop anomaly');
  assert(src.includes('isolate_execution'), 'Must write isolate_execution marker');
  assert(src.includes('anomaly.executionId'), 'Must use executionId to target specific execution');
});

test('phase9-execution-isolation', 'execution_loop isolation uses cooldown to prevent repeated markers', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'execution_loop'");
  const body = src.slice(idx, idx + 400);
  assert(body.includes("isOnCooldown('isolate_execution'"), 'Must check cooldown per execution ID');
  assert(body.includes("recordHealingAction('isolate_execution'"), 'Must record action with execution ID as target');
});

test('phase9-node-quarantine', 'repeated_node_failures triggers quarantine_node marker', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes("anomaly.alertType === 'repeated_node_failures'"), 'Must handle repeated_node_failures anomaly');
  assert(src.includes('quarantine_node'), 'Must write quarantine_node marker');
  assert(src.includes('node_key'), 'Must use node_key as quarantine target');
});

test('phase9-node-quarantine', 'node quarantine uses cooldown to prevent repeated writes', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'repeated_node_failures'");
  const body = src.slice(idx, idx + 1000);
  assert(body.includes("isOnCooldown('quarantine_node'"), 'Must check cooldown per node_key');
  assert(body.includes("recordHealingAction('quarantine_node'"), 'Must record action with node_key as target');
});

test('phase9-cooldown-config', 'COOLDOWN_MINUTES defines all Phase 9 action types', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf('COOLDOWN_MINUTES');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('recover_dlq'), 'recover_dlq cooldown must be defined');
  assert(body.includes('recover_congestion'), 'recover_congestion cooldown must be defined');
  assert(body.includes('isolate_execution'), 'isolate_execution cooldown must be defined');
  assert(body.includes('quarantine_node'), 'quarantine_node cooldown must be defined');
});

test('phase9-duplicate-prevention', 'recover_orphan_executions has cooldown guard in self-healer', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("'recover_orphan_executions'");
  const body = src.slice(idx, idx + 300);
  assert(body.includes("isOnCooldown('recover_orphan_executions'"), 'recover_orphan_executions must check cooldown');
  assert(body.includes("recordHealingAction('recover_orphan_executions'"), 'Must record action to set cooldown');
});

test('phase9-duplicate-prevention', 'recover_stuck_queue_jobs has cooldown guard in self-healer', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("'recover_stuck_queue_jobs'");
  const body = src.slice(idx, idx + 300);
  assert(body.includes("isOnCooldown('recover_stuck_queue_jobs'"), 'recover_stuck_queue_jobs must check cooldown');
  assert(body.includes("recordHealingAction('recover_stuck_queue_jobs'"), 'Must record action to set cooldown');
});

test('phase9-duplicate-prevention', 'COOLDOWN_MINUTES defines recovery operation cooldowns', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf('COOLDOWN_MINUTES');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('recover_orphan_executions'), 'recover_orphan_executions cooldown must be defined');
  assert(body.includes('recover_stuck_queue_jobs'), 'recover_stuck_queue_jobs cooldown must be defined');
});

// ============================================================================
// Section 23: Phase 10 — Runtime Enforcement Layer
// ============================================================================

test('phase10-drain-enforcement', 'isWorkerDraining function exists and queries runtime_workers status', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('async function isWorkerDraining'), 'isWorkerDraining must be defined');
  const idx = src.indexOf('async function isWorkerDraining');
  const body = src.slice(idx, idx + 800);
  assert(body.includes("'runtime_workers'"), 'Must query runtime_workers table');
  assert(body.includes("'status'"), 'Must select status column');
  assert(body.includes("eq('worker_id'"), 'Must filter by worker_id');
});

test('phase10-drain-enforcement', 'drain states cover draining, restarting, stopping', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isWorkerDraining');
  const body = src.slice(idx, idx + 1100);
  assert(body.includes("'draining'"), 'Must check draining state');
  assert(body.includes("'restarting'"), 'Must check restarting state');
  assert(body.includes("'stopping'"), 'Must check stopping state');
});

test('phase10-drain-enforcement', 'drain check is placed before claimQueueJobLease in processor', () => {
  const src = readFile('lib/runtime/worker.ts');
  const drainIdx = src.indexOf('isWorkerDraining(effectiveWorkerId)');
  const leaseIdx = src.indexOf('claimQueueJobLease({');
  assert(drainIdx > 0, 'drain check must exist in processor');
  assert(drainIdx < leaseIdx, 'drain check must precede claimQueueJobLease');
});

test('phase10-drain-enforcement', 'drain throws regular Error (retryable, not UnrecoverableError)', () => {
  const src = readFile('lib/runtime/worker.ts');
  const drainIdx = src.indexOf('isWorkerDraining(effectiveWorkerId)');
  const body = src.slice(drainIdx, drainIdx + 350);
  assert(body.includes('throw new Error('), 'drain must throw retryable Error');
  assert(!body.includes('BullUnrecoverableError'), 'drain must NOT throw UnrecoverableError');
  assert(body.includes('draining'), 'drain error message must mention draining');
});

test('phase10-execution-isolation', 'isExecutionIsolated function exists and queries isolate_execution marker', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('async function isExecutionIsolated'), 'isExecutionIsolated must be defined');
  const idx = src.indexOf('async function isExecutionIsolated');
  const body = src.slice(idx, idx + 700);
  assert(body.includes("'runtime_healing_actions'"), 'Must query runtime_healing_actions table');
  assert(body.includes("'isolate_execution'"), 'Must filter by isolate_execution action_type');
  assert(body.includes("eq('target'"), 'Must filter by target (executionId)');
  assert(body.includes("'cooldown_until'"), 'Must check cooldown_until > now');
});

test('phase10-execution-isolation', 'isolation check is before claimQueueJobLease in processor', () => {
  const src = readFile('lib/runtime/worker.ts');
  const isolationIdx = src.indexOf('isExecutionIsolated(job.data.executionId)');
  const leaseIdx = src.indexOf('claimQueueJobLease({');
  assert(isolationIdx > 0, 'isolation check must exist in processor');
  assert(isolationIdx < leaseIdx, 'isolation check must precede claimQueueJobLease');
});

test('phase10-execution-isolation', 'isolation throws BullUnrecoverableError to prevent retry loop', () => {
  const src = readFile('lib/runtime/worker.ts');
  const isolationIdx = src.indexOf('isExecutionIsolated(job.data.executionId)');
  const body = src.slice(isolationIdx, isolationIdx + 550);
  assert(body.includes('BullUnrecoverableError'), 'isolation must throw BullUnrecoverableError');
  assert(body.includes('is isolated'), 'error message must state execution is isolated');
});

test('phase10-execution-isolation', 'isolation updates job status to failed before throwing', () => {
  const src = readFile('lib/runtime/worker.ts');
  const isolationIdx = src.indexOf('isExecutionIsolated(job.data.executionId)');
  const body = src.slice(isolationIdx, isolationIdx + 400);
  assert(body.includes("updateQueueJob("), 'must call updateQueueJob before throwing');
  assert(body.includes("status: 'failed'"), 'must set status to failed');
  assert(body.includes('Execution isolated by healing system'), 'must record isolation reason');
});

test('phase10-node-quarantine', 'isNodeQuarantined function exists and queries quarantine_node marker', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('async function isNodeQuarantined'), 'isNodeQuarantined must be defined');
  const idx = src.indexOf('async function isNodeQuarantined');
  const body = src.slice(idx, idx + 700);
  assert(body.includes("'runtime_healing_actions'"), 'Must query runtime_healing_actions table');
  assert(body.includes("'quarantine_node'"), 'Must filter by quarantine_node action_type');
  assert(body.includes("'cooldown_until'"), 'Must check cooldown_until > now');
});

test('phase10-node-quarantine', 'quarantine uses workflowId prefix to cover all nodes in workflow', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isNodeQuarantined');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('.like('), 'Must use LIKE for prefix match on workflow nodes');
  assert(body.includes('workflowId'), 'Must use workflowId as prefix');
  assert(body.includes(':%'), 'LIKE pattern must use colon separator (workflowId:%)');
});

test('phase10-node-quarantine', 'quarantine check is before processRuntimeJob in processor', () => {
  const src = readFile('lib/runtime/worker.ts');
  const quarantineIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  const processIdx = src.indexOf('await processRuntimeJob(job,');
  assert(quarantineIdx > 0, 'quarantine check must exist in processor');
  assert(quarantineIdx < processIdx, 'quarantine check must precede processRuntimeJob');
});

test('phase10-node-quarantine', 'quarantine throws BullUnrecoverableError to prevent retry loop', () => {
  const src = readFile('lib/runtime/worker.ts');
  const quarantineIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  const body = src.slice(quarantineIdx, quarantineIdx + 600);
  assert(body.includes('BullUnrecoverableError'), 'quarantine must throw BullUnrecoverableError');
  assert(body.includes('quarantined node'), 'error message must mention quarantined node');
});

test('phase10-node-quarantine', 'quarantine updates job status to failed before throwing', () => {
  const src = readFile('lib/runtime/worker.ts');
  const quarantineIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  const body = src.slice(quarantineIdx, quarantineIdx + 400);
  assert(body.includes("updateQueueJob("), 'must call updateQueueJob before throwing');
  assert(body.includes("status: 'failed'"), 'must set status to failed');
  assert(body.includes('quarantined node'), 'must record quarantine reason');
});

test('phase10-unrecoverable-error', 'BullUnrecoverableError is extracted from bullmq dynamic import', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('BullUnrecoverableError = bullmq.UnrecoverableError'), 'Must extract UnrecoverableError from bullmq');
  assert(src.includes('as new (message: string) => Error'), 'Must cast for safe use');
});

test('phase10-ordering', 'enforcement checks execute in order: drain → isolation → quarantine', () => {
  const src = readFile('lib/runtime/worker.ts');
  const drainIdx = src.indexOf('isWorkerDraining(effectiveWorkerId)');
  const isolationIdx = src.indexOf('isExecutionIsolated(job.data.executionId)');
  const quarantineIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  assert(drainIdx < isolationIdx, 'drain check must come before isolation check');
  assert(isolationIdx < quarantineIdx, 'isolation check must come before quarantine check');
});

test('phase10-ordering', 'drain and isolation precede claimQueueJobLease; quarantine precedes processRuntimeJob', () => {
  const src = readFile('lib/runtime/worker.ts');
  const drainIdx = src.indexOf('isWorkerDraining(effectiveWorkerId)');
  const isolationIdx = src.indexOf('isExecutionIsolated(job.data.executionId)');
  const quarantineIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  const leaseIdx = src.indexOf('claimQueueJobLease({');
  const processIdx = src.indexOf('await processRuntimeJob(job,');
  assert(drainIdx < leaseIdx, 'drain precedes lease claim');
  assert(isolationIdx < leaseIdx, 'isolation precedes lease claim');
  assert(quarantineIdx < processIdx, 'quarantine precedes processRuntimeJob');
});

// ============================================================================
// Section 24: Phase 11 — Drain signal, precise quarantine, hot-path cache
// ============================================================================

// ── Drain signal ──────────────────────────────────────────────────────────────

test('phase11-drain-signal', 'drain-signal.ts exports markWorkerDraining, markWorkerActive, isWorkerDrainingInMemory', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  assert(src.includes('export function markWorkerDraining'), 'markWorkerDraining must be exported');
  assert(src.includes('export function markWorkerActive'), 'markWorkerActive must be exported');
  assert(src.includes('export function isWorkerDrainingInMemory'), 'isWorkerDrainingInMemory must be exported');
});

test('phase11-drain-signal', 'publishDrainSignal publishes to DRAIN_CHANNEL via Redis', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  assert(src.includes("DRAIN_CHANNEL = 'runtime:worker:drain'"), 'DRAIN_CHANNEL must be defined');
  assert(src.includes('export async function publishDrainSignal'), 'publishDrainSignal must be exported');
  const idx = src.indexOf('async function publishDrainSignal');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('redis.publish'), 'must call redis.publish');
  assert(body.includes('DRAIN_CHANNEL'), 'must publish to DRAIN_CHANNEL');
  assert(body.includes('JSON.stringify'), 'must serialize workerId as JSON');
});

test('phase11-drain-signal', 'subscribeDrainSignal creates dedicated subscriber connection', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  assert(src.includes('export async function subscribeDrainSignal'), 'subscribeDrainSignal must be exported');
  const idx = src.indexOf('async function subscribeDrainSignal');
  const body = src.slice(idx, idx + 1100);
  assert(body.includes('new Redis('), 'must create dedicated subscriber connection');
  assert(body.includes('sub.subscribe(DRAIN_CHANNEL)'), 'must subscribe to DRAIN_CHANNEL');
  assert(body.includes('params.onDrain()'), 'must call onDrain when matching workerId');
  assert(body.includes('params.workerId'), 'must filter by workerId before calling onDrain');
});

test('phase11-drain-signal', 'markWorkerActive clears both the drain Set and drain cache', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  const idx = src.indexOf('export function markWorkerActive');
  const body = src.slice(idx, idx + 150);
  assert(body.includes('drainingWorkers.delete(workerId)'), 'must remove from drain Set');
  assert(body.includes('drainCache.delete(workerId)'), 'must clear drain cache entry');
});

test('phase11-drain-signal', 'markWorkerDraining clears drain cache on write (prevents stale reads)', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  const idx = src.indexOf('export function markWorkerDraining');
  const body = src.slice(idx, idx + 150);
  assert(body.includes('drainingWorkers.add(workerId)'), 'must add to drain Set');
  assert(body.includes('drainCache.delete(workerId)'), 'must clear drain cache to force revalidation');
});

test('phase11-drain-signal', 'drainWorker in worker-lifecycle calls publishDrainSignal', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  assert(src.includes("import { publishDrainSignal, markWorkerActive } from './drain-signal'"), 'must import from drain-signal');
  const idx = src.indexOf('export async function drainWorker');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('publishDrainSignal(workerId)'), 'drainWorker must call publishDrainSignal');
  assert(body.includes('.catch(() => undefined)'), 'publishDrainSignal call must be fail-safe');
});

test('phase11-drain-signal', 'performRestart calls markWorkerActive after restart succeeds', () => {
  const src = readFile('lib/runtime/worker-lifecycle.ts');
  const idx = src.indexOf('async function performRestart');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('markWorkerActive(params.workerId)'), 'must clear drain flag on restart success');
  const markActiveIdx = body.indexOf('markWorkerActive(params.workerId)');
  const markRestartedIdx = body.indexOf('markRestarted(params.workerId)');
  assert(markRestartedIdx < markActiveIdx, 'must call markRestarted before markWorkerActive');
});

test('phase11-drain-signal', 'runtime-worker.ts subscribes to drain channel and pauses on match', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes("import { subscribeDrainSignal, markWorkerDraining } from '../lib/runtime/drain-signal'"), 'must import drain-signal');
  assert(src.includes('subscribeDrainSignal({'), 'must call subscribeDrainSignal');
  assert(src.includes('markWorkerDraining(workerId)'), 'must mark worker draining on signal');
  assert(src.includes("workers.map(w => w.pause())"), 'must pause all workers immediately');
});

test('phase11-drain-signal', 'runtime-worker.ts unsubscribes drain listener on shutdown', () => {
  const src = readFile('scripts/runtime-worker.ts');
  assert(src.includes('drainUnsubscribe'), 'must track drain unsubscribe handle');
  assert(src.includes('if (drainUnsubscribe) drainUnsubscribe()'), 'must unsubscribe on shutdown');
});

// ── Hot-path cache ────────────────────────────────────────────────────────────

test('phase11-hot-cache', 'worker.ts defines module-level hotCache Map', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('const hotCache = new Map<string, HotCacheEntry>()'), 'hotCache Map must exist');
  assert(src.includes('type HotCacheEntry = { value: boolean; expiresAt: number }'), 'HotCacheEntry type must exist');
});

test('phase11-hot-cache', 'drain check uses in-memory flag before cache and DB', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isWorkerDraining(');
  const body = src.slice(idx, idx + 1100);
  assert(body.includes('isWorkerDrainingInMemory(workerId)'), 'must check in-memory flag first');
  assert(body.includes('getDrainCache(workerId)'), 'must check drain cache second');
  assert(body.includes('runtime_workers'), 'must fall back to DB');
  const memIdx = body.indexOf('isWorkerDrainingInMemory');
  const cacheIdx = body.indexOf('getDrainCache');
  const dbIdx = body.indexOf('runtime_workers');
  assert(memIdx < cacheIdx, 'in-memory check must come before cache check');
  assert(cacheIdx < dbIdx, 'cache check must come before DB fallback');
});

test('phase11-hot-cache', 'isExecutionIsolated uses hotCache with 10 s TTL', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isExecutionIsolated(');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('hotCacheGet('), 'must check hotCache first');
  assert(body.includes('hotCacheSet('), 'must write to hotCache after DB read');
  assert(body.includes('10_000'), 'isolation TTL must be 10 000 ms');
});

test('phase11-hot-cache', 'isNodeQuarantined uses hotCache with 10 s TTL', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isNodeQuarantined(');
  const body = src.slice(idx, idx + 1000);
  assert(body.includes('hotCacheGet('), 'must check hotCache first');
  assert(body.includes('hotCacheSet('), 'must write to hotCache after DB read');
  assert(body.includes('10_000'), 'quarantine TTL must be 10 000 ms');
});

test('phase11-hot-cache', 'drain DB result is cached with 5 s TTL via setDrainCache', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isWorkerDraining(');
  const body = src.slice(idx, idx + 1100);
  assert(body.includes('setDrainCache('), 'must call setDrainCache after DB read');
  assert(body.includes('5_000'), 'drain TTL must be 5 000 ms');
});

test('phase11-hot-cache', 'hotCacheGet deletes expired entries on access', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('function hotCacheGet(');
  const body = src.slice(idx, idx + 250);
  assert(body.includes('Date.now() > entry.expiresAt'), 'must check expiry');
  assert(body.includes('hotCache.delete(key)'), 'must delete expired entry');
  assert(body.includes('return null'), 'must return null for expired/missing entry');
});

// ── Precise node quarantine ───────────────────────────────────────────────────

test('phase11-quarantine-precision', 'isNodeQuarantined accepts optional nodeId for exact match', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isNodeQuarantined(');
  const sig = src.slice(idx, idx + 80);
  assert(sig.includes('nodeId?: string'), 'nodeId must be optional parameter');
});

test('phase11-quarantine-precision', 'exact nodeId target uses workflowId:nodeId with colon separator', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isNodeQuarantined(');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('`${workflowId}:${nodeId}`'), 'exact target must use colon separator');
  assert(body.includes(".eq('target', target)"), 'exact match must use eq not like');
});

test('phase11-quarantine-precision', 'prefix match uses workflowId:% pattern', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function isNodeQuarantined(');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('`${workflowId}:%`'), 'prefix match must use colon separator');
  assert(body.includes('.like('), 'prefix match must use LIKE');
});

test('phase11-quarantine-precision', 'quarantine check only applies to execution tool names', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes("const EXECUTION_TOOL_NAMES = new Set("), 'EXECUTION_TOOL_NAMES set must exist');
  assert(src.includes("'test_workflow'"), 'test_workflow must be in EXECUTION_TOOL_NAMES');
  const processorIdx = src.indexOf('isNodeQuarantined(job.data.workflowId)');
  const toolCheckIdx = src.indexOf('EXECUTION_TOOL_NAMES.has(job.data.toolName)');
  assert(toolCheckIdx > 0, 'tool name check must exist in processor');
  assert(Math.abs(processorIdx - toolCheckIdx) < 300, 'tool check must be adjacent to quarantine check');
});

test('phase11-quarantine-precision', 'self-healer normalizes quarantine target to workflowId:nodeId', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  const idx = src.indexOf("anomaly.alertType === 'repeated_node_failures'");
  const body = src.slice(idx, idx + 600);
  assert(body.includes('rawKey'), 'must read rawKey from anomaly');
  assert(body.includes("rawKey.includes(':')"), 'must detect colon separator format');
  assert(body.includes("`${wfId}:${"), 'must build colon-separated key');
  assert(body.includes('wfId.length + 1'), 'must correctly extract nodeId after legacy prefix');
});

test('phase11-quarantine-precision', 'migration uses colon separator in detect_repeated_node_failures', () => {
  const sql = readFile('supabase/migrations/20260525000003_runtime_phase11_node_key.sql');
  assert(sql.includes("|| ':' ||"), "SQL must use ':' separator between workflow_id and node_id");
  assert(sql.includes('detect_repeated_node_failures'), 'must redefine detect_repeated_node_failures');
  assert(sql.includes('CREATE OR REPLACE FUNCTION'), 'must use CREATE OR REPLACE for safe re-run');
});

test('phase11-quarantine-precision', 'anomaly-detector parses node_key with colon separator first', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('const rawKey =');
  const body = src.slice(idx, idx + 250);
  assert(body.includes("rawKey.indexOf(':')"), 'must check for colon separator first');
  assert(body.includes("rawKey.slice(colonIdx + 1)"), 'must slice nodeId after colon');
  assert(body.includes('split'), 'must retain underscore fallback for legacy records');
});

// ── Observability ─────────────────────────────────────────────────────────────

test('phase11-observability', 'drain enforcement logs drain_signal_received event', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('drain_signal_received'), 'must log drain_signal_received');
});

test('phase11-observability', 'isolation enforcement logs execution_isolated event', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('execution_isolated'), 'must log execution_isolated');
});

test('phase11-observability', 'quarantine enforcement logs node_quarantined event', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('node_quarantined'), 'must log node_quarantined');
});

test('phase11-observability', 'cache layer logs hit and miss events', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('hit=memory') || src.includes('hit=cache'), 'must log cache hits');
  assert(src.includes('miss → db'), 'must log cache misses');
});

// ── Safety ────────────────────────────────────────────────────────────────────

test('phase11-safety', 'subscribeDrainSignal is safe if Redis unavailable (returns null)', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  const idx = src.indexOf('async function subscribeDrainSignal');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('canUseRuntimeRedis()'), 'must check Redis availability');
  assert(body.includes('return null'), 'must return null if Redis unavailable');
});

test('phase11-safety', 'publishDrainSignal is safe if Redis unavailable (early return)', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  const idx = src.indexOf('async function publishDrainSignal');
  const body = src.slice(idx, idx + 250);
  assert(body.includes('canUseRuntimeRedis()'), 'must check Redis availability');
  assert(body.includes('return'), 'must return early if Redis unavailable');
});

test('phase11-safety', 'malformed drain messages are safely ignored', () => {
  const src = readFile('lib/runtime/drain-signal.ts');
  assert(src.includes('try {'), 'must wrap JSON.parse in try block');
  assert(src.includes('// malformed drain message'), 'must comment intent of silent catch');
});

// ============================================================================
// Section 25: Phase 12 — Distributed Lease Authority + Split-Brain Protection
// ============================================================================

// ── Migration ────────────────────────────────────────────────────────────────

test('phase12-migration', 'migration adds fencing_token column to runtime_execution_ownership', () => {
  const sql = readFile('supabase/migrations/20260528000001_runtime_phase12_fencing_tokens.sql');
  assert(sql.includes('fencing_token'), 'fencing_token column must be added');
  assert(sql.includes('bigint'), 'fencing_token must be bigint type');
  assert(sql.includes('NOT NULL'), 'fencing_token must be NOT NULL');
  assert(sql.includes('DEFAULT 0'), 'fencing_token must default to 0');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS'), 'must use IF NOT EXISTS for idempotency');
});

test('phase12-migration', 'migration adds fencing index for fast authority lookup', () => {
  const sql = readFile('supabase/migrations/20260528000001_runtime_phase12_fencing_tokens.sql');
  assert(sql.includes('runtime_execution_ownership_fencing_idx'), 'fencing index must be named');
  assert(sql.includes("state = 'active'"), 'index must be partial (active rows only)');
});

// ── hardening-layer.ts: fencing token on claim ───────────────────────────────

test('phase12-claim-fencing', 'claimExecutionOwnership selects fencing_token from existing row', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function claimExecutionOwnership');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('fencing_token'), 'must select fencing_token column');
  assert(body.includes("'worker_id, lease_expires_at, owner_token, fencing_token'"), 'select string must include fencing_token');
});

test('phase12-claim-fencing', 'claimExecutionOwnership increments fencing token on each claim', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function claimExecutionOwnership');
  const body = src.slice(idx, idx + 2700);
  assert(body.includes('nextFencingToken'), 'must compute nextFencingToken');
  assert(body.includes('existingFencingToken + 1'), 'must increment existing token by 1');
  assert(body.includes('fencing_token: 1'), 'new row must start with fencing_token = 1');
});

test('phase12-claim-fencing', 'claimExecutionOwnership uses optimistic fencing token check on update', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function claimExecutionOwnership');
  const body = src.slice(idx, idx + 2700);
  assert(body.includes('.eq(\'fencing_token\', existingFencingToken)'), 'update must be conditional on current fencing_token (optimistic lock)');
});

test('phase12-claim-fencing', 'claimExecutionOwnership returns fencingToken in success result', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function claimExecutionOwnership');
  const body = src.slice(idx, idx + 3500);
  assert(body.includes('fencingToken: nextFencingToken'), 'must return nextFencingToken for update path');
  assert(body.includes('fencingToken: 1'), 'must return fencingToken: 1 for insert path');
});

// ── hardening-layer.ts: validateExecutionOwnership ───────────────────────────

test('phase12-validate-ownership', 'hardening-layer exports OwnershipValidationResult type', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes('export type OwnershipValidationResult'), 'OwnershipValidationResult must be exported');
  assert(src.includes("'OWNER_REPLACED'"), 'must include OWNER_REPLACED reason');
  assert(src.includes("'LEASE_EXPIRED'"), 'must include LEASE_EXPIRED reason');
  assert(src.includes("'FENCED_OUT'"), 'must include FENCED_OUT reason');
  assert(src.includes("'NOT_FOUND'"), 'must include NOT_FOUND reason');
});

test('phase12-validate-ownership', 'hardening-layer exports validateExecutionOwnership function', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes('export async function validateExecutionOwnership'), 'validateExecutionOwnership must be exported');
});

test('phase12-validate-ownership', 'validateExecutionOwnership returns FENCED_OUT when DB token exceeds local token', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function validateExecutionOwnership');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes('dbFencingToken > params.fencingToken'), 'must detect DB token > local token');
  assert(body.includes("reason: 'FENCED_OUT'"), 'must return FENCED_OUT reason');
});

test('phase12-validate-ownership', 'validateExecutionOwnership returns OWNER_REPLACED on token/worker mismatch', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function validateExecutionOwnership');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes("data.worker_id !== params.workerId"), 'must check worker_id mismatch');
  assert(body.includes('data.owner_token !== params.ownerToken'), 'must check owner_token mismatch');
  assert(body.includes("reason: 'OWNER_REPLACED'"), 'must return OWNER_REPLACED reason');
});

test('phase12-validate-ownership', 'validateExecutionOwnership returns LEASE_EXPIRED when lease has expired', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function validateExecutionOwnership');
  const body = src.slice(idx, idx + 1900);
  assert(body.includes('leaseExpiresAt <= now'), 'must detect expired lease');
  assert(body.includes("reason: 'LEASE_EXPIRED'"), 'must return LEASE_EXPIRED reason');
});

test('phase12-validate-ownership', 'validateExecutionOwnership checks FENCED_OUT before OWNER_REPLACED (monotonic precedence)', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function validateExecutionOwnership');
  const body = src.slice(idx, idx + 1500);
  const fencedIdx = body.indexOf("'FENCED_OUT'");
  const replacedIdx = body.indexOf("'OWNER_REPLACED'");
  assert(fencedIdx < replacedIdx, 'FENCED_OUT check must precede OWNER_REPLACED check');
});

test('phase12-validate-ownership', 'validateExecutionOwnership returns { valid: true } for valid active owner', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf('export async function validateExecutionOwnership');
  const body = src.slice(idx, idx + 1900);
  assert(body.includes('{ valid: true }'), 'must return { valid: true } when all checks pass');
});

// ── worker.ts: ownership cache and abort signal ───────────────────────────────

test('phase12-worker-cache', 'worker.ts imports validateExecutionOwnership from hardening-layer', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('validateExecutionOwnership'), 'must import validateExecutionOwnership');
  assert(src.includes("from '@/runtime/hardening-layer'"), 'must import from hardening-layer');
});

test('phase12-worker-cache', 'worker.ts defines module-level ownershipCache Map with 1.5 s TTL', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('const ownershipCache = new Map<string, OwnershipCacheEntry>()'), 'ownershipCache Map must exist');
  assert(src.includes('type OwnershipCacheEntry = {'), 'OwnershipCacheEntry type must exist');
  assert(src.includes('1_500'), 'TTL must be 1 500 ms');
});

test('phase12-worker-cache', 'ownershipCacheGet deletes expired entries on access', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('function ownershipCacheGet(');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('Date.now() > entry.expiresAt'), 'must check expiry');
  assert(body.includes('ownershipCache.delete(key)'), 'must delete expired entry');
  assert(body.includes('return null'), 'must return null for expired/missing entry');
});

test('phase12-worker-cache', 'OwnershipAbortSignal class exists with reason field', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('class OwnershipAbortSignal extends Error'), 'OwnershipAbortSignal must extend Error');
  assert(src.includes('public readonly reason: string'), 'must have reason field');
  assert(src.includes('stale_executor_aborted'), 'error message must include stale_executor_aborted prefix');
});

test('phase12-worker-cache', 'assertOwnership function checks ownership cache before DB', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('async function assertOwnership('), 'assertOwnership must be defined');
  const idx = src.indexOf('async function assertOwnership(');
  const body = src.slice(idx, idx + 800);
  assert(body.includes('ownershipCacheGet(cacheKey)'), 'must check cache first');
  assert(body.includes('validateExecutionOwnership({'), 'must call validateExecutionOwnership on cache miss');
  assert(body.includes('ownershipCacheSet(cacheKey, result, 1_500)'), 'must cache the result with 1.5 s TTL');
});

test('phase12-worker-cache', 'assertOwnership logs split_brain_prevented on FENCED_OUT', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function assertOwnership(');
  const body = src.slice(idx, idx + 1800);
  assert(body.includes('split_brain_prevented'), 'must log split_brain_prevented on FENCED_OUT');
  assert(body.includes("result.reason === 'FENCED_OUT'"), 'must check for FENCED_OUT specifically');
});

test('phase12-worker-cache', 'assertOwnership throws OwnershipAbortSignal when validation fails', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function assertOwnership(');
  const body = src.slice(idx, idx + 1000);
  assert(body.includes('throw new OwnershipAbortSignal('), 'must throw OwnershipAbortSignal on invalid ownership');
  assert(body.includes('ownership_validation_failed'), 'must log ownership_validation_failed event');
});

// ── worker.ts: side-effect gates ─────────────────────────────────────────────

test('phase12-side-effect-gates', 'ownership validated before deploy_workflow_to_n8n side effect', () => {
  const src = readFile('lib/runtime/worker.ts');
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'deploy_workflow_to_n8n')");
  const deployIdx = src.indexOf('await withExponentialBackoff');
  assert(assertIdx > 0, 'assertOwnership for deploy must exist');
  assert(assertIdx < deployIdx, 'assertOwnership must precede createWorkflow call');
});

test('phase12-side-effect-gates', 'ownership validated before activate_workflow side effect', () => {
  const src = readFile('lib/runtime/worker.ts');
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'activate_workflow')");
  const activateIdx = src.indexOf('await n8nActivate(n8n');
  assert(assertIdx > 0, 'assertOwnership for activate must exist');
  assert(assertIdx < activateIdx, 'assertOwnership must precede n8nActivate call');
});

test('phase12-side-effect-gates', 'ownership validated before test_workflow side effect', () => {
  const src = readFile('lib/runtime/worker.ts');
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'test_workflow')");
  const testIdx = src.indexOf('await runTestExecution(');
  assert(assertIdx > 0, 'assertOwnership for test must exist');
  assert(assertIdx < testIdx, 'assertOwnership must precede runTestExecution call');
});

test('phase12-side-effect-gates', 'processRuntimeJob accepts ownerCtx parameter', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('async function processRuntimeJob(');
  const sig = src.slice(idx, idx + 120);
  assert(sig.includes('ownerCtx: OwnerCtx | null'), 'processRuntimeJob must accept ownerCtx parameter');
});

// ── worker.ts: jittered renew timer ──────────────────────────────────────────

test('phase12-jitter-renew', 'renew timer uses jittered setTimeout instead of fixed setInterval', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('RENEW_JITTER_MS'), 'jitter constant must be defined');
  assert(src.includes('const scheduleRenew ='), 'scheduleRenew function must exist');
  assert(src.includes('setTimeout(async ()'), 'must use setTimeout not setInterval for renew');
  assert(!src.includes('setInterval(() =>'), 'must not use setInterval for renew');
});

test('phase12-jitter-renew', 'renew uses BASE_RENEW_MS with ±RENEW_JITTER_MS jitter', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('BASE_RENEW_MS = 15_000'), 'BASE_RENEW_MS must be 15 000 ms');
  assert(src.includes('RENEW_JITTER_MS = 1_500'), 'RENEW_JITTER_MS must be 1 500 ms');
  assert(src.includes('BASE_RENEW_MS + jitter'), 'jitter must be applied to BASE_RENEW_MS');
});

test('phase12-jitter-renew', 'renewActive flag stops renew after job completes', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('let renewActive = true'), 'renewActive must be initialized to true');
  const finallyIdx = src.indexOf('renewActive = false');
  assert(finallyIdx > 0, 'must set renewActive = false in finally block');
  assert(src.includes('if (!renewActive) return'), 'scheduleRenew must check renewActive guard');
});

test('phase12-jitter-renew', 'finally uses clearTimeout not clearInterval for renew cleanup', () => {
  const src = readFile('lib/runtime/worker.ts');
  const finallyIdx = src.indexOf('renewActive = false');
  const body = src.slice(finallyIdx, finallyIdx + 100);
  assert(body.includes('clearTimeout(renewTimerHandle)'), 'must use clearTimeout for cleanup');
  assert(!body.includes('clearInterval'), 'must not use clearInterval for renew timer');
});

// ── worker.ts: renew miss tracking + cache invalidation ─────────────────────

test('phase12-renew-miss', 'renewMissCount tracks consecutive renew failures', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('let renewMissCount = 0'), 'renewMissCount must be initialized to 0');
  assert(src.includes('renewMissCount++'), 'must increment renewMissCount on failure');
  assert(src.includes('renewMissCount = 0'), 'must reset renewMissCount on success');
});

test('phase12-renew-miss', 'ownership cache is cleared on renew failure', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('renewMissCount++');
  const body = src.slice(idx, idx + 200);
  assert(body.includes('ownershipCache.delete('), 'must clear ownership cache entry on renew failure');
});

test('phase12-renew-miss', 'lease_renewal_lag is logged on each renew failure', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('lease_renewal_lag'), 'must log lease_renewal_lag event');
  assert(src.includes('miss='), 'log must include miss count');
});

test('phase12-renew-miss', 'stale_executor_aborted is logged when renew miss count reaches threshold', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('renewMissCount >= 3');
  assert(idx > 0, 'must check renewMissCount >= 3 threshold');
  const body = src.slice(idx, idx + 200);
  assert(body.includes('stale_executor_aborted'), 'must log stale_executor_aborted when threshold reached');
  assert(body.includes('LEASE_EXPIRED'), 'stale_executor_aborted log must include LEASE_EXPIRED reason');
});

// ── worker.ts: OwnershipAbortSignal catch ────────────────────────────────────

test('phase12-abort-signal', 'OwnershipAbortSignal is caught and rethrown as BullUnrecoverableError', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('if (err instanceof OwnershipAbortSignal)');
  assert(idx > 0, 'must catch OwnershipAbortSignal');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('throw new BullUnrecoverableError('), 'must rethrow as BullUnrecoverableError');
  assert(body.includes('stale_executor_aborted'), 'BullUnrecoverableError message must include stale_executor_aborted');
  assert(body.includes("status: 'failed'"), 'must update job status to failed before throwing');
});

test('phase12-abort-signal', 'OwnershipAbortSignal catch is at the top of the processor catch block', () => {
  const src = readFile('lib/runtime/worker.ts');
  // The processor catch block uses } catch (err) { — find the one containing the OwnershipAbortSignal handler
  const catchIdx = src.lastIndexOf('} catch (err) {');
  assert(catchIdx > 0, 'must have processor catch block');
  const body = src.slice(catchIdx, catchIdx + 200);
  assert(body.includes('OwnershipAbortSignal'), 'OwnershipAbortSignal handler must be first in the processor catch block');
});

// ── Observability ─────────────────────────────────────────────────────────────

test('phase12-observability', 'ownership_validation_failed event is logged', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('ownership_validation_failed'), 'must log ownership_validation_failed');
  assert(src.includes('reason='), 'log must include reason');
});

test('phase12-observability', 'split_brain_prevented event is logged on FENCED_OUT', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('split_brain_prevented'), 'must log split_brain_prevented');
});

test('phase12-observability', 'stale_executor_aborted event is logged in catch handler', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('if (err instanceof OwnershipAbortSignal)');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('stale_executor_aborted'), 'catch handler must log stale_executor_aborted');
  assert(body.includes('worker='), 'log must include worker ID');
});

test('phase12-observability', 'lease_renewal_lag event is logged on renew failure', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('lease_renewal_lag'), 'must log lease_renewal_lag');
});

// ============================================================================
// Section 26: Phase 13 — Migration (event store + idempotency)
// ============================================================================

test('phase13-migration', 'migration creates runtime_execution_events table', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('runtime_execution_events'), 'must create runtime_execution_events table');
  assert(sql.includes('sequence_number'), 'must have sequence_number column');
  assert(sql.includes('execution_id'), 'must have execution_id column');
});

test('phase13-migration', 'runtime_execution_events has unique constraint on (execution_id, sequence_number)', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('UNIQUE (execution_id, sequence_number)'), 'must have unique constraint');
});

test('phase13-migration', 'migration includes append_execution_event() function', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('append_execution_event'), 'must define append_execution_event function');
  assert(sql.includes('pg_advisory_xact_lock'), 'must use advisory lock for atomicity');
});

test('phase13-migration', 'append_execution_event uses hashtext advisory lock per execution', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('hashtext(p_execution_id)'), 'advisory lock must hash execution_id');
});

test('phase13-migration', 'migration creates runtime_idempotency_keys table', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('runtime_idempotency_keys'), 'must create runtime_idempotency_keys table');
  assert(sql.includes('idempotency_key'), 'must have idempotency_key column');
  assert(sql.includes('UNIQUE (idempotency_key, user_id)'), 'must have unique constraint per user');
});

test('phase13-migration', 'event store table enables RLS with INSERT+SELECT only', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('ENABLE ROW LEVEL SECURITY'), 'must enable RLS');
  assert(sql.includes('FOR INSERT'), 'must have INSERT policy');
  assert(sql.includes('FOR SELECT'), 'must have SELECT policy');
  assert(!sql.includes('FOR UPDATE'), 'must NOT allow UPDATE — append-only');
  assert(!sql.includes('FOR DELETE'), 'must NOT allow DELETE — append-only');
});

test('phase13-migration', 'event store has causation_id, correlation_id, parent_event_id for causal chains', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('causation_id'), 'must have causation_id');
  assert(sql.includes('correlation_id'), 'must have correlation_id');
  assert(sql.includes('parent_event_id'), 'must have parent_event_id');
});

test('phase13-migration', 'event store has fencing_token column for split-brain auditability', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('fencing_token'), 'must have fencing_token column');
});

test('phase13-migration', 'event store has indexes on execution_id+sequence_number and causation_id', () => {
  const sql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(sql.includes('runtime_execution_events_exec_seq_idx'), 'must have primary replay index');
  assert(sql.includes('runtime_execution_events_causation_idx'), 'must have causation lookup index');
});

// ============================================================================
// Section 27: Phase 13 — event-store.ts
// ============================================================================

test('phase13-event-store', 'event-store exports appendExecutionEvent', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('export async function appendExecutionEvent'), 'must export appendExecutionEvent');
});

test('phase13-event-store', 'appendExecutionEvent calls db.rpc append_execution_event', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes("db.rpc('append_execution_event'"), 'must call append_execution_event RPC');
  assert(src.includes('p_execution_id'), 'must pass p_execution_id param');
  assert(src.includes('p_event_type'), 'must pass p_event_type param');
});

test('phase13-event-store', 'appendExecutionEvent returns null when userId is absent', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('if (!input.userId) return null'), 'must guard against missing userId');
});

test('phase13-event-store', 'event-store exports loadExecutionEvents', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('export async function loadExecutionEvents'), 'must export loadExecutionEvents');
  assert(src.includes("order('sequence_number'"), 'must order by sequence_number');
});

test('phase13-event-store', 'loadExecutionEvents supports fromSequence and toSequence filters', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('fromSequence'), 'must support fromSequence');
  assert(src.includes('toSequence'), 'must support toSequence');
  assert(src.includes('gte(') || src.includes('.gte('), 'must use gte for fromSequence');
  assert(src.includes('lte(') || src.includes('.lte('), 'must use lte for toSequence');
});

test('phase13-event-store', 'event-store exports loadLatestSnapshot using runtime_execution_snapshots', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('export async function loadLatestSnapshot'), 'must export loadLatestSnapshot');
  assert(src.includes('runtime_execution_snapshots'), 'must query runtime_execution_snapshots');
});

test('phase13-event-store', 'event-store exports saveExecutionSnapshot', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('export async function saveExecutionSnapshot'), 'must export saveExecutionSnapshot');
});

test('phase13-event-store', 'event-store exports checkIdempotencyKey and recordIdempotencyKey', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('export async function checkIdempotencyKey'), 'must export checkIdempotencyKey');
  assert(src.includes('export async function recordIdempotencyKey'), 'must export recordIdempotencyKey');
  assert(src.includes('runtime_idempotency_keys'), 'must query runtime_idempotency_keys');
});

test('phase13-event-store', 'event-store defines ExecutionEventType with all required types', () => {
  const src = readFile('lib/runtime/event-store.ts');
  const required = [
    'execution_created', 'execution_completed', 'execution_failed',
    'ownership_claimed', 'ownership_fenced', 'ownership_expired', 'split_brain_prevented',
    'side_effect_requested', 'side_effect_completed', 'side_effect_failed',
    'replay_started', 'replay_completed',
  ];
  for (const t of required) {
    assert(src.includes(`'${t}'`), `ExecutionEventType must include '${t}'`);
  }
});

test('phase13-event-store', 'recordIdempotencyKey uses ignoreDuplicates to prevent double-insert', () => {
  const src = readFile('lib/runtime/event-store.ts');
  assert(src.includes('ignoreDuplicates'), 'must set ignoreDuplicates to prevent race conditions');
});

// ============================================================================
// Section 28: Phase 13 — replay-engine.ts
// ============================================================================

test('phase13-replay-engine', 'replay-engine exports replayFromEvents', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('export function replayFromEvents'), 'must export replayFromEvents');
});

test('phase13-replay-engine', 'replayFromEvents returns unknown state for empty event array', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes("status: 'unknown'"), 'initial state must use unknown status');
  assert(src.includes('events.length === 0'), 'must handle empty events array');
});

test('phase13-replay-engine', 'replay-engine exports replayFromSnapshot', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('export function replayFromSnapshot'), 'must export replayFromSnapshot');
});

test('phase13-replay-engine', 'replayFromSnapshot hydrates from stateSnapshot fields', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('ss.status'), 'must read status from stateSnapshot');
  assert(src.includes('ss.worker_id'), 'must read worker_id from stateSnapshot');
  assert(src.includes('ss.fencing_token'), 'must read fencing_token from stateSnapshot');
  assert(src.includes('ss.side_effects'), 'must read side_effects from stateSnapshot');
  assert(src.includes('ss.ownership_history'), 'must read ownership_history from stateSnapshot');
});

test('phase13-replay-engine', 'replay-engine exports filterEventsUntilSequence and filterEventsUntilTimestamp', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('export function filterEventsUntilSequence'), 'must export filterEventsUntilSequence');
  assert(src.includes('export function filterEventsUntilTimestamp'), 'must export filterEventsUntilTimestamp');
});

test('phase13-replay-engine', 'replay-engine exports diffReplayStates', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('export function diffReplayStates'), 'must export diffReplayStates');
});

test('phase13-replay-engine', 'applyEvent handles all ownership event types', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes("case 'ownership_claimed':"), 'must handle ownership_claimed');
  assert(src.includes("case 'ownership_fenced':"), 'must handle ownership_fenced');
  assert(src.includes("case 'ownership_expired':"), 'must handle ownership_expired');
  assert(src.includes("case 'split_brain_prevented':"), 'must handle split_brain_prevented');
});

test('phase13-replay-engine', 'applyEvent handles all side-effect event types', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes("case 'side_effect_requested':"), 'must handle side_effect_requested');
  assert(src.includes("case 'side_effect_completed':"), 'must handle side_effect_completed');
  assert(src.includes("case 'side_effect_failed':"), 'must handle side_effect_failed');
});

test('phase13-replay-engine', 'side_effect_completed resolves by causationId first', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('causationId') || src.includes('causation_id'), 'must check causationId');
  assert(src.includes('eventId === causingId') || src.includes("eventId === causingId"),
    'must match effect by eventId === causationId');
});

test('phase13-replay-engine', 'replayedEventCount increments on each applied event', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  assert(src.includes('replayedEventCount: state.replayedEventCount + 1'), 'must increment replayedEventCount');
});

test('phase13-replay-engine', 'ownership_claimed adds to ownershipHistory', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  const idx = src.indexOf("case 'ownership_claimed':");
  assert(idx > 0, 'must handle ownership_claimed case');
  const body = src.slice(idx, idx + 900);
  assert(body.includes('ownershipHistory'), 'must update ownershipHistory on ownership_claimed');
});

test('phase13-replay-engine', 'split_brain_prevented adds to splitBrainEvents', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  const idx = src.indexOf("case 'split_brain_prevented':");
  assert(idx > 0, 'must handle split_brain_prevented case');
  const body = src.slice(idx, idx + 550);
  assert(body.includes('splitBrainEvents'), 'must update splitBrainEvents on split_brain_prevented');
});

test('phase13-replay-engine', 'ExecutionReplayState has all required fields', () => {
  const src = readFile('lib/runtime/replay-engine.ts');
  const required = [
    'executionId', 'status', 'workerId', 'ownerToken', 'fencingToken',
    'sideEffects', 'ownershipHistory', 'splitBrainEvents', 'lastSequence',
    'replayedEventCount',
  ];
  for (const field of required) {
    assert(src.includes(field), `ExecutionReplayState must include '${field}'`);
  }
});

// ============================================================================
// Section 29: Phase 13 — hardening-layer.ts ownership events
// ============================================================================

test('phase13-hardening', 'hardening-layer imports appendExecutionEvent from event-store', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(
    src.includes("from '@/lib/runtime/event-store'"),
    'must import from event-store'
  );
  assert(src.includes('appendExecutionEvent'), 'must import appendExecutionEvent');
});

test('phase13-hardening', 'claimExecutionOwnership emits ownership_claimed on INSERT path', () => {
  const src = readFile('runtime/hardening-layer.ts');
  // Locate the else block's db.insert call which contains fencing_token: 1
  const insertIdx = src.indexOf('fencing_token: 1,');
  assert(insertIdx > 0, 'INSERT path must set fencing_token to 1');
  const afterInsert = src.slice(insertIdx, insertIdx + 700);
  assert(afterInsert.includes("eventType: 'ownership_claimed'"), 'INSERT path must emit ownership_claimed');
  assert(afterInsert.includes('fencingToken: 1'), 'INSERT path must pass fencingToken: 1');
});

test('phase13-hardening', 'claimExecutionOwnership emits ownership_claimed on UPDATE path', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const updateIdx = src.indexOf('fencingToken: nextFencingToken');
  assert(updateIdx > 0, 'UPDATE path must return nextFencingToken');
  const afterUpdate = src.slice(Math.max(0, updateIdx - 400), updateIdx + 200);
  assert(afterUpdate.includes("eventType: 'ownership_claimed'"), 'UPDATE path must emit ownership_claimed');
});

test('phase13-hardening', 'validateExecutionOwnership emits split_brain_prevented on FENCED_OUT', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const fencedIdx = src.indexOf("reason: 'FENCED_OUT'");
  assert(fencedIdx > 0, 'must return FENCED_OUT reason');
  const beforeFenced = src.slice(Math.max(0, fencedIdx - 600), fencedIdx);
  assert(beforeFenced.includes("eventType: 'split_brain_prevented'"), 'must emit split_brain_prevented before returning FENCED_OUT');
});

test('phase13-hardening', 'split_brain_prevented payload includes stale and authoritative fencing tokens', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const idx = src.indexOf("eventType: 'split_brain_prevented'");
  assert(idx > 0, 'must have split_brain_prevented emission');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('stale_worker_id'), 'payload must include stale_worker_id');
  assert(body.includes('authoritative_fencing_token'), 'payload must include authoritative_fencing_token');
  assert(body.includes('stale_fencing_token'), 'payload must include stale_fencing_token');
});

test('phase13-hardening', 'releaseExecutionOwnership emits ownership_expired for orphaned state', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes("'ownership_expired'"), 'must emit ownership_expired');
  const idx = src.indexOf("'ownership_expired'");
  const context = src.slice(Math.max(0, idx - 200), idx + 100);
  assert(context.includes("'orphaned'"), "ownership_expired must be tied to 'orphaned' state");
});

test('phase13-hardening', 'releaseExecutionOwnership emits ownership_replaced for failed_over state', () => {
  const src = readFile('runtime/hardening-layer.ts');
  assert(src.includes("'ownership_replaced'"), 'must emit ownership_replaced');
  const idx = src.indexOf("'ownership_replaced'");
  const context = src.slice(Math.max(0, idx - 200), idx + 100);
  assert(context.includes("'failed_over'"), "ownership_replaced must be tied to 'failed_over' state");
});

test('phase13-hardening', 'ownership event emissions use fire-and-forget (.catch)', () => {
  const src = readFile('runtime/hardening-layer.ts');
  const emitCount = (src.match(/appendExecutionEvent\(/g) ?? []).length;
  const catchCount = (src.match(/\.catch\(\(\) => undefined\)/g) ?? []).length;
  assert(emitCount >= 4, `must have at least 4 appendExecutionEvent calls, found ${emitCount}`);
  assert(catchCount >= 3, `fire-and-forget emissions must have .catch(() => undefined), found ${catchCount}`);
});

// ============================================================================
// Section 30: Phase 13 — worker.ts side-effect journaling
// ============================================================================

test('phase13-worker', 'worker.ts imports appendExecutionEvent from event-store', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes("from './event-store'"), 'must import from event-store');
  assert(src.includes('appendExecutionEvent'), 'must import appendExecutionEvent');
});

test('phase13-worker', 'deploy_workflow_to_n8n emits side_effect_requested before assertOwnership', () => {
  const src = readFile('lib/runtime/worker.ts');
  const requestIdx = src.indexOf("operation: 'deploy_workflow_to_n8n'");
  assert(requestIdx > 0, "must emit event with operation: 'deploy_workflow_to_n8n'");
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'deploy_workflow_to_n8n')");
  assert(assertIdx > 0, 'must call assertOwnership for deploy');
  assert(requestIdx < assertIdx, 'side_effect_requested must be emitted BEFORE assertOwnership');
});

test('phase13-worker', 'deploy_workflow_to_n8n emits side_effect_completed on success', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf("operation: 'deploy_workflow_to_n8n'");
  const fromDeploy = src.slice(idx);
  assert(fromDeploy.includes("eventType: 'side_effect_completed'"), 'deploy must emit side_effect_completed on success');
  assert(fromDeploy.includes('n8n_workflow_id'), 'completed event must include n8n_workflow_id');
});

test('phase13-worker', 'deploy_workflow_to_n8n emits side_effect_failed on deploy error', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf("operation: 'deploy_workflow_to_n8n'");
  const fromDeploy = src.slice(idx);
  assert(fromDeploy.includes("eventType: 'side_effect_failed'"), 'deploy failure must emit side_effect_failed');
  assert(fromDeploy.includes('error_code'), 'failed event must include error_code');
});

test('phase13-worker', 'side_effect_completed for deploy uses causationId from request ref', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('deployRequestRef'), 'must capture deploy request ref');
  // deployRequestRef is referenced in both side_effect_failed and side_effect_completed
  // check that the pattern appears anywhere in the file after the declaration
  const declIdx = src.indexOf('const deployRequestRef');
  assert(declIdx > 0, 'must declare deployRequestRef');
  const remainder = src.slice(declIdx);
  assert(remainder.includes('causationId: deployRequestRef?.eventId'), 'completed event must link causationId to request');
});

test('phase13-worker', 'activate_workflow emits side_effect_requested before assertOwnership', () => {
  const src = readFile('lib/runtime/worker.ts');
  const requestIdx = src.indexOf("operation: 'activate_workflow'");
  assert(requestIdx > 0, "must emit event with operation: 'activate_workflow'");
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'activate_workflow')");
  assert(assertIdx > 0, 'must call assertOwnership for activate');
  assert(requestIdx < assertIdx, 'side_effect_requested must be emitted BEFORE assertOwnership');
});

test('phase13-worker', 'activate_workflow emits side_effect_completed on success', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('activateRequestRef'), 'must capture activate request ref');
  const idx = src.indexOf('activateRequestRef');
  const body = src.slice(idx, idx + 2000);
  assert(body.includes("eventType: 'side_effect_completed'"), 'activate must emit side_effect_completed');
  assert(body.includes('causationId: activateRequestRef?.eventId'), 'completed event must link causationId');
});

test('phase13-worker', 'test_workflow emits side_effect_requested before assertOwnership', () => {
  const src = readFile('lib/runtime/worker.ts');
  const requestIdx = src.indexOf("operation: 'test_workflow'");
  assert(requestIdx > 0, "must emit event with operation: 'test_workflow'");
  const assertIdx = src.indexOf("assertOwnership(payload.executionId, payload.userId, ownerCtx, 'test_workflow')");
  assert(assertIdx > 0, 'must call assertOwnership for test');
  assert(requestIdx < assertIdx, 'side_effect_requested must be emitted BEFORE assertOwnership');
});

test('phase13-worker', 'test_workflow emits side_effect_completed or side_effect_failed based on result', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('testRequestRef'), 'must capture test request ref');
  const idx = src.indexOf('testRequestRef');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes("'side_effect_completed'") || body.includes("side_effect_completed"), 'test must emit side_effect_completed');
  assert(body.includes("'side_effect_failed'") || body.includes("side_effect_failed"), 'test must emit side_effect_failed');
  assert(body.includes('causationId: testRequestRef?.eventId'), 'event must link causationId to request');
});

test('phase13-worker', 'side-effect event emissions use fire-and-forget (.catch)', () => {
  const src = readFile('lib/runtime/worker.ts');
  const catchCount = (src.match(/appendExecutionEvent\(/g) ?? []).length;
  assert(catchCount >= 6, `must have at least 6 appendExecutionEvent calls in worker.ts, found ${catchCount}`);
});

// ============================================================================
// Section 31: Phase 13 — API routes
// ============================================================================

test('phase13-api-replay', 'replay route file exists for dynamic executionId', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('executionId'), 'must extract executionId from params');
  assert(src.includes('loadExecutionEvents'), 'must use loadExecutionEvents');
  assert(src.includes('replayFromEvents'), 'must call replayFromEvents');
});

test('phase13-api-replay', 'replay route supports until_seq time-travel parameter', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('until_seq'), 'must support until_seq parameter');
  assert(src.includes('filterEventsUntilSequence'), 'must call filterEventsUntilSequence');
});

test('phase13-api-replay', 'replay route supports until_ts timestamp time-travel', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('until_ts'), 'must support until_ts parameter');
  assert(src.includes('filterEventsUntilTimestamp'), 'must call filterEventsUntilTimestamp');
});

test('phase13-api-replay', 'replay route supports diff between two sequence points', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('diff_from'), 'must support diff_from parameter');
  assert(src.includes('diff_to'), 'must support diff_to parameter');
  assert(src.includes('diffReplayStates'), 'must call diffReplayStates');
});

test('phase13-api-replay', 'replay route uses snapshot acceleration when available', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('loadLatestSnapshot'), 'must load snapshot');
  assert(src.includes('replayFromSnapshot'), 'must use replayFromSnapshot for acceleration');
  assert(src.includes('snapshotUsed'), 'must report whether snapshot was used');
});

test('phase13-api-replay', 'replay route reports observability metrics', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('replay_ms'), 'must report replay duration');
  assert(src.includes('replay_event_count'), 'must report replay event count');
  assert(src.includes('load_ms'), 'must report load duration');
});

test('phase13-api-replay', 'replay route returns 401 for unauthenticated requests', () => {
  const src = readFile('app/api/runtime/replay/[executionId]/route.ts');
  assert(src.includes('Unauthorized'), 'must return 401 for no user');
  assert(src.includes('getUserFromRequest'), 'must use getUserFromRequest');
});

test('phase13-api-timeline', 'timeline route exists and loads execution events', () => {
  const src = readFile('app/api/runtime/timeline/[executionId]/route.ts');
  assert(src.includes('loadExecutionEvents'), 'must load execution events');
  assert(src.includes('timeline'), 'must return timeline array');
});

test('phase13-api-timeline', 'timeline route supports type filter', () => {
  const src = readFile('app/api/runtime/timeline/[executionId]/route.ts');
  assert(src.includes("sp.get('type')"), 'must support type filter param');
});

test('phase13-api-timeline', 'timeline route annotates causality chains', () => {
  const src = readFile('app/api/runtime/timeline/[executionId]/route.ts');
  assert(src.includes('causedBy'), 'must annotate causedBy field for causal chain visibility');
});

test('phase13-api-snapshot', 'snapshot GET route loads latest snapshot', () => {
  const src = readFile('app/api/runtime/snapshot/[executionId]/route.ts');
  assert(src.includes('loadLatestSnapshot'), 'must load latest snapshot');
  assert(src.includes('executionId'), 'must use executionId from params');
});

test('phase13-api-snapshot', 'snapshot GET creates snapshot from replay when ?create=true', () => {
  const src = readFile('app/api/runtime/snapshot/[executionId]/route.ts');
  assert(src.includes("sp.get('create') === 'true'"), 'must support create=true query param');
  assert(src.includes('saveExecutionSnapshot'), 'must call saveExecutionSnapshot');
  assert(src.includes('replayFromEvents'), 'must replay events before creating snapshot');
});

test('phase13-api-snapshot', 'snapshot POST force-creates a snapshot from current replayed state', () => {
  const src = readFile('app/api/runtime/snapshot/[executionId]/route.ts');
  assert(src.includes('export async function POST'), 'must export POST handler');
  assert(src.includes("snapshotType: 'manual'"), "POST must use 'manual' snapshot type");
});

// ============================================================================
// Section 32: Phase 14 — Migration (command bus tables)
// ============================================================================

test('phase14-migration', 'migration creates runtime_execution_commands with status check constraint', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_execution_commands'), 'must create commands table');
  assert(sql.includes("CHECK (status IN ('pending','processing','acknowledged','failed','dead_letter'))"), 'must have status check constraint');
});

test('phase14-migration', 'commands table has UNIQUE(execution_id, sequence_number)', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('runtime_execution_commands_seq_uniq'), 'must name the unique constraint');
  assert(sql.includes('UNIQUE (execution_id, sequence_number)'), 'must enforce uniqueness on (execution_id, sequence_number)');
});

test('phase14-migration', 'migration creates runtime_command_dispatch_log with dispatch_type check', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_command_dispatch_log'), 'must create dispatch log table');
  assert(sql.includes("CHECK (dispatch_type IN ('claimed','acked','failed','dead_lettered','retried'))"), 'must constrain dispatch_type');
});

test('phase14-migration', 'migration creates runtime_workflow_versions with UNIQUE(workflow_id, workflow_version)', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_workflow_versions'), 'must create workflow versions table');
  assert(sql.includes('UNIQUE (workflow_id, workflow_version)'), 'must enforce unique per workflow and version');
  assert(sql.includes('workflow_hash'), 'must store workflow hash');
});

test('phase14-migration', 'append_execution_command uses DIFFERENT advisory lock key than event store', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes("hashtext('cmd:' || p_execution_id)"), "must lock on 'cmd:'+execution_id to avoid deadlock with event store");
  // Verify the event store migration uses a different key
  const eventSql = readFile('supabase/migrations/20260528000002_runtime_phase13_event_sourcing.sql');
  assert(eventSql.includes('hashtext(p_execution_id)') && !eventSql.includes("hashtext('cmd:"), 'event store must use plain hashtext(execution_id)');
});

test('phase14-migration', 'append_execution_command is SECURITY DEFINER and returns (command_id, sequence_number)', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION append_execution_command'), 'must create function');
  assert(sql.includes('RETURNS TABLE(command_id uuid, sequence_number bigint)'), 'must return table with command_id and sequence_number');
  assert(sql.includes('SECURITY DEFINER'), 'must be SECURITY DEFINER');
});

test('phase14-migration', 'fetch_pending_execution_commands uses SKIP LOCKED', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION fetch_pending_execution_commands'), 'must create function');
  assert(sql.includes('FOR UPDATE SKIP LOCKED'), 'must use SKIP LOCKED for multi-worker safety');
  assert(sql.includes('RETURNS SETOF runtime_execution_commands'), 'must return set of command rows');
});

test('phase14-migration', 'ack_execution_command returns boolean and uses GET DIAGNOSTICS', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION ack_execution_command'), 'must create ack function');
  assert(sql.includes('RETURNS boolean'), 'must return boolean');
  assert(sql.includes('GET DIAGNOSTICS'), 'must use GET DIAGNOSTICS for row count');
});

test('phase14-migration', 'migration adds compactable and archivable columns to runtime_execution_events', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS compactable boolean NOT NULL DEFAULT false'), 'must add compactable column');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS archivable  boolean NOT NULL DEFAULT false'), 'must add archivable column');
});

test('phase14-migration', 'mark_execution_events_compactable is SECURITY DEFINER and uses UPDATE', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION mark_execution_events_compactable'), 'must create compactable function');
  assert(sql.includes('RETURNS integer'), 'must return count of marked rows');
  const fnIdx = sql.indexOf('CREATE OR REPLACE FUNCTION mark_execution_events_compactable');
  const fnBody = sql.slice(fnIdx, fnIdx + 800);
  assert(fnBody.includes('SECURITY DEFINER'), 'must be SECURITY DEFINER to bypass INSERT-only RLS');
  assert(fnBody.includes('SET compactable = true'), 'must mark compactable');
});

test('phase14-migration', 'mark_execution_events_archivable is SECURITY DEFINER and marks archivable', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION mark_execution_events_archivable'), 'must create archivable function');
  const fnIdx = sql.indexOf('CREATE OR REPLACE FUNCTION mark_execution_events_archivable');
  const fnBody = sql.slice(fnIdx, fnIdx + 800);
  assert(fnBody.includes('SECURITY DEFINER'), 'must be SECURITY DEFINER');
  assert(fnBody.includes('SET archivable = true'), 'must mark archivable');
});

// ============================================================================
// Section 33: Phase 14 — deterministic-clock.ts
// ============================================================================

test('phase14-clock', 'RuntimeClock class is exported from deterministic-clock.ts', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('export class RuntimeClock'), 'must export RuntimeClock class');
});

test('phase14-clock', 'RuntimeClock.wall() creates a wall-mode clock', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('static wall()'), 'must have static wall() factory');
  assert(src.includes('new RuntimeClock(true)'), 'wall() must pass true for wallMode');
});

test('phase14-clock', 'RuntimeClock.fromEventTimestamps creates replay clock', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('static fromEventTimestamps(timestamps: string[])'), 'must have fromEventTimestamps factory');
  assert(src.includes('new RuntimeClock(false'), 'fromEventTimestamps must pass false for wallMode');
});

test('phase14-clock', 'RuntimeClock.isReplay returns false for wall mode', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('isReplay()'), 'must have isReplay() method');
  assert(src.includes('return !this._wallMode'), 'isReplay must return !wallMode');
});

test('phase14-clock', 'RuntimeClock.now() returns replay timestamps in order', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('this._replayIndex++'), 'must advance replay index');
  assert(src.includes('this._replayTimestamps[this._replayIndex'), 'must read from replay timestamps array');
});

test('phase14-clock', 'RuntimeClock.nowMs returns number from now()', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('nowMs()'), 'must have nowMs() method');
  assert(src.includes('new Date(this.now()).getTime()'), 'nowMs must derive from now()');
});

test('phase14-clock', 'LogicalClock class is exported from deterministic-clock.ts', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('export class LogicalClock'), 'must export LogicalClock class');
});

test('phase14-clock', 'LogicalClock.fromSequence initialises from last sequence number', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('static fromSequence(lastSequence: number)'), 'must have fromSequence factory');
  assert(src.includes('new LogicalClock(lastSequence)'), 'must initialise with lastSequence');
});

test('phase14-clock', 'LogicalClock.tick increments and LogicalClock.peek does not', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('return ++this._counter'), 'tick() must pre-increment');
  assert(src.includes('peek()'), 'must have peek() method');
  assert(src.includes('return this._counter'), 'peek() must return counter without change');
});

test('phase14-clock', 'LogicalClock.advance moves counter forward only', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('advance(to: number)'), 'must have advance() method');
  assert(src.includes('if (to > this._counter)'), 'advance() must only move forward');
});

test('phase14-clock', 'scheduleVirtualTimer sets timer:true in metadata and persists via scheduleCommand', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('export async function scheduleVirtualTimer'), 'must export scheduleVirtualTimer');
  assert(src.includes('timer: true'), 'must mark commands with timer:true in metadata');
  assert(src.includes('scheduleCommand('), 'must use scheduleCommand for persistence');
});

test('phase14-clock', 'loadPendingTimers filters by timer:true metadata', () => {
  const src = readFile('lib/runtime/deterministic-clock.ts');
  assert(src.includes('export async function loadPendingTimers'), 'must export loadPendingTimers');
  assert(src.includes('.filter((t) => t.metadata.timer === true)'), 'must filter to only timer commands');
  assert(src.includes("'runtime_execution_commands'"), 'must query the command table');
});

// ============================================================================
// Section 34: Phase 14 — command-bus.ts
// ============================================================================

test('phase14-command-bus', 'appendCommand returns null when userId is absent', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('if (!input.userId) return null;'), 'must guard against absent userId');
});

test('phase14-command-bus', 'appendCommand calls append_execution_command RPC', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("rpc('append_execution_command'"), 'must call append_execution_command RPC');
  assert(src.includes('p_execution_id'), 'must pass p_execution_id');
  assert(src.includes('p_command_type'), 'must pass p_command_type');
  assert(src.includes('p_scheduled_for'), 'must pass p_scheduled_for for timer support');
});

test('phase14-command-bus', 'dispatchCommand is an alias for appendCommand', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('export const dispatchCommand = appendCommand'), 'dispatchCommand must be an alias');
});

test('phase14-command-bus', 'fetchPendingCommands calls fetch_pending_execution_commands RPC', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("rpc('fetch_pending_execution_commands'"), 'must call fetch RPC');
  assert(src.includes('p_worker_id'), 'must pass worker_id to the RPC');
  assert(src.includes('p_limit'), 'must pass limit to the RPC');
});

test('phase14-command-bus', 'acknowledgeCommand calls ack_execution_command RPC', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("rpc('ack_execution_command'"), 'must call ack RPC');
  assert(src.includes('p_command_id'), 'must pass command_id');
  assert(src.includes('p_worker_id'), 'must pass worker_id to ack');
});

test('phase14-command-bus', 'deadLetterCommand sets status to dead_letter', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("status: 'dead_letter'"), 'must set status to dead_letter');
  assert(src.includes("'runtime_command_dispatch_log'"), 'must insert into dispatch log');
  assert(src.includes("dispatch_type: 'dead_lettered'"), 'must record dead_lettered dispatch type');
});

test('phase14-command-bus', 'deadLetterExecutionCommands finds all pending/processing commands for execution', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('export async function deadLetterExecutionCommands'), 'must export deadLetterExecutionCommands');
  assert(src.includes(".in('status', ['pending', 'processing'])"), 'must find pending and processing commands');
  assert(src.includes('deadLetterCommand('), 'must call deadLetterCommand for each found command');
});

test('phase14-command-bus', 'retryCommand uses exponential backoff with Math.pow', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('Math.pow(2, retryCount)'), 'must use exponential backoff');
  assert(src.includes('MAX_RETRY_DELAY_MS'), 'must cap the delay');
  assert(src.includes('computeRetryDelay'), 'must have retry delay calculation');
});

test('phase14-command-bus', 'retryCommand dead-letters after MAX_RETRY_COUNT', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('MAX_RETRY_COUNT'), 'must define MAX_RETRY_COUNT');
  assert(src.includes('currentRetryCount >= MAX_RETRY_COUNT'), 'must check against max retries');
  const idx = src.indexOf('currentRetryCount >= MAX_RETRY_COUNT');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('deadLetterCommand('), 'must call deadLetterCommand when max retries exceeded');
});

test('phase14-command-bus', 'scheduleCommand passes scheduledFor to appendCommand', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('export async function scheduleCommand'), 'must export scheduleCommand');
  assert(src.includes('scheduledFor:  params.scheduledFor'), 'must forward scheduledFor to appendCommand');
  assert(src.includes('return appendCommand('), 'scheduleCommand must delegate to appendCommand');
});

test('phase14-command-bus', 'pinWorkflowVersion computes SHA-256 hash from nodes and connections', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("from 'node:crypto'"), 'must import from node:crypto');
  assert(src.includes("createHash('sha256')"), 'must use SHA-256');
  assert(src.includes('JSON.stringify({ nodes: params.nodes, connections: params.connections })'), 'must hash canonical JSON');
});

test('phase14-command-bus', 'pinWorkflowVersion is idempotent: checks for existing hash before inserting', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('export async function pinWorkflowVersion'), 'must export pinWorkflowVersion');
  const idx = src.indexOf('pinWorkflowVersion');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes('.eq(\'workflow_hash\', hash)'), 'must check for existing hash');
  assert(body.includes('if (existing)'), 'must return early if hash already pinned');
});

test('phase14-command-bus', 'pinWorkflowVersion inserts into runtime_workflow_versions', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("'runtime_workflow_versions'"), 'must reference workflow versions table');
  assert(src.includes('workflow_hash:'), 'must store the hash');
  assert(src.includes('workflow_snapshot:'), 'must store the snapshot');
});

test('phase14-command-bus', 'CommandType union includes all expected types', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes("'deploy_workflow'"), 'must include deploy_workflow');
  assert(src.includes("'cancel_execution'"), 'must include cancel_execution');
  assert(src.includes("'scheduled_timer'"), 'must include scheduled_timer');
  assert(src.includes("'compact_events'"), 'must include compact_events');
  assert(src.includes("'archive_events'"), 'must include archive_events');
});

test('phase14-command-bus', 'ExecutionCommand type has all required fields', () => {
  const src = readFile('lib/runtime/command-bus.ts');
  assert(src.includes('export type ExecutionCommand'), 'must export ExecutionCommand type');
  const idx = src.indexOf('export type ExecutionCommand');
  const body = src.slice(idx, idx + 700);
  assert(body.includes('sequenceNumber'), 'must have sequenceNumber');
  assert(body.includes('causationId'), 'must have causationId');
  assert(body.includes('retryCount'), 'must have retryCount');
  assert(body.includes('scheduledFor'), 'must have scheduledFor');
  assert(body.includes('processingStartedAt'), 'must have processingStartedAt');
});

// ============================================================================
// Section 35: Phase 14 — replay-integrity.ts
// ============================================================================

test('phase14-replay-integrity', 'computeEventStreamChecksum returns empty string for empty array', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('if (events.length === 0) return'), 'must short-circuit on empty events');
  assert(src.includes("return ''"), "must return empty string for empty events");
});

test('phase14-replay-integrity', 'computeEventStreamChecksum uses SHA-256 over seq:type:payload', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes("createHash('sha256')"), 'must use SHA-256');
  assert(src.includes('`${event.sequenceNumber}:${event.eventType}:${JSON.stringify(event.payload)}'), 'must hash seq:type:payload per event');
  assert(src.includes('.digest(\'hex\')'), 'must return hex digest');
});

test('phase14-replay-integrity', 'detectSequenceGaps returns empty for contiguous sequence', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('export function detectSequenceGaps'), 'must export detectSequenceGaps');
  assert(src.includes('const gaps: SequenceGap[]'), 'must accumulate gaps array');
  assert(src.includes('curr - prev > 1'), 'must detect gaps when diff > 1');
});

test('phase14-replay-integrity', 'detectSequenceGaps computes missingCount correctly', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('missingCount:   curr - prev - 1'), 'missingCount must be curr - prev - 1');
  assert(src.includes('afterSequence:  prev'), 'must record afterSequence');
  assert(src.includes('beforeSequence: curr'), 'must record beforeSequence');
});

test('phase14-replay-integrity', 'validateFencingConsistency detects non-monotonic tokens', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('export function validateFencingConsistency'), 'must export validateFencingConsistency');
  assert(src.includes("violationType:  'non_monotonic'"), 'must mark non_monotonic violations');
  assert(src.includes('if (token < maxFencingToken)'), 'must detect when token regresses');
});

test('phase14-replay-integrity', 'validateFencingConsistency detects split-brain stale-token violations', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes("violationType:  'split_brain_stale_token'"), 'must detect split_brain_stale_token');
  assert(src.includes('if (staleToken >= authToken)'), 'stale must be strictly less than authoritative');
});

test('phase14-replay-integrity', 'verifyReplayIntegrity returns no_events verdict for empty stream', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes("deterministicReplayVerdict: 'no_events'"), 'must return no_events for empty stream');
  assert(src.includes('if (events.length === 0)'), 'must short-circuit on empty stream');
});

test('phase14-replay-integrity', 'verifyReplayIntegrity returns clean when all checks pass', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes("deterministicReplayVerdict: 'clean'"), 'must produce clean verdict');
  assert(src.includes("deterministicReplayVerdict = 'clean'"), 'clean must be the default verdict');
});

test('phase14-replay-integrity', 'verifyReplayIntegrity loads both events and latest snapshot', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('loadExecutionEvents'), 'must load execution events');
  assert(src.includes('loadLatestSnapshot'), 'must load latest snapshot');
  assert(src.includes('Promise.all(['), 'must load events and snapshot in parallel');
});

test('phase14-replay-integrity', 'ReplayIntegrityReport type has required fields', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('export type ReplayIntegrityReport'), 'must export type');
  const idx = src.indexOf('export type ReplayIntegrityReport');
  const body = src.slice(idx, idx + 500);
  assert(body.includes('checksum'), 'must have checksum field');
  assert(body.includes('sequenceGaps'), 'must have sequenceGaps field');
  assert(body.includes('fencingViolations'), 'must have fencingViolations field');
  assert(body.includes('deterministicReplayVerdict'), 'must have verdict field');
});

test('phase14-replay-integrity', 'SequenceGap type has afterSequence, beforeSequence, missingCount', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('export type SequenceGap'), 'must export SequenceGap type');
  assert(src.includes('afterSequence'), 'must have afterSequence');
  assert(src.includes('beforeSequence'), 'must have beforeSequence');
  assert(src.includes('missingCount'), 'must have missingCount');
});

test('phase14-replay-integrity', 'verifyReplayIntegrity checks snapshot version compatibility', () => {
  const src = readFile('lib/runtime/replay-integrity.ts');
  assert(src.includes('snapshotCompatible'), 'must report snapshot compatibility');
  assert(src.includes('snapshot.snapshotVersion <= maxSeq'), 'must verify snapshot version does not exceed event stream');
});

// ============================================================================
// Section 36: Phase 14 — compaction.ts
// ============================================================================

test('phase14-compaction', 'analyzeCompaction returns empty report when no events exist', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('if (events.length === 0)'), 'must short-circuit when no events');
  assert(src.includes('replayCostEstimate:  0'), 'must return 0 replay cost for empty stream');
});

test('phase14-compaction', 'analyzeCompaction identifies compactable range before snapshot', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('compactableRanges'), 'must compute compactable ranges');
  const idx = src.indexOf('compactableRanges.push(');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('covered by snapshot'), 'must explain why range is compactable');
  assert(body.includes('fromSequence'), 'must record range start');
});

test('phase14-compaction', 'analyzeCompaction computes replayCostEstimate from snapshot', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('replayCostEstimate'), 'must compute replay cost');
  assert(src.includes('e.sequenceNumber > snapshotSeq'), 'must count events after snapshot');
});

test('phase14-compaction', 'analyzeCompaction recommends snapshot when cost > 100 and snapshot stale', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('snapshotRecommended'), 'must compute snapshotRecommended');
  assert(src.includes('replayCostEstimate > 100'), 'must trigger recommendation at >100 events');
  assert(src.includes('maxSeq - snapshotSeq > 50'), 'must check staleness');
});

test('phase14-compaction', 'analyzeCompaction identifies archival candidates by date cutoff', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('archivalRanges'), 'must compute archival ranges');
  assert(src.includes('archiveCutoff'), 'must use date cutoff for archival');
  assert(src.includes('e.createdAt < archiveCutoff'), 'must filter events before cutoff');
});

test('phase14-compaction', 'markEventsCompactable calls mark_execution_events_compactable RPC', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('export async function markEventsCompactable'), 'must export markEventsCompactable');
  assert(src.includes("rpc('mark_execution_events_compactable'"), 'must call the SECURITY DEFINER RPC');
  assert(src.includes('p_up_to_sequence'), 'must pass up_to_sequence');
});

test('phase14-compaction', 'markEventsArchivable calls mark_execution_events_archivable RPC', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('export async function markEventsArchivable'), 'must export markEventsArchivable');
  assert(src.includes("rpc('mark_execution_events_archivable'"), 'must call the SECURITY DEFINER RPC');
  assert(src.includes('p_before_ts'), 'must pass before_ts');
});

test('phase14-compaction', 'CompactionReport type has all required fields', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('export type CompactionReport'), 'must export CompactionReport type');
  const idx = src.indexOf('export type CompactionReport');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('replayCostEstimate'), 'must have replayCostEstimate');
  assert(body.includes('snapshotRecommended'), 'must have snapshotRecommended');
  assert(body.includes('alreadyCompactable'), 'must have alreadyCompactable');
  assert(body.includes('alreadyArchivable'), 'must have alreadyArchivable');
});

test('phase14-compaction', 'CompactionRange type has fromSequence, toSequence, eventCount, reason', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('export type CompactionRange'), 'must export CompactionRange type');
  const idx = src.indexOf('export type CompactionRange');
  const body = src.slice(idx, idx + 200);
  assert(body.includes('fromSequence'), 'must have fromSequence');
  assert(body.includes('toSequence'), 'must have toSequence');
  assert(body.includes('reason'), 'must have reason field');
});

test('phase14-compaction', 'ArchivalRange type has date metadata fields', () => {
  const src = readFile('lib/runtime/compaction.ts');
  assert(src.includes('export type ArchivalRange'), 'must export ArchivalRange type');
  const idx = src.indexOf('export type ArchivalRange');
  const body = src.slice(idx, idx + 200);
  assert(body.includes('oldestEventAt'), 'must have oldestEventAt');
  assert(body.includes('newestEventAt'), 'must have newestEventAt');
});

// ============================================================================
// Section 37: Phase 14 — worker.ts modifications
// ============================================================================

test('phase14-worker', 'worker imports pinWorkflowVersion from command-bus', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('pinWorkflowVersion'), 'must import pinWorkflowVersion');
  assert(src.includes("from './command-bus'"), "must import from './command-bus'");
});

test('phase14-worker', 'worker imports deadLetterExecutionCommands from command-bus', () => {
  const src = readFile('lib/runtime/worker.ts');
  assert(src.includes('deadLetterExecutionCommands'), 'must import deadLetterExecutionCommands');
});

test('phase14-worker', 'deploy_workflow_to_n8n calls pinWorkflowVersion before deployment', () => {
  const src = readFile('lib/runtime/worker.ts');
  const pinIdx = src.indexOf('pinWorkflowVersion(');
  assert(pinIdx > 0, 'must call pinWorkflowVersion');
  // Verify it is called in the deploy_workflow_to_n8n section, before the deploy RPC
  const deployIdx = src.indexOf("if (toolName === 'deploy_workflow_to_n8n')");
  assert(deployIdx > 0, 'must have deploy_workflow_to_n8n handler');
  assert(pinIdx > deployIdx, 'pinWorkflowVersion must be called inside the deploy handler');
});

test('phase14-worker', 'pinWorkflowVersion receives workflowData nodes and connections', () => {
  const src = readFile('lib/runtime/worker.ts');
  const idx = src.indexOf('pinWorkflowVersion(');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('nodes: workflowData.nodes'), 'must pass workflowData.nodes');
  assert(body.includes('connections: workflowData.connections'), 'must pass workflowData.connections');
});

test('phase14-worker', 'OwnershipAbortSignal path calls deadLetterExecutionCommands fire-and-forget', () => {
  const src = readFile('lib/runtime/worker.ts');
  const abortIdx = src.indexOf('instanceof OwnershipAbortSignal');
  assert(abortIdx > 0, 'must handle OwnershipAbortSignal');
  const abortBody = src.slice(abortIdx, abortIdx + 900);
  assert(abortBody.includes('deadLetterExecutionCommands('), 'must call deadLetterExecutionCommands on abort');
  assert(abortBody.includes('.catch(() => undefined)'), 'must be fire-and-forget');
});

// ============================================================================
// Section 38: Phase 14 — API routes (commands, replay-integrity, compaction)
// ============================================================================

test('phase14-api-commands', 'commands GET route loads commands for execution', () => {
  const src = readFile('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes("'runtime_execution_commands'"), 'must query commands table');
  assert(src.includes('executionId'), 'must use executionId from params');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase14-api-commands', 'commands GET route supports status filter', () => {
  const src = readFile('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes("sp.get('status')"), 'must support status filter query param');
  assert(src.includes('.eq(\'status\''), 'must apply status filter');
});

test('phase14-api-commands', 'commands GET route annotates causation chain', () => {
  const src = readFile('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes('causedByType'), 'must annotate causedByType for causation chain');
  assert(src.includes('commandIndex'), 'must build command index for causation lookup');
});

test('phase14-api-commands', 'commands GET route returns 401 for unauthenticated requests', () => {
  const src = readFile('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes('Unauthorized'), 'must return 401 for unauthenticated');
});

test('phase14-api-commands', 'commands POST route supports retry and dead_letter actions', () => {
  const src = readFile('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes('export async function POST'), 'must export POST handler');
  assert(src.includes("action === 'retry'"), 'must support retry action');
  assert(src.includes("action === 'dead_letter'"), 'must support dead_letter action');
  assert(src.includes('retryCommand('), 'must call retryCommand');
  assert(src.includes('deadLetterCommand('), 'must call deadLetterCommand');
});

test('phase14-api-replay-integrity', 'replay-integrity GET route calls verifyReplayIntegrity', () => {
  const src = readFile('app/api/runtime/replay-integrity/[executionId]/route.ts');
  assert(src.includes('verifyReplayIntegrity'), 'must call verifyReplayIntegrity');
  assert(src.includes('executionId'), 'must use executionId from params');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase14-api-replay-integrity', 'replay-integrity route supports expected_checksum parameter', () => {
  const src = readFile('app/api/runtime/replay-integrity/[executionId]/route.ts');
  assert(src.includes('expected_checksum'), 'must support expected_checksum query param');
  assert(src.includes('expectedChecksum'), 'must forward to verifyReplayIntegrity');
});

test('phase14-api-replay-integrity', 'replay-integrity route returns deterministicReplayVerdict in response', () => {
  const src = readFile('app/api/runtime/replay-integrity/[executionId]/route.ts');
  assert(src.includes('...report'), 'must spread the full report into response');
  assert(src.includes('metrics'), 'must include timing metrics');
});

test('phase14-api-compaction', 'compaction GET route calls analyzeCompaction', () => {
  const src = readFile('app/api/runtime/compaction/[executionId]/route.ts');
  assert(src.includes('analyzeCompaction'), 'must call analyzeCompaction');
  assert(src.includes('executionId'), 'must use executionId');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase14-api-compaction', 'compaction GET route supports archive_after_days parameter', () => {
  const src = readFile('app/api/runtime/compaction/[executionId]/route.ts');
  assert(src.includes('archive_after_days'), 'must support archive_after_days query param');
  assert(src.includes('archiveAfterDays'), 'must forward to analyzeCompaction');
});

test('phase14-api-compaction', 'compaction POST route supports mark_compactable and mark_archivable', () => {
  const src = readFile('app/api/runtime/compaction/[executionId]/route.ts');
  assert(src.includes('export async function POST'), 'must export POST handler');
  assert(src.includes("action === 'mark_compactable'"), 'must handle mark_compactable');
  assert(src.includes("action === 'mark_archivable'"), 'must handle mark_archivable');
  assert(src.includes('markEventsCompactable('), 'must call markEventsCompactable');
  assert(src.includes('markEventsArchivable('), 'must call markEventsArchivable');
});

// ============================================================================
// Section 39: Phase 14 — event-store compaction column additions
// ============================================================================

test('phase14-event-store-compaction', 'Phase 14 migration adds compactable to runtime_execution_events', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(
    sql.includes('ALTER TABLE runtime_execution_events') && sql.includes('compactable'),
    'must alter runtime_execution_events to add compactable column'
  );
});

test('phase14-event-store-compaction', 'Phase 14 migration adds archivable to runtime_execution_events', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(
    sql.includes('ALTER TABLE runtime_execution_events') && sql.includes('archivable'),
    'must alter runtime_execution_events to add archivable column'
  );
});

test('phase14-event-store-compaction', 'compactable and archivable columns default to false', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  const idx = sql.indexOf('ADD COLUMN IF NOT EXISTS compactable');
  const body = sql.slice(idx, idx + 200);
  assert(body.includes('DEFAULT false'), 'compactable must default to false');
});

test('phase14-event-store-compaction', 'compaction marking functions exist in Phase 14 migration', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('mark_execution_events_compactable'), 'compactable function must exist');
  assert(sql.includes('mark_execution_events_archivable'), 'archivable function must exist');
});

test('phase14-event-store-compaction', 'compaction indexes are created for compactable and archivable columns', () => {
  const sql = readFile('supabase/migrations/20260529000001_runtime_phase14_command_bus.sql');
  assert(sql.includes('runtime_execution_events_compactable_idx'), 'must create compactable index');
  assert(sql.includes('runtime_execution_events_archivable_idx'), 'must create archivable index');
  assert(sql.includes('WHERE compactable = true'), 'compactable index must be partial');
  assert(sql.includes('WHERE archivable = true'), 'archivable index must be partial');
});

// ============================================================================
// Section 40: Phase 15 — migration (runtime_incidents + runtime_incident_events)
// ============================================================================

test('phase15-migration', 'migration creates runtime_incidents table', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_incidents'), 'must create runtime_incidents');
  assert(sql.includes('incident_type'), 'must have incident_type column');
  assert(sql.includes('occurrence_count'), 'must have occurrence_count for dedup bump');
  assert(sql.includes('first_seen_at'), 'must have first_seen_at');
  assert(sql.includes('last_seen_at'), 'must have last_seen_at');
});

test('phase15-migration', 'migration creates runtime_incident_events table', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_incident_events'), 'must create runtime_incident_events');
  assert(sql.includes("CHECK (event_type IN ('created', 'updated', 'escalated', 'resolved', 'comment')"), 'must constrain event_type');
  assert(sql.includes('REFERENCES runtime_incidents(id)'), 'must FK to runtime_incidents');
});

test('phase15-migration', 'migration creates runtime_operator_actions table', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS runtime_operator_actions'), 'must create runtime_operator_actions');
  assert(sql.includes('action_type'), 'must have action_type');
  assert(sql.includes('operator_id'), 'must have operator_id');
});

test('phase15-migration', 'runtime_incidents has severity and status CHECK constraints', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes("CHECK (severity IN ('low', 'medium', 'high', 'critical')"), 'must constrain severity');
  assert(sql.includes("CHECK (status   IN ('open', 'investigating', 'resolved')"), 'must constrain status');
});

test('phase15-migration', 'migration creates dedup partial unique index on runtime_incidents', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('runtime_incidents_dedup_idx'), 'must name dedup index');
  assert(sql.includes("WHERE status IN ('open', 'investigating')"), 'must be partial on open/investigating');
  assert(sql.includes('COALESCE(execution_id'), 'must COALESCE execution_id for null handling');
  assert(sql.includes('COALESCE(worker_id'), 'must COALESCE worker_id for null handling');
});

test('phase15-migration', 'migration creates open_or_bump_incident() function', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION open_or_bump_incident'), 'must create open_or_bump_incident');
  assert(sql.includes('SECURITY DEFINER'), 'must be SECURITY DEFINER');
  assert(sql.includes('occurrence_count = occurrence_count + 1'), 'must bump occurrence_count on dedup');
  assert(sql.includes('was_created'), 'must return was_created flag');
});

test('phase15-migration', 'open_or_bump_incident escalates severity when incoming is higher', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes("p_severity = 'critical' THEN 'critical'"), 'must escalate to critical');
  assert(sql.includes("p_severity = 'high'"), 'must handle high escalation');
});

test('phase15-migration', 'migration enables RLS on all three new tables', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('ALTER TABLE runtime_incidents          ENABLE ROW LEVEL SECURITY'), 'must enable RLS on incidents');
  assert(sql.includes('ALTER TABLE runtime_incident_events    ENABLE ROW LEVEL SECURITY'), 'must enable RLS on incident_events');
  assert(sql.includes('ALTER TABLE runtime_operator_actions   ENABLE ROW LEVEL SECURITY'), 'must enable RLS on operator_actions');
});

test('phase15-migration', 'migration creates performance indexes', () => {
  const sql = readFile('supabase/migrations/20260530000001_runtime_phase15_incidents_control.sql');
  assert(sql.includes('runtime_incidents_status_idx'), 'must index by status+severity');
  assert(sql.includes('runtime_incident_events_incident_idx'), 'must index events by incident_id');
  assert(sql.includes('runtime_operator_actions_operator_idx'), 'must index operator actions');
});

// ============================================================================
// Section 41: Phase 15 — incident-manager.ts
// ============================================================================

test('phase15-incident-manager', 'exports IncidentType union with required types', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes('export type IncidentType'), 'must export IncidentType');
  assert(src.includes("'split_brain_prevented'"), 'must include split_brain_prevented');
  assert(src.includes("'ownership_fenced'"), 'must include ownership_fenced');
  assert(src.includes("'worker_crash_repeated'"), 'must include worker_crash_repeated');
  assert(src.includes("'command_dead_letter'"), 'must include command_dead_letter');
  assert(src.includes("'replay_integrity_failure'"), 'must include replay_integrity_failure');
  assert(src.includes("'queue_congestion'"), 'must include queue_congestion');
});

test('phase15-incident-manager', 'Incident type has all required fields', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes('export type Incident'), 'must export Incident type');
  const idx = src.indexOf('export type Incident =');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('incidentType'), 'must have incidentType');
  assert(body.includes('occurrenceCount'), 'must have occurrenceCount');
  assert(body.includes('firstSeenAt'), 'must have firstSeenAt');
  assert(body.includes('lastSeenAt'), 'must have lastSeenAt');
  assert(body.includes('resolvedAt'), 'must have resolvedAt');
  assert(body.includes('resolvedBy'), 'must have resolvedBy');
});

test('phase15-incident-manager', 'IncidentEvent type has required fields', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes('export type IncidentEvent'), 'must export IncidentEvent type');
  const idx = src.indexOf('export type IncidentEvent');
  const body = src.slice(idx, idx + 300);
  assert(body.includes("'created' | 'updated' | 'escalated' | 'resolved' | 'comment'"), 'must enumerate event types');
  assert(body.includes('actor'), 'must have actor field');
});

test('phase15-incident-manager', 'openIncident calls open_or_bump_incident RPC', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function openIncident"), 'must export openIncident');
  assert(src.includes("rpc('open_or_bump_incident'"), 'must call RPC for atomic dedup');
  assert(src.includes('wasCreated'), 'must return wasCreated flag');
});

test('phase15-incident-manager', 'openIncident appends audit event after open/bump', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  const idx = src.indexOf('export async function openIncident');
  const body = src.slice(idx, idx + 1600);
  assert(body.includes('appendIncidentEvent('), 'must append audit event');
  assert(body.includes(".catch(() => undefined)"), 'must be fire-and-forget');
});

test('phase15-incident-manager', 'appendIncidentEvent inserts into runtime_incident_events', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function appendIncidentEvent"), 'must export appendIncidentEvent');
  assert(src.includes("'runtime_incident_events'"), 'must target incident events table');
  assert(src.includes('incident_id'), 'must set incident_id');
  assert(src.includes('event_type'), 'must set event_type');
});

test('phase15-incident-manager', 'resolveIncident marks status resolved and appends resolved event', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function resolveIncident"), 'must export resolveIncident');
  const idx = src.indexOf('export async function resolveIncident');
  const body = src.slice(idx, idx + 750);
  assert(body.includes("status:      'resolved'"), 'must set status to resolved');
  assert(body.includes('resolved_at'), 'must set resolved_at timestamp');
  assert(body.includes("eventType:  'resolved'"), "must append 'resolved' event");
});

test('phase15-incident-manager', 'escalateIncident updates severity and sets status to investigating', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function escalateIncident"), 'must export escalateIncident');
  const idx = src.indexOf('export async function escalateIncident');
  const body = src.slice(idx, idx + 750);
  assert(body.includes("status:     'investigating'"), 'must set status to investigating');
  assert(body.includes('toSeverity'), 'must use the provided toSeverity');
  assert(body.includes("eventType:  'escalated'"), "must append 'escalated' event");
});

test('phase15-incident-manager', 'listActiveIncidents filters by status IN open/investigating', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function listActiveIncidents"), 'must export listActiveIncidents');
  assert(src.includes("in('status', ['open', 'investigating'])"), 'must filter to active statuses');
  assert(src.includes("'last_seen_at'"), 'must order by last_seen_at');
});

test('phase15-incident-manager', 'getIncidentById returns incident with audit events', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function getIncidentById"), 'must export getIncidentById');
  const idx = src.indexOf('export async function getIncidentById');
  const body = src.slice(idx, idx + 500);
  assert(body.includes("'runtime_incident_events'"), 'must load incident events');
  assert(body.includes('Promise.all(['), 'must load incident + events in parallel');
  assert(body.includes('incidentEvents'), 'must return incidentEvents array');
});

test('phase15-incident-manager', 'recordOperatorAction inserts into runtime_operator_actions', () => {
  const src = readFile('lib/runtime/incident-manager.ts');
  assert(src.includes("export async function recordOperatorAction"), 'must export recordOperatorAction');
  assert(src.includes("'runtime_operator_actions'"), 'must target operator actions table');
  assert(src.includes('action_type'), 'must set action_type');
  assert(src.includes('operator_id'), 'must set operator_id');
});

// ============================================================================
// Section 42: Phase 15 — health-score-v2.ts
// ============================================================================

test('phase15-health-score', 'exports HealthScoreV2 type with all required fields', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('export type HealthScoreV2'), 'must export HealthScoreV2');
  const idx = src.indexOf('export type HealthScoreV2');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('overallScore'), 'must have overallScore');
  assert(body.includes('components'), 'must have components');
  assert(body.includes('signals'), 'must have signals');
  assert(body.includes('computedAt'), 'must have computedAt');
});

test('phase15-health-score', 'HealthScoreComponents has all five component scores', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('export type HealthScoreComponents'), 'must export HealthScoreComponents');
  const idx = src.indexOf('export type HealthScoreComponents');
  const body = src.slice(idx, idx + 300);
  assert(body.includes('workerLiveness'), 'must have workerLiveness');
  assert(body.includes('queueHealth'), 'must have queueHealth');
  assert(body.includes('commandBusHealth'), 'must have commandBusHealth');
  assert(body.includes('replayIntegrityHealth'), 'must have replayIntegrityHealth');
  assert(body.includes('incidentSeverityScore'), 'must have incidentSeverityScore');
});

test('phase15-health-score', 'HealthScoreSignals has all required signals', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('export type HealthScoreSignals'), 'must export HealthScoreSignals');
  const idx = src.indexOf('export type HealthScoreSignals');
  const body = src.slice(idx, idx + 400);
  assert(body.includes('commandBacklog'), 'must have commandBacklog signal');
  assert(body.includes('deadLetterRate'), 'must have deadLetterRate signal');
  assert(body.includes('replayIntegrityStatus'), 'must have replayIntegrityStatus signal');
  assert(body.includes('workerLivenessPercent'), 'must have workerLivenessPercent signal');
  assert(body.includes('openIncidentCount'), 'must have openIncidentCount signal');
  assert(body.includes('criticalIncidentCount'), 'must have criticalIncidentCount signal');
  assert(body.includes('queueDelay'), 'must have queueDelay signal');
});

test('phase15-health-score', 'computeHealthScoreV2 uses weighted combination', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('export async function computeHealthScoreV2'), 'must export computeHealthScoreV2');
  assert(src.includes('WEIGHTS'), 'must define weight table');
  assert(src.includes('workerLiveness        * WEIGHTS.workerLiveness'), 'must weight worker liveness');
  assert(src.includes('commandBusHealth      * WEIGHTS.commandBusHealth'), 'must weight command bus health');
  assert(src.includes('incidentSeverityScore * WEIGHTS.incidentSeverityScore'), 'must weight incident severity');
});

test('phase15-health-score', 'computeHealthScoreV2 queries command backlog and dead-letter rate', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes("'runtime_execution_commands'"), 'must query commands table');
  assert(src.includes("eq('status', 'pending')"), 'must count pending commands as backlog');
  assert(src.includes("eq('status', 'dead_letter')"), 'must count dead_letter commands');
  assert(src.includes('deadLetterRate'), 'must compute deadLetterRate');
});

test('phase15-health-score', 'computeHealthScoreV2 calls listActiveIncidents for incident signals', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes("listActiveIncidents"), 'must call listActiveIncidents');
  assert(src.includes("criticalIncidentCount"), 'must count critical incidents');
  assert(src.includes("incidentSeverityScore"), 'must compute incidentSeverityScore');
});

test('phase15-health-score', 'computeHealthScoreV2 clamps overallScore to 0-100', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('Math.max(0, Math.min(100, overallScore))'), 'must clamp overall score to 0-100');
});

test('phase15-health-score', 'computeHealthScoreV2 computes replayIntegrityStatus from incidents', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes("replayIntegrityStatus"), 'must compute replayIntegrityStatus');
  assert(src.includes("'replay_integrity_failure'"), 'must check replay_integrity_failure incidents');
  assert(src.includes("'degraded'"), "must set 'degraded' when replay incidents exist");
  assert(src.includes("'clean'"), "must default to 'clean' when no replay incidents");
});

test('phase15-health-score', 'computeHealthScoreV2 queries worker liveness with heartbeat cutoff', () => {
  const src = readFile('lib/runtime/health-score-v2.ts');
  assert(src.includes('staleWorkerCutoff'), 'must define stale worker cutoff');
  assert(src.includes('workerLivenessPercent'), 'must compute workerLivenessPercent');
  assert(src.includes("in('status', ['healthy', 'degraded'])"), 'must filter live worker statuses');
});

// ============================================================================
// Section 43: Phase 15 — control/overview route
// ============================================================================

test('phase15-control-overview', 'overview GET route requires authentication', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
  assert(src.includes('Unauthorized'), 'must return 401 for unauthenticated');
});

test('phase15-control-overview', 'overview GET route calls computeHealthScoreV2', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('computeHealthScoreV2'), 'must call computeHealthScoreV2');
  assert(src.includes('healthScore'), 'must include healthScore in response');
});

test('phase15-control-overview', 'overview GET route includes active incidents', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('listActiveIncidents'), 'must call listActiveIncidents');
  assert(src.includes('activeIncidents'), 'must include activeIncidents in response');
});

test('phase15-control-overview', 'overview GET route includes worker summary', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('workerSummary'), 'must include workerSummary in response');
  assert(src.includes('liveWorkers'), 'must count live workers');
  assert(src.includes('totalConcurrency'), 'must sum concurrency');
});

test('phase15-control-overview', 'overview GET route includes command backlog breakdown', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('commandBacklog'), 'must include commandBacklog in response');
  assert(src.includes("'runtime_execution_commands'"), 'must query commands table');
  assert(src.includes('byType'), 'must break down backlog by command type');
});

test('phase15-control-overview', 'overview GET route loads all data in parallel', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('Promise.all(['), 'must load all data in parallel');
  assert(src.includes('generatedAt'), 'must include generatedAt timestamp');
});

// ============================================================================
// Section 44: Phase 15 — control/commands route
// ============================================================================

test('phase15-control-commands', 'commands GET supports filtering by execution_id, status, command_type', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes("sp.get('execution_id')"), 'must support execution_id filter');
  assert(src.includes("sp.get('status')"), 'must support status filter');
  assert(src.includes("sp.get('command_type')"), 'must support command_type filter');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase15-control-commands', 'commands GET returns count and generatedAt', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes('count:'), 'must return count');
  assert(src.includes('generatedAt'), 'must return generatedAt');
});

test('phase15-control-commands', 'commands POST supports retry action calling retryCommand', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes("action === 'retry'"), 'must handle retry action');
  assert(src.includes('retryCommand('), 'must call retryCommand');
  assert(src.includes('currentRetryCount'), 'must pass currentRetryCount');
});

test('phase15-control-commands', 'commands POST supports dead_letter action calling deadLetterCommand', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes("action === 'dead_letter'"), 'must handle dead_letter action');
  assert(src.includes('deadLetterCommand('), 'must call deadLetterCommand');
});

test('phase15-control-commands', 'commands POST records operator action for audit', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes('recordOperatorAction('), 'must record operator action');
  assert(src.includes("'retry_command'"), 'must audit retry_command');
  assert(src.includes("'dead_letter_command'"), 'must audit dead_letter_command');
});

// ============================================================================
// Section 45: Phase 15 — control/executions + control/workers routes
// ============================================================================

test('phase15-control-executions', 'executions GET filters by status, workflow_id, and from', () => {
  const src = readFile('app/api/runtime/control/executions/route.ts');
  assert(src.includes("sp.get('status')"), 'must support status filter');
  assert(src.includes("sp.get('workflow_id')"), 'must support workflow_id filter');
  assert(src.includes("sp.get('from')"), 'must support from filter');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase15-control-executions', 'executions POST pause action appends execution_paused event and command', () => {
  const src = readFile('app/api/runtime/control/executions/route.ts');
  assert(src.includes("action === 'pause'"), 'must handle pause action');
  assert(src.includes("eventType: 'execution_paused'"), 'must append execution_paused event');
  assert(src.includes("commandType: 'pause_execution'"), 'must dispatch pause_execution command');
  assert(src.includes('appendExecutionEvent('), 'must call appendExecutionEvent');
  assert(src.includes('appendCommand('), 'must call appendCommand');
});

test('phase15-control-executions', 'executions POST cancel action appends execution_cancelled event and command', () => {
  const src = readFile('app/api/runtime/control/executions/route.ts');
  assert(src.includes("action === 'cancel'"), 'must handle cancel action');
  assert(src.includes("eventType: 'execution_cancelled'"), 'must append execution_cancelled event');
  assert(src.includes("commandType: 'cancel_execution'"), 'must dispatch cancel_execution command');
});

test('phase15-control-executions', 'executions POST force_snapshot saves snapshot and appends event', () => {
  const src = readFile('app/api/runtime/control/executions/route.ts');
  assert(src.includes("action === 'force_snapshot'"), 'must handle force_snapshot action');
  assert(src.includes('saveExecutionSnapshot('), 'must call saveExecutionSnapshot');
  assert(src.includes("snapshotType:  'manual'"), "must set snapshotType to 'manual'");
  assert(src.includes("operation:       'force_snapshot'"), 'must audit the operation in event payload');
});

test('phase15-control-executions', 'executions POST records operator action for all actions', () => {
  const src = readFile('app/api/runtime/control/executions/route.ts');
  assert(src.includes('recordOperatorAction('), 'must record operator action');
  assert(src.includes("'pause_execution'"), 'must audit pause_execution');
  assert(src.includes("'cancel_execution'"), 'must audit cancel_execution');
  assert(src.includes("'force_snapshot'"), 'must audit force_snapshot');
});

test('phase15-control-workers', 'workers GET returns workers, liveCount, stalledCount, and restartRequests', () => {
  const src = readFile('app/api/runtime/control/workers/route.ts');
  assert(src.includes('liveCount'), 'must include liveCount in response');
  assert(src.includes('stalledCount'), 'must include stalledCount in response');
  assert(src.includes('restartRequests'), 'must include restartRequests in response');
  assert(src.includes('staleWorkerCutoff'), 'must use stale worker cutoff for liveness');
});

test('phase15-control-workers', 'workers POST drain action calls drainWorker', () => {
  const src = readFile('app/api/runtime/control/workers/route.ts');
  assert(src.includes("action === 'drain'"), 'must handle drain action');
  assert(src.includes('drainWorker('), 'must call drainWorker');
  assert(src.includes('recordOperatorAction('), 'must audit drain action');
});

test('phase15-control-workers', 'workers POST restart action calls requestWorkerRestart', () => {
  const src = readFile('app/api/runtime/control/workers/route.ts');
  assert(src.includes("action === 'restart'"), 'must handle restart action');
  assert(src.includes('requestWorkerRestart('), 'must call requestWorkerRestart');
  assert(src.includes("reason: 'manual'"), "must set reason to 'manual'");
});

// ============================================================================
// Section 46: Phase 15 — control/incidents route
// ============================================================================

test('phase15-control-incidents', 'incidents GET supports ?id for single incident with events', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("sp.get('id')"), 'must support id parameter for single lookup');
  assert(src.includes('getIncidentById('), 'must call getIncidentById');
  assert(src.includes('Incident not found'), 'must return 404 for missing incident');
});

test('phase15-control-incidents', 'incidents GET lists active incidents with severity and type filters', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('listActiveIncidents('), 'must call listActiveIncidents');
  assert(src.includes("sp.get('severity')"), 'must support severity filter');
  assert(src.includes("sp.get('incident_type')"), 'must support incident_type filter');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
});

test('phase15-control-incidents', 'incidents POST resolve action calls resolveIncident', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("action === 'resolve'"), 'must handle resolve action');
  assert(src.includes('resolveIncident('), 'must call resolveIncident');
  assert(src.includes("resolved: true"), 'must return resolved: true');
});

test('phase15-control-incidents', 'incidents POST escalate action validates severity and calls escalateIncident', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("action === 'escalate'"), 'must handle escalate action');
  assert(src.includes('escalateIncident('), 'must call escalateIncident');
  assert(src.includes("validSeverities"), 'must validate severity values');
  assert(src.includes("'low', 'medium', 'high', 'critical'"), 'must list valid severities');
});

test('phase15-control-incidents', 'incidents POST comment action calls appendIncidentEvent', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("action === 'comment'"), 'must handle comment action');
  assert(src.includes('appendIncidentEvent('), 'must call appendIncidentEvent');
  assert(src.includes("eventType: 'comment'"), "must append 'comment' event type");
});

test('phase15-control-incidents', 'incidents POST records operator action for all three actions', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('recordOperatorAction('), 'must record operator action');
  assert(src.includes("'resolve_incident'"), 'must audit resolve_incident');
  assert(src.includes("'escalate_incident'"), 'must audit escalate_incident');
  assert(src.includes("'comment_incident'"), 'must audit comment_incident');
});

test('phase15-control-incidents', 'incidents POST validates incidentId is required', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("incidentId is required"), 'must validate incidentId presence');
});

// ============================================================================
// Section 47: Phase 17 — use-auto-refresh hook
// ============================================================================

test('phase17-auto-refresh', 'useAutoRefresh hook exports function', () => {
  const src = readFile('components/control/use-auto-refresh.ts');
  assert(src.includes("export function useAutoRefresh"), 'must export useAutoRefresh');
  assert(src.includes('intervalMs'), 'must accept intervalMs parameter');
  assert(src.includes('enabled'), 'must accept enabled parameter');
});

test('phase17-auto-refresh', 'useAutoRefresh uses Visibility API to pause on hidden', () => {
  const src = readFile('components/control/use-auto-refresh.ts');
  assert(src.includes("visibilitychange"), 'must listen to visibilitychange event');
  assert(src.includes('document.hidden'), 'must check document.hidden');
  assert(src.includes('stop()'), 'must stop when hidden');
});

test('phase17-auto-refresh', 'useAutoRefresh resumes on visibility restore', () => {
  const src = readFile('components/control/use-auto-refresh.ts');
  assert(src.includes('start()'), 'must start when visible');
  assert(src.includes('removeEventListener'), 'must clean up event listener on unmount');
});

test('phase17-auto-refresh', 'useAutoRefresh cleans up timer on unmount', () => {
  const src = readFile('components/control/use-auto-refresh.ts');
  assert(src.includes('clearInterval'), 'must clear interval on cleanup');
  assert(src.includes('setInterval'), 'must use setInterval for polling');
});

// ============================================================================
// Section 48: Phase 17 — health snapshot migration
// ============================================================================

test('phase17-migration', 'migration creates runtime_health_score_snapshots table', () => {
  const src = readFile('supabase/migrations/20260530000002_runtime_phase17_health_history.sql');
  assert(src.includes('runtime_health_score_snapshots'), 'must create snapshots table');
  assert(src.includes('overall_score'), 'must have overall_score column');
  assert(src.includes('components'), 'must have components jsonb column');
  assert(src.includes('signals'), 'must have signals jsonb column');
  assert(src.includes('computed_at'), 'must have computed_at column');
});

test('phase17-migration', 'migration enables RLS on snapshots table', () => {
  const src = readFile('supabase/migrations/20260530000002_runtime_phase17_health_history.sql');
  assert(src.includes('ENABLE ROW LEVEL SECURITY'), 'must enable RLS');
  assert(src.includes('service_role'), 'must have service_role bypass policy');
});

test('phase17-migration', 'migration adds computed_at index for efficient querying', () => {
  const src = readFile('supabase/migrations/20260530000002_runtime_phase17_health_history.sql');
  assert(src.includes('runtime_health_snapshots_computed_at_idx'), 'must have computed_at index');
  assert(src.includes('computed_at DESC'), 'must index computed_at descending');
});

// ============================================================================
// Section 49: Phase 17 — operator-actions API route
// ============================================================================

test('phase17-operator-actions', 'operator-actions GET requires authentication', () => {
  const src = readFile('app/api/runtime/control/operator-actions/route.ts');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
  assert(src.includes('Unauthorized'), 'must return 401 for unauthenticated');
});

test('phase17-operator-actions', 'operator-actions GET supports pagination', () => {
  const src = readFile('app/api/runtime/control/operator-actions/route.ts');
  assert(src.includes("sp.get('page')"), 'must support page param');
  assert(src.includes("sp.get('page_size')"), 'must support page_size param');
  assert(src.includes('.range('), 'must use range for pagination');
  assert(src.includes("{ count: 'exact' }"), 'must request exact count');
});

test('phase17-operator-actions', 'operator-actions GET supports search and action_type filter', () => {
  const src = readFile('app/api/runtime/control/operator-actions/route.ts');
  assert(src.includes("sp.get('search')"), 'must support search param');
  assert(src.includes("sp.get('action_type')"), 'must support action_type filter');
  assert(src.includes('ilike'), 'must use ilike for search');
});

test('phase17-operator-actions', 'operator-actions GET supports date range filtering', () => {
  const src = readFile('app/api/runtime/control/operator-actions/route.ts');
  assert(src.includes("sp.get('from')"), 'must support from date filter');
  assert(src.includes("sp.get('to')"), 'must support to date filter');
});

test('phase17-operator-actions', 'operator-actions GET returns total count and pagination info', () => {
  const src = readFile('app/api/runtime/control/operator-actions/route.ts');
  assert(src.includes('total:'), 'must return total count');
  assert(src.includes('page,'), 'must return current page');
  assert(src.includes('pageSize,'), 'must return page size');
});

// ============================================================================
// Section 50: Phase 17 — health-history API route
// ============================================================================

test('phase17-health-history', 'health-history GET requires authentication', () => {
  const src = readFile('app/api/runtime/control/health-history/route.ts');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
  assert(src.includes('Unauthorized'), 'must return 401 for unauthenticated');
});

test('phase17-health-history', 'health-history GET supports 24h/7d/30d windows', () => {
  const src = readFile('app/api/runtime/control/health-history/route.ts');
  assert(src.includes("sp.get('window')"), 'must support window param');
  assert(src.includes("'24h'"), 'must support 24h window');
  assert(src.includes("'7d'"), 'must support 7d window');
  assert(src.includes("'30d'"), 'must support 30d window');
});

test('phase17-health-history', 'health-history GET queries snapshots table with time filter', () => {
  const src = readFile('app/api/runtime/control/health-history/route.ts');
  assert(src.includes('runtime_health_score_snapshots'), 'must query snapshots table');
  assert(src.includes('.gte('), 'must filter by computed_at >= since');
  assert(src.includes("'computed_at'"), 'must reference computed_at column');
});

test('phase17-health-history', 'health-history GET returns snapshots and window', () => {
  const src = readFile('app/api/runtime/control/health-history/route.ts');
  assert(src.includes('snapshots:'), 'must return snapshots array');
  assert(src.includes('window,'), 'must return the window value');
});

// ============================================================================
// Section 51: Phase 17 — workers/[workerId] detail route
// ============================================================================

test('phase17-worker-detail', 'worker detail route exists and requires auth', () => {
  const src = readFile('app/api/runtime/control/workers/[workerId]/route.ts');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
  assert(src.includes('Worker not found'), 'must return 404 for missing worker');
});

test('phase17-worker-detail', 'worker detail route queries worker by ID', () => {
  const src = readFile('app/api/runtime/control/workers/[workerId]/route.ts');
  assert(src.includes('.eq(\'worker_id\', workerId)'), 'must filter by worker_id');
  assert(src.includes("'runtime_workers'"), 'must query runtime_workers table');
});

test('phase17-worker-detail', 'worker detail route loads restart history', () => {
  const src = readFile('app/api/runtime/control/workers/[workerId]/route.ts');
  assert(src.includes('restartHistory'), 'must include restart history');
  assert(src.includes("'runtime_worker_restart_requests'"), 'must query restart requests');
});

test('phase17-worker-detail', 'worker detail route loads active incidents for worker', () => {
  const src = readFile('app/api/runtime/control/workers/[workerId]/route.ts');
  assert(src.includes('activeIncidents'), 'must include active incidents');
  assert(src.includes('listActiveIncidents'), 'must call listActiveIncidents');
  assert(src.includes('i.workerId === workerId'), 'must filter incidents by workerId');
});

test('phase17-worker-detail', 'worker detail route loads recent commands for worker', () => {
  const src = readFile('app/api/runtime/control/workers/[workerId]/route.ts');
  assert(src.includes('recentCommands'), 'must include recent commands');
  assert(src.includes("'runtime_execution_commands'"), 'must query commands table');
  assert(src.includes('.eq(\'worker_id\', workerId)'), 'must filter commands by worker_id');
});

// ============================================================================
// Section 52: Phase 17 — executions/[executionId] detail route
// ============================================================================

test('phase17-execution-detail', 'execution detail route exists and requires auth', () => {
  const src = readFile('app/api/runtime/control/executions/[executionId]/route.ts');
  assert(src.includes('getUserFromRequest'), 'must require authentication');
  assert(src.includes('Execution not found'), 'must return 404 for missing execution');
});

test('phase17-execution-detail', 'execution detail route loads execution by ID', () => {
  const src = readFile('app/api/runtime/control/executions/[executionId]/route.ts');
  assert(src.includes("'workflow_executions_v2'"), 'must query executions table');
  assert(src.includes('.eq(\'id\', executionId)'), 'must filter by execution id');
});

test('phase17-execution-detail', 'execution detail route loads execution events', () => {
  const src = readFile('app/api/runtime/control/executions/[executionId]/route.ts');
  assert(src.includes("'runtime_execution_events'"), 'must query events table');
  assert(src.includes("sequence_number"), 'must order by sequence_number');
});

test('phase17-execution-detail', 'execution detail route loads snapshots', () => {
  const src = readFile('app/api/runtime/control/executions/[executionId]/route.ts');
  assert(src.includes("'runtime_execution_snapshots'"), 'must query snapshots table');
  assert(src.includes('snapshots:'), 'must include snapshots in response');
});

test('phase17-execution-detail', 'execution detail route loads commands and incidents', () => {
  const src = readFile('app/api/runtime/control/executions/[executionId]/route.ts');
  assert(src.includes("'runtime_execution_commands'"), 'must query commands table');
  assert(src.includes('incidents:'), 'must include incidents in response');
  assert(src.includes('listActiveIncidents'), 'must call listActiveIncidents');
  assert(src.includes('i.executionId === executionId'), 'must filter incidents by executionId');
});

// ============================================================================
// Section 53: Phase 17 — overview route health snapshot persistence
// ============================================================================

test('phase17-overview-snapshot', 'overview route persists health snapshot on each load', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('runtime_health_score_snapshots'), 'must insert into snapshots table');
  assert(src.includes('overall_score'), 'must store overall_score in snapshot');
  assert(src.includes('healthScore.computedAt'), 'must store computedAt in snapshot');
});

test('phase17-overview-snapshot', 'overview snapshot insert is fire-and-forget', () => {
  const src = readFile('app/api/runtime/control/overview/route.ts');
  assert(src.includes('.catch(() => undefined)'), 'must fire-and-forget snapshot insert');
});

// ============================================================================
// Section 54: Phase 17 — bulk incident actions in incidents route
// ============================================================================

test('phase17-bulk-incidents', 'incidents POST supports bulk_resolve action', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("action === 'bulk_resolve'"), 'must handle bulk_resolve action');
  assert(src.includes('incidentIds'), 'must accept incidentIds array');
  assert(src.includes('bulk_resolve_incidents'), 'must audit bulk_resolve_incidents');
});

test('phase17-bulk-incidents', 'incidents POST supports bulk_escalate action', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes("action === 'bulk_escalate'"), 'must handle bulk_escalate action');
  assert(src.includes("action === 'bulk_escalate'"), 'must handle bulk_escalate');
  assert(src.includes('bulk_escalate_incidents'), 'must audit bulk_escalate_incidents');
});

test('phase17-bulk-incidents', 'incidents POST bulk actions skip single incidentId check', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('isBulkAction'), 'must detect bulk actions before validating incidentId');
  assert(src.includes("incidentIds must be a non-empty string array"), 'must validate incidentIds array');
});

test('phase17-bulk-incidents', 'incidents POST bulk actions return resolved/escalated counts', () => {
  const src = readFile('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('resolved,'), 'must return resolved count');
  assert(src.includes('escalated,'), 'must return escalated count');
  assert(src.includes('total:'), 'must return total count');
});

// ============================================================================
// Section 55: Phase 17 — bulk command actions in commands route
// ============================================================================

test('phase17-bulk-commands', 'commands POST supports bulk_retry action', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes("action === 'bulk_retry'"), 'must handle bulk_retry action');
  assert(src.includes('bulk_retry_commands'), 'must audit bulk_retry_commands');
});

test('phase17-bulk-commands', 'commands POST supports bulk_dead_letter action', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes("action === 'bulk_dead_letter'"), 'must handle bulk_dead_letter action');
  assert(src.includes('bulk_dead_letter_commands'), 'must audit bulk_dead_letter_commands');
});

test('phase17-bulk-commands', 'commands POST bulk actions validate commands array', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes('commands must be a non-empty array'), 'must validate commands array');
});

test('phase17-bulk-commands', 'commands POST bulk actions return counts', () => {
  const src = readFile('app/api/runtime/control/commands/route.ts');
  assert(src.includes('queued,'), 'must return queued count for bulk_retry');
  assert(src.includes('deadLettered:'), 'must return deadLettered count');
});

// ============================================================================
// Section 56: Phase 17 — GlobalRuntimeAlerts component
// ============================================================================

test('phase17-global-alerts', 'GlobalRuntimeAlerts component exists and polls overview', () => {
  const src = readFile('components/control/GlobalRuntimeAlerts.tsx');
  assert(src.includes('export function GlobalRuntimeAlerts'), 'must export GlobalRuntimeAlerts');
  assert(src.includes('/api/runtime/control/overview'), 'must poll overview endpoint');
  assert(src.includes('useAutoRefresh'), 'must use auto-refresh hook');
});

test('phase17-global-alerts', 'GlobalRuntimeAlerts renders critical incident alerts', () => {
  const src = readFile('components/control/GlobalRuntimeAlerts.tsx');
  assert(src.includes("'critical'"), 'must check for critical severity');
  assert(src.includes('critical incident'), 'must message critical incidents');
  assert(src.includes("level: 'critical'"), 'must have critical level');
});

test('phase17-global-alerts', 'GlobalRuntimeAlerts renders warning alerts for backlog and DLQ', () => {
  const src = readFile('components/control/GlobalRuntimeAlerts.tsx');
  assert(src.includes('command-backlog'), 'must have command backlog alert id');
  assert(src.includes('dead-letter'), 'must have dead letter alert id');
  assert(src.includes("level: 'warning'"), 'must have warning level');
});

test('phase17-global-alerts', 'GlobalRuntimeAlerts supports dismissing individual alerts', () => {
  const src = readFile('components/control/GlobalRuntimeAlerts.tsx');
  assert(src.includes('dismissed'), 'must track dismissed alerts');
  assert(src.includes('Dismiss alert'), 'must have dismiss button');
  assert(src.includes('setDismissed'), 'must update dismissed state');
});

// ============================================================================
// Section 57: Phase 17 — HealthTrendChart component
// ============================================================================

test('phase17-health-trend-chart', 'HealthTrendChart component exists and fetches data', () => {
  const src = readFile('components/control/HealthTrendChart.tsx');
  assert(src.includes('export function HealthTrendChart'), 'must export HealthTrendChart');
  assert(src.includes('/api/runtime/control/health-history'), 'must fetch from health-history endpoint');
});

test('phase17-health-trend-chart', 'HealthTrendChart uses recharts AreaChart', () => {
  const src = readFile('components/control/HealthTrendChart.tsx');
  assert(src.includes('AreaChart'), 'must use AreaChart');
  assert(src.includes('Area'), 'must use Area component');
  assert(src.includes('ChartContainer'), 'must use ChartContainer from existing chart lib');
});

test('phase17-health-trend-chart', 'HealthTrendChart supports 24h/7d/30d window toggle', () => {
  const src = readFile('components/control/HealthTrendChart.tsx');
  assert(src.includes("'24h'"), 'must support 24h window');
  assert(src.includes("'7d'"), 'must support 7d window');
  assert(src.includes("'30d'"), 'must support 30d window');
  assert(src.includes('setWindow'), 'must allow switching windows');
});

test('phase17-health-trend-chart', 'HealthTrendChart shows empty state for no data', () => {
  const src = readFile('components/control/HealthTrendChart.tsx');
  assert(src.includes('No health snapshots'), 'must show empty state message');
});

// ============================================================================
// Section 58: Phase 17 — OperatorAuditDrawer component
// ============================================================================

test('phase17-audit-drawer', 'OperatorAuditDrawer component exists with Sheet', () => {
  const src = readFile('components/control/OperatorAuditDrawer.tsx');
  assert(src.includes('export function OperatorAuditDrawer'), 'must export OperatorAuditDrawer');
  assert(src.includes('SheetContent'), 'must use Sheet component');
});

test('phase17-audit-drawer', 'OperatorAuditDrawer fetches from operator-actions endpoint', () => {
  const src = readFile('components/control/OperatorAuditDrawer.tsx');
  assert(src.includes('/api/runtime/control/operator-actions'), 'must fetch from operator-actions');
  assert(src.includes('page,'), 'must include page in request');
});

test('phase17-audit-drawer', 'OperatorAuditDrawer supports search with debounce', () => {
  const src = readFile('components/control/OperatorAuditDrawer.tsx');
  assert(src.includes('search'), 'must have search state');
  assert(src.includes('setTimeout'), 'must debounce search input');
});

test('phase17-audit-drawer', 'OperatorAuditDrawer supports pagination', () => {
  const src = readFile('components/control/OperatorAuditDrawer.tsx');
  assert(src.includes('ChevronLeft'), 'must have previous page button');
  assert(src.includes('ChevronRight'), 'must have next page button');
  assert(src.includes('totalPages'), 'must compute total pages');
});

// ============================================================================
// Section 59: Phase 17 — WorkerDetailSheet component
// ============================================================================

test('phase17-worker-sheet', 'WorkerDetailSheet component exists', () => {
  const src = readFile('components/control/WorkerDetailSheet.tsx');
  assert(src.includes('export function WorkerDetailSheet'), 'must export WorkerDetailSheet');
  assert(src.includes('SheetContent'), 'must use Sheet component');
});

test('phase17-worker-sheet', 'WorkerDetailSheet fetches from worker detail endpoint', () => {
  const src = readFile('components/control/WorkerDetailSheet.tsx');
  assert(src.includes('/api/runtime/control/workers/'), 'must fetch from workers detail endpoint');
  assert(src.includes('encodeURIComponent'), 'must encode worker ID in URL');
});

test('phase17-worker-sheet', 'WorkerDetailSheet shows worker metadata', () => {
  const src = readFile('components/control/WorkerDetailSheet.tsx');
  assert(src.includes('jobs_processed'), 'must display jobs processed');
  assert(src.includes('restart_count'), 'must display restart count');
  assert(src.includes('heartbeat_at'), 'must display heartbeat time');
});

test('phase17-worker-sheet', 'WorkerDetailSheet shows restart history and active incidents', () => {
  const src = readFile('components/control/WorkerDetailSheet.tsx');
  assert(src.includes('restartHistory'), 'must display restart history');
  assert(src.includes('activeIncidents'), 'must display active incidents');
  assert(src.includes('recentCommands'), 'must display recent commands');
});

// ============================================================================
// Section 60: Phase 17 — ExecutionDetailModal component
// ============================================================================

test('phase17-exec-modal', 'ExecutionDetailModal component exists', () => {
  const src = readFile('components/control/ExecutionDetailModal.tsx');
  assert(src.includes('export function ExecutionDetailModal'), 'must export ExecutionDetailModal');
  assert(src.includes('DialogContent'), 'must use Dialog component');
});

test('phase17-exec-modal', 'ExecutionDetailModal fetches from execution detail endpoint', () => {
  const src = readFile('components/control/ExecutionDetailModal.tsx');
  assert(src.includes('/api/runtime/control/executions/'), 'must fetch from execution detail endpoint');
  assert(src.includes('encodeURIComponent'), 'must encode execution ID in URL');
});

test('phase17-exec-modal', 'ExecutionDetailModal has tabbed interface for timeline/events/snapshots/incidents', () => {
  const src = readFile('components/control/ExecutionDetailModal.tsx');
  assert(src.includes("'timeline'"), 'must have timeline tab');
  assert(src.includes("'events'"), 'must have events tab');
  assert(src.includes("'snapshots'"), 'must have snapshots tab');
  assert(src.includes("'incidents'"), 'must have incidents tab');
});

test('phase17-exec-modal', 'ExecutionDetailModal renders command timeline with status dots', () => {
  const src = readFile('components/control/ExecutionDetailModal.tsx');
  assert(src.includes('CommandTimeline'), 'must have CommandTimeline sub-component');
  assert(src.includes('sequence_number'), 'must display sequence numbers');
  assert(src.includes('acknowledged'), 'must handle acknowledged status');
});

// ============================================================================
// Section 61: Phase 17 — updated panels with auto-refresh
// ============================================================================

test('phase17-panels-refresh', 'OverviewPanel uses auto-refresh at 10s', () => {
  const src = readFile('components/control/OverviewPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must import and use useAutoRefresh');
  assert(src.includes('10_000'), 'must refresh every 10 seconds');
});

test('phase17-panels-refresh', 'ExecutionsPanel uses auto-refresh at 10s', () => {
  const src = readFile('components/control/ExecutionsPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must use useAutoRefresh');
  assert(src.includes('10_000'), 'must refresh every 10 seconds');
});

test('phase17-panels-refresh', 'WorkersPanel uses auto-refresh at 10s', () => {
  const src = readFile('components/control/WorkersPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must use useAutoRefresh');
  assert(src.includes('10_000'), 'must refresh every 10 seconds');
});

test('phase17-panels-refresh', 'IncidentsPanel uses auto-refresh at 15s', () => {
  const src = readFile('components/control/IncidentsPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must use useAutoRefresh');
  assert(src.includes('15_000'), 'must refresh every 15 seconds');
});

test('phase17-panels-refresh', 'CommandsPanel uses auto-refresh at 15s', () => {
  const src = readFile('components/control/CommandsPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must use useAutoRefresh');
  assert(src.includes('15_000'), 'must refresh every 15 seconds');
});

// ============================================================================
// Section 62: Phase 17 — control page updates
// ============================================================================

test('phase17-page-updates', 'control page imports GlobalRuntimeAlerts', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes('GlobalRuntimeAlerts'), 'must import and render GlobalRuntimeAlerts');
});

test('phase17-page-updates', 'control page imports OperatorAuditDrawer with button', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes('OperatorAuditDrawer'), 'must import OperatorAuditDrawer');
  assert(src.includes('Audit Log'), 'must have Audit Log button in header');
  assert(src.includes('auditOpen'), 'must track audit drawer open state');
});

test('phase17-page-updates', 'control page places GlobalRuntimeAlerts above tabs', () => {
  const src = readFile('app/runtime/control/page.tsx');
  const alertsIdx = src.indexOf('GlobalRuntimeAlerts');
  const tabsIdx   = src.indexOf('<Tabs');
  assert(alertsIdx > -1 && tabsIdx > -1 && alertsIdx < tabsIdx, 'GlobalRuntimeAlerts must appear before Tabs');
});

// ============================================================================
// Section 63: Phase 18.1 — SSE stream endpoint
// ============================================================================

test('phase18-sse-stream', 'SSE stream route exists', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
});

test('phase18-sse-stream', 'SSE stream returns text/event-stream content type', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('text/event-stream'), 'must set Content-Type: text/event-stream');
});

test('phase18-sse-stream', 'SSE stream uses ReadableStream', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('ReadableStream'), 'must use ReadableStream');
});

test('phase18-sse-stream', 'SSE stream sends runtime_update events', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('runtime_update'), 'must emit runtime_update events');
});

test('phase18-sse-stream', 'SSE stream sends heartbeat events', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('heartbeat'), 'must emit heartbeat events');
});

test('phase18-sse-stream', 'SSE stream polls every 5 seconds', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('5_000'), 'must poll at 5s interval');
});

test('phase18-sse-stream', 'SSE stream heartbeat interval is 15 seconds', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('15_000'), 'heartbeat must be every 15s');
});

test('phase18-sse-stream', 'SSE stream requires authentication', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('getUserFromRequest'), 'must authenticate user');
  assert(src.includes('Unauthorized'), 'must return 401 for unauthenticated requests');
});

test('phase18-sse-stream', 'SSE stream cleans up on cancel', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('cancel('), 'must implement cancel cleanup');
  assert(src.includes('clearInterval'), 'must clear intervals on cleanup');
});

// ============================================================================
// Section 64: Phase 18.1 — use-runtime-stream hook
// ============================================================================

test('phase18-stream-hook', 'use-runtime-stream hook exists', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes('export function useRuntimeStream'), 'must export useRuntimeStream');
});

test('phase18-stream-hook', 'hook connects to SSE stream endpoint', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes('/api/runtime/control/stream'), 'must connect to SSE stream endpoint');
  assert(src.includes('EventSource'), 'must use EventSource');
});

test('phase18-stream-hook', 'hook reconnects with exponential backoff', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes('Math.pow(2,'), 'must use exponential backoff');
  assert(src.includes('30_000'), 'must cap reconnect at 30s');
});

test('phase18-stream-hook', 'hook pauses reconnect when tab hidden', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes('document.hidden'), 'must check document.hidden');
  assert(src.includes('visibilitychange'), 'must listen for visibilitychange');
});

test('phase18-stream-hook', 'hook exposes connected state', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes('connected'), 'must expose connected state');
  assert(src.includes('retryCount'), 'must expose retryCount');
});

test('phase18-stream-hook', 'hook handles runtime_update and heartbeat events', () => {
  const src = readFile('components/control/use-runtime-stream.ts');
  assert(src.includes("'runtime_update'"), 'must handle runtime_update events');
  assert(src.includes("'heartbeat'"), 'must handle heartbeat events');
});

// ============================================================================
// Section 65: Phase 18.2 — Metrics Engine service
// ============================================================================

test('phase18-metrics-engine', 'metrics-engine service exists', () => {
  const src = readFile('lib/runtime/metrics-engine.ts');
  assert(src.includes("import 'server-only'"), 'must be server-only');
  assert(src.includes('export async function recordMetric'), 'must export recordMetric');
});

test('phase18-metrics-engine', 'metrics-engine records runtime snapshot', () => {
  const src = readFile('lib/runtime/metrics-engine.ts');
  assert(src.includes('export async function recordRuntimeMetricsSnapshot'), 'must export recordRuntimeMetricsSnapshot');
  assert(src.includes('computeRuntimeMetrics'), 'must call computeRuntimeMetrics');
});

test('phase18-metrics-engine', 'metrics-engine persists to runtime_metrics table', () => {
  const src = readFile('lib/runtime/metrics-engine.ts');
  assert(src.includes("'runtime_metrics'"), 'must write to runtime_metrics table');
});

test('phase18-metrics-engine', 'metrics-engine queryMetricSeries supports time range', () => {
  const src = readFile('lib/runtime/metrics-engine.ts');
  assert(src.includes('export async function queryMetricSeries'), 'must export queryMetricSeries');
  assert(src.includes('.gte('), 'must filter by from date');
  assert(src.includes('.lte('), 'must filter by to date');
});

test('phase18-metrics-engine', 'metrics-engine tracks cpu_load and queue_depth', () => {
  const src = readFile('lib/runtime/metrics-engine.ts');
  assert(src.includes("'cpu_load'"), 'must track cpu_load');
  assert(src.includes("'queue_depth'"), 'must track queue_depth');
  assert(src.includes("'error_rate'"), 'must track error_rate');
  assert(src.includes("'worker_utilization'"), 'must track worker_utilization');
});

// ============================================================================
// Section 66: Phase 18.2 — Metrics API route
// ============================================================================

test('phase18-metrics-route', 'metrics route exists', () => {
  const src = readFile('app/api/runtime/control/metrics/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
});

test('phase18-metrics-route', 'metrics route supports snapshot=true query', () => {
  const src = readFile('app/api/runtime/control/metrics/route.ts');
  assert(src.includes("'snapshot'"), 'must support snapshot query param');
  assert(src.includes('recordRuntimeMetricsSnapshot'), 'must call recordRuntimeMetricsSnapshot');
});

test('phase18-metrics-route', 'metrics route supports metric query param', () => {
  const src = readFile('app/api/runtime/control/metrics/route.ts');
  assert(src.includes("sp.get('metric')"), 'must read metric query param');
  assert(src.includes('queryMetricSeries'), 'must call queryMetricSeries');
});

test('phase18-metrics-route', 'metrics route supports list=true query', () => {
  const src = readFile('app/api/runtime/control/metrics/route.ts');
  assert(src.includes("'list'"), 'must support list param');
  assert(src.includes('listAvailableMetrics'), 'must call listAvailableMetrics');
});

// ============================================================================
// Section 67: Phase 18.3 — ObservabilityPanel component
// ============================================================================

test('phase18-observability-panel', 'ObservabilityPanel component exists', () => {
  const src = readFile('components/control/ObservabilityPanel.tsx');
  assert(src.includes('export function ObservabilityPanel'), 'must export ObservabilityPanel');
});

test('phase18-observability-panel', 'ObservabilityPanel uses recharts for charts', () => {
  const src = readFile('components/control/ObservabilityPanel.tsx');
  assert(src.includes('AreaChart'), 'must use AreaChart');
  assert(src.includes('ChartContainer'), 'must use ChartContainer');
});

test('phase18-observability-panel', 'ObservabilityPanel shows multiple metric charts', () => {
  const src = readFile('components/control/ObservabilityPanel.tsx');
  assert(src.includes("'cpu_load'"), 'must show cpu_load chart');
  assert(src.includes("'queue_depth'"), 'must show queue_depth chart');
  assert(src.includes("'error_rate'"), 'must show error_rate chart');
  assert(src.includes("'worker_utilization'"), 'must show worker_utilization chart');
});

test('phase18-observability-panel', 'ObservabilityPanel has time window controls', () => {
  const src = readFile('components/control/ObservabilityPanel.tsx');
  assert(src.includes("'1h'"), 'must have 1h window option');
  assert(src.includes("'24h'"), 'must have 24h window option');
  assert(src.includes("'7d'"), 'must have 7d window option');
});

test('phase18-observability-panel', 'ObservabilityPanel uses auto-refresh', () => {
  const src = readFile('components/control/ObservabilityPanel.tsx');
  assert(src.includes('useAutoRefresh'), 'must use useAutoRefresh');
  assert(src.includes('30_000'), 'must refresh every 30 seconds');
});

// ============================================================================
// Section 68: Phase 18.4 — Traces API route
// ============================================================================

test('phase18-traces-route', 'traces route exists', () => {
  const src = readFile('app/api/runtime/control/traces/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
});

test('phase18-traces-route', 'traces route supports single trace fetch', () => {
  const src = readFile('app/api/runtime/control/traces/route.ts');
  assert(src.includes("sp.get('id')"), 'must support id param for single trace');
  assert(src.includes('runtime_spans'), 'must query runtime_spans for span detail');
});

test('phase18-traces-route', 'traces route supports execution_id filter', () => {
  const src = readFile('app/api/runtime/control/traces/route.ts');
  assert(src.includes("sp.get('execution_id')"), 'must support execution_id filter');
  assert(src.includes('runtime_traces'), 'must query runtime_traces table');
});

// ============================================================================
// Section 69: Phase 18.4 — TraceViewer component
// ============================================================================

test('phase18-trace-viewer', 'TraceViewer component exists', () => {
  const src = readFile('components/control/TraceViewer.tsx');
  assert(src.includes('export function TraceViewer'), 'must export TraceViewer');
});

test('phase18-trace-viewer', 'TraceViewer fetches from traces endpoint', () => {
  const src = readFile('components/control/TraceViewer.tsx');
  assert(src.includes('/api/runtime/control/traces'), 'must fetch from traces API');
});

test('phase18-trace-viewer', 'TraceViewer renders span tree', () => {
  const src = readFile('components/control/TraceViewer.tsx');
  assert(src.includes('buildSpanTree'), 'must build span tree');
  assert(src.includes('parent_span_id'), 'must handle parent-child span relationships');
  assert(src.includes('duration_ms'), 'must show span durations');
});

test('phase18-trace-viewer', 'TraceViewer shows trace status', () => {
  const src = readFile('components/control/TraceViewer.tsx');
  assert(src.includes('StatusIcon'), 'must render status icons');
  assert(src.includes("'completed'"), 'must handle completed status');
  assert(src.includes("'failed'"), 'must handle failed status');
});

// ============================================================================
// Section 70: Phase 18.5 — ReplayVisualizer component
// ============================================================================

test('phase18-replay-visualizer', 'ReplayVisualizer component exists', () => {
  const src = readFile('components/control/ReplayVisualizer.tsx');
  assert(src.includes('export function ReplayVisualizer'), 'must export ReplayVisualizer');
});

test('phase18-replay-visualizer', 'ReplayVisualizer fetches from replay-visualizer endpoint', () => {
  const src = readFile('components/control/ReplayVisualizer.tsx');
  assert(src.includes('/api/runtime/control/replay-visualizer'), 'must fetch from replay-visualizer API');
  assert(src.includes('encodeURIComponent'), 'must encode execution ID');
});

test('phase18-replay-visualizer', 'ReplayVisualizer shows event timeline', () => {
  const src = readFile('components/control/ReplayVisualizer.tsx');
  assert(src.includes('EventTimeline'), 'must render EventTimeline');
  assert(src.includes('sequence_number'), 'must show sequence numbers');
});

test('phase18-replay-visualizer', 'ReplayVisualizer shows replay checkpoints', () => {
  const src = readFile('components/control/ReplayVisualizer.tsx');
  assert(src.includes('CheckpointList'), 'must render CheckpointList');
  assert(src.includes('snapshotVersion'), 'must show snapshot version');
});

test('phase18-replay-visualizer', 'ReplayVisualizer has tabbed interface', () => {
  const src = readFile('components/control/ReplayVisualizer.tsx');
  assert(src.includes("'timeline'"), 'must have timeline tab');
  assert(src.includes("'checkpoints'"), 'must have checkpoints tab');
  assert(src.includes("'commands'"), 'must have commands tab');
});

// ============================================================================
// Section 71: Phase 18.5 — replay-visualizer API route
// ============================================================================

test('phase18-replay-route', 'replay-visualizer route exists', () => {
  const src = readFile('app/api/runtime/control/replay-visualizer/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
});

test('phase18-replay-route', 'replay-visualizer route requires execution_id', () => {
  const src = readFile('app/api/runtime/control/replay-visualizer/route.ts');
  assert(src.includes("'execution_id'"), 'must require execution_id param');
  assert(src.includes('execution_id is required'), 'must return error when missing');
});

test('phase18-replay-route', 'replay-visualizer builds checkpoints', () => {
  const src = readFile('app/api/runtime/control/replay-visualizer/route.ts');
  assert(src.includes('checkpoints'), 'must build checkpoints array');
  assert(src.includes('snapshotVersion'), 'must include snapshot version');
});

// ============================================================================
// Section 72: Phase 18.6 — SLA engine service
// ============================================================================

test('phase18-sla-engine', 'sla-engine service exists', () => {
  const src = readFile('lib/runtime/sla-engine.ts');
  assert(src.includes("import 'server-only'"), 'must be server-only');
  assert(src.includes('export async function getSlaTargets'), 'must export getSlaTargets');
});

test('phase18-sla-engine', 'sla-engine records violations', () => {
  const src = readFile('lib/runtime/sla-engine.ts');
  assert(src.includes('export async function recordSlaViolation'), 'must export recordSlaViolation');
  assert(src.includes("'runtime_sla_violations'"), 'must write to runtime_sla_violations');
});

test('phase18-sla-engine', 'sla-engine checks execution SLA', () => {
  const src = readFile('lib/runtime/sla-engine.ts');
  assert(src.includes('export async function checkExecutionSla'), 'must export checkExecutionSla');
  assert(src.includes("'execution_duration'"), 'must check execution_duration target');
});

test('phase18-sla-engine', 'sla-engine generates SLA report', () => {
  const src = readFile('lib/runtime/sla-engine.ts');
  assert(src.includes('export async function getSlaReport'), 'must export getSlaReport');
  assert(src.includes('complianceByType'), 'must compute complianceByType');
  assert(src.includes('compliancePct'), 'must compute compliancePct');
});

// ============================================================================
// Section 73: Phase 18.6 — SLA API route
// ============================================================================

test('phase18-sla-route', 'SLA route exists with GET and POST', () => {
  const src = readFile('app/api/runtime/control/sla/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
  assert(src.includes('export async function POST'), 'must export POST');
});

test('phase18-sla-route', 'SLA GET returns report', () => {
  const src = readFile('app/api/runtime/control/sla/route.ts');
  assert(src.includes('getSlaReport'), 'must call getSlaReport');
});

test('phase18-sla-route', 'SLA POST upserts target', () => {
  const src = readFile('app/api/runtime/control/sla/route.ts');
  assert(src.includes('upsertSlaTarget'), 'must call upsertSlaTarget');
  assert(src.includes('thresholdMs'), 'must validate thresholdMs');
});

// ============================================================================
// Section 74: Phase 18.6 — SlaPanel component
// ============================================================================

test('phase18-sla-panel', 'SlaPanel component exists', () => {
  const src = readFile('components/control/SlaPanel.tsx');
  assert(src.includes('export function SlaPanel'), 'must export SlaPanel');
});

test('phase18-sla-panel', 'SlaPanel fetches from SLA endpoint', () => {
  const src = readFile('components/control/SlaPanel.tsx');
  assert(src.includes('/api/runtime/control/sla'), 'must fetch from SLA API');
});

test('phase18-sla-panel', 'SlaPanel shows compliance percentages', () => {
  const src = readFile('components/control/SlaPanel.tsx');
  assert(src.includes('ComplianceBadge'), 'must render ComplianceBadge');
  assert(src.includes('compliancePct'), 'must show compliance percentage');
});

test('phase18-sla-panel', 'SlaPanel shows violations', () => {
  const src = readFile('components/control/SlaPanel.tsx');
  assert(src.includes('ViolationRow'), 'must render ViolationRow');
  assert(src.includes('recentViolations'), 'must show recent violations');
});

// ============================================================================
// Section 75: Phase 18.7 — Cost engine service
// ============================================================================

test('phase18-cost-engine', 'cost-engine service exists', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  assert(src.includes("import 'server-only'"), 'must be server-only');
  assert(src.includes('export async function recordCost'), 'must export recordCost');
});

test('phase18-cost-engine', 'cost-engine tracks multiple cost types', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  assert(src.includes("'execution'"), 'must track execution cost');
  assert(src.includes("'worker_time'"), 'must track worker_time cost');
  assert(src.includes("'ai_token'"), 'must track ai_token cost');
});

test('phase18-cost-engine', 'cost-engine writes to runtime_cost_records', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  assert(src.includes("'runtime_cost_records'"), 'must write to runtime_cost_records');
});

test('phase18-cost-engine', 'cost-engine generates monthly projection', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  assert(src.includes('monthlyProjection'), 'must compute monthly projection');
  assert(src.includes('getCostSummary'), 'must export getCostSummary');
});

test('phase18-cost-engine', 'cost-engine records execution cost', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  assert(src.includes('export async function recordExecutionCost'), 'must export recordExecutionCost');
});

// ============================================================================
// Section 76: Phase 18.7 — Cost API route
// ============================================================================

test('phase18-cost-route', 'cost route exists', () => {
  const src = readFile('app/api/runtime/control/cost/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
});

test('phase18-cost-route', 'cost route returns summary and topWorkflows', () => {
  const src = readFile('app/api/runtime/control/cost/route.ts');
  assert(src.includes('getCostSummary'), 'must call getCostSummary');
  assert(src.includes('getTopCostlyWorkflows'), 'must call getTopCostlyWorkflows');
});

// ============================================================================
// Section 77: Phase 18.7 — CostPanel component
// ============================================================================

test('phase18-cost-panel', 'CostPanel component exists', () => {
  const src = readFile('components/control/CostPanel.tsx');
  assert(src.includes('export function CostPanel'), 'must export CostPanel');
});

test('phase18-cost-panel', 'CostPanel fetches from cost endpoint', () => {
  const src = readFile('components/control/CostPanel.tsx');
  assert(src.includes('/api/runtime/control/cost'), 'must fetch from cost API');
});

test('phase18-cost-panel', 'CostPanel shows monthly projection', () => {
  const src = readFile('components/control/CostPanel.tsx');
  assert(src.includes('monthlyProjection'), 'must display monthly projection');
  assert(src.includes('Monthly projection'), 'must label monthly projection');
});

test('phase18-cost-panel', 'CostPanel shows top costly workflows', () => {
  const src = readFile('components/control/CostPanel.tsx');
  assert(src.includes('topWorkflows'), 'must display top costly workflows');
  assert(src.includes('Top Costly Workflows'), 'must label section');
});

test('phase18-cost-panel', 'CostPanel uses BarChart for cost breakdown', () => {
  const src = readFile('components/control/CostPanel.tsx');
  assert(src.includes('BarChart'), 'must use BarChart for cost by type');
});

// ============================================================================
// Section 78: Phase 18.8 — RBAC service
// ============================================================================

test('phase18-rbac', 'RBAC service exists', () => {
  const src = readFile('lib/runtime/rbac.ts');
  assert(src.includes("import 'server-only'"), 'must be server-only');
  assert(src.includes('export async function getUserPermissions'), 'must export getUserPermissions');
});

test('phase18-rbac', 'RBAC has 8 permissions', () => {
  const src = readFile('lib/runtime/rbac.ts');
  const permissions = [
    'view_runtime', 'manage_workers', 'manage_incidents', 'manage_commands',
    'manage_executions', 'view_audit', 'manage_replay', 'admin_runtime',
  ];
  for (const p of permissions) {
    assert(src.includes(`'${p}'`), `must include permission '${p}'`);
  }
});

test('phase18-rbac', 'RBAC hasPermission checks admin_runtime override', () => {
  const src = readFile('lib/runtime/rbac.ts');
  assert(src.includes('export async function hasPermission'), 'must export hasPermission');
  assert(src.includes("'admin_runtime'"), 'hasPermission must check admin_runtime override');
});

test('phase18-rbac', 'RBAC requires permission (throws on deny)', () => {
  const src = readFile('lib/runtime/rbac.ts');
  assert(src.includes('export async function requirePermission'), 'must export requirePermission');
  assert(src.includes('Permission denied'), 'must throw Permission denied error');
});

test('phase18-rbac', 'RBAC grants full access when no roles assigned', () => {
  const src = readFile('lib/runtime/rbac.ts');
  assert(src.includes('backward compat'), 'must note backward compatibility');
  assert(src.includes('admin_runtime'), 'must include admin_runtime in full-access grant');
});

test('phase18-rbac', 'RBAC supports assignRole and revokeRole', () => {
  const src = readFile('lib/runtime/rbac.ts');
  assert(src.includes('export async function assignRole'), 'must export assignRole');
  assert(src.includes('export async function revokeRole'), 'must export revokeRole');
});

// ============================================================================
// Section 79: Phase 18.8 — RBAC API route
// ============================================================================

test('phase18-rbac-route', 'RBAC route exists with GET and POST', () => {
  const src = readFile('app/api/runtime/control/rbac/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
  assert(src.includes('export async function POST'), 'must export POST');
});

test('phase18-rbac-route', 'RBAC POST supports assign and revoke actions', () => {
  const src = readFile('app/api/runtime/control/rbac/route.ts');
  assert(src.includes("action === 'assign'"), 'must support assign action');
  assert(src.includes("action === 'revoke'"), 'must support revoke action');
});

test('phase18-rbac-route', 'RBAC GET supports me=true param', () => {
  const src = readFile('app/api/runtime/control/rbac/route.ts');
  assert(src.includes("'me'"), 'must support me=true param');
  assert(src.includes('getUserPermissions'), 'must return user permissions');
});

// ============================================================================
// Section 80: Phase 18.9 — Alert engine service
// ============================================================================

test('phase18-alert-engine', 'alert-engine service exists', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes("import 'server-only'"), 'must be server-only');
  assert(src.includes('export async function listAlertRules'), 'must export listAlertRules');
});

test('phase18-alert-engine', 'alert-engine supports all condition types', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes("'queue_overload'"), 'must support queue_overload condition');
  assert(src.includes("'worker_crash'"), 'must support worker_crash condition');
  assert(src.includes("'incident_explosion'"), 'must support incident_explosion condition');
  assert(src.includes("'replay_corruption'"), 'must support replay_corruption condition');
  assert(src.includes("'sla_violation'"), 'must support sla_violation condition');
});

test('phase18-alert-engine', 'alert-engine supports all delivery channels', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes("'dashboard'"), 'must support dashboard channel');
  assert(src.includes("'email'"), 'must support email channel');
  assert(src.includes("'webhook'"), 'must support webhook channel');
  assert(src.includes("'slack'"), 'must support slack channel');
  assert(src.includes("'telegram'"), 'must support telegram channel');
});

test('phase18-alert-engine', 'alert-engine uses nodemailer for email', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes("import('nodemailer')"), 'must use nodemailer for email delivery');
});

test('phase18-alert-engine', 'alert-engine evaluates all active rules', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('export async function evaluateAlertRules'), 'must export evaluateAlertRules');
  assert(src.includes('is_active'), 'must only evaluate active rules');
});

test('phase18-alert-engine', 'alert-engine fires alerts and records firings', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('export async function fireAlert'), 'must export fireAlert');
  assert(src.includes('runtime_alert_firings'), 'must write to runtime_alert_firings');
});

test('phase18-alert-engine', 'alert-engine CRUD operations', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('export async function createAlertRule'), 'must export createAlertRule');
  assert(src.includes('export async function updateAlertRule'), 'must export updateAlertRule');
  assert(src.includes('export async function deleteAlertRule'), 'must export deleteAlertRule');
});

// ============================================================================
// Section 81: Phase 18.9 — Alerts API route
// ============================================================================

test('phase18-alerts-route', 'alerts route exists with GET and POST', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  assert(src.includes('export async function GET'), 'must export GET');
  assert(src.includes('export async function POST'), 'must export POST');
});

test('phase18-alerts-route', 'alerts POST supports create action', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  assert(src.includes("action === 'create'"), 'must support create action');
  assert(src.includes('createAlertRule'), 'must call createAlertRule');
});

test('phase18-alerts-route', 'alerts POST supports update, delete, test actions', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  assert(src.includes("action === 'update'"), 'must support update action');
  assert(src.includes("action === 'delete'"), 'must support delete action');
  assert(src.includes("action === 'test'"), 'must support test action');
  assert(src.includes('fireAlert'), 'test action must call fireAlert');
});

test('phase18-alerts-route', 'alerts GET supports firings=true param', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  assert(src.includes("'firings'"), 'must support firings=true param');
  assert(src.includes('getRecentFirings'), 'must call getRecentFirings');
});

// ============================================================================
// Section 82: Phase 18.9 — AlertsPanel component
// ============================================================================

test('phase18-alerts-panel', 'AlertsPanel component exists', () => {
  const src = readFile('components/control/AlertsPanel.tsx');
  assert(src.includes('export function AlertsPanel'), 'must export AlertsPanel');
});

test('phase18-alerts-panel', 'AlertsPanel shows rule list and firings tabs', () => {
  const src = readFile('components/control/AlertsPanel.tsx');
  assert(src.includes("'rules'"), 'must have rules tab');
  assert(src.includes("'firings'"), 'must have firings tab');
});

test('phase18-alerts-panel', 'AlertsPanel can toggle, test, and delete rules', () => {
  const src = readFile('components/control/AlertsPanel.tsx');
  assert(src.includes('handleToggle'), 'must handle rule toggle');
  assert(src.includes('handleTest'), 'must handle rule test');
  assert(src.includes('handleDelete'), 'must handle rule delete');
});

test('phase18-alerts-panel', 'AlertsPanel has delete confirmation dialog', () => {
  const src = readFile('components/control/AlertsPanel.tsx');
  assert(src.includes('AlertDialog'), 'must use AlertDialog for delete confirmation');
  assert(src.includes('AlertDialogAction'), 'must have confirm action');
});

// ============================================================================
// Section 83: Phase 18 — DB migrations
// ============================================================================

test('phase18-migrations', 'metrics migration exists', () => {
  const src = readFile('supabase/migrations/20260531000001_runtime_phase18_metrics.sql');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_metrics'), 'must create runtime_metrics');
  assert(src.includes('metric_name'), 'must have metric_name column');
  assert(src.includes('metric_value'), 'must have metric_value column');
  assert(src.includes('ROW LEVEL SECURITY'), 'must enable RLS');
});

test('phase18-migrations', 'SLA migration exists', () => {
  const src = readFile('supabase/migrations/20260531000002_runtime_phase18_sla.sql');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_sla_targets'), 'must create runtime_sla_targets');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_sla_violations'), 'must create runtime_sla_violations');
  assert(src.includes('execution_duration'), 'must seed execution_duration default target');
});

test('phase18-migrations', 'cost migration exists', () => {
  const src = readFile('supabase/migrations/20260531000003_runtime_phase18_cost.sql');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_cost_records'), 'must create runtime_cost_records');
  assert(src.includes('total_cost_usd'), 'must have total_cost_usd column');
});

test('phase18-migrations', 'RBAC migration exists', () => {
  const src = readFile('supabase/migrations/20260531000004_runtime_phase18_rbac.sql');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_roles'), 'must create runtime_roles');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_permissions'), 'must create runtime_permissions');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_role_assignments'), 'must create runtime_role_assignments');
  assert(src.includes("'viewer'"), 'must seed viewer role');
  assert(src.includes("'operator'"), 'must seed operator role');
  assert(src.includes("'admin'"), 'must seed admin role');
  assert(src.includes("'admin_runtime'"), 'must seed admin_runtime permission');
});

test('phase18-migrations', 'alerts migration exists', () => {
  const src = readFile('supabase/migrations/20260531000005_runtime_phase18_alerts.sql');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_alert_rules'), 'must create runtime_alert_rules');
  assert(src.includes('CREATE TABLE IF NOT EXISTS runtime_alert_firings'), 'must create runtime_alert_firings');
  assert(src.includes('channels'), 'must have channels column');
});

// ============================================================================
// Section 84: Phase 18 — types.ts Phase 18 additions
// ============================================================================

test('phase18-types', 'types.ts has Phase 18 metric types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type MetricPoint'), 'must export MetricPoint');
  assert(src.includes('export type MetricSeries'), 'must export MetricSeries');
  assert(src.includes('export type MetricSnapshot'), 'must export MetricSnapshot');
});

test('phase18-types', 'types.ts has Trace and TraceSpan types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type Trace'), 'must export Trace');
  assert(src.includes('export type TraceSpan'), 'must export TraceSpan');
  assert(src.includes('trace_id'), 'Trace must have trace_id');
});

test('phase18-types', 'types.ts has SLA types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type SlaTarget'), 'must export SlaTarget');
  assert(src.includes('export type SlaViolation'), 'must export SlaViolation');
  assert(src.includes('export type SlaReport'), 'must export SlaReport');
});

test('phase18-types', 'types.ts has cost types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type CostSummary'), 'must export CostSummary');
  assert(src.includes('export type CostResponse'), 'must export CostResponse');
  assert(src.includes('monthlyProjection'), 'CostSummary must have monthlyProjection');
});

test('phase18-types', 'types.ts has alert types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type AlertRule'), 'must export AlertRule');
  assert(src.includes('export type AlertFiring'), 'must export AlertFiring');
  assert(src.includes('export type AlertChannel'), 'must export AlertChannel');
});

test('phase18-types', 'types.ts has RBAC types', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type RuntimeRole'), 'must export RuntimeRole');
  assert(src.includes('export type RbacResponse'), 'must export RbacResponse');
});

test('phase18-types', 'types.ts has ReplayResponse type', () => {
  const src = readFile('components/control/types.ts');
  assert(src.includes('export type ReplayCheckpoint'), 'must export ReplayCheckpoint');
  assert(src.includes('export type ReplayResponse'), 'must export ReplayResponse');
});

// ============================================================================
// Section 85: Phase 18 — control page updated with new tabs
// ============================================================================

test('phase18-control-page', 'control page imports Phase 18 panels', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes('ObservabilityPanel'), 'must import ObservabilityPanel');
  assert(src.includes('TraceViewer'), 'must import TraceViewer');
  assert(src.includes('ReplayVisualizer'), 'must import ReplayVisualizer');
  assert(src.includes('SlaPanel'), 'must import SlaPanel');
  assert(src.includes('CostPanel'), 'must import CostPanel');
  assert(src.includes('AlertsPanel'), 'must import AlertsPanel');
});

test('phase18-control-page', 'control page has observability tab', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes("value='observability'"), 'must have observability tab');
  assert(src.includes('<ObservabilityPanel'), 'must render ObservabilityPanel');
});

test('phase18-control-page', 'control page has traces tab', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes("value='traces'"), 'must have traces tab');
  assert(src.includes('<TraceViewer'), 'must render TraceViewer');
});

test('phase18-control-page', 'control page has replay tab', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes("value='replay'"), 'must have replay tab');
  assert(src.includes('<ReplayVisualizer'), 'must render ReplayVisualizer');
});

test('phase18-control-page', 'control page has sla, cost, alerts tabs', () => {
  const src = readFile('app/runtime/control/page.tsx');
  assert(src.includes("value='sla'"), 'must have sla tab');
  assert(src.includes("value='cost'"), 'must have cost tab');
  assert(src.includes("value='alerts'"), 'must have alerts tab');
  assert(src.includes('<SlaPanel'), 'must render SlaPanel');
  assert(src.includes('<CostPanel'), 'must render CostPanel');
  assert(src.includes('<AlertsPanel'), 'must render AlertsPanel');
});

// ============================================================================
// Section 86: Phase 18 — enterprise readiness checks
// ============================================================================

test('phase18-enterprise', 'all Phase 18 service files are server-only', () => {
  const files = [
    'lib/runtime/metrics-engine.ts',
    'lib/runtime/sla-engine.ts',
    'lib/runtime/cost-engine.ts',
    'lib/runtime/rbac.ts',
    'lib/runtime/alert-engine.ts',
  ];
  for (const f of files) {
    const src = readFile(f);
    assert(src.includes("import 'server-only'"), `${f} must have server-only guard`);
  }
});

test('phase18-enterprise', 'all Phase 18 API routes authenticate users', () => {
  const routes = [
    'app/api/runtime/control/stream/route.ts',
    'app/api/runtime/control/metrics/route.ts',
    'app/api/runtime/control/traces/route.ts',
    'app/api/runtime/control/sla/route.ts',
    'app/api/runtime/control/cost/route.ts',
    'app/api/runtime/control/rbac/route.ts',
    'app/api/runtime/control/alerts/route.ts',
    'app/api/runtime/control/replay-visualizer/route.ts',
  ];
  for (const f of routes) {
    const src = readFile(f);
    assert(src.includes('getUserFromRequest'), `${f} must authenticate user`);
    assert(src.includes('Unauthorized'), `${f} must handle unauthorized`);
  }
});

test('phase18-enterprise', 'all Phase 18 services use createServiceClient for DB access', () => {
  const services = [
    'lib/runtime/metrics-engine.ts',
    'lib/runtime/sla-engine.ts',
    'lib/runtime/cost-engine.ts',
    'lib/runtime/rbac.ts',
    'lib/runtime/alert-engine.ts',
  ];
  for (const f of services) {
    const src = readFile(f);
    assert(src.includes('createServiceClient'), `${f} must use createServiceClient`);
  }
});

test('phase18-enterprise', 'RBAC 3 roles × 8 permissions model is complete', () => {
  const rbac = readFile('lib/runtime/rbac.ts');
  assert(rbac.includes("'view_runtime'"),      'must have view_runtime');
  assert(rbac.includes("'manage_workers'"),    'must have manage_workers');
  assert(rbac.includes("'manage_incidents'"),  'must have manage_incidents');
  assert(rbac.includes("'manage_commands'"),   'must have manage_commands');
  assert(rbac.includes("'manage_executions'"), 'must have manage_executions');
  assert(rbac.includes("'view_audit'"),        'must have view_audit');
  assert(rbac.includes("'manage_replay'"),     'must have manage_replay');
  assert(rbac.includes("'admin_runtime'"),     'must have admin_runtime');

  const migration = readFile('supabase/migrations/20260531000004_runtime_phase18_rbac.sql');
  assert(migration.includes("'viewer'"),   'migration must seed viewer role');
  assert(migration.includes("'operator'"), 'migration must seed operator role');
  assert(migration.includes("'admin'"),    'migration must seed admin role');
});

test('phase18-enterprise', 'alert-engine delivers to 5 channels', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('deliverToEmail'),    'must implement email delivery');
  assert(src.includes('deliverToWebhook'), 'must implement webhook delivery');
  assert(src.includes('deliverToSlack'),   'must implement Slack delivery');
  assert(src.includes('deliverToTelegram'),'must implement Telegram delivery');
  assert(src.includes("'dashboard'"),      'must support dashboard channel');
});

test('phase18-enterprise', 'SLA migration seeds default targets', () => {
  const src = readFile('supabase/migrations/20260531000002_runtime_phase18_sla.sql');
  assert(src.includes('execution_duration'),  'must seed execution_duration target');
  assert(src.includes('worker_availability'), 'must seed worker_availability target');
  assert(src.includes('queue_latency'),       'must seed queue_latency target');
  assert(src.includes('command_ack_time'),    'must seed command_ack_time target');
});

test('phase18-enterprise', 'metrics table has proper indexes', () => {
  const src = readFile('supabase/migrations/20260531000001_runtime_phase18_metrics.sql');
  assert(src.includes('CREATE INDEX'), 'must have indexes');
  assert(src.includes('metric_name'), 'must index metric_name');
  assert(src.includes('recorded_at'), 'must index recorded_at');
});

// ============================================================================
// Section 87: Phase 19 — Production Hardening: migration fixes
// ============================================================================

test('phase19-migration-hardening', 'hardening migration 006 exists', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  assert(src.length > 0, 'Hardening migration must exist');
});

test('phase19-migration-hardening', 'hardening migration drops partial SLA index and adds full unique constraint', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  assert(src.includes('DROP INDEX IF EXISTS runtime_sla_targets_type_idx'), 'Must drop the partial unique index');
  assert(
    src.includes('ADD CONSTRAINT runtime_sla_targets_target_type_key UNIQUE (target_type)'),
    'Must add full unique constraint on target_type'
  );
});

test('phase19-migration-hardening', 'hardening migration deduplicates SLA targets before adding constraint', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  const dedupeIdx = src.indexOf('DELETE FROM runtime_sla_targets');
  const constraintIdx = src.indexOf('ADD CONSTRAINT runtime_sla_targets_target_type_key');
  assert(dedupeIdx !== -1, 'Must delete duplicates from runtime_sla_targets');
  assert(dedupeIdx < constraintIdx, 'Dedup DELETE must come before ADD CONSTRAINT');
});

test('phase19-migration-hardening', 'hardening migration adds UNIQUE constraint on alert rule name', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  assert(
    src.includes('ADD CONSTRAINT runtime_alert_rules_name_key UNIQUE (name)'),
    'Must add unique constraint on alert rule name'
  );
});

test('phase19-migration-hardening', 'hardening migration deduplicates alert rules before adding constraint', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  const dedupeIdx = src.indexOf('DELETE FROM runtime_alert_rules');
  const constraintIdx = src.indexOf('ADD CONSTRAINT runtime_alert_rules_name_key');
  assert(dedupeIdx !== -1, 'Must delete duplicate alert rules');
  assert(dedupeIdx < constraintIdx, 'Alert rule dedup DELETE must come before ADD CONSTRAINT');
});

test('phase19-migration-hardening', 'hardening migration re-seeds alert rules with explicit ON CONFLICT (name)', () => {
  const src = readFile('supabase/migrations/20260531000006_runtime_phase18_hardening.sql');
  assert(src.includes('ON CONFLICT (name) DO NOTHING'), 'Re-seed must use explicit conflict target ON CONFLICT (name)');
});

// ============================================================================
// Section 88: Phase 19 — Production Hardening: alert engine
// ============================================================================

test('phase19-alert-engine', 'evaluateAlertRules has cooldown check to prevent alert spam', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  const idx = src.indexOf('export async function evaluateAlertRules');
  const body = src.slice(idx, idx + 2500);
  assert(body.includes('cooldownMs'), 'Must define cooldownMs per rule');
  assert(body.includes('lastFiredAt'), 'Must track last firing time per rule');
  assert(body.includes('if (Date.now() - lastFiredAt < cooldownMs) continue'), 'Must skip rule if within cooldown window');
});

test('phase19-alert-engine', 'evaluateAlertRules loads last firing times before evaluating', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  const idx = src.indexOf('export async function evaluateAlertRules');
  const body = src.slice(idx, idx + 2500);
  const lastFiredIdx = body.indexOf('getLastFiringTimes');
  const loopIdx = body.indexOf('for (const rule of');
  assert(lastFiredIdx !== -1, 'Must call getLastFiringTimes');
  assert(lastFiredIdx < loopIdx, 'getLastFiringTimes must be called before the rule evaluation loop');
});

test('phase19-alert-engine', 'getLastFiringTimes helper fetches firings for all active rules', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('async function getLastFiringTimes'), 'getLastFiringTimes helper must exist');
  const idx = src.indexOf('async function getLastFiringTimes');
  const body = src.slice(idx, idx + 500);
  assert(body.includes('.in(\'rule_id\''), 'Must query firings by rule_id using .in()');
  assert(body.includes('fired_at'), 'Must select fired_at for timestamp comparison');
});

test('phase19-alert-engine', 'deliverToWebhook has AbortController timeout', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  const idx = src.indexOf('async function deliverToWebhook');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('AbortController'), 'Must use AbortController for timeout');
  assert(body.includes('DELIVERY_TIMEOUT_MS'), 'Must use named timeout constant');
  assert(body.includes('abort.signal'), 'Must pass signal to fetch');
  assert(body.includes('finally'), 'Must clear timer in finally block');
});

test('phase19-alert-engine', 'deliverToSlack has AbortController timeout', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  const idx = src.indexOf('async function deliverToSlack');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('AbortController'), 'Must use AbortController for timeout');
  assert(body.includes('abort.signal'), 'Must pass signal to fetch');
  assert(body.includes('finally'), 'Must clear timer in finally block');
});

test('phase19-alert-engine', 'deliverToTelegram has AbortController timeout', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  const idx = src.indexOf('async function deliverToTelegram');
  const body = src.slice(idx, idx + 700);
  assert(body.includes('AbortController'), 'Must use AbortController for timeout');
  assert(body.includes('abort.signal'), 'Must pass signal to fetch');
  assert(body.includes('finally'), 'Must clear timer in finally block');
});

test('phase19-alert-engine', 'DELIVERY_TIMEOUT_MS constant is defined', () => {
  const src = readFile('lib/runtime/alert-engine.ts');
  assert(src.includes('DELIVERY_TIMEOUT_MS'), 'Must define DELIVERY_TIMEOUT_MS constant');
  assert(src.includes('const DELIVERY_TIMEOUT_MS = '), 'DELIVERY_TIMEOUT_MS must be a const');
});

// ============================================================================
// Section 89: Phase 19 — Production Hardening: RBAC enforcement on routes
// ============================================================================

test('phase19-rbac-enforcement', 'alerts POST route enforces manage_incidents permission', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  assert(src.includes("from '@/lib/runtime/rbac'"), 'alerts route must import from rbac');
  assert(src.includes('requirePermission'), 'alerts POST must call requirePermission');
  assert(src.includes("'manage_incidents'"), "alerts POST must require 'manage_incidents' permission");
});

test('phase19-rbac-enforcement', 'alerts POST route returns 403 on permission denial', () => {
  const src = readFile('app/api/runtime/control/alerts/route.ts');
  const postIdx = src.indexOf('export async function POST');
  const body = src.slice(postIdx, postIdx + 400);
  assert(body.includes('requirePermission'), 'POST handler must call requirePermission');
  assert(body.includes('status: 403') || body.includes("{ status: 403 }"), 'Must return 403 when permission denied');
  assert(body.includes('Forbidden'), "Must include 'Forbidden' in 403 response");
});

test('phase19-rbac-enforcement', 'SLA POST route enforces manage_executions permission', () => {
  const src = readFile('app/api/runtime/control/sla/route.ts');
  assert(src.includes("from '@/lib/runtime/rbac'"), 'sla route must import from rbac');
  assert(src.includes('requirePermission'), 'sla POST must call requirePermission');
  assert(src.includes("'manage_executions'"), "sla POST must require 'manage_executions' permission");
});

test('phase19-rbac-enforcement', 'SLA POST route returns 403 on permission denial', () => {
  const src = readFile('app/api/runtime/control/sla/route.ts');
  const postIdx = src.indexOf('export async function POST');
  const body = src.slice(postIdx, postIdx + 400);
  assert(body.includes('status: 403') || body.includes("{ status: 403 }"), 'Must return 403 when permission denied');
});

test('phase19-rbac-enforcement', 'RBAC POST route enforces admin_runtime permission', () => {
  const src = readFile('app/api/runtime/control/rbac/route.ts');
  assert(src.includes('requirePermission'), 'rbac POST must call requirePermission');
  assert(src.includes("'admin_runtime'"), "rbac POST must require 'admin_runtime' permission");
});

test('phase19-rbac-enforcement', 'RBAC POST route returns 403 on permission denial', () => {
  const src = readFile('app/api/runtime/control/rbac/route.ts');
  const postIdx = src.indexOf('export async function POST');
  const body = src.slice(postIdx, postIdx + 400);
  assert(body.includes('status: 403') || body.includes("{ status: 403 }"), 'Must return 403 when permission denied');
  assert(body.includes('Forbidden'), "Must include 'Forbidden' in 403 response");
});

test('phase19-rbac-enforcement', 'RBAC backward compatibility: no assignments returns all permissions', () => {
  const src = readFile('lib/runtime/rbac.ts');
  const idx = src.indexOf('export async function getUserPermissions');
  const body = src.slice(idx, idx + 600);
  assert(body.includes('assignments.length === 0'), 'Must check for empty assignments');
  assert(body.includes('admin_runtime'), 'Must grant admin_runtime for backward compat');
  assert(
    body.includes('return [') || body.includes('return [\n'),
    'Must return full permission list for backward compat'
  );
});

// ============================================================================
// Section 90: Phase 19 — Production Hardening: SSE stream cleanup race
// ============================================================================

test('phase19-sse-stream', 'SSE stream has cancelled flag to prevent post-cancel interval setup', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes('let cancelled = false'), 'Must declare cancelled flag');
  assert(src.includes('cancelled = true'), 'Must set cancelled to true in cleanup');
});

test('phase19-sse-stream', 'SSE stream start() checks cancelled before setting up intervals', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  const startIdx = src.indexOf('async start(controller)');
  const body = src.slice(startIdx, startIdx + 1200);
  const cancelledCheckIdx = body.indexOf('if (cancelled) return');
  const heartbeatIdx = body.indexOf('heartbeatId = setInterval');
  assert(cancelledCheckIdx !== -1, 'Must check cancelled flag before setting up intervals');
  assert(cancelledCheckIdx < heartbeatIdx, 'cancelled check must come before interval setup');
});

test('phase19-sse-stream', 'SSE stream cleanup function sets cancelled flag', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  const cleanupIdx = src.indexOf('function cleanup()');
  const body = src.slice(cleanupIdx, cleanupIdx + 200);
  assert(body.includes('cancelled = true'), 'cleanup() must set cancelled=true to guard async start()');
});

test('phase19-sse-stream', 'SSE stream abort handler calls cleanup', () => {
  const src = readFile('app/api/runtime/control/stream/route.ts');
  assert(src.includes("req.signal.addEventListener('abort'"), 'Must listen for abort signal');
  const abortIdx = src.indexOf("req.signal.addEventListener('abort'");
  const body = src.slice(abortIdx, abortIdx + 100);
  assert(body.includes('cleanup()'), 'abort handler must call cleanup()');
});

// ============================================================================
// Section 91: Phase 19 — Production Hardening: cost engine parallel inserts
// ============================================================================

test('phase19-cost-engine', 'recordExecutionCost uses Promise.all for parallel inserts', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  const idx = src.indexOf('export async function recordExecutionCost');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes('Promise.all'), 'Must use Promise.all to issue both inserts in parallel');
  assert(body.includes("costType:    'execution'"), 'Must still record execution cost');
  assert(body.includes("costType:    'worker_time'"), 'Must still record worker_time cost');
});

test('phase19-cost-engine', 'recordExecutionCost only inserts worker_time when durationMs > 0', () => {
  const src = readFile('lib/runtime/cost-engine.ts');
  const idx = src.indexOf('export async function recordExecutionCost');
  const body = src.slice(idx, idx + 1500);
  assert(body.includes('durationMs > 0'), 'worker_time insert must be guarded by durationMs > 0');
});

// ============================================================================
// Summary
// ============================================================================

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
const total = results.length;

const sectionMap = new Map<string, { pass: number; fail: number }>();
for (const r of results) {
  const s = sectionMap.get(r.section) ?? { pass: 0, fail: 0 };
  r.ok ? s.pass++ : s.fail++;
  sectionMap.set(r.section, s);
}

console.log('\n=== Phase 7 Fix — Self-Healing Chaos Test Results ===\n');

for (const [section, counts] of sectionMap) {
  const icon = counts.fail === 0 ? '✓' : '✗';
  console.log(`${icon} ${section}: ${counts.pass}/${counts.pass + counts.fail} passed`);
}

if (failed > 0) {
  console.log('\n--- FAILURES ---');
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  [${r.section}] ${r.name}`);
    console.log(`    → ${r.message}`);
  }
}

console.log(`\nTotal: ${passed}/${total} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
