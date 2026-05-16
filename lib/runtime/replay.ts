import { createServiceClient } from '@/lib/supabase-server';
import { createCorrelationId } from './events';
import { createTraceId } from './tracing';
import { enqueueRuntimeJob, runtimeQueueForTool, runtimeTaskTypeForTool } from './queue';

export async function replayExecution(params: {
  userId: string;
  executionId: string;
  reason?: string;
}): Promise<{ replayId: string | null; queued: boolean; queueJobId?: string; traceId?: string }> {
  const db = createServiceClient();
  const { data: execution } = await db
    .from('workflow_executions_v2')
    .select('id, workflow_id, user_id, input_data')
    .eq('id', params.executionId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!execution) {
    throw new Error('Execution not found');
  }

  const replayTraceId = createTraceId();
  const correlationId = createCorrelationId(params.executionId);

  const { data: replayRow } = await db
    .from('runtime_replays')
    .insert({
      user_id: params.userId,
      replay_type: 'execution',
      source_execution_id: params.executionId,
      original_trace_id: null,
      replay_trace_id: replayTraceId,
      correlation_id: correlationId,
      status: 'queued',
      result: { reason: params.reason ?? 'manual replay' },
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  const queued = await enqueueRuntimeJob({
    queueName: 'execution_queue',
    taskType: 'test_workflow',
    payload: {
      userId: params.userId,
      sessionId: `replay-${params.executionId}`,
      workflowId: String(execution.workflow_id),
      toolName: 'test_workflow',
      args: {
        workflow_id: String(execution.workflow_id),
        replay: true,
        source_execution_id: params.executionId,
      },
      correlationId,
      executionId: `replay-${params.executionId}`,
      traceId: replayTraceId,
    },
  });

  await db
    .from('runtime_replays')
    .update({
      status: queued.enqueued ? 'running' : 'failed',
      result: {
        queue_job_id: queued.queueJobId,
        queued: queued.enqueued,
        reason: queued.reason ?? null,
      },
      error_message: queued.enqueued ? null : queued.reason ?? 'Queueing failed',
    })
    .eq('id', replayRow?.id ?? '');

  return {
    replayId: replayRow?.id ?? null,
    queued: queued.enqueued,
    queueJobId: queued.queueJobId,
    traceId: replayTraceId,
  };
}

export async function replayFromStep(params: {
  userId: string;
  stepId: string;
  reason?: string;
}): Promise<{ replayId: string | null; queued: boolean; queueJobId?: string; traceId?: string }> {
  const db = createServiceClient();

  const { data: step } = await db
    .from('workflow_execution_steps')
    .select('id, execution_id, workflow_id, user_id, node_name, output_data')
    .eq('id', params.stepId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!step) {
    throw new Error('Step not found');
  }

  const replayTraceId = createTraceId();
  const correlationId = createCorrelationId(params.stepId);

  const { data: replayRow } = await db
    .from('runtime_replays')
    .insert({
      user_id: params.userId,
      replay_type: 'step',
      source_execution_id: String(step.execution_id),
      source_step_id: params.stepId,
      replay_trace_id: replayTraceId,
      correlation_id: correlationId,
      status: 'queued',
      result: { reason: params.reason ?? 'manual step replay' },
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  const queued = await enqueueRuntimeJob({
    queueName: 'execution_queue',
    taskType: 'test_workflow',
    payload: {
      userId: params.userId,
      sessionId: `replay-step-${params.stepId}`,
      workflowId: String(step.workflow_id),
      toolName: 'test_workflow',
      args: {
        workflow_id: String(step.workflow_id),
        replay: true,
        source_step_id: params.stepId,
        resume_from_node: step.node_name,
      },
      correlationId,
      executionId: `replay-step-${params.stepId}`,
      traceId: replayTraceId,
    },
  });

  await db
    .from('runtime_replays')
    .update({
      status: queued.enqueued ? 'running' : 'failed',
      result: {
        queue_job_id: queued.queueJobId,
        queued: queued.enqueued,
        reason: queued.reason ?? null,
      },
      error_message: queued.enqueued ? null : queued.reason ?? 'Queueing failed',
    })
    .eq('id', replayRow?.id ?? '');

  return {
    replayId: replayRow?.id ?? null,
    queued: queued.enqueued,
    queueJobId: queued.queueJobId,
    traceId: replayTraceId,
  };
}

export async function replayDeadLetterJob(params: {
  userId: string;
  dlqId: string;
  reason?: string;
}): Promise<{ replayId: string | null; queued: boolean; queueJobId?: string; traceId?: string }> {
  const db = createServiceClient();

  const { data: dlq } = await db
    .from('runtime_queue_dead_letters')
    .select('id, user_id, queue_name, task_type, payload, session_id, workflow_id, execution_id, correlation_id, trace_id')
    .eq('id', params.dlqId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!dlq) {
    throw new Error('DLQ item not found');
  }

  const toolName = String((dlq.payload as Record<string, unknown>)?.toolName ?? 'planner_followup');
  const replayTraceId = createTraceId();
  const correlationId = createCorrelationId(params.dlqId);

  const { data: replayRow } = await db
    .from('runtime_replays')
    .insert({
      user_id: params.userId,
      replay_type: 'dlq_job',
      source_dlq_id: params.dlqId,
      original_trace_id: dlq.trace_id ?? null,
      replay_trace_id: replayTraceId,
      correlation_id: correlationId,
      status: 'queued',
      result: { reason: params.reason ?? 'manual dlq replay' },
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  const payload = dlq.payload as Record<string, unknown>;
  const queued = await enqueueRuntimeJob({
    queueName: runtimeQueueForTool(toolName),
    taskType: runtimeTaskTypeForTool(toolName),
    payload: {
      userId: params.userId,
      sessionId: String(dlq.session_id ?? `dlq-${params.dlqId}`),
      workflowId: dlq.workflow_id ? String(dlq.workflow_id) : undefined,
      toolName,
      args: (payload.args as Record<string, unknown>) ?? payload,
      correlationId,
      executionId: String(dlq.execution_id ?? `dlq-${params.dlqId}`),
      traceId: replayTraceId,
    },
  });

  await db
    .from('runtime_queue_dead_letters')
    .update({
      replayed_at: queued.enqueued ? new Date().toISOString() : null,
      replay_status: queued.enqueued ? 'replayed' : 'failed',
    })
    .eq('id', params.dlqId)
    .eq('user_id', params.userId);

  await db
    .from('runtime_replays')
    .update({
      status: queued.enqueued ? 'running' : 'failed',
      result: {
        queue_job_id: queued.queueJobId,
        queued: queued.enqueued,
        reason: queued.reason ?? null,
      },
      error_message: queued.enqueued ? null : queued.reason ?? 'Queueing failed',
    })
    .eq('id', replayRow?.id ?? '');

  return {
    replayId: replayRow?.id ?? null,
    queued: queued.enqueued,
    queueJobId: queued.queueJobId,
    traceId: replayTraceId,
  };
}
