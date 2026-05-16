import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

function toIsoDayStart(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();
  const days = Number(req.nextUrl.searchParams.get('days') ?? '7');
  const since = toIsoDayStart(Math.max(1, Math.min(30, days)));

  const [executions, queueRows, usageRows, metricsRows] = await Promise.all([
    db
      .from('workflow_executions_v2')
      .select('status, started_at, completed_at, retry_count')
      .eq('user_id', user.id)
      .gte('started_at', since)
      .limit(5000),
    db
      .from('runtime_queue_jobs')
      .select('queue_name, status, queued_at, completed_at, attempts')
      .eq('user_id', user.id)
      .gte('created_at', since)
      .limit(5000),
    db
      .from('agent_ai_usage')
      .select('provider, model, total_tokens, estimated_cost_usd')
      .eq('user_id', user.id)
      .gte('created_at', since)
      .limit(5000),
    db
      .from('runtime_metrics_minute')
      .select('metric_minute, queue_name, executions_started, executions_completed, executions_failed, retries, avg_duration_ms, avg_provider_latency_ms, token_usage, api_cost_usd')
      .eq('user_id', user.id)
      .gte('metric_minute', since)
      .order('metric_minute', { ascending: false })
      .limit(2000),
  ]);

  const executionData = executions.data ?? [];
  const queueData = queueRows.data ?? [];
  const usageData = usageRows.data ?? [];
  const metricsData = metricsRows.data ?? [];

  const completed = executionData.filter((e) => e.status === 'success').length;
  const failed = executionData.filter((e) => e.status === 'failed').length;
  const waiting = executionData.filter((e) => e.status === 'waiting').length;

  const durationMs = executionData
    .filter((e) => e.started_at && e.completed_at)
    .map((e) => {
      const started = new Date(String(e.started_at)).getTime();
      const completedAt = new Date(String(e.completed_at)).getTime();
      return Math.max(0, completedAt - started);
    });

  const avgExecutionDurationMs = durationMs.length > 0
    ? Math.round(durationMs.reduce((sum, v) => sum + v, 0) / durationMs.length)
    : 0;

  const queueThroughput = queueData.reduce<Record<string, number>>((acc, row) => {
    const queue = String(row.queue_name ?? 'unknown');
    acc[queue] = (acc[queue] ?? 0) + 1;
    return acc;
  }, {});

  const failureHeatmap = queueData.reduce<Record<string, number>>((acc, row) => {
    if (row.status !== 'failed') return acc;
    const queue = String(row.queue_name ?? 'unknown');
    acc[queue] = (acc[queue] ?? 0) + 1;
    return acc;
  }, {});

  const providerLatencyMs = metricsData.reduce<Record<string, number>>((acc, row) => {
    const queue = String(row.queue_name ?? 'runtime');
    const latency = Number(row.avg_provider_latency_ms ?? 0);
    if (!acc[queue]) {
      acc[queue] = latency;
    } else {
      acc[queue] = Math.round((acc[queue] + latency) / 2);
    }
    return acc;
  }, {});

  const totalTokens = usageData.reduce((sum, row) => sum + Number(row.total_tokens ?? 0), 0);
  const totalCostUsd = Number(
    usageData.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0).toFixed(4)
  );

  const retryInsights = {
    totalRetries: executionData.reduce((sum, row) => sum + Number(row.retry_count ?? 0), 0),
    retriedExecutions: executionData.filter((row) => Number(row.retry_count ?? 0) > 0).length,
  };

  const aiRecommendations: string[] = [];
  if (failed > completed && failed > 10) {
    aiRecommendations.push('Failure volume is high. Enable stricter provider fallback and reduce concurrent retries.');
  }
  if (totalCostUsd > 25) {
    aiRecommendations.push('AI cost trend is elevated. Switch low-priority runs to cheaper models and lower token budgets.');
  }
  if (avgExecutionDurationMs > 120000) {
    aiRecommendations.push('Average execution duration is high. Consider splitting long workflows into resumable chunks.');
  }

  return NextResponse.json({
    success: true,
    periodDays: Math.max(1, Math.min(30, days)),
    executionAnalytics: {
      total: executionData.length,
      completed,
      failed,
      waiting,
      avgExecutionDurationMs,
    },
    queueAnalytics: {
      throughput: queueThroughput,
      failureHeatmap,
      providerLatencyMs,
    },
    aiUsage: {
      totalTokens,
      totalCostUsd,
    },
    retryInsights,
    recommendations: aiRecommendations,
  });
}
