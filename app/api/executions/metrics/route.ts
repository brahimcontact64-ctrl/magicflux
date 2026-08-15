import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import type { ExecutionMetrics, ExecutionMetricsResponse } from '@/lib/execution/types';

/**
 * GET /api/executions/metrics
 *
 * Query params:
 *   ?workflow_id=<uuid>  – scope to one workflow (optional)
 *   ?days=<n>            – look-back window in days (default 30, max 365)
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const workflowId = sp.get('workflow_id');
  const daysRaw    = parseInt(sp.get('days') ?? '30', 10);
  const windowDays = Math.min(365, Math.max(1, isNaN(daysRaw) ? 30 : daysRaw));
  const since      = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  let query = db
    .from('workflow_executions_v2')
    .select('status, started_at, completed_at')
    .eq('user_id', user.id)
    .gte('started_at', since);

  if (workflowId) query = query.eq('workflow_id', workflowId);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to load metrics' }, { status: 500 });
  }

  const rows = data ?? [];
  const total         = rows.length;
  const successCount  = rows.filter(r => r.status === 'success').length;
  const failedCount   = rows.filter(r => r.status === 'failed').length;
  const runningCount  = rows.filter(r => r.status === 'running').length;

  // Compute duration for completed executions
  const durations: number[] = rows
    .filter(r => r.started_at && r.completed_at)
    .map(r => {
      const ms = new Date(r.completed_at as string).getTime() -
                 new Date(r.started_at  as string).getTime();
      return ms >= 0 ? ms : 0;
    });

  durations.sort((a, b) => a - b);

  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : null;

  const p95Duration = durations.length > 0
    ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]
    : null;

  const lastStartedAt = rows.length > 0
    ? rows
        .filter(r => r.started_at)
        .map(r => r.started_at as string)
        .sort()
        .at(-1) ?? null
    : null;

  const metrics: ExecutionMetrics = {
    total_executions:  total,
    success_count:     successCount,
    failed_count:      failedCount,
    running_count:     runningCount,
    success_rate:      total > 0 ? Math.round((successCount / total) * 1000) / 10 : 0,
    avg_duration_ms:   avgDuration,
    p95_duration_ms:   p95Duration ?? null,
    last_execution_at: lastStartedAt,
  };

  const response: ExecutionMetricsResponse = { metrics, window_days: windowDays };
  return NextResponse.json(response);
}
