import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { emitRuntimeEvent } from './events';
import { canUseRuntimeRedis, getRedisConnection } from './redis';
import { logger } from './logger';

/**
 * BullMQ rejects any custom job ID containing ':' unless it has exactly 3
 * colon-separated segments (reserved for its own repeatable-job bookkeeping
 * format `repeat:jobId:timestamp`) — see job.js's validateOptions(). Our
 * dedupe keys (e.g. `webhook:{workflowId}:hash:{bodyHash}`) always have more
 * segments than that and would make queue.add() throw for every real
 * webhook-triggered execution. Hash the dedupe key into a colon-free,
 * deterministic BullMQ job ID instead — same dedupeKey still always maps to
 * the same jobId, preserving BullMQ's own duplicate-add semantics — while the
 * original human-readable dedupeKey is still stored verbatim in the
 * runtime_queue_jobs.dedupe_key column for auditability.
 */
function bullmqSafeJobId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex');
}

export type RuntimeQueueName =
  | 'planner_queue'
  | 'deploy_queue'
  | 'execution_queue'
  | 'retry_queue'
  | 'monitoring_queue'
  | 'recovery_queue'
  | 'notification_queue'
  | 'ai_task_queue';

export type RuntimeQueueTaskType =
  | 'deploy_workflow'
  | 'activate_workflow'
  | 'test_workflow'
  | 'get_workflow_status'
  | 'get_execution_logs'
  | 'retry_action'
  | 'recovery_action'
  | 'planner_followup'
  | 'ai_reasoning'
  | 'run_workflow_execution'
  | 'resume_workflow_execution';

export const RUNTIME_QUEUE_NAMES: RuntimeQueueName[] = [
  'planner_queue',
  'deploy_queue',
  'execution_queue',
  'retry_queue',
  'monitoring_queue',
  'recovery_queue',
  'notification_queue',
  'ai_task_queue',
];

export type RuntimeQueuePayload = {
  userId: string | null;
  sessionId: string;
  workflowId?: string;
  toolName: string;
  policyMode?: 'safe' | 'staging' | 'production';
  args: Record<string, unknown>;
  correlationId: string;
  executionId: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
};

type QueueHandle = {
  queue: RuntimeQueue;
  events: RuntimeQueueEvents;
};

type RuntimeQueue = {
  add: (
    name: string,
    data: RuntimeQueuePayload,
    options: {
      attempts: number;
      backoff: {
        type: 'exponential';
        delay: number;
      };
      removeOnComplete: number;
      removeOnFail: number;
      delay: number;
      priority: number | undefined;
      jobId: string | undefined;
    }
  ) => Promise<{ id: string | number | undefined }>;
  on: (event: 'error', handler: (error: Error) => void) => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
};

type RuntimeQueueEvents = {
  on: (event: 'error', handler: (error: Error) => void) => void;
};

const queueHandles = new Map<RuntimeQueueName, QueueHandle>();

function isQueueEnabled(): boolean {
  return canUseRuntimeRedis();
}

export function runtimeQueueConfigured(): boolean {
  return isQueueEnabled();
}

export async function getRedisStatus(): Promise<'connected' | 'missing' | 'error'> {
  const conn = await getRedisConnection({ key: 'runtime-status' });
  if (!conn) return 'missing';

  try {
    await conn.ping();
    return 'connected';
  } catch {
    return 'error';
  }
}

async function getQueueHandle(queueName: RuntimeQueueName): Promise<QueueHandle> {
  const existing = queueHandles.get(queueName);
  if (existing) return existing;

  if (typeof window !== 'undefined') {
    throw new Error('Queue subsystem is server-only.');
  }

  const queueConnection = await getRedisConnection({ key: `runtime-queue:${queueName}:queue` });
  const eventsConnection = await getRedisConnection({ key: `runtime-queue:${queueName}:events` });
  if (!queueConnection || !eventsConnection) {
    throw new Error('REDIS_URL is not configured. Queue subsystem is disabled.');
  }

  const bullmq = await import("bullmq");
  const BullQueue = bullmq.Queue as new (
    queueName: string,
    options: { connection: unknown }
  ) => RuntimeQueue;
  const BullQueueEvents = bullmq.QueueEvents as new (
    queueName: string,
    options: { connection: unknown }
  ) => RuntimeQueueEvents;
  const queue = new BullQueue(queueName, { connection: queueConnection });
  const events = new BullQueueEvents(queueName, { connection: eventsConnection });

  // Prevent noisy unhandled error events during transient redis disconnects.
  queue.on('error', (error: Error) => {
    const message = error.message ?? String(error);
    const isTransient = message.includes('ECONNRESET') || message.includes('ECONNABORTED') || message.includes('ECONNREFUSED');
    logger[isTransient ? 'warn' : 'error']('queue_error', { queue: queueName, error: message });
  });

  events.on('error', (error: Error) => {
    const message = error.message ?? String(error);
    const isTransient = message.includes('ECONNRESET') || message.includes('ECONNABORTED') || message.includes('ECONNREFUSED');
    logger[isTransient ? 'warn' : 'error']('queue_events_error', { queue: queueName, error: message });
  });

  const handle = { queue, events };
  queueHandles.set(queueName, handle);
  return handle;
}

export async function enqueueRuntimeJob(params: {
  queueName: RuntimeQueueName;
  taskType: RuntimeQueueTaskType;
  payload: RuntimeQueuePayload;
  attempts?: number;
  delayMs?: number;
  priority?: number;
  dedupeKey?: string;
}): Promise<{ enqueued: boolean; queueJobId: string; reason?: string }> {
  const queueEnabled = isQueueEnabled();
  const queueJobId = `${params.queueName}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  if (!queueEnabled) {
    await emitRuntimeEvent({
      eventType: 'execution.failed',
      userId: params.payload.userId,
      sessionId: params.payload.sessionId,
      workflowId: params.payload.workflowId,
      agentId: 'runtime',
      executionId: params.payload.executionId,
      correlationId: params.payload.correlationId,
      severity: 'warning',
      payload: {
        reason: 'Queue subsystem disabled (REDIS_URL missing)',
        queue: params.queueName,
        taskType: params.taskType,
      },
    });

    return {
      enqueued: false,
      queueJobId,
      reason: 'Queue subsystem disabled (REDIS_URL missing)',
    };
  }

  const db = createServiceClient();
  const { queue } = await getQueueHandle(params.queueName);

  const job = await queue.add(params.taskType, params.payload, {
    attempts: params.attempts ?? 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 500,
    removeOnFail: 1000,
    delay: params.delayMs ?? 0,
    priority: params.priority,
    jobId: params.dedupeKey ? bullmqSafeJobId(params.dedupeKey) : undefined,
  });

  const persistedJobId = String(job.id ?? queueJobId);

  if (params.payload.userId) {
    await db.from('runtime_queue_jobs').insert({
      user_id: params.payload.userId,
      session_id: params.payload.sessionId,
      workflow_id: params.payload.workflowId ?? null,
      queue_name: params.queueName,
      job_id: persistedJobId,
      task_type: params.taskType,
      status: 'queued',
      attempts: 0,
      max_attempts: params.attempts ?? 3,
      delay_ms: params.delayMs ?? 0,
      priority: params.priority ?? null,
      correlation_id: params.payload.correlationId,
      dedupe_key: params.dedupeKey ?? null,
      payload: params.payload.args,
      trace_id: params.payload.traceId ?? null,
      span_id: params.payload.spanId ?? null,
      parent_span_id: params.payload.parentSpanId ?? null,
      queued_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  await emitRuntimeEvent({
    eventType: 'execution.started',
    userId: params.payload.userId,
    sessionId: params.payload.sessionId,
    workflowId: params.payload.workflowId,
    executionId: params.payload.executionId,
    correlationId: params.payload.correlationId,
    agentId: 'runtime',
    payload: {
      queue: params.queueName,
      taskType: params.taskType,
      queueJobId: persistedJobId,
    },
    severity: 'info',
  });

  return {
    enqueued: true,
    queueJobId: persistedJobId,
  };
}

export function runtimeQueueForTool(toolName: string): RuntimeQueueName {
  if (toolName === 'generate_workflow_json' || toolName === 'request_credential') return 'planner_queue';
  if (toolName === 'deploy_workflow_to_n8n' || toolName === 'activate_workflow') return 'deploy_queue';
  if (toolName === 'test_workflow') return 'execution_queue';
  if (toolName === 'get_workflow_status' || toolName === 'get_execution_logs') return 'monitoring_queue';
  if (toolName.includes('ai_') || toolName.includes('reason')) return 'ai_task_queue';
  return 'planner_queue';
}

export function runtimeTaskTypeForTool(toolName: string): RuntimeQueueTaskType {
  if (toolName === 'deploy_workflow_to_n8n') return 'deploy_workflow';
  if (toolName === 'activate_workflow') return 'activate_workflow';
  if (toolName === 'test_workflow') return 'test_workflow';
  if (toolName === 'get_workflow_status') return 'get_workflow_status';
  if (toolName === 'get_execution_logs') return 'get_execution_logs';
  if (toolName.includes('ai_') || toolName.includes('reason')) return 'ai_reasoning';
  return 'planner_followup';
}

export async function pauseRuntimeQueue(queueName: RuntimeQueueName): Promise<void> {
  if (!isQueueEnabled()) return;
  const { queue } = await getQueueHandle(queueName);
  await queue.pause();
}

export async function resumeRuntimeQueue(queueName: RuntimeQueueName): Promise<void> {
  if (!isQueueEnabled()) return;
  const { queue } = await getQueueHandle(queueName);
  await queue.resume();
}
