import { randomUUID } from 'crypto';

import { createServiceClient } from '@/lib/supabase-server';

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  correlationId: string;
};

export function createTraceId(): string {
  return `trace-${randomUUID()}`;
}

export function createSpanId(): string {
  return `span-${randomUUID()}`;
}

export async function startTrace(params: {
  userId: string | null;
  sessionId?: string;
  workflowId?: string;
  executionId?: string;
  correlationId: string;
  rootAgent?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}): Promise<string> {
  const traceId = params.traceId ?? createTraceId();
  if (!params.userId) return traceId;

  const db = createServiceClient();
  await db.from('runtime_traces').upsert({
    trace_id: traceId,
    user_id: params.userId,
    session_id: params.sessionId ?? null,
    workflow_id: params.workflowId ?? null,
    execution_id: params.executionId ?? null,
    correlation_id: params.correlationId,
    root_agent: params.rootAgent ?? null,
    status: 'running',
    metadata: params.metadata ?? {},
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return traceId;
}

export async function finishTrace(params: {
  userId: string | null;
  traceId: string;
  status: 'completed' | 'failed' | 'cancelled';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  await db
    .from('runtime_traces')
    .update({
      status: params.status,
      metadata: params.metadata ?? {},
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('trace_id', params.traceId)
    .eq('user_id', params.userId);
}

export async function startSpan(params: {
  userId: string | null;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  agentId?: string;
  queueName?: string;
  jobId?: string;
  sessionId?: string;
  workflowId?: string;
  executionId?: string;
  attributes?: Record<string, unknown>;
  spanId?: string;
}): Promise<string> {
  const spanId = params.spanId ?? createSpanId();
  if (!params.userId) return spanId;

  const db = createServiceClient();
  await db.from('runtime_spans').insert({
    span_id: spanId,
    trace_id: params.traceId,
    parent_span_id: params.parentSpanId ?? null,
    name: params.name,
    kind: params.kind,
    agent_id: params.agentId ?? null,
    queue_name: params.queueName ?? null,
    job_id: params.jobId ?? null,
    user_id: params.userId,
    session_id: params.sessionId ?? null,
    workflow_id: params.workflowId ?? null,
    execution_id: params.executionId ?? null,
    status: 'running',
    attributes: params.attributes ?? {},
    started_at: new Date().toISOString(),
  });

  return spanId;
}

export async function endSpan(params: {
  userId: string | null;
  spanId: string;
  status: 'success' | 'error' | 'cancelled';
  errorMessage?: string;
  attributes?: Record<string, unknown>;
}): Promise<void> {
  if (!params.userId) return;
  const endedAt = new Date();

  const db = createServiceClient();
  const { data: existing } = await db
    .from('runtime_spans')
    .select('started_at')
    .eq('span_id', params.spanId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  const durationMs = existing?.started_at
    ? Math.max(0, endedAt.getTime() - new Date(existing.started_at).getTime())
    : null;

  await db
    .from('runtime_spans')
    .update({
      status: params.status,
      error_message: params.errorMessage ?? null,
      attributes: params.attributes ?? {},
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
    })
    .eq('span_id', params.spanId)
    .eq('user_id', params.userId);
}
