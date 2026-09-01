import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { assertTrustedUserId } from '@/lib/credentials/storage';
import { reserveConcurrencySlot, releaseConcurrencySlot } from './concurrency-guard';
import * as cronParser from 'cron-parser';

/**
 * Schedule-trigger engine.
 *
 * Genuinely new (confirmed by audit: no cron/schedule engine existed
 * anywhere in the codebase before this — scheduleTriggerNode was UI-only).
 *
 * Design choices, and why:
 *   - cron-parser (already a transitive dependency via bullmq; promoted to a
 *     direct dependency here) handles cron math + IANA timezone conversion —
 *     hand-rolling cron/DST arithmetic is exactly the kind of thing that
 *     looks correct until a timezone transition proves it isn't.
 *   - No new distributed-lock table. next_run_at is claimed via an atomic
 *     compare-and-swap UPDATE ... WHERE next_run_at = <value I read> —
 *     the same optimistic-concurrency pattern already used by
 *     runtime_execution_locks.lock_version elsewhere in this codebase. If
 *     two scheduler pollers race on the same due schedule, only one UPDATE
 *     matches the WHERE clause and returns a row; the loser sees zero rows
 *     and skips. This makes "two scheduler workers must not trigger the same
 *     schedule twice" true without inventing new lock infrastructure.
 *   - Firing goes through the SAME idempotency mechanism every other
 *     execution path uses (buildExecutionIdempotencyKey / runtime_execution_locks
 *     unique index), keyed by the exact firing timestamp, as a second,
 *     independent layer of duplicate-prevention defense-in-depth.
 *   - Dispatch cadence: intended to be invoked once a minute (Vercel Cron
 *     minimum granularity, matching the existing app/api/cron/reverify-credentials
 *     pattern) via app/api/cron/dispatch-schedules, and/or from the runtime
 *     worker's existing watchdog timer loop.
 */

export type CronValidationResult = { valid: true } | { valid: false; error: string };

/** Validates a cron expression without computing anything — used before activation. */
export function validateCronExpression(cronExpression: string, timezone?: string): CronValidationResult {
  const trimmed = (cronExpression ?? '').trim();
  if (!trimmed) return { valid: false, error: 'Cron expression is required' };

  try {
    cronParser.parseExpression(trimmed, { tz: timezone || 'UTC' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Invalid cron expression' };
  }
}

/** Computes the next fire time strictly after `fromDate`, in the given IANA timezone. */
export function computeNextRunAt(cronExpression: string, timezone: string, fromDate: Date = new Date()): Date {
  const interval = cronParser.parseExpression(cronExpression, {
    tz: timezone || 'UTC',
    currentDate: fromDate,
  });
  return interval.next().toDate();
}

export type ScheduleTriggerSpec = {
  nodeId: string;
  nodeName: string;
  cronExpression: string;
  timezone: string;
};

/** Extracts every schedule-trigger node from a workflow JSON. */
export function extractScheduleTriggers(workflowJson: unknown): ScheduleTriggerSpec[] {
  const wf = (workflowJson ?? {}) as { nodes?: Array<Record<string, unknown>> };
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const specs: ScheduleTriggerSpec[] = [];

  for (const node of nodes) {
    const type = String(node.type ?? '').toLowerCase();
    if (!type.includes('scheduletrigger')) continue;
    const params = (node.parameters ?? {}) as Record<string, unknown>;
    const nodeName = String(node.name ?? node.id ?? '').trim();
    const nodeId = String(node.id ?? nodeName);
    specs.push({
      nodeId,
      nodeName,
      cronExpression: String(params.cronExpression ?? '').trim(),
      timezone: String(params.timezone ?? '').trim() || 'UTC',
    });
  }

  return specs;
}

/** Validates every schedule-trigger node's cron expression. Called during activation. */
export function validateScheduleTriggers(workflowJson: unknown): string[] {
  const errors: string[] = [];
  for (const spec of extractScheduleTriggers(workflowJson)) {
    const result = validateCronExpression(spec.cronExpression, spec.timezone);
    if (!result.valid) {
      errors.push(`Schedule trigger "${spec.nodeName}": ${result.error}`);
    }
  }
  return errors;
}

/**
 * Registers (or updates) the schedule rows for every schedule-trigger node in
 * an activated workflow, and removes rows for any schedule-trigger node that
 * no longer exists in the new active version. Called by activateWorkflow()
 * after a version is frozen. Callers must have already validated the cron
 * expressions (validateScheduleTriggers) — this function does not re-validate.
 */
export async function syncWorkflowSchedules(params: {
  userId: string;
  workflowId: string;
  workflowJson: unknown;
}): Promise<void> {
  assertTrustedUserId(params.userId);
  const db = createServiceClient();
  const specs = extractScheduleTriggers(params.workflowJson);
  const now = new Date();

  const { data: existing } = await db
    .from('workflow_schedules')
    .select('id, node_id')
    .eq('workflow_id', params.workflowId)
    .eq('user_id', params.userId);

  const keepNodeIds = new Set(specs.map((s) => s.nodeId));
  for (const row of (existing ?? []) as Array<{ id: string; node_id: string }>) {
    if (!keepNodeIds.has(row.node_id)) {
      await db.from('workflow_schedules').delete().eq('id', row.id).eq('user_id', params.userId);
    }
  }

  for (const spec of specs) {
    const nextRunAt = computeNextRunAt(spec.cronExpression, spec.timezone, now);
    await db.from('workflow_schedules').upsert(
      {
        workflow_id: params.workflowId,
        user_id: params.userId,
        node_id: spec.nodeId,
        node_name: spec.nodeName,
        schedule_type: 'cron',
        cron_expression: spec.cronExpression,
        timezone: spec.timezone,
        enabled: true,
        next_run_at: nextRunAt.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'workflow_id,node_id' },
    );
  }
}

/** Disables (does not delete) every schedule row for a workflow — called on pause/disable/archive. */
export async function disableWorkflowSchedules(userId: string, workflowId: string): Promise<void> {
  assertTrustedUserId(userId);
  const db = createServiceClient();
  await db
    .from('workflow_schedules')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('workflow_id', workflowId)
    .eq('user_id', userId);
}

/** Re-enables every schedule row for a workflow and recomputes next_run_at from now — called on resume/reactivate. */
export async function enableWorkflowSchedules(userId: string, workflowId: string): Promise<void> {
  assertTrustedUserId(userId);
  const db = createServiceClient();
  const { data: rows } = await db
    .from('workflow_schedules')
    .select('id, cron_expression, timezone')
    .eq('workflow_id', workflowId)
    .eq('user_id', userId);

  const now = new Date();
  for (const row of (rows ?? []) as Array<{ id: string; cron_expression: string; timezone: string }>) {
    const nextRunAt = computeNextRunAt(row.cron_expression, row.timezone, now);
    await db
      .from('workflow_schedules')
      .update({ enabled: true, next_run_at: nextRunAt.toISOString(), updated_at: now.toISOString() })
      .eq('id', row.id)
      .eq('user_id', userId);
  }
}

export type ScheduleDispatchResult = {
  fired: number;
  skipped: number;
  errors: Array<{ scheduleId: string; error: string }>;
};

/**
 * Finds every due, enabled schedule and fires exactly one execution per
 * schedule via an atomic claim (see module doc). Safe to call concurrently
 * from multiple processes/instances — that's the whole point.
 */
export async function pollDueSchedules(now: Date = new Date()): Promise<ScheduleDispatchResult> {
  const db = createServiceClient();
  const result: ScheduleDispatchResult = { fired: 0, skipped: 0, errors: [] };

  const { data: due } = await db
    .from('workflow_schedules')
    .select('id, workflow_id, user_id, node_id, node_name, cron_expression, timezone, next_run_at')
    .eq('enabled', true)
    .lte('next_run_at', now.toISOString())
    .limit(100);

  for (const schedule of (due ?? []) as Array<{
    id: string; workflow_id: string; user_id: string; node_id: string; node_name: string;
    cron_expression: string; timezone: string; next_run_at: string;
  }>) {
    const claimedFiringAt = schedule.next_run_at;
    const nextRunAt = computeNextRunAt(schedule.cron_expression, schedule.timezone, now);

    // Atomic claim: only succeeds if next_run_at still equals what we just read.
    const { data: claimed } = await db
      .from('workflow_schedules')
      .update({ next_run_at: nextRunAt.toISOString(), last_run_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', schedule.id)
      .eq('next_run_at', claimedFiringAt)
      .select('id')
      .maybeSingle();

    if (!claimed) {
      result.skipped += 1; // another poller already claimed this firing
      continue;
    }

    try {
      const { data: workflow } = await db
        .from('workflows')
        .select('id, workflow_json, status, active_deployment_version_id')
        .eq('id', schedule.workflow_id)
        .eq('user_id', schedule.user_id)
        .maybeSingle();

      if (!workflow || !['active', 'deployed'].includes(String(workflow.status))) {
        result.skipped += 1;
        continue;
      }

      let workflowJson = workflow.workflow_json;
      if (workflow.active_deployment_version_id) {
        const { data: version } = await db
          .from('deployment_versions')
          .select('workflow_data')
          .eq('id', workflow.active_deployment_version_id)
          .maybeSingle();
        if (version?.workflow_data) workflowJson = version.workflow_data;
      }

      // Concurrency reservation (Phase 8.9 Step 10 scheduler certification
      // fix): this path previously never reserved a slot at all, unlike the
      // webhook (execution-dispatch.ts) and retry (retry-dispatcher.ts)
      // paths — scheduled executions were completely unbounded by
      // RUNTIME_MAX_CONCURRENT_PER_USER/PER_WORKFLOW. runWorkflowExecution()
      // always creates a brand-new execution row with an engine-generated
      // id (initializeExecution() UPDATEs rather than INSERTs when an
      // executionId is pre-supplied, so we cannot pre-generate one here
      // without changing that shared contract used by resume/pause/cancel).
      // runtime_concurrency_reservations.execution_id has no FK to
      // workflow_executions_v2 — it is purely a reservation ticket — so the
      // same per-occurrence-unique idempotency key doubles as the
      // reservation key, reserved here and released once the run settles.
      const reservationKey = `schedule:${schedule.id}:${claimedFiringAt}`;
      const reservation = await reserveConcurrencySlot({
        executionId: reservationKey,
        userId: schedule.user_id,
        workflowId: schedule.workflow_id,
      });

      if (!reservation.reserved) {
        // Consistent with this module's existing skip-to-latest catch-up
        // semantics (see module doc): the claim already advanced
        // next_run_at, so a denied occurrence is not retried — it is
        // recorded and dropped, exactly like every other skip path here.
        result.skipped += 1;
        await db
          .from('workflow_schedules')
          .update({ last_error: `Skipped: ${reservation.reason}` })
          .eq('id', schedule.id);
        continue;
      }

      try {
        const execResult = await runWorkflowExecution({
          workflowJson,
          inputData: { triggeredBy: 'schedule', nodeId: schedule.node_id, firedAt: claimedFiringAt },
          userId: schedule.user_id,
          workflowId: schedule.workflow_id,
          mode: 'live',
          idempotencyKey: reservationKey,
          // Bug fix (Phase 8.9 Step 10 scheduler certification): workflowJson
          // above is already correctly resolved from the frozen active
          // deployment version, but the version id itself was never threaded
          // through to initializeExecution() — every scheduled execution's
          // workflow_executions_v2.deployment_version_id was silently written
          // NULL, unlike the webhook/retry paths (lib/runtime/execution-dispatch.ts)
          // which always pass this. Content executed was already correct; this
          // restores the audit-trail column to match reality.
          deploymentVersionId: workflow.active_deployment_version_id ?? null,
        });

        await db
          .from('workflow_schedules')
          .update({ last_execution_id: execResult.executionId, last_error: execResult.error ?? null })
          .eq('id', schedule.id);

        result.fired += 1;
      } finally {
        await releaseConcurrencySlot({ executionId: reservationKey });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.from('workflow_schedules').update({ last_error: message }).eq('id', schedule.id);
      result.errors.push({ scheduleId: schedule.id, error: message });
    }
  }

  return result;
}
