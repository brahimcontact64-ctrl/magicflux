import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { createCorrelationId } from './events';
import { enqueueRuntimeJob } from './queue';
import { reserveConcurrencySlot, releaseConcurrencySlot } from './concurrency-guard';

/**
 * Phase 8.8 — the missing consumer for workflow_executions_v2 rows parked
 * in status='waiting' with a next_run_at (either an execution-level retry
 * scheduled by runtime/workflow-engine.ts after a node exhausts its own
 * retries, or a Wait node's intentional pause — see lib/workflow-runtime/
 * node-handlers/wait.ts). Before this module, nothing anywhere queried for
 * due waiting executions; such a row could sit stuck indefinitely.
 *
 * Design, and why it looks the way it does:
 *   - Claim via the SAME optimistic-CAS UPDATE...WHERE pattern already
 *     proven by lib/runtime/scheduler.ts's pollDueSchedules() (Phase 8.6
 *     certified this exact pattern against real concurrent pollers) —
 *     no new atomicity mechanism invented. The WHERE clause matches only if
 *     the row is still 'waiting' with the exact next_run_at just read; a
 *     concurrent claimant loses the race and sees zero rows.
 *   - Claims INTO status='running' rather than a new intermediate status —
 *     this is not a new state machine value, and it means a dispatcher
 *     crash between claim and enqueue is already covered by the EXISTING
 *     self-heal safety net (markOrphanExecutionsFailed treats stale
 *     'running' rows as orphaned after 10 minutes), not a new one.
 *   - Reserves a concurrency slot (reuses reserveConcurrencySlot() —
 *     Phase 8.8 also fixed a bug where re-reserving a previously-released
 *     execution_id silently no-opped, see migration
 *     20260611000001_phase8_8_concurrency_reservation_reclaim.sql) BEFORE
 *     enqueueing, mirroring dispatchProductionExecution()'s own pattern —
 *     never invents a parallel counter. If the user/workflow is at their
 *     limit, the claim is reverted back to 'waiting' with the same
 *     next_run_at so a later tick retries once a slot frees up — this is
 *     concurrency pressure, not a failure.
 *   - Dispatches through the EXISTING production queue/worker
 *     (lib/runtime/queue.ts's enqueueRuntimeJob, task type
 *     'resume_workflow_execution' handled in lib/runtime/worker.ts) —
 *     never calls the execution engine inline, never creates a duplicate
 *     execution row, never re-derives workflow_json itself (the worker
 *     re-resolves it from deployment_version_id, exactly like every other
 *     queue-driven execution path already does).
 *   - The dedupe key is `resume:{executionId}:{retryCount}` — deterministic
 *     per execution *and* per retry attempt, so a duplicate cron
 *     invocation within the same attempt cannot enqueue a second job, while
 *     a later retry attempt (higher retryCount, only reachable after this
 *     one settles) still gets its own job.
 */

const DEFAULT_BATCH_SIZE = Number(process.env.RUNTIME_RETRY_DISPATCH_BATCH_SIZE ?? 50);

// ioredis is configured with maxRetriesPerRequest: null (see
// lib/runtime/redis.ts) so that transient outages retry rather than fail a
// single command outright — but that means a genuine Redis outage makes
// enqueueRuntimeJob() HANG rather than reject (confirmed live in Phase 8.6's
// BullMQ certification). A bare `.catch()` only handles rejection; without a
// bound, a hung enqueue call would leave this execution claimed
// (status='running') with the cron request itself stuck, which is exactly
// the "permanently claimed but unqueued" outcome this module exists to
// prevent. Race every enqueue attempt against this timeout so a Redis
// outage always resolves to an explicit, handled failure.
const ENQUEUE_TIMEOUT_MS = Number(process.env.RUNTIME_RETRY_DISPATCH_ENQUEUE_TIMEOUT_MS ?? 10_000);

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type RetryDispatchResult = {
  scanned: number;
  claimed: number;
  enqueued: number;
  skipped: number;
  failed: number;
};

type DueExecutionRow = {
  id: string;
  workflow_id: string;
  user_id: string;
  deployment_version_id: string | null;
  retry_count: number;
  max_retries: number;
  input_data: Record<string, unknown> | null;
  mode: 'test' | 'live';
  next_run_at: string | null;
};

export async function dispatchDueRetries(params?: { batchSize?: number; now?: Date }): Promise<RetryDispatchResult> {
  const db = createServiceClient();
  const batchSize = params?.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = params?.now ?? new Date();
  const nowIso = now.toISOString();

  const result: RetryDispatchResult = { scanned: 0, claimed: 0, enqueued: 0, skipped: 0, failed: 0 };

  const { data: candidates } = await db
    .from('workflow_executions_v2')
    .select('id, workflow_id, user_id, deployment_version_id, retry_count, max_retries, input_data, mode, next_run_at')
    .eq('status', 'waiting')
    .lte('next_run_at', nowIso)
    .limit(batchSize);

  const rows = (candidates ?? []) as DueExecutionRow[];
  result.scanned = rows.length;

  for (const row of rows) {
    const { data: claimed } = await db
      .from('workflow_executions_v2')
      .update({ status: 'running', updated_at: nowIso })
      .eq('id', row.id)
      .eq('status', 'waiting')
      .eq('next_run_at', row.next_run_at as string)
      .select('id')
      .maybeSingle();

    if (!claimed) {
      // Another poller (or a manual resume, or a fresh update to
      // next_run_at) already moved this row on — safe to skip.
      result.skipped += 1;
      continue;
    }

    result.claimed += 1;
    const executionId = row.id;

    const reservation = await reserveConcurrencySlot({
      executionId,
      userId: row.user_id,
      workflowId: row.workflow_id,
    });

    if (!reservation.reserved) {
      await db
        .from('workflow_executions_v2')
        .update({ status: 'waiting', updated_at: new Date().toISOString() })
        .eq('id', executionId)
        .eq('status', 'running');
      result.skipped += 1;
      continue;
    }

    const correlationId = createCorrelationId(executionId);
    const enqueueResult = await withTimeout(
      enqueueRuntimeJob({
        queueName: 'execution_queue',
        taskType: 'resume_workflow_execution',
        dedupeKey: `resume:${executionId}:${row.retry_count}`,
        payload: {
          userId: row.user_id,
          sessionId: executionId,
          workflowId: row.workflow_id,
          toolName: 'resume_workflow_execution',
          executionId,
          correlationId,
          args: {
            deploymentVersionId: row.deployment_version_id,
            inputData: row.input_data ?? {},
            mode: row.mode,
            retryCount: row.retry_count,
            maxRetries: row.max_retries,
          },
        },
      }),
      ENQUEUE_TIMEOUT_MS,
      `Retry dispatch enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`,
    ).catch((err: unknown) => ({ enqueued: false as const, queueJobId: '', reason: err instanceof Error ? err.message : String(err) }));

    if (!enqueueResult.enqueued) {
      // Never leave a claimed-but-unqueued execution behind an infra
      // failure — release the slot just reserved and fail safely, mirroring
      // dispatchProductionExecution()'s own enqueue-failure handling.
      await releaseConcurrencySlot({ executionId });
      await db
        .from('workflow_executions_v2')
        .update({
          status: 'failed',
          error_message: 'Retry dispatch queue unavailable. Please retry manually.',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', executionId)
        .eq('user_id', row.user_id)
        .eq('status', 'running');
      result.failed += 1;
      continue;
    }

    result.enqueued += 1;
  }

  return result;
}
