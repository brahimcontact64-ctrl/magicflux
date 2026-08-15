/**
 * scripts/seed-large-dataset.ts
 *
 * Phase 20 — Staging Environment Data Seeding
 *
 * Seeds realistic production-scale data:
 *   100,000 workflow executions
 *    50,000 distributed traces
 *    25,000 runtime incidents
 *    10,000 alert firings
 *     1,000 synthetic users
 *        50 synthetic teams (workflows)
 *
 * Safety: requires SEED_CONFIRM=yes to prevent accidental production seeding.
 *
 * Usage:
 *   SEED_CONFIRM=yes npx tsx --env-file=.env.local scripts/seed-large-dataset.ts
 *   SEED_CONFIRM=yes SEED_PREFIX=staging_ npx tsx --env-file=.env.local scripts/seed-large-dataset.ts
 *   SEED_CONFIRM=yes DRY_RUN=true npx tsx --env-file=.env.local scripts/seed-large-dataset.ts
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

// ── Safety guard ─────────────────────────────────────────────────────────────

if (process.env.SEED_CONFIRM !== 'yes') {
  console.error('ERROR: This script inserts large volumes of data into the database.');
  console.error('       Set SEED_CONFIRM=yes to proceed.');
  console.error('       Set DRY_RUN=true to validate without inserting.');
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === 'true';
const SEED_PREFIX = process.env.SEED_PREFIX ?? 'seed_';

if (DRY_RUN) {
  console.log('[seed] DRY_RUN=true — no data will be written');
}

// ── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500; // rows per insert batch

const COUNTS = {
  users:      1_000,
  teams:         50,   // teams = distinct workflow_ids
  executions: 100_000,
  traces:      50_000,
  incidents:   25_000,
  alertFirings: 10_000,
};

// ── DB client ────────────────────────────────────────────────────────────────

const sbUrl      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!sbUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(sbUrl, serviceKey, { auth: { persistSession: false } });

// ── Random helpers ───────────────────────────────────────────────────────────

function uuid(): string { return randomUUID(); }

function rndInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rndFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rndDate(daysBack: number): string {
  const ms = Date.now() - rndInt(0, daysBack * 86_400_000);
  return new Date(ms).toISOString();
}

function rndDuration(minMs: number, maxMs: number): number {
  return rndInt(minMs, maxMs);
}

// ── Progress helper ──────────────────────────────────────────────────────────

async function insertBatched<T extends object>(
  table: string,
  rows: T[],
  label: string,
): Promise<void> {
  if (DRY_RUN) {
    console.log(`[seed][dry-run] Would insert ${rows.length} rows into ${table}`);
    return;
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await db.from(table).insert(batch);
    if (error) {
      console.error(`[seed] Error inserting into ${table}: ${error.message}`);
      throw error;
    }
    inserted += batch.length;
    process.stdout.write(
      `\r[seed] ${label}: ${inserted}/${rows.length} (${Math.round((inserted / rows.length) * 100)}%)`
    );
  }
  console.log(`\r[seed] ${label}: ${rows.length}/${rows.length} ✓`);
}

// ── Seed functions ───────────────────────────────────────────────────────────

function generateUserIds(count: number): string[] {
  return Array.from({ length: count }, () => uuid());
}

function generateWorkflowIds(count: number): string[] {
  return Array.from({ length: count }, () => uuid());
}

function generateExecutions(
  count: number,
  userIds: string[],
  workflowIds: string[],
): Array<Record<string, unknown>> {
  const statuses = ['completed', 'completed', 'completed', 'failed', 'failed', 'running', 'cancelled'];
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < count; i++) {
    const startedAt = rndDate(90);
    const durationMs = rndDuration(500, 600_000);
    const completedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
    const status = rndFrom(statuses);

    rows.push({
      id:            uuid(),
      workflow_id:   rndFrom(workflowIds),
      user_id:       rndFrom(userIds),
      status,
      started_at:    startedAt,
      completed_at:  status === 'running' ? null : completedAt,
      retry_count:   status === 'failed' ? rndInt(0, 3) : 0,
      error_message: status === 'failed' ? `Error in node_${rndInt(1, 20)}: timeout after ${rndInt(5, 60)}s` : null,
      created_at:    startedAt,
    });
  }

  return rows;
}

function generateTraces(
  count: number,
  userIds: string[],
  workflowIds: string[],
  executionIds: string[],
): Array<Record<string, unknown>> {
  const statuses = ['completed', 'completed', 'completed', 'failed', 'running'];
  const agentNames = ['planner', 'deployer', 'monitor', 'healer', 'scheduler', 'executor'];
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < count; i++) {
    const traceId = `trace_${SEED_PREFIX}${uuid().replace(/-/g, '').slice(0, 16)}`;
    const startedAt = rndDate(30);
    const durationMs = rndDuration(50, 30_000);
    const completedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
    const status = rndFrom(statuses);

    rows.push({
      trace_id:     traceId,
      user_id:      rndFrom(userIds),
      session_id:   `sess_${uuid().slice(0, 8)}`,
      workflow_id:  rndFrom(workflowIds),
      execution_id: rndFrom(executionIds),
      correlation_id: uuid(),
      root_agent:   rndFrom(agentNames),
      status,
      started_at:   startedAt,
      completed_at: status === 'running' ? null : completedAt,
      metadata:     { seed: true, duration_ms: durationMs },
    });
  }

  return rows;
}

function generateIncidents(
  count: number,
  workflowIds: string[],
  executionIds: string[],
): Array<Record<string, unknown>> {
  const severities = ['low', 'medium', 'high', 'critical'];
  const statuses = ['open', 'open', 'investigating', 'resolved', 'closed'];
  const types = [
    'worker_crash', 'execution_stuck', 'queue_backlog', 'replay_corruption',
    'sla_violation', 'memory_pressure', 'network_partition', 'db_connection_pool',
  ];
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < count; i++) {
    const detectedAt = rndDate(60);
    const status = rndFrom(statuses);
    const resolvedAt = (status === 'resolved' || status === 'closed')
      ? new Date(new Date(detectedAt).getTime() + rndDuration(60_000, 3_600_000)).toISOString()
      : null;

    rows.push({
      id:           uuid(),
      incident_type: rndFrom(types),
      severity:     rndFrom(severities),
      status,
      title:        `[${rndFrom(types).replace(/_/g, ' ').toUpperCase()}] Detected at ${new Date(detectedAt).toUTCString()}`,
      description:  `Automated incident detected by anomaly detector. Affects ${rndInt(1, 10)} workflows.`,
      workflow_id:  rndInt(0, 3) === 0 ? rndFrom(workflowIds) : null,
      execution_id: rndInt(0, 4) === 0 ? rndFrom(executionIds.slice(0, 1000)) : null,
      worker_id:    rndInt(0, 3) === 0 ? `worker_${rndInt(1, 20)}` : null,
      detected_at:  detectedAt,
      resolved_at:  resolvedAt,
      metadata:     { seed: true, anomaly_score: rndInt(40, 100) },
      created_at:   detectedAt,
    });
  }

  return rows;
}

function generateAlertFirings(
  ruleIds: string[],
): Array<Record<string, unknown>> {
  const count = COUNTS.alertFirings;
  const rows: Array<Record<string, unknown>> = [];
  const channels = [['dashboard'], ['dashboard', 'email'], ['dashboard', 'slack']];

  for (let i = 0; i < count; i++) {
    const firedAt = rndDate(30);
    const isResolved = rndInt(0, 1) === 0;
    const resolvedAt = isResolved
      ? new Date(new Date(firedAt).getTime() + rndDuration(60_000, 7_200_000)).toISOString()
      : null;

    rows.push({
      id:            uuid(),
      rule_id:       rndFrom(ruleIds),
      fired_at:      firedAt,
      resolved_at:   resolvedAt,
      payload:       {
        seed: true,
        current_value: rndInt(1, 500),
        threshold: rndInt(1, 200),
        condition_type: rndFrom(['queue_overload', 'worker_crash', 'incident_explosion', 'sla_violation']),
      },
      channels_sent: rndFrom(channels),
    });
  }

  return rows;
}

function generateMetrics(
  workflowIds: string[],
): Array<Record<string, unknown>> {
  const metricNames = [
    'cpu_load', 'queue_depth', 'queue_throughput', 'command_latency_ms',
    'worker_utilization', 'error_rate', 'incident_rate', 'memory_mb',
  ];
  const rows: Array<Record<string, unknown>> = [];

  // Generate 30 days of hourly data for each metric
  for (const metric of metricNames) {
    for (let h = 0; h < 720; h++) {
      const recordedAt = new Date(Date.now() - h * 3_600_000).toISOString();
      const baseValue = metric === 'cpu_load' ? rndInt(5, 80) :
                        metric === 'queue_depth' ? rndInt(0, 250) :
                        metric === 'memory_mb' ? rndInt(200, 2048) :
                        metric === 'error_rate' ? Math.random() * 0.05 :
                        rndInt(0, 100);

      rows.push({
        metric_name:  metric,
        metric_value: baseValue,
        labels:       { seed: true, workflow_sample: rndFrom(workflowIds) },
        window:       '5m',
        recorded_at:  recordedAt,
      });
    }
  }

  return rows;
}

function generateSlaViolations(
  workflowIds: string[],
  executionIds: string[],
): Array<Record<string, unknown>> {
  const targetTypes = ['execution_duration', 'worker_availability', 'queue_latency', 'command_ack_time'];
  const severities = ['warning', 'warning', 'violated'];
  const count = 5000;
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < count; i++) {
    const targetType = rndFrom(targetTypes);
    const thresholdMs = targetType === 'execution_duration' ? 300_000 :
                        targetType === 'worker_availability' ? 5_000 :
                        targetType === 'queue_latency' ? 10_000 : 30_000;
    const severity = rndFrom(severities);
    const actualMs = severity === 'violated'
      ? thresholdMs + rndInt(1000, thresholdMs)
      : Math.floor(thresholdMs * 0.85) + rndInt(0, Math.floor(thresholdMs * 0.1));

    rows.push({
      id:              uuid(),
      target_type:     targetType,
      severity,
      actual_value_ms: actualMs,
      threshold_ms:    thresholdMs,
      execution_id:    targetType === 'execution_duration' ? rndFrom(executionIds.slice(0, 5000)) : null,
      worker_id:       targetType === 'worker_availability' ? `worker_${rndInt(1, 20)}` : null,
      command_id:      null,
      details:         { seed: true },
      recorded_at:     rndDate(30),
    });
  }

  return rows;
}

function generateCostRecords(
  userIds: string[],
  workflowIds: string[],
  executionIds: string[],
): Array<Record<string, unknown>> {
  const costTypes = ['execution', 'worker_time', 'api_call', 'ai_token'];
  const count = 50_000;
  const rows: Array<Record<string, unknown>> = [];

  const unitCosts: Record<string, number> = {
    execution: 0.001,
    worker_time: 0.00001,
    api_call: 0.0001,
    ai_token: 0.000002,
  };

  for (let i = 0; i < count; i++) {
    const costType = rndFrom(costTypes);
    const quantity = costType === 'worker_time' ? rndInt(500, 300_000) :
                     costType === 'ai_token' ? rndInt(100, 10_000) :
                     rndInt(1, 10);
    const unitCost = unitCosts[costType] ?? 0.001;

    rows.push({
      id:             uuid(),
      cost_type:      costType,
      workflow_id:    rndFrom(workflowIds),
      execution_id:   costType === 'execution' || costType === 'worker_time'
                        ? rndFrom(executionIds.slice(0, 10_000))
                        : null,
      worker_id:      costType === 'worker_time' ? `worker_${rndInt(1, 20)}` : null,
      user_id:        rndFrom(userIds),
      quantity,
      unit_cost_usd:  unitCost,
      total_cost_usd: quantity * unitCost,
      metadata:       { seed: true },
      period_start:   rndDate(30),
      period_end:     null,
    });
  }

  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('═══════════════════════════════════════════════════════');
  console.log('  MagicFlux Large-Scale Dataset Seeder');
  console.log(`  Target:   ${sbUrl}`);
  console.log(`  Dry run:  ${DRY_RUN}`);
  console.log(`  Prefix:   ${SEED_PREFIX}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('\n  Generating IDs...');

  const userIds     = generateUserIds(COUNTS.users);
  const workflowIds = generateWorkflowIds(COUNTS.teams);

  // Generate executions first (we need their IDs for traces/incidents)
  console.log('\n  Building executions...');
  const executions  = generateExecutions(COUNTS.executions, userIds, workflowIds);
  const executionIds = executions.map(e => e.id as string);

  console.log('\n  Building traces...');
  const traces = generateTraces(COUNTS.traces, userIds, workflowIds, executionIds);

  console.log('\n  Building incidents...');
  const incidents = generateIncidents(COUNTS.incidents, workflowIds, executionIds);

  // Fetch existing alert rule IDs for firings
  let ruleIds: string[] = [];
  if (!DRY_RUN) {
    const { data: rules } = await db.from('runtime_alert_rules').select('id');
    ruleIds = (rules ?? []).map((r: Record<string, unknown>) => r.id as string);
  }
  if (ruleIds.length === 0) ruleIds = [uuid(), uuid(), uuid()]; // fallback for dry-run

  console.log('\n  Building alert firings...');
  const alertFirings = generateAlertFirings(ruleIds);

  console.log('\n  Building metrics...');
  const metrics = generateMetrics(workflowIds);

  console.log('\n  Building SLA violations...');
  const slaViolations = generateSlaViolations(workflowIds, executionIds);

  console.log('\n  Building cost records...');
  const costRecords = generateCostRecords(userIds, workflowIds, executionIds);

  console.log('\n  Starting inserts...\n');

  await insertBatched('workflow_executions_v2',   executions,   `executions   (${COUNTS.executions.toLocaleString()})`);
  await insertBatched('runtime_traces',           traces,       `traces        (${COUNTS.traces.toLocaleString()})`);
  await insertBatched('runtime_incidents',        incidents,    `incidents     (${COUNTS.incidents.toLocaleString()})`);
  await insertBatched('runtime_alert_firings',    alertFirings, `alert firings (${COUNTS.alertFirings.toLocaleString()})`);
  await insertBatched('runtime_metrics',          metrics,      `metrics       (${metrics.length.toLocaleString()})`);
  await insertBatched('runtime_sla_violations',   slaViolations,`sla violations(${slaViolations.length.toLocaleString()})`);
  await insertBatched('runtime_cost_records',     costRecords,  `cost records  (${costRecords.length.toLocaleString()})`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Seed Complete');
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  Rows written:`);
  console.log(`    workflow_executions_v2  : ${executions.length.toLocaleString()}`);
  console.log(`    runtime_traces         : ${traces.length.toLocaleString()}`);
  console.log(`    runtime_incidents      : ${incidents.length.toLocaleString()}`);
  console.log(`    runtime_alert_firings  : ${alertFirings.length.toLocaleString()}`);
  console.log(`    runtime_metrics        : ${metrics.length.toLocaleString()}`);
  console.log(`    runtime_sla_violations : ${slaViolations.length.toLocaleString()}`);
  console.log(`    runtime_cost_records   : ${costRecords.length.toLocaleString()}`);
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('\n[seed] Fatal error:', e);
  process.exit(1);
});
