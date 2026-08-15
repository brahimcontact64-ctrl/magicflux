import "server-only";

import { createServiceClient } from '@/lib/supabase-server';
import { listActiveIncidents } from './incident-manager';

export type HealthScoreComponents = {
  workerLiveness:        number; // 0-100
  queueHealth:           number; // 0-100
  commandBusHealth:      number; // 0-100
  replayIntegrityHealth: number; // 0-100
  incidentSeverityScore: number; // 0-100 (100 = no incidents)
};

export type HealthScoreSignals = {
  commandBacklog:         number;
  deadLetterRate:         number;  // 0-100 percent
  replayIntegrityStatus:  'clean' | 'degraded' | 'unknown';
  workerLivenessPercent:  number;  // 0-100
  openIncidentCount:      number;
  criticalIncidentCount:  number;
  queueDelay:             number;  // ms
};

export type HealthScoreV2 = {
  overallScore: number;            // 0-100
  components:   HealthScoreComponents;
  signals:      HealthScoreSignals;
  computedAt:   string;
};

// Weight table for weighted average (must sum to 1.0)
const WEIGHTS = {
  workerLiveness:        0.25,
  queueHealth:           0.20,
  commandBusHealth:      0.20,
  replayIntegrityHealth: 0.15,
  incidentSeverityScore: 0.20,
};

const SEVERITY_PENALTY: Record<string, number> = {
  low:      5,
  medium:  15,
  high:    25,
  critical: 50,
};

export async function computeHealthScoreV2(params?: {
  windowMinutes?: number;
}): Promise<HealthScoreV2> {
  const db = createServiceClient();
  const windowMinutes   = params?.windowMinutes ?? 30;
  const windowStart     = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();
  const stalledJobCutoff  = new Date(Date.now() - 10 * 60_000).toISOString();

  const [
    workersRes,
    allWorkersCountRes,
    commandBacklogRes,
    commandDeadLetterRes,
    recentCommandsRes,
    stalledJobsRes,
    queueLatencyRes,
    incidents,
  ] = await Promise.all([
    // Healthy/degraded workers (alive)
    db
      .from('runtime_workers')
      .select('worker_id, concurrency', { count: 'exact' })
      .in('status', ['healthy', 'degraded'])
      .gte('heartbeat_at', staleWorkerCutoff)
      .limit(500),
    // Total workers registered recently
    db
      .from('runtime_workers')
      .select('worker_id', { count: 'exact', head: true })
      .gte('heartbeat_at', windowStart)
      .limit(500),
    // Pending commands = command backlog
    db
      .from('runtime_execution_commands')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    // Dead-lettered commands in window
    db
      .from('runtime_execution_commands')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'dead_letter')
      .gte('created_at', windowStart),
    // All commands in window (for dead-letter rate denominator)
    db
      .from('runtime_execution_commands')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', windowStart),
    // Stalled queue jobs
    db
      .from('runtime_queue_jobs')
      .select('job_id', { count: 'exact', head: true })
      .eq('status', 'active')
      .lt('heartbeat_at', stalledJobCutoff),
    // Queue latency sample (active jobs)
    db
      .from('runtime_queue_jobs')
      .select('queued_at, started_at')
      .eq('status', 'active')
      .gte('created_at', windowStart)
      .not('started_at', 'is', null)
      .limit(200),
    // Active incidents
    listActiveIncidents({ limit: 200 }),
  ]);

  // ── Worker liveness ─────────────────────────────────────────────────────────
  const liveWorkerCount  = workersRes.count ?? 0;
  const totalWorkerCount = allWorkersCountRes.count ?? 0;
  const workerLivenessPercent = totalWorkerCount > 0
    ? Math.min(100, Math.round((liveWorkerCount / totalWorkerCount) * 100))
    : (liveWorkerCount > 0 ? 100 : 0);
  const workerLiveness = workerLivenessPercent;

  // ── Command bus health ──────────────────────────────────────────────────────
  const commandBacklog   = Number(commandBacklogRes.count   ?? 0);
  const deadLetterCount  = Number(commandDeadLetterRes.count ?? 0);
  const totalCommandsInWindow = Number(recentCommandsRes.count ?? 0);
  const deadLetterRate = totalCommandsInWindow > 0
    ? Math.round((deadLetterCount / totalCommandsInWindow) * 100)
    : 0;

  let commandBusHealth = 100;
  commandBusHealth -= Math.min(30, commandBacklog * 2);   // each backlogged command costs 2 pts (cap 30)
  commandBusHealth -= Math.min(40, deadLetterRate * 2);   // each pct dead-letter costs 2 pts (cap 40)
  commandBusHealth = Math.max(0, commandBusHealth);

  // ── Queue health ────────────────────────────────────────────────────────────
  const stalledCount = Number(stalledJobsRes.count ?? 0);
  const queueJobs    = (queueLatencyRes.data ?? []) as Array<{ queued_at: string; started_at: string }>;
  const latencies    = queueJobs
    .filter(j => j.queued_at && j.started_at)
    .map(j => Math.max(0,
      new Date(String(j.started_at)).getTime() - new Date(String(j.queued_at)).getTime()
    ));
  const queueDelay = latencies.length > 0
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  let queueHealth = 100;
  queueHealth -= Math.min(40, stalledCount * 8);           // each stalled job costs 8 pts (cap 40)
  queueHealth -= Math.min(30, Math.floor(queueDelay / 10_000) * 5); // each 10s delay costs 5 pts (cap 30)
  queueHealth = Math.max(0, queueHealth);

  // ── Replay integrity health ─────────────────────────────────────────────────
  // Proxy: if there are recent replay-integrity-failure incidents, degrade the score.
  const replayFailureIncidents = incidents.filter(
    (i) => i.incidentType === 'replay_integrity_failure' && i.status !== 'resolved'
  );
  let replayIntegrityHealth  = 100;
  let replayIntegrityStatus: HealthScoreSignals['replayIntegrityStatus'] = 'clean';
  if (replayFailureIncidents.length > 0) {
    const worst = replayFailureIncidents.reduce((a, b) => {
      const order = ['low', 'medium', 'high', 'critical'];
      return order.indexOf(b.severity) > order.indexOf(a.severity) ? b : a;
    });
    replayIntegrityHealth  -= SEVERITY_PENALTY[worst.severity] ?? 15;
    replayIntegrityHealth   = Math.max(0, replayIntegrityHealth);
    replayIntegrityStatus   = 'degraded';
  }

  // ── Incident severity score ─────────────────────────────────────────────────
  const openIncidentCount     = incidents.filter(i => i.status === 'open').length;
  const criticalIncidentCount = incidents.filter(i => i.severity === 'critical').length;

  let incidentSeverityScore = 100;
  for (const incident of incidents) {
    incidentSeverityScore -= SEVERITY_PENALTY[incident.severity] ?? 5;
  }
  incidentSeverityScore = Math.max(0, incidentSeverityScore);

  // ── Weighted overall score ──────────────────────────────────────────────────
  const overallScore = Math.round(
    workerLiveness        * WEIGHTS.workerLiveness        +
    queueHealth           * WEIGHTS.queueHealth           +
    commandBusHealth      * WEIGHTS.commandBusHealth      +
    replayIntegrityHealth * WEIGHTS.replayIntegrityHealth +
    incidentSeverityScore * WEIGHTS.incidentSeverityScore
  );

  return {
    overallScore: Math.max(0, Math.min(100, overallScore)),
    components: {
      workerLiveness,
      queueHealth,
      commandBusHealth,
      replayIntegrityHealth,
      incidentSeverityScore,
    },
    signals: {
      commandBacklog,
      deadLetterRate,
      replayIntegrityStatus,
      workerLivenessPercent,
      openIncidentCount,
      criticalIncidentCount,
      queueDelay,
    },
    computedAt: new Date().toISOString(),
  };
}
