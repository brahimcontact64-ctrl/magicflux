import { randomUUID } from 'crypto';

import { createServiceClient } from '@/lib/supabase-server';

export type RuntimeEventType =
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.deleted'
  | 'workflow.deployed'
  | 'workflow.activated'
  | 'workflow.failed'
  | 'workflow.mutated'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.rejected'
  | 'retry.started'
  | 'retry.completed'
  | 'retry.failed'
  | 'execution.started'
  | 'execution.paused'
  | 'execution.cancelled'
  | 'execution.checkpointed'
  | 'execution.completed'
  | 'execution.failed'
  | 'deployment.started'
  | 'deployment.completed'
  | 'deployment.failed'
  | 'deployment.rolled_back'
  | 'integration.connected'
  | 'integration.failed'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'budget.warning'
  | 'budget.exceeded'
  | 'ai.request.started'
  | 'ai.request.completed'
  | 'ai.request.failed';

export type RuntimeEventSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export type RuntimeEvent = {
  event_id: string;
  event_type: RuntimeEventType;
  timestamp: string;
  user_id: string | null;
  workflow_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  execution_id: string | null;
  payload: Record<string, unknown>;
  severity: RuntimeEventSeverity;
  correlation_id: string;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
};

export type EmitRuntimeEventInput = {
  eventType: RuntimeEventType;
  userId: string | null;
  workflowId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  executionId?: string | null;
  payload?: Record<string, unknown>;
  severity?: RuntimeEventSeverity;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
};

type RuntimeEventSubscriber = {
  id: string;
  fn: (event: RuntimeEvent) => Promise<void> | void;
};

const subscribers: RuntimeEventSubscriber[] = [];

export function createCorrelationId(seed?: string): string {
  const base = seed?.trim() || randomUUID();
  return `corr-${base.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}-${Date.now()}`;
}

export function subscribeRuntimeEvents(fn: (event: RuntimeEvent) => Promise<void> | void): () => void {
  const id = randomUUID();
  subscribers.push({ id, fn });
  return () => {
    const idx = subscribers.findIndex((s) => s.id === id);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}

async function persistRuntimeEvent(event: RuntimeEvent): Promise<void> {
  if (!event.user_id) return;

  const db = createServiceClient();
  await db.from('runtime_events').insert({
    event_id: event.event_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    user_id: event.user_id,
    workflow_id: event.workflow_id,
    session_id: event.session_id,
    agent_id: event.agent_id,
    execution_id: event.execution_id,
    payload: event.payload,
    severity: event.severity,
    correlation_id: event.correlation_id,
    trace_id: event.trace_id ?? null,
    span_id: event.span_id ?? null,
    parent_span_id: event.parent_span_id ?? null,
    source: 'runtime_bus',
    created_at: event.timestamp,
  });
}

async function writeDeadLetter(event: RuntimeEvent, reason: string, retryCount = 0): Promise<void> {
  if (!event.user_id) return;
  const db = createServiceClient();
  await db.from('runtime_event_dead_letters').insert({
    event_id: event.event_id,
    event_type: event.event_type,
    correlation_id: event.correlation_id,
    reason,
    payload: event.payload,
    retry_count: retryCount,
    created_at: new Date().toISOString(),
  });
}

export async function emitRuntimeEvent(input: EmitRuntimeEventInput): Promise<RuntimeEvent> {
  const event: RuntimeEvent = {
    event_id: randomUUID(),
    event_type: input.eventType,
    timestamp: new Date().toISOString(),
    user_id: input.userId,
    workflow_id: input.workflowId ?? null,
    session_id: input.sessionId ?? null,
    agent_id: input.agentId ?? null,
    execution_id: input.executionId ?? null,
    payload: input.payload ?? {},
    severity: input.severity ?? 'info',
    correlation_id: input.correlationId ?? createCorrelationId(input.sessionId ?? undefined),
    trace_id: input.traceId ?? null,
    span_id: input.spanId ?? null,
    parent_span_id: input.parentSpanId ?? null,
  };

  await persistRuntimeEvent(event);

  for (const subscriber of subscribers) {
    try {
      await subscriber.fn(event);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeDeadLetter(event, reason, 0);
    }
  }

  return event;
}

export async function replayRuntimeEvents(params: {
  userId: string;
  sessionId?: string;
  correlationId?: string;
  limit?: number;
}): Promise<RuntimeEvent[]> {
  const db = createServiceClient();
  let query = db
    .from('runtime_events')
    .select('event_id, event_type, timestamp, user_id, workflow_id, session_id, agent_id, execution_id, payload, severity, correlation_id, trace_id, span_id, parent_span_id')
    .eq('user_id', params.userId)
    .order('created_at', { ascending: true })
    .limit(params.limit ?? 500);

  if (params.sessionId) query = query.eq('session_id', params.sessionId);
  if (params.correlationId) query = query.eq('correlation_id', params.correlationId);

  const { data } = await query;
  return (data ?? []) as RuntimeEvent[];
}
