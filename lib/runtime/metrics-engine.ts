import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { computeRuntimeMetrics } from '@/lib/runtime/metrics';

export type MetricWindow = '5m' | '15m' | '1h' | '24h' | '7d' | '30d';

export type MetricPoint = {
  recorded_at: string;
  metric_value: number;
  labels: Record<string, unknown>;
};

export type MetricSeries = {
  metric_name: string;
  window: MetricWindow;
  points: MetricPoint[];
};

export type MetricSnapshot = {
  cpu_load: number;
  memory_mb: number | null;
  queue_depth: number;
  queue_throughput: number;
  command_latency_ms: number;
  execution_latency_ms: number;
  worker_utilization: number;
  error_rate: number;
  incident_rate: number;
  recorded_at: string;
};

export async function recordMetric(params: {
  metricName: string;
  value: number;
  labels?: Record<string, unknown>;
  window?: MetricWindow;
}): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_metrics').insert({
    metric_name:  params.metricName,
    metric_value: params.value,
    labels:       params.labels ?? {},
    window:       params.window ?? '5m',
    recorded_at:  new Date().toISOString(),
  });
}

export async function recordRuntimeMetricsSnapshot(): Promise<MetricSnapshot> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();

  const [baseMetrics, workersRes, pendingCommandsRes, activeIncidentsRes] = await Promise.all([
    computeRuntimeMetrics({ windowMinutes: 5 }),
    db
      .from('runtime_workers')
      .select('memory_mb, cpu_load, concurrency, status')
      .gte('heartbeat_at', staleWorkerCutoff)
      .limit(200),
    db
      .from('runtime_execution_commands')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    db
      .from('runtime_incidents')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'investigating']),
  ]);

  const workers = workersRes.data ?? [];
  const avgCpuLoad = workers.length > 0
    ? workers.reduce((s, w) => s + Number(w.cpu_load ?? 0), 0) / workers.length
    : baseMetrics.worker_load;
  const avgMemory = workers.length > 0
    ? workers.reduce((s, w) => s + Number(w.memory_mb ?? 0), 0) / workers.length
    : null;

  const snapshot: MetricSnapshot = {
    cpu_load:             Math.round(avgCpuLoad * 10) / 10,
    memory_mb:            avgMemory !== null ? Math.round(avgMemory) : null,
    queue_depth:          Number(pendingCommandsRes.count ?? 0),
    queue_throughput:     baseMetrics.queue_latency > 0
      ? Math.round(60000 / baseMetrics.queue_latency)
      : 0,
    command_latency_ms:   baseMetrics.queue_latency,
    execution_latency_ms: 0,
    worker_utilization:   baseMetrics.worker_load,
    error_rate:           baseMetrics.failure_rate,
    incident_rate:        Number(activeIncidentsRes.count ?? 0),
    recorded_at:          now,
  };

  // Persist all dimensions as individual rows for time-series queries.
  const rows = [
    { metric_name: 'cpu_load',            metric_value: snapshot.cpu_load },
    { metric_name: 'queue_depth',         metric_value: snapshot.queue_depth },
    { metric_name: 'queue_throughput',    metric_value: snapshot.queue_throughput },
    { metric_name: 'command_latency_ms',  metric_value: snapshot.command_latency_ms },
    { metric_name: 'worker_utilization',  metric_value: snapshot.worker_utilization },
    { metric_name: 'error_rate',          metric_value: snapshot.error_rate },
    { metric_name: 'incident_rate',       metric_value: snapshot.incident_rate },
    ...(snapshot.memory_mb !== null
      ? [{ metric_name: 'memory_mb', metric_value: snapshot.memory_mb }]
      : []),
  ].map(r => ({
    ...r,
    labels:      {},
    window:      '5m',
    recorded_at: now,
  }));

  await db.from('runtime_metrics').insert(rows);

  return snapshot;
}

export async function queryMetricSeries(params: {
  metricName: string;
  window?: MetricWindow;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<MetricSeries> {
  const db = createServiceClient();
  const limit = Math.min(params.limit ?? 500, 2000);
  const window = params.window ?? '5m';

  const windowMs: Record<MetricWindow, number> = {
    '5m':  5   * 60_000,
    '15m': 15  * 60_000,
    '1h':  60  * 60_000,
    '24h': 24  * 60 * 60_000,
    '7d':  7   * 24 * 60 * 60_000,
    '30d': 30  * 24 * 60 * 60_000,
  };

  const from = params.from ?? new Date(Date.now() - windowMs[window]).toISOString();
  const to   = params.to   ?? new Date().toISOString();

  const { data } = await db
    .from('runtime_metrics')
    .select('recorded_at, metric_value, labels')
    .eq('metric_name', params.metricName)
    .gte('recorded_at', from)
    .lte('recorded_at', to)
    .order('recorded_at', { ascending: true })
    .limit(limit);
  const points = (data ?? []).map(r => ({
    recorded_at:  r.recorded_at as string,
    metric_value: Number(r.metric_value),
    labels:       (r.labels ?? {}) as Record<string, unknown>,
  }));

  return { metric_name: params.metricName, window, points };
}

export async function listAvailableMetrics(): Promise<string[]> {
  const db = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  const { data } = await db
    .from('runtime_metrics')
    .select('metric_name')
    .gte('recorded_at', since)
    .limit(500);

  const names = [...new Set((data ?? []).map(r => String(r.metric_name)))];
  return names.sort();
}
