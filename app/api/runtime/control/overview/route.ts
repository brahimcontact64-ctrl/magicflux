import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { computeHealthScoreV2 } from '@/lib/runtime/health-score-v2';
import { listActiveIncidents } from '@/lib/runtime/incident-manager';

// GET — full runtime overview for the operator dashboard.
//
// Response shape:
//   healthScore     — HealthScoreV2 with overallScore, components, signals
//   activeIncidents — open + investigating incidents sorted by severity/recency
//   workerSummary   — live worker count, statuses, total concurrency
//   commandBacklog  — pending command count by type
//   recentActivity  — last 20 operator actions
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const db = createServiceClient();
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();

  let commandsQ = db
    .from('runtime_execution_commands')
    .select('command_type, status')
    .in('status', ['pending', 'processing', 'failed', 'dead_letter'])
    .limit(2000);
  if (!isAdmin) commandsQ = commandsQ.eq('user_id', user.id);

  let actionsQ = db
    .from('runtime_operator_actions')
    .select('action_type, operator_id, execution_id, payload, result, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (!isAdmin) actionsQ = actionsQ.eq('operator_id', user.id);

  const [
    healthScore,
    activeIncidents,
    workersRes,
    commandBacklogRes,
    recentActionsRes,
  ] = await Promise.all([
    computeHealthScoreV2({ windowMinutes: 30 }),
    listActiveIncidents({ limit: 50, userId: isAdmin ? undefined : user.id }),
    db
      .from('runtime_workers')
      .select('worker_id, status, concurrency, cpu_load, memory_mb, queues, heartbeat_at')
      .gte('heartbeat_at', staleWorkerCutoff)
      .order('heartbeat_at', { ascending: false })
      .limit(100),
    commandsQ,
    actionsQ,
  ]);

  const workers = (workersRes.data ?? []) as Array<Record<string, unknown>>;
  const workerStatuses = workers.reduce<Record<string, number>>((acc, w) => {
    const s = String(w.status ?? 'unknown');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const totalConcurrency = workers.reduce((s, w) => s + Number(w.concurrency ?? 1), 0);

  const commands = (commandBacklogRes.data ?? []) as Array<Record<string, unknown>>;
  const commandBacklogByType = commands.reduce<Record<string, number>>((acc, c) => {
    if (String(c.status) === 'pending') {
      const t = String(c.command_type ?? 'unknown');
      acc[t] = (acc[t] ?? 0) + 1;
    }
    return acc;
  }, {});
  const commandStatusCounts = commands.reduce<Record<string, number>>((acc, c) => {
    const s = String(c.status ?? 'unknown');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  // Persist a health snapshot for the trend chart (fire-and-forget).
  void (async () => {
    await db.from('runtime_health_score_snapshots').insert({
      overall_score: healthScore.overallScore,
      components:    healthScore.components,
      signals:       healthScore.signals,
      computed_at:   healthScore.computedAt,
    });
  })().catch(() => undefined);

  return NextResponse.json({
    healthScore,
    activeIncidents,
    workerSummary: {
      liveWorkers:    workers.length,
      statuses:       workerStatuses,
      totalConcurrency,
    },
    commandBacklog: {
      byType:        commandBacklogByType,
      statusCounts:  commandStatusCounts,
    },
    recentActivity: recentActionsRes.data ?? [],
    generatedAt:    new Date().toISOString(),
  });
}
