import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();
  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim() || undefined;
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), 500) : 100;

  let eventsQuery = db
    .from('runtime_events')
    .select('event_id, event_type, severity, timestamp, correlation_id, trace_id, span_id, parent_span_id, session_id, workflow_id, execution_id, payload')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  let queueQuery = db
    .from('runtime_queue_jobs')
    .select('job_id, queue_name, task_type, status, attempts, max_attempts, correlation_id, trace_id, span_id, parent_span_id, session_id, workflow_id, execution_id, queued_at, started_at, completed_at, error_message')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  let tracesQuery = db
    .from('runtime_traces')
    .select('trace_id, correlation_id, session_id, workflow_id, execution_id, root_agent, status, started_at, completed_at, metadata')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  let spansQuery = db
    .from('runtime_spans')
    .select('span_id, trace_id, parent_span_id, name, kind, agent_id, queue_name, job_id, status, started_at, ended_at, duration_ms, error_message, attributes, execution_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  let replaysQuery = db
    .from('runtime_replays')
    .select('id, replay_type, source_execution_id, source_step_id, source_queue_job_id, source_dlq_id, original_trace_id, replay_trace_id, correlation_id, status, result, error_message, requested_at, completed_at')
    .eq('user_id', userId)
    .order('requested_at', { ascending: false })
    .limit(limit);

  let dlqQuery = db
    .from('runtime_queue_dead_letters')
    .select('id, queue_name, task_type, job_id, trace_id, span_id, correlation_id, session_id, workflow_id, execution_id, payload, error_message, failed_at, replayed_at, replay_status')
    .eq('user_id', userId)
    .order('failed_at', { ascending: false })
    .limit(limit);

  if (sessionId) {
    eventsQuery = eventsQuery.eq('session_id', sessionId);
    queueQuery = queueQuery.eq('session_id', sessionId);
    tracesQuery = tracesQuery.eq('session_id', sessionId);
    spansQuery = spansQuery.eq('session_id', sessionId);
    dlqQuery = dlqQuery.eq('session_id', sessionId);
  }

  const [eventsRes, queueRes, tracesRes, spansRes, workersRes, replaysRes, dlqRes] = await Promise.all([
    eventsQuery,
    queueQuery,
    tracesQuery,
    spansQuery,
    db
      .from('runtime_workers')
      .select('worker_id, status, hostname, pid, queues, capabilities, concurrency, heartbeat_at, last_error, cpu_load, memory_mb, jobs_processed, updated_at')
      .order('heartbeat_at', { ascending: false })
      .limit(100),
    replaysQuery,
    dlqQuery,
  ]);

  const errors = [
    eventsRes.error,
    queueRes.error,
    tracesRes.error,
    spansRes.error,
    workersRes.error,
    replaysRes.error,
    dlqRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    const message = errors.map((e) => String(e?.message ?? 'Unknown query error')).join('; ');
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const queueRows = queueRes.data ?? [];
  const eventRows = eventsRes.data ?? [];
  const traceRows = tracesRes.data ?? [];
  const spanRows = spansRes.data ?? [];
  const replayRows = replaysRes.data ?? [];
  const dlqRows = dlqRes.data ?? [];

  const queueByStatus = queueRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const traceByStatus = traceRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const replayByStatus = replayRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    success: true,
    summary: {
      events: eventRows.length,
      queues: queueRows.length,
      traces: traceRows.length,
      spans: spanRows.length,
      workers: (workersRes.data ?? []).length,
      replays: replayRows.length,
      deadLetters: dlqRows.length,
      queueByStatus,
      traceByStatus,
      replayByStatus,
    },
    events: eventRows,
    queues: queueRows,
    traces: traceRows,
    spans: spanRows,
    workers: workersRes.data ?? [],
    replays: replayRows,
    deadLetters: dlqRows,
  });
}
