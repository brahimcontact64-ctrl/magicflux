import 'server-only';

import { randomUUID } from 'crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { createCorrelationId } from '@/lib/runtime/events';
import { enqueueRuntimeJob } from '@/lib/runtime/queue';
import { reserveIdempotencyKey, releaseIdempotencyKey } from '@/lib/runtime/idempotency';
import { reserveConcurrencySlot, releaseConcurrencySlot } from '@/lib/runtime/concurrency-guard';
import { recordUsageEvent } from '@/lib/runtime/usage-metering';

/**
 * Async production-execution dispatch: the replacement for "the webhook
 * route calls runWorkflowExecution() and blocks the HTTP response on the
 * whole workflow run."
 *
 * Flow (each step only runs if the previous one succeeded; every failure
 * path unwinds anything already reserved so nothing is left half-done):
 *   1. Atomically reserve the idempotency key. A duplicate returns the
 *      existing execution immediately — nothing else in this function runs.
 *   2. Atomically reserve a concurrency slot (per-user, per-workflow).
 *   3. Insert the workflow_executions_v2 row as status='queued', pinned to
 *      the caller-supplied (already-frozen) deploymentVersionId.
 *   4. Enqueue the job onto the existing execution_queue (BullMQ) — no new
 *      queue implementation. The job payload carries only IDs, never the
 *      workflow JSON or credentials; the worker re-resolves the frozen
 *      snapshot itself (see lib/runtime/worker.ts's 'run_workflow_execution'
 *      branch), so a tampered/stale queue payload cannot change what runs.
 *   5. On enqueue failure, release the concurrency slot and mark the
 *      execution row 'failed' with a sanitized message — it can never be
 *      left permanently 'queued' or 'running' because of an infra failure
 *      at this step.
 */

export type DispatchExecutionParams = {
  userId: string;
  workflowId: string;
  deploymentVersionId: string | null;
  inputData: Record<string, unknown>;
  idempotencyKey: string;
  maxRetries?: number;
  maxPerUser?: number;
  maxPerWorkflow?: number;
};

export type DispatchExecutionResult =
  | { ok: true; duplicate: false; executionId: string; status: 'queued' }
  | { ok: true; duplicate: true; executionId: string; status: string }
  | { ok: false; code: 'USER_CONCURRENCY_LIMIT' | 'WORKFLOW_CONCURRENCY_LIMIT'; message: string }
  | { ok: false; code: 'ENQUEUE_FAILED'; message: string };

export async function dispatchProductionExecution(params: DispatchExecutionParams): Promise<DispatchExecutionResult> {
  const db = createServiceClient();
  const executionId = randomUUID();

  // 1. Idempotency — atomic, DB-unique-constraint-backed.
  const idempotency = await reserveIdempotencyKey({
    executionId,
    userId: params.userId,
    workflowId: params.workflowId,
    idempotencyKey: params.idempotencyKey,
  });

  if (idempotency.isDuplicate) {
    if (idempotency.existing) {
      return { ok: true, duplicate: true, executionId: idempotency.existing.executionId, status: idempotency.existing.status };
    }
    // Winning row existed for idempotency purposes but its execution could not
    // be resolved (e.g. cross-user lookup denied, or the row was since
    // deleted) — fail safe rather than silently re-running.
    return { ok: false, code: 'ENQUEUE_FAILED', message: 'Duplicate trigger detected but the original execution could not be located.' };
  }

  // 2. Concurrency — atomic reservation via Postgres advisory-lock RPC.
  const reservation = await reserveConcurrencySlot({
    executionId,
    userId: params.userId,
    workflowId: params.workflowId,
    maxPerUser: params.maxPerUser,
    maxPerWorkflow: params.maxPerWorkflow,
  });

  if (!reservation.reserved) {
    // No execution row was ever created for this executionId — the
    // idempotency lock reserved in step 1 must be released, or this event
    // could never be legitimately retried once concurrency frees up.
    await releaseIdempotencyKey({ executionId, userId: params.userId });
    return { ok: false, code: reservation.code, message: reservation.reason };
  }

  // 3. Create the execution row up front, in 'queued' state, pinned to the
  //    frozen version — this is the row the fast 202 response's executionId
  //    points at, and what the worker will flip to 'running' when it claims the job.
  const { error: insertError } = await db.from('workflow_executions_v2').insert({
    id: executionId,
    workflow_id: params.workflowId,
    user_id: params.userId,
    status: 'queued',
    mode: 'live',
    input_data: params.inputData,
    retry_count: 0,
    max_retries: params.maxRetries ?? 3,
    deployment_version_id: params.deploymentVersionId,
  });

  if (insertError) {
    await releaseConcurrencySlot({ executionId });
    await releaseIdempotencyKey({ executionId, userId: params.userId });
    return { ok: false, code: 'ENQUEUE_FAILED', message: 'Failed to create execution record.' };
  }

  await recordUsageEvent({
    userId: params.userId,
    workflowId: params.workflowId,
    executionId,
    eventType: 'execution_started',
    idempotencyKey: `${executionId}:execution_started`,
  }).catch(() => undefined);

  // 4. Enqueue onto the existing execution_queue — no second queue.
  const correlationId = createCorrelationId(executionId);
  const enqueueResult = await enqueueRuntimeJob({
    queueName: 'execution_queue',
    taskType: 'run_workflow_execution',
    dedupeKey: params.idempotencyKey,
    payload: {
      userId: params.userId,
      sessionId: executionId,
      workflowId: params.workflowId,
      toolName: 'run_workflow_execution',
      executionId,
      correlationId,
      args: {
        deploymentVersionId: params.deploymentVersionId,
        inputData: params.inputData,
        mode: 'live',
      },
    },
  }).catch((err: unknown) => ({ enqueued: false as const, queueJobId: '', reason: err instanceof Error ? err.message : String(err) }));

  if (!enqueueResult.enqueued) {
    // 5. Never leave a false "running"/"queued" execution behind an infra failure.
    await releaseConcurrencySlot({ executionId });
    await db
      .from('workflow_executions_v2')
      .update({
        status: 'failed',
        error_message: 'Execution queue unavailable. Please retry.',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', executionId)
      .eq('user_id', params.userId);

    return { ok: false, code: 'ENQUEUE_FAILED', message: 'Execution queue unavailable. Please retry.' };
  }

  return { ok: true, duplicate: false, executionId, status: 'queued' };
}
