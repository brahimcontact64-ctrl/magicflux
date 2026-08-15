import { createServiceClient } from '@/lib/supabase-server';

export type AnomalyAlertType =
  | 'repeated_node_failures'
  | 'retry_storm'
  | 'dead_letter_spike'
  | 'execution_loop'
  | 'worker_crash_frequency'
  | 'queue_congestion';

export type AnomalyAlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AnomalyAlert = {
  alertType: AnomalyAlertType;
  severity: AnomalyAlertSeverity;
  message: string;
  userId: string | null;
  workflowId?: string;
  executionId?: string;
  workerId?: string;
  details: Record<string, unknown>;
  score: number;
};

export type AnomalyDetectionThresholds = {
  nodeFailureCount: number;
  retryStormRatio: number;
  dlqSpikeCount: number;
  executionLoopSteps: number;
  workerCrashCount: number;
  queueCongestionCount: number;
  windowMinutes: number;
};

const DEFAULT_THRESHOLDS: AnomalyDetectionThresholds = {
  nodeFailureCount: 5,
  retryStormRatio: 0.20,
  dlqSpikeCount: 5,
  executionLoopSteps: 100,
  workerCrashCount: 2,
  queueCongestionCount: 10,
  windowMinutes: 10,
};

function severityFromCount(
  count: number,
  bounds: [number, number, number]
): AnomalyAlertSeverity {
  if (count >= bounds[2]) return 'critical';
  if (count >= bounds[1]) return 'high';
  if (count >= bounds[0]) return 'medium';
  return 'low';
}

type NodeFailRow = {
  node_key: string;
  workflow_id: string;
  execution_id: string;
  user_id: string | null;
  failure_count: number;
};

type RetryStormRow = { retried_count: number; total_count: number };
type DlqRow = { dlq_count: number };
type ExecLoopRow = { execution_id: string; workflow_id: string; user_id: string | null; step_count: number };
type WorkerCrashRow = { crash_count: number; worker_ids: string[] };
type CongestionRow = { stalled_count: number };

export async function detectAnomalies(params?: {
  thresholds?: Partial<AnomalyDetectionThresholds>;
}): Promise<AnomalyAlert[]> {
  const db = createServiceClient();
  const t: AnomalyDetectionThresholds = { ...DEFAULT_THRESHOLDS, ...(params?.thresholds ?? {}) };
  const alerts: AnomalyAlert[] = [];

  // ── 1. Repeated node failures ──────────────────────────────────────────────
  const { data: nodeFailRows } = await db.rpc('detect_repeated_node_failures', {
    p_threshold: t.nodeFailureCount,
    p_window_minutes: t.windowMinutes,
  });

  for (const row of ((nodeFailRows ?? []) as NodeFailRow[])) {
    const count = Number(row.failure_count);
    const severity = severityFromCount(count, [5, 10, 20]);
    const rawKey = String(row.node_key ?? '');
    const colonIdx = rawKey.indexOf(':');
    const nodeId = colonIdx >= 0 ? rawKey.slice(colonIdx + 1) : rawKey.split('_').slice(1).join('_');
    alerts.push({
      alertType: 'repeated_node_failures',
      severity,
      message: `Node "${nodeId}" failed ${count} times in the last ${t.windowMinutes} minutes`,
      userId: row.user_id ?? null,
      workflowId: row.workflow_id || undefined,
      details: { node_key: row.node_key, failure_count: count, window_minutes: t.windowMinutes },
      score: Math.min(100, count * 5),
    });
  }

  // ── 2. Retry storm ─────────────────────────────────────────────────────────
  const { data: retryRows } = await db.rpc('detect_retry_storm', {
    p_ratio: t.retryStormRatio,
    p_window_minutes: t.windowMinutes,
  });

  const retryRow = ((retryRows ?? []) as RetryStormRow[])[0];
  if (retryRow) {
    const totalJobs = Number(retryRow.total_count);
    const retriedJobs = Number(retryRow.retried_count);
    const retryRatio = totalJobs > 0 ? retriedJobs / totalJobs : 0;
    const pct = Math.round(retryRatio * 100);
    const severity = severityFromCount(pct, [20, 35, 50]);
    alerts.push({
      alertType: 'retry_storm',
      severity,
      message: `Retry storm: ${pct}% of ${totalJobs} jobs retried in the last ${t.windowMinutes} minutes`,
      userId: null,
      details: { retry_ratio: retryRatio, total_jobs: totalJobs, retried_jobs: retriedJobs, window_minutes: t.windowMinutes },
      score: Math.min(100, pct * 2),
    });
  }

  // ── 3. Dead-letter spike ───────────────────────────────────────────────────
  const { data: dlqRows } = await db.rpc('detect_dlq_spike', {
    p_threshold: t.dlqSpikeCount,
    p_window_minutes: t.windowMinutes,
  });

  const dlqRow = ((dlqRows ?? []) as DlqRow[])[0];
  if (dlqRow) {
    const dlqTotal = Number(dlqRow.dlq_count);
    const severity = severityFromCount(dlqTotal, [5, 10, 20]);
    alerts.push({
      alertType: 'dead_letter_spike',
      severity,
      message: `DLQ spike: ${dlqTotal} dead-letter entries in the last ${t.windowMinutes} minutes`,
      userId: null,
      details: { dlq_count: dlqTotal, window_minutes: t.windowMinutes },
      score: Math.min(100, dlqTotal * 4),
    });
  }

  // ── 4. Execution loops ─────────────────────────────────────────────────────
  const { data: loopRows } = await db.rpc('detect_execution_loops', {
    p_threshold: t.executionLoopSteps,
    p_window_minutes: t.windowMinutes,
  });

  for (const row of ((loopRows ?? []) as ExecLoopRow[])) {
    const count = Number(row.step_count);
    const severity = severityFromCount(count, [100, 200, 400]);
    const execId = String(row.execution_id ?? '');
    alerts.push({
      alertType: 'execution_loop',
      severity,
      message: `Execution loop: ${count} steps executed in run ${execId.slice(0, 8)} within ${t.windowMinutes} minutes`,
      userId: row.user_id ?? null,
      workflowId: row.workflow_id || undefined,
      executionId: execId,
      details: { execution_id: execId, step_count: count, window_minutes: t.windowMinutes },
      score: Math.min(100, Math.round(count / 4)),
    });
  }

  // ── 5. Worker crash frequency ──────────────────────────────────────────────
  const { data: crashRows } = await db.rpc('detect_worker_crashes', {
    p_threshold: t.workerCrashCount,
  });

  const crashRow = ((crashRows ?? []) as WorkerCrashRow[])[0];
  if (crashRow) {
    const crashCount = Number(crashRow.crash_count);
    const severity = severityFromCount(crashCount, [2, 5, 10]);
    alerts.push({
      alertType: 'worker_crash_frequency',
      severity,
      message: `Worker crash spike: ${crashCount} workers crashed in the last 30 minutes`,
      userId: null,
      details: {
        crash_count: crashCount,
        window_minutes: 30,
        worker_ids: crashRow.worker_ids ?? [],
      },
      score: Math.min(100, crashCount * 10),
    });
  }

  // ── 6. Queue congestion ────────────────────────────────────────────────────
  const { data: congestionRows } = await db.rpc('detect_queue_congestion', {
    p_threshold: t.queueCongestionCount,
  });

  const congestionRow = ((congestionRows ?? []) as CongestionRow[])[0];
  if (congestionRow) {
    const congestionCount = Number(congestionRow.stalled_count);
    const severity = severityFromCount(congestionCount, [10, 20, 50]);
    alerts.push({
      alertType: 'queue_congestion',
      severity,
      message: `Queue congestion: ${congestionCount} active jobs stalled (no heartbeat for >5 minutes)`,
      userId: null,
      details: { stalled_count: congestionCount, stale_threshold_minutes: 5 },
      score: Math.min(100, congestionCount * 2),
    });
  }

  return alerts;
}

export async function writeAnomalyAlerts(alerts: AnomalyAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  const db = createServiceClient();
  const now = new Date().toISOString();

  for (const alert of alerts) {
    // Build query for existing unresolved alert matching this dedup key.
    // Dedup key: (alert_type, workflow_id, execution_id, worker_id) WHERE resolved_at IS NULL.
    let q = db
      .from('runtime_security_alerts')
      .select('id, occurrences')
      .eq('alert_type', alert.alertType)
      .is('resolved_at', null);

    q = alert.workflowId ? q.eq('workflow_id', alert.workflowId) : q.is('workflow_id', null);
    q = alert.executionId ? q.eq('execution_id', alert.executionId) : q.is('execution_id', null);
    q = alert.workerId ? q.eq('worker_id', alert.workerId) : q.is('worker_id', null);

    const { data: existing } = await q.limit(1).maybeSingle() as { data: { id: string; occurrences: number } | null };

    if (existing) {
      await db
        .from('runtime_security_alerts')
        .update({
          occurrences: (Number(existing.occurrences) || 1) + 1,
          last_seen_at: now,
          score: alert.score,
          message: alert.message,
          details: alert.details,
          severity: alert.severity,
        })
        .eq('id', existing.id);
    } else {
      await db.from('runtime_security_alerts').insert({
        user_id: alert.userId ?? null,
        workflow_id: alert.workflowId ?? null,
        execution_id: alert.executionId ?? null,
        worker_id: alert.workerId ?? null,
        alert_type: alert.alertType,
        severity: alert.severity,
        message: alert.message,
        score: alert.score,
        details: alert.details,
        occurrences: 1,
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
      });
    }
  }
}
