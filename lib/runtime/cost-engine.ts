import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

export type CostType =
  | 'execution'
  | 'worker_time'
  | 'storage'
  | 'api_call'
  | 'ai_token';

// Cost rates in USD per unit
const UNIT_COSTS: Record<CostType, number> = {
  execution:   0.001,   // per execution
  worker_time: 0.00001, // per ms of worker uptime
  storage:     0.000001,// per KB stored
  api_call:    0.0001,  // per API call
  ai_token:    0.000002,// per token
};

export type CostRecord = {
  id:             string;
  cost_type:      CostType;
  workflow_id:    string | null;
  execution_id:   string | null;
  worker_id:      string | null;
  user_id:        string | null;
  quantity:       number;
  unit_cost_usd:  number;
  total_cost_usd: number;
  metadata:       Record<string, unknown>;
  period_start:   string;
  period_end:     string | null;
};

export type CostSummary = {
  totalUsd:          number;
  byType:            Record<string, number>;
  byWorkflow:        Array<{ workflow_id: string; total_usd: number; execution_count: number }>;
  monthlyProjection: number;
  windowDays:        number;
};

export async function recordCost(params: {
  costType:    CostType;
  workflowId?: string;
  executionId?: string;
  workerId?:   string;
  userId?:     string;
  quantity:    number;
  metadata?:   Record<string, unknown>;
  periodStart?: string;
  periodEnd?:   string;
}): Promise<void> {
  const db = createServiceClient();
  const unitCost = UNIT_COSTS[params.costType];
  const totalCost = params.quantity * unitCost;
  const now = new Date().toISOString();

  await db.from('runtime_cost_records').insert({
    cost_type:      params.costType,
    workflow_id:    params.workflowId  ?? null,
    execution_id:   params.executionId ?? null,
    worker_id:      params.workerId    ?? null,
    user_id:        params.userId      ?? null,
    quantity:       params.quantity,
    unit_cost_usd:  unitCost,
    total_cost_usd: totalCost,
    metadata:       params.metadata    ?? {},
    period_start:   params.periodStart ?? now,
    period_end:     params.periodEnd   ?? null,
  });
}

export async function recordExecutionCost(params: {
  executionId: string;
  workflowId?: string;
  userId?:     string;
  startedAt:   string;
  completedAt: string;
}): Promise<void> {
  const durationMs = Math.max(
    0,
    new Date(params.completedAt).getTime() - new Date(params.startedAt).getTime()
  );

  const tasks: Promise<void>[] = [
    recordCost({
      costType:    'execution',
      executionId: params.executionId,
      workflowId:  params.workflowId,
      userId:      params.userId,
      quantity:    1,
      metadata:    { duration_ms: durationMs, started_at: params.startedAt, completed_at: params.completedAt },
      periodStart: params.startedAt,
      periodEnd:   params.completedAt,
    }),
  ];

  if (durationMs > 0) {
    tasks.push(recordCost({
      costType:    'worker_time',
      executionId: params.executionId,
      workflowId:  params.workflowId,
      userId:      params.userId,
      quantity:    durationMs,
      metadata:    { duration_ms: durationMs },
      periodStart: params.startedAt,
      periodEnd:   params.completedAt,
    }));
  }

  await Promise.all(tasks);
}

export async function getCostSummary(windowDays: number = 30, userId?: string): Promise<CostSummary> {
  const db = createServiceClient();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000).toISOString();

  let q = db
    .from('runtime_cost_records')
    .select('cost_type, workflow_id, execution_id, total_cost_usd, period_start')
    .gte('period_start', since)
    .limit(10000);
  if (userId) q = q.eq('user_id', userId);

  const { data } = await q;

  const records = data ?? [];

  const totalUsd = records.reduce((s, r) => s + Number(r.total_cost_usd ?? 0), 0);

  const byType: Record<string, number> = {};
  for (const r of records) {
    const t = String(r.cost_type ?? 'unknown');
    byType[t] = (byType[t] ?? 0) + Number(r.total_cost_usd ?? 0);
  }

  const workflowMap: Record<string, { total_usd: number; execution_count: number }> = {};
  for (const r of records) {
    if (!r.workflow_id) continue;
    const wid = String(r.workflow_id);
    if (!workflowMap[wid]) workflowMap[wid] = { total_usd: 0, execution_count: 0 };
    workflowMap[wid].total_usd += Number(r.total_cost_usd ?? 0);
    if (r.cost_type === 'execution' && r.execution_id) {
      workflowMap[wid].execution_count++;
    }
  }

  const byWorkflow = Object.entries(workflowMap)
    .map(([workflow_id, stats]) => ({ workflow_id, ...stats }))
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, 20);

  // Monthly projection: extrapolate from window
  const dailyAvg = windowDays > 0 ? totalUsd / windowDays : 0;
  const monthlyProjection = dailyAvg * 30;

  return {
    totalUsd:          Math.round(totalUsd * 100000) / 100000,
    byType:            Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, Math.round(v * 100000) / 100000])
    ),
    byWorkflow,
    monthlyProjection: Math.round(monthlyProjection * 100000) / 100000,
    windowDays,
  };
}

export async function getTopCostlyWorkflows(limit: number = 10, userId?: string): Promise<
  Array<{ workflow_id: string; total_usd: number; execution_count: number }>
> {
  const summary = await getCostSummary(30, userId);
  return summary.byWorkflow.slice(0, limit);
}
