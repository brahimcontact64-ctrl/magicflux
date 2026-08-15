/**
 * Phase 7 — Observability + Self-Healing Runtime Tests
 * Covers: anomaly detector, runtime metrics, self-healer, /api/runtime/self-heal,
 * migration, and alert schema completeness.
 * Run: npx tsx scripts/test-observability.ts
 */

import { readFileSync, existsSync } from 'node:fs';
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

function fileExists(rel: string): boolean {
  return existsSync(resolve(__dirname, '..', rel));
}

// ============================================================================
// Section 1: Migration — runtime_anomaly_observability
// ============================================================================

test('migration', 'migration file exists', () => {
  assert(fileExists('supabase/migrations/20260524000001_runtime_anomaly_observability.sql'), 'Migration file missing');
});

test('migration', 'adds message column to runtime_security_alerts', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS message text'), 'Missing: ADD COLUMN IF NOT EXISTS message text');
});

test('migration', 'adds worker_id column to runtime_security_alerts', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS worker_id text'), 'Missing: ADD COLUMN IF NOT EXISTS worker_id text');
});

test('migration', 'adds resolved_at column to runtime_security_alerts', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS resolved_at timestamptz'), 'Missing: ADD COLUMN IF NOT EXISTS resolved_at timestamptz');
});

test('migration', 'drops and recreates alert_type CHECK constraint', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes('DROP CONSTRAINT IF EXISTS runtime_security_alerts_alert_type_check'), 'Must drop old alert_type constraint');
  assert(sql.includes('ADD CONSTRAINT runtime_security_alerts_alert_type_check'), 'Must add new alert_type constraint');
});

test('migration', 'includes all 6 anomaly alert types in CHECK constraint', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  const types = [
    'repeated_node_failures',
    'retry_storm',
    'dead_letter_spike',
    'execution_loop',
    'worker_crash_frequency',
    'queue_congestion',
  ];
  for (const t of types) {
    assert(sql.includes(`'${t}'`), `Missing anomaly type '${t}' in CHECK constraint`);
  }
});

test('migration', 'preserves all original alert_type values', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  const originals = ['prompt_injection', 'tool_abuse', 'provider_misuse', 'unsafe_execution', 'webhook_replay', 'rate_limit_violation'];
  for (const t of originals) {
    assert(sql.includes(`'${t}'`), `Missing original type '${t}' in expanded CHECK constraint`);
  }
});

test('migration', 'expands severity constraint with low/medium/high', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes("DROP CONSTRAINT IF EXISTS runtime_security_alerts_severity_check"), 'Must drop old severity constraint');
  assert(sql.includes("'low'"), "Missing 'low' in severity constraint");
  assert(sql.includes("'medium'"), "Missing 'medium' in severity constraint");
  assert(sql.includes("'high'"), "Missing 'high' in severity constraint");
  assert(sql.includes("'critical'"), "Missing 'critical' in severity constraint");
});

test('migration', 'adds unresolved and worker_id indexes', () => {
  const sql = readFile('supabase/migrations/20260524000001_runtime_anomaly_observability.sql');
  assert(sql.includes('runtime_security_alerts_unresolved_idx'), 'Missing unresolved index');
  assert(sql.includes('runtime_security_alerts_worker_idx'), 'Missing worker_id index');
});

// ============================================================================
// Section 2: Anomaly detector
// ============================================================================

test('anomaly-detector', 'detectAnomalies is exported', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes('export async function detectAnomalies'), 'detectAnomalies must be exported');
});

test('anomaly-detector', 'writeAnomalyAlerts is exported', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes('export async function writeAnomalyAlerts'), 'writeAnomalyAlerts must be exported');
});

test('anomaly-detector', 'AnomalyAlert type defines all required fields', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes('alertType:'), 'AnomalyAlert must have alertType');
  assert(src.includes('severity:'), 'AnomalyAlert must have severity');
  assert(src.includes('message:'), 'AnomalyAlert must have message');
  assert(src.includes('userId:'), 'AnomalyAlert must have userId');
  assert(src.includes('executionId?:'), 'AnomalyAlert must have executionId');
  assert(src.includes('workerId?:'), 'AnomalyAlert must have workerId');
  assert(src.includes('score:'), 'AnomalyAlert must have score');
});

test('anomaly-detector', 'detects repeated_node_failures from runtime_node_states', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'runtime_node_states'"), 'Must query runtime_node_states');
  assert(src.includes("'repeated_node_failures'"), 'Must emit repeated_node_failures alert type');
  assert(src.includes(".eq('status', 'failed')"), "Must filter status=failed on node states");
});

test('anomaly-detector', 'detects retry_storm from runtime_queue_jobs attempts', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'runtime_queue_jobs'"), 'Must query runtime_queue_jobs');
  assert(src.includes("'retry_storm'"), 'Must emit retry_storm alert type');
  assert(src.includes('retryRatio'), 'Must compute retry ratio');
});

test('anomaly-detector', 'detects dead_letter_spike from runtime_queue_dead_letters', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'runtime_queue_dead_letters'"), 'Must query runtime_queue_dead_letters');
  assert(src.includes("'dead_letter_spike'"), 'Must emit dead_letter_spike alert type');
  assert(src.includes("'failed_at'") || src.includes('failed_at'), 'Must filter by failed_at timestamp');
});

test('anomaly-detector', 'detects execution_loop from workflow_execution_steps', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'workflow_execution_steps'"), 'Must query workflow_execution_steps');
  assert(src.includes("'execution_loop'"), 'Must emit execution_loop alert type');
  assert(src.includes('execStepCounts'), 'Must count steps per execution');
});

test('anomaly-detector', 'detects worker_crash_frequency from runtime_workers', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'runtime_workers'"), 'Must query runtime_workers');
  assert(src.includes("'worker_crash_frequency'"), 'Must emit worker_crash_frequency alert type');
  assert(src.includes(".eq('status', 'crashed')"), "Must filter status=crashed");
});

test('anomaly-detector', 'detects queue_congestion via stalled heartbeat', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes("'queue_congestion'"), 'Must emit queue_congestion alert type');
  assert(src.includes('stalledCutoff'), 'Must compute stalled cutoff time');
  assert(src.includes(".lt('heartbeat_at', stalledCutoff)"), 'Must filter stalled active jobs');
});

test('anomaly-detector', 'writeAnomalyAlerts writes message and worker_id columns', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const idx = src.indexOf('writeAnomalyAlerts');
  const body = src.slice(idx);
  assert(body.includes('message: a.message'), 'Must write message column');
  assert(body.includes('worker_id:'), 'Must write worker_id column');
  assert(body.includes("'runtime_security_alerts'"), 'Must insert to runtime_security_alerts');
});

test('anomaly-detector', 'score is capped at 100 for each anomaly type', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  const capCount = (src.match(/Math\.min\(100,/g) ?? []).length;
  assert(capCount >= 6, `Expected at least 6 Math.min(100,...) calls (one per anomaly type), got ${capCount}`);
});

test('anomaly-detector', 'thresholds are configurable via params', () => {
  const src = readFile('lib/runtime/anomaly-detector.ts');
  assert(src.includes('AnomalyDetectionThresholds'), 'Must define AnomalyDetectionThresholds type');
  assert(src.includes('DEFAULT_THRESHOLDS'), 'Must have DEFAULT_THRESHOLDS');
  assert(src.includes('params?.thresholds'), 'Must allow threshold override via params');
});

// ============================================================================
// Section 3: Runtime metrics
// ============================================================================

test('metrics', 'computeRuntimeMetrics is exported from lib/runtime/metrics.ts', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('export async function computeRuntimeMetrics'), 'computeRuntimeMetrics must be exported');
});

test('metrics', 'RuntimeMetrics type defines all 5 required fields', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('queue_latency:'), 'RuntimeMetrics must have queue_latency');
  assert(src.includes('worker_load:'), 'RuntimeMetrics must have worker_load');
  assert(src.includes('retry_rate:'), 'RuntimeMetrics must have retry_rate');
  assert(src.includes('failure_rate:'), 'RuntimeMetrics must have failure_rate');
  assert(src.includes('runtime_health_score:'), 'RuntimeMetrics must have runtime_health_score');
});

test('metrics', 'queue_latency is computed from queued_at and started_at timestamps', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('queued_at'), 'Must use queued_at for latency');
  assert(src.includes('started_at'), 'Must use started_at for latency');
  assert(src.includes('queue_latency'), 'Must compute queue_latency');
});

test('metrics', 'worker_load uses worker concurrency capacity', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('totalConcurrency'), 'Must compute totalConcurrency from workers');
  assert(src.includes('activeJobs'), 'Must count active jobs');
  assert(src.includes('worker_load'), 'Must compute worker_load');
});

test('metrics', 'retry_rate is percentage of jobs with attempts > 1', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('retriedJobs'), 'Must count retried jobs');
  assert(src.includes('retry_rate'), 'Must compute retry_rate');
});

test('metrics', 'failure_rate only counts terminal jobs (failed / (failed + completed))', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('failedJobs'), 'Must count failedJobs');
  assert(src.includes('completedJobs'), 'Must count completedJobs');
  assert(src.includes('terminalJobs'), 'Must compute terminalJobs = failed + completed');
  assert(src.includes('failure_rate'), 'Must compute failure_rate');
});

test('metrics', 'runtime_health_score starts at 100 and deducts for each problem type', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('let score = 100'), 'Health score must start at 100');
  assert(src.includes('score -= '), 'Health score must have deductions');
  assert(src.includes('Math.max(0,'), 'Health score must be floored at 0');
  assert(src.includes('runtime_health_score'), 'Must return runtime_health_score');
});

test('metrics', 'function uses windowMinutes parameter for time window', () => {
  const src = readFile('lib/runtime/metrics.ts');
  assert(src.includes('windowMinutes'), 'Must accept windowMinutes parameter');
  assert(src.includes('windowStart'), 'Must compute windowStart from windowMinutes');
});

// ============================================================================
// Section 4: Self-healer
// ============================================================================

test('self-healer', 'runSelfHeal is exported from lib/runtime/self-healer.ts', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('export async function runSelfHeal'), 'runSelfHeal must be exported');
});

test('self-healer', 'SelfHealReport type has required fields', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('ranAt:'), 'SelfHealReport must have ranAt');
  assert(src.includes('metrics:'), 'SelfHealReport must have metrics');
  assert(src.includes('alerts:'), 'SelfHealReport must have alerts');
  assert(src.includes('alertsWritten:'), 'SelfHealReport must have alertsWritten');
  assert(src.includes('actions:'), 'SelfHealReport must have actions');
});

test('self-healer', 'SelfHealAction has action/result/affected fields', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('action:'), 'SelfHealAction must have action');
  assert(src.includes("result: 'success' | 'skipped' | 'error'"), 'SelfHealAction result must be typed union');
  assert(src.includes('affected:'), 'SelfHealAction must have affected count');
});

test('self-healer', 'calls detectAnomalies and writeAnomalyAlerts', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('detectAnomalies'), 'Must call detectAnomalies');
  assert(src.includes('writeAnomalyAlerts'), 'Must call writeAnomalyAlerts');
});

test('self-healer', 'calls markOrphanExecutionsFailed', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('markOrphanExecutionsFailed'), 'Must call markOrphanExecutionsFailed');
});

test('self-healer', 'calls cleanupStaleWorkers', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('cleanupStaleWorkers'), 'Must call cleanupStaleWorkers');
});

test('self-healer', 'calls recoverStuckQueueJobs', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('recoverStuckQueueJobs'), 'Must call recoverStuckQueueJobs');
});

test('self-healer', 'calls cleanupExpiredLocks', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('cleanupExpiredRuntimeLocks'), 'Must call cleanupExpiredRuntimeLocks');
});

test('self-healer', 'wraps each action in safeRun to prevent one failure from stopping others', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('async function safeRun'), 'Must define safeRun helper');
  const safeRunCalls = (src.match(/safeRun\(/g) ?? []).length;
  assert(safeRunCalls >= 5, `Expected at least 5 safeRun calls, got ${safeRunCalls}`);
});

test('self-healer', 'returns ranAt ISO timestamp', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('ranAt: new Date().toISOString()'), 'Must set ranAt to current ISO timestamp');
});

test('self-healer', 'computeRuntimeMetrics and detectAnomalies run in parallel via Promise.all', () => {
  const src = readFile('lib/runtime/self-healer.ts');
  assert(src.includes('Promise.all'), 'Must use Promise.all for parallel execution');
  assert(src.includes('computeRuntimeMetrics'), 'Must call computeRuntimeMetrics');
});

// ============================================================================
// Section 5: Self-heal API endpoint
// ============================================================================

test('self-heal-api', 'route file exists', () => {
  assert(fileExists('app/api/runtime/self-heal/route.ts'), 'Route file missing: app/api/runtime/self-heal/route.ts');
});

test('self-heal-api', 'exports POST handler only', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes('export async function POST'), 'Route must export POST handler');
  assert(!src.includes('export async function GET'), 'Route must NOT export GET (maintenance op only)');
});

test('self-heal-api', 'validates CRON_SECRET Bearer token', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes('CRON_SECRET'), 'Must check CRON_SECRET env var');
  assert(src.includes("'Bearer '"), "Must strip 'Bearer ' prefix from Authorization header");
  assert(src.includes('{ status: 401 }'), 'Must return 401 for invalid token');
  assert(src.includes('{ status: 500 }'), 'Must return 500 if CRON_SECRET is not set');
});

test('self-heal-api', 'calls runSelfHeal from lib/runtime/self-healer', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes("from '@/lib/runtime/self-healer'"), 'Must import from @/lib/runtime/self-healer');
  assert(src.includes('runSelfHeal'), 'Must call runSelfHeal');
});

test('self-heal-api', 'returns { success: true, report } on success', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes('success: true'), 'Must return success: true');
  assert(src.includes('report'), 'Must include report in response');
});

test('self-heal-api', 'accepts optional body parameters and clamps them safely', () => {
  const src = readFile('app/api/runtime/self-heal/route.ts');
  assert(src.includes('orphanStaleMinutes'), 'Must accept orphanStaleMinutes param');
  assert(src.includes('jobStaleMinutes'), 'Must accept jobStaleMinutes param');
  assert(src.includes('Number.isFinite'), 'Must validate numeric params with isFinite');
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
