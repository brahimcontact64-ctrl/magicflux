import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.14 -- Part B/M/N: the canonical operational-state taxonomy.
 *
 * Root cause this exists to fix: workflow_executions_v2.status is exactly
 * a 7-value DB CHECK enum (queued/running/success/failed/waiting/paused/
 * cancelled) with no concept of indeterminate/blocked_configuration/
 * recovery_required at all -- an indeterminate side-effect outcome or a
 * definitive credential rejection is flattened to plain 'failed' with the
 * real detail preserved only in free-text error_message, and the product
 * UI/API has never distinguished any of this (confirmed by exhaustive
 * grep across app/executions and components/runs -- zero references to
 * "indeterminate" or workflow_side_effects anywhere in the product).
 *
 * This module deliberately does NOT require a schema migration: it is a
 * pure, read-only DERIVATION over data that already exists --
 * workflow_executions_v2's own status/error_message, plus whether a
 * pending workflow_review_items / workflow_acknowledgments /
 * workflow_side_effects row exists for this execution. Changing the
 * underlying CHECK enum would be a much larger, riskier migration than
 * this phase's own findings justify; every distinction Part B/N asks for
 * is already fully computable from what is durably persisted today.
 *
 * Superset of Part N's exact 9-state list (running/waiting_human/
 * waiting_acknowledgment/retrying/failed/configuration_blocked/
 * indeterminate/recovery_required/succeeded) -- 'queued' and 'cancelled'
 * are real, distinct DB states that would otherwise be lossily collapsed
 * into 'running'/'failed' respectively; a consumer that only cares about
 * Part N's 9 names can freely treat 'queued' as 'running' and 'cancelled'
 * as a form of 'failed'.
 */
export type ExecutionOperationalState =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'waiting_acknowledgment'
  | 'retrying'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'configuration_blocked'
  | 'indeterminate'
  | 'recovery_required';

export type ExecutionOperationalStateResult = {
  state: ExecutionOperationalState;
  /** Human-readable, secret-free explanation of why this state was derived (never the raw error_message verbatim if it could contain provider response bodies -- callers needing more detail should use the dedicated, redacted execution-detail endpoints). */
  reason: string;
};

type MinimalExecutionRow = {
  status: string;
  error_message: string | null;
  next_run_at: string | null;
  retry_count: number | null;
};

function classifyErrorMessage(errorMessage: string | null): { state: ExecutionOperationalState; reason: string } | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith('INDETERMINATE:') || errorMessage.startsWith('AMBIGUOUS_DELIVERY:')) {
    return { state: 'indeterminate', reason: 'A prior side effect may have already reached the provider -- automatic retry was stopped to avoid a duplicate. Needs manual verification.' };
  }
  if (errorMessage.startsWith('CONFIG_BLOCKED:')) {
    return { state: 'configuration_blocked', reason: 'A connected integration rejected the request due to invalid/revoked credentials or missing permissions. Reconnect the integration, then retry.' };
  }
  // Matches both this phase's own new messages (which explicitly say
  // "recovery_required") and the pre-existing markOrphanExecutionsFailed
  // message ('worker timeout') -- both mean the SAME thing: the process
  // running this execution died before it could reach any terminal state
  // itself, and a maintenance sweep (not the engine) force-closed the row.
  if (/recovery_required/i.test(errorMessage) || errorMessage === 'worker timeout') {
    return { state: 'recovery_required', reason: 'This execution stopped making progress (a crash or a process restart) before it could reach a terminal state on its own. It was force-closed by a maintenance sweep and may need manual review.' };
  }
  return null;
}

/**
 * Derives the operational state for ONE execution the caller has ALREADY
 * confirmed ownership of (tenant scoping is the caller's responsibility --
 * this function issues service-role reads keyed only by executionId).
 */
export async function computeExecutionOperationalState(executionId: string): Promise<ExecutionOperationalStateResult> {
  const db = createServiceClient();

  const { data: execRow } = await db
    .from('workflow_executions_v2')
    .select('status, error_message, next_run_at, retry_count')
    .eq('id', executionId)
    .maybeSingle();

  if (!execRow) {
    return { state: 'failed', reason: 'Execution not found.' };
  }
  const row = execRow as MinimalExecutionRow;

  if (row.status === 'success') return { state: 'succeeded', reason: 'Completed successfully.' };
  if (row.status === 'cancelled') return { state: 'cancelled', reason: 'Cancelled by a user.' };
  if (row.status === 'queued') return { state: 'queued', reason: 'Waiting to be picked up for execution.' };

  if (row.status === 'failed') {
    const classified = classifyErrorMessage(row.error_message);
    if (classified) return classified;
    return { state: 'failed', reason: row.error_message ? 'Failed -- see execution detail for the specific error.' : 'Failed.' };
  }

  if (row.status === 'waiting') {
    // Distinguish WHY this execution is durably parked -- a pending Human
    // Review or Acknowledgment row for this exact execution is a far more
    // specific and actionable signal than the raw 'waiting' status alone.
    const [{ data: pendingReview }, { data: pendingAck }] = await Promise.all([
      db.from('workflow_review_items').select('id').eq('execution_id', executionId).eq('status', 'pending').limit(1).maybeSingle(),
      db.from('workflow_acknowledgments').select('id').eq('execution_id', executionId).eq('status', 'pending').limit(1).maybeSingle(),
    ]);

    if (pendingReview) return { state: 'waiting_human', reason: 'Parked at a Human Review step -- waiting for a person to decide.' };
    if (pendingAck) return { state: 'waiting_acknowledgment', reason: 'Parked at an SLA acknowledgment step -- waiting for acknowledgment or the deadline to pass.' };

    // Durably waiting with no pending human-facing gate: either a plain
    // Wait node's own deliberate delay, or the execution-level retry timer
    // after a node failure (retry_count > 0 is the deterministic signal
    // for the latter -- see runtime/workflow-engine.ts's own retry path).
    if ((row.retry_count ?? 0) > 0) {
      return { state: 'retrying', reason: 'A node failed and this execution is scheduled to automatically retry it.' };
    }
    return { state: 'running', reason: 'Durably paused (e.g. a Wait node) -- will resume automatically.' };
  }

  // 'running' or 'paused' (paused folds into running for this purpose --
  // both mean "in progress, no action needed from the owner").
  return { state: 'running', reason: row.status === 'paused' ? 'Paused by a user.' : 'In progress.' };
}

/**
 * Batch variant for a list view (e.g. the dashboard's execution list) --
 * avoids N sequential round trips per row. Returns a Map keyed by
 * executionId; any id not resolvable is simply absent from the result.
 */
export async function computeExecutionOperationalStates(executionIds: string[]): Promise<Map<string, ExecutionOperationalStateResult>> {
  const result = new Map<string, ExecutionOperationalStateResult>();
  if (executionIds.length === 0) return result;

  const db = createServiceClient();
  const { data: execRows } = await db
    .from('workflow_executions_v2')
    .select('id, status, error_message, next_run_at, retry_count')
    .in('id', executionIds);

  const rows = (execRows ?? []) as Array<MinimalExecutionRow & { id: string }>;
  const waitingIds = rows.filter((r) => r.status === 'waiting').map((r) => r.id);

  const [{ data: reviewRows }, { data: ackRows }] = await Promise.all([
    waitingIds.length > 0
      ? db.from('workflow_review_items').select('execution_id').eq('status', 'pending').in('execution_id', waitingIds)
      : Promise.resolve({ data: [] as Array<{ execution_id: string }> }),
    waitingIds.length > 0
      ? db.from('workflow_acknowledgments').select('execution_id').eq('status', 'pending').in('execution_id', waitingIds)
      : Promise.resolve({ data: [] as Array<{ execution_id: string }> }),
  ]);

  const reviewExecIds = new Set((reviewRows ?? []).map((r) => r.execution_id));
  const ackExecIds = new Set((ackRows ?? []).map((r) => r.execution_id));

  for (const row of rows) {
    if (row.status === 'success') { result.set(row.id, { state: 'succeeded', reason: 'Completed successfully.' }); continue; }
    if (row.status === 'cancelled') { result.set(row.id, { state: 'cancelled', reason: 'Cancelled by a user.' }); continue; }
    if (row.status === 'queued') { result.set(row.id, { state: 'queued', reason: 'Waiting to be picked up for execution.' }); continue; }

    if (row.status === 'failed') {
      const classified = classifyErrorMessage(row.error_message);
      result.set(row.id, classified ?? { state: 'failed', reason: row.error_message ? 'Failed -- see execution detail for the specific error.' : 'Failed.' });
      continue;
    }

    if (row.status === 'waiting') {
      if (reviewExecIds.has(row.id)) { result.set(row.id, { state: 'waiting_human', reason: 'Parked at a Human Review step -- waiting for a person to decide.' }); continue; }
      if (ackExecIds.has(row.id)) { result.set(row.id, { state: 'waiting_acknowledgment', reason: 'Parked at an SLA acknowledgment step -- waiting for acknowledgment or the deadline to pass.' }); continue; }
      if ((row.retry_count ?? 0) > 0) { result.set(row.id, { state: 'retrying', reason: 'A node failed and this execution is scheduled to automatically retry it.' }); continue; }
      result.set(row.id, { state: 'running', reason: 'Durably paused (e.g. a Wait node) -- will resume automatically.' });
      continue;
    }

    result.set(row.id, { state: 'running', reason: row.status === 'paused' ? 'Paused by a user.' : 'In progress.' });
  }

  return result;
}
