import "server-only";

import { detectAnomalies, writeAnomalyAlerts, type AnomalyAlert } from './anomaly-detector';
import { computeRuntimeMetrics, type RuntimeMetrics } from './metrics';
import { markOrphanExecutionsFailed, cleanupExpiredRuntimeLocks, recoverOrphanExecutions } from '@/runtime/hardening-layer';
import { cleanupStaleWorkers, cleanupHistoricalWorkers } from './worker-registry';
import { recoverStuckQueueJobs } from './worker';
import { pauseRuntimeQueue, resumeRuntimeQueue, RUNTIME_QUEUE_NAMES, type RuntimeQueueName } from './queue';
import { requestWorkerRestart, drainWorker, cleanupExpiredRestartRequests } from './worker-lifecycle';
import { createServiceClient } from '@/lib/supabase-server';

export type SelfHealAction = {
  action: string;
  result: 'success' | 'skipped' | 'error';
  affected: number;
  details?: Record<string, unknown>;
};

export type SelfHealReport = {
  ranAt: string;
  metrics: RuntimeMetrics;
  alerts: AnomalyAlert[];
  alertsWritten: number;
  actions: SelfHealAction[];
};

const COOLDOWN_MINUTES: Record<string, number> = {
  restart_worker: 10,
  pause_queue: 5,
  repair_orphan: 15,
  resume_queue: 1,
  recover_dlq: 5,
  recover_congestion: 3,
  isolate_execution: 30,
  quarantine_node: 30,
  recover_orphan_executions: 2,
  recover_stuck_queue_jobs: 2,
};

async function isOnCooldown(actionType: string, target: string): Promise<boolean> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_healing_actions')
    .select('id')
    .eq('action_type', actionType)
    .eq('target', target)
    .gt('cooldown_until', new Date().toISOString())
    .limit(1)
    .maybeSingle();
  return data !== null;
}

async function recordHealingAction(
  actionType: string,
  target: string,
  details?: Record<string, unknown>
): Promise<void> {
  const db = createServiceClient();
  const minutes = COOLDOWN_MINUTES[actionType] ?? 5;
  const now = new Date();
  await db.from('runtime_healing_actions').insert({
    action_type: actionType,
    target,
    executed_at: now.toISOString(),
    cooldown_until: new Date(now.getTime() + minutes * 60_000).toISOString(),
    details: details ?? {},
  });
}

async function safeRun(action: string, fn: () => Promise<number>): Promise<SelfHealAction> {
  try {
    const affected = await fn();
    return { action, result: 'success', affected };
  } catch (err) {
    return {
      action,
      result: 'error',
      affected: 0,
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function applyHealingForAnomaly(anomaly: AnomalyAlert): Promise<SelfHealAction[]> {
  const actions: SelfHealAction[] = [];

  if (anomaly.alertType === 'retry_storm' && (anomaly.severity === 'high' || anomaly.severity === 'critical')) {
    for (const queueName of RUNTIME_QUEUE_NAMES) {
      const onCooldown = await isOnCooldown('pause_queue', queueName);
      if (!onCooldown) {
        actions.push(await safeRun(`pause_queue:${queueName}`, async () => {
          await pauseRuntimeQueue(queueName as RuntimeQueueName);
          await recordHealingAction('pause_queue', queueName, { triggered_by: anomaly.alertType, severity: anomaly.severity });
          return 1;
        }));
      } else {
        actions.push({ action: `pause_queue:${queueName}`, result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
      }
    }
  }

  if (anomaly.alertType === 'worker_crash_frequency') {
    const workerIds = (anomaly.details.worker_ids as string[] | undefined) ?? [];
    for (const workerId of workerIds) {
      const onCooldown = await isOnCooldown('restart_worker', workerId);
      if (!onCooldown) {
        actions.push(await safeRun(`restart_worker:${workerId.slice(0, 16)}`, async () => {
          await drainWorker(workerId);
          await requestWorkerRestart({ workerId, reason: 'anomaly_detected' });
          await recordHealingAction('restart_worker', workerId, { triggered_by: anomaly.alertType, crash_count: anomaly.details.crash_count });
          return 1;
        }));
      } else {
        actions.push({ action: `restart_worker:${workerId.slice(0, 16)}`, result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
      }
    }
  }

  if (anomaly.alertType === 'dead_letter_spike') {
    const onCooldown = await isOnCooldown('recover_dlq', 'global');
    if (!onCooldown) {
      actions.push(await safeRun('recover_dlq', async () => {
        const recovered = await recoverStuckQueueJobs({ staleMinutes: 5, limit: 100 });
        await recordHealingAction('recover_dlq', 'global', { triggered_by: anomaly.alertType, dlq_count: anomaly.details.dlq_count });
        if (anomaly.severity === 'critical') {
          for (const queueName of RUNTIME_QUEUE_NAMES) {
            const qOnCooldown = await isOnCooldown('pause_queue', queueName);
            if (!qOnCooldown) {
              await pauseRuntimeQueue(queueName as RuntimeQueueName);
              await recordHealingAction('pause_queue', queueName, { triggered_by: anomaly.alertType, severity: anomaly.severity });
            }
          }
        }
        return recovered;
      }));
    } else {
      actions.push({ action: 'recover_dlq', result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
    }
  }

  if (anomaly.alertType === 'queue_congestion') {
    const onCooldown = await isOnCooldown('recover_congestion', 'global');
    if (!onCooldown) {
      actions.push(await safeRun('recover_congestion', async () => {
        const recovered = await recoverStuckQueueJobs({ staleMinutes: 5, limit: 100 });
        await recordHealingAction('recover_congestion', 'global', { triggered_by: anomaly.alertType, stalled_count: anomaly.details.stalled_count });
        return recovered;
      }));
    } else {
      actions.push({ action: 'recover_congestion', result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
    }
  }

  if (anomaly.alertType === 'execution_loop' && anomaly.executionId) {
    const execId = anomaly.executionId;
    const onCooldown = await isOnCooldown('isolate_execution', execId);
    if (!onCooldown) {
      actions.push(await safeRun(`isolate_execution:${execId.slice(0, 8)}`, async () => {
        await recordHealingAction('isolate_execution', execId, {
          triggered_by: anomaly.alertType,
          step_count: anomaly.details.step_count,
          workflow_id: anomaly.workflowId,
        });
        return 1;
      }));
    } else {
      actions.push({ action: `isolate_execution:${execId.slice(0, 8)}`, result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
    }
  }

  if (anomaly.alertType === 'repeated_node_failures' && anomaly.details.node_key) {
    const rawKey = String(anomaly.details.node_key);
    const wfId = anomaly.workflowId ?? '';
    // Normalize to workflowId:nodeId format (separator ':' for precise per-node targeting).
    // Handles both legacy '_' separator (pre-migration) and current ':' separator.
    let nodeKey: string;
    if (rawKey.includes(':')) {
      nodeKey = rawKey;
    } else if (wfId && rawKey.startsWith(wfId + '_')) {
      nodeKey = `${wfId}:${rawKey.slice(wfId.length + 1)}`;
    } else {
      nodeKey = rawKey;
    }
    const onCooldown = await isOnCooldown('quarantine_node', nodeKey);
    if (!onCooldown) {
      actions.push(await safeRun(`quarantine_node:${nodeKey.slice(0, 20)}`, async () => {
        await recordHealingAction('quarantine_node', nodeKey, {
          triggered_by: anomaly.alertType,
          failure_count: anomaly.details.failure_count,
          workflow_id: anomaly.workflowId,
        });
        return 1;
      }));
    } else {
      actions.push({ action: `quarantine_node:${nodeKey.slice(0, 20)}`, result: 'skipped', affected: 0, details: { reason: 'cooldown_active' } });
    }
  }

  return actions;
}

async function resumePausedQueues(anomalies: AnomalyAlert[]): Promise<SelfHealAction[]> {
  const actions: SelfHealAction[] = [];
  const hasRetryStorm = anomalies.some(a => a.alertType === 'retry_storm');
  if (hasRetryStorm) return actions;

  const db = createServiceClient();
  const windowStart = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentPauses } = await db
    .from('runtime_healing_actions')
    .select('target')
    .eq('action_type', 'pause_queue')
    .gte('executed_at', windowStart);

  for (const pause of (recentPauses ?? []) as Array<{ target: string }>) {
    const queueName = pause.target as RuntimeQueueName;
    if (!RUNTIME_QUEUE_NAMES.includes(queueName)) continue;
    const onCooldown = await isOnCooldown('resume_queue', queueName);
    if (!onCooldown) {
      actions.push(await safeRun(`resume_queue:${queueName}`, async () => {
        await resumeRuntimeQueue(queueName);
        await recordHealingAction('resume_queue', queueName, { reason: 'retry_storm_cleared' });
        return 1;
      }));
    }
  }

  return actions;
}

export async function runSelfHeal(params?: {
  windowMinutes?: number;
  orphanStaleMinutes?: number;
  jobStaleMinutes?: number;
  limit?: number;
}): Promise<SelfHealReport> {
  const orphanStaleMinutes = params?.orphanStaleMinutes ?? 10;
  const jobStaleMinutes = params?.jobStaleMinutes ?? 10;
  const limit = params?.limit ?? 100;

  const [metrics, anomalies] = await Promise.all([
    computeRuntimeMetrics({ windowMinutes: params?.windowMinutes ?? 60 }),
    detectAnomalies(),
  ]);

  await writeAnomalyAlerts(anomalies);

  // Always-on maintenance actions run unconditionally on every heal cycle.
  const maintenanceActions = await Promise.all([
    safeRun('mark_orphan_executions_failed', () =>
      markOrphanExecutionsFailed({ staleAfterMinutes: orphanStaleMinutes, limit })
    ),
    safeRun('recover_orphan_executions', async () => {
      if (await isOnCooldown('recover_orphan_executions', 'global')) return 0;
      const rows = await recoverOrphanExecutions({ staleAfterMinutes: 3, limit });
      await recordHealingAction('recover_orphan_executions', 'global');
      return rows.length;
    }),
    safeRun('cleanup_stale_workers', async () => {
      await cleanupStaleWorkers({ staleSeconds: 90 });
      return 0;
    }),
    safeRun('recover_stuck_queue_jobs', async () => {
      if (await isOnCooldown('recover_stuck_queue_jobs', 'global')) return 0;
      const n = await recoverStuckQueueJobs({ staleMinutes: jobStaleMinutes, limit });
      await recordHealingAction('recover_stuck_queue_jobs', 'global');
      return n;
    }),
    safeRun('cleanup_expired_locks', async () => {
      await cleanupExpiredRuntimeLocks();
      return 0;
    }),
    safeRun('cleanup_historical_workers', async () => {
      await cleanupHistoricalWorkers({ retainDays: 7 });
      return 0;
    }),
    safeRun('cleanup_expired_restart_requests', () =>
      cleanupExpiredRestartRequests({ retainDays: 7 })
    ),
  ]);

  // Anomaly-driven healing with cooldown protection.
  const healingActions: SelfHealAction[] = [];
  for (const anomaly of anomalies) {
    const actionsForAnomaly = await applyHealingForAnomaly(anomaly);
    healingActions.push(...actionsForAnomaly);
  }

  // Auto-resume queues that were paused by healing if the condition cleared.
  const resumeActions = await resumePausedQueues(anomalies);

  return {
    ranAt: new Date().toISOString(),
    metrics,
    alerts: anomalies,
    alertsWritten: anomalies.length,
    actions: [...maintenanceActions, ...healingActions, ...resumeActions],
  };
}
