import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { ExecutionManager } from '@/runtime/execution-manager';

/**
 * Phase 9.9.12 -- crash-safe decision->resume for the durable SLA
 * acknowledgment primitive (magicflux-nodes.waitForAcknowledgment).
 *
 * Mirrors lib/runtime/review-resume.ts's exact architecture (the same
 * decide-then-resume crash window exists here: a CAS transition to
 * 'acknowledged'/'timed_out' durably records the outcome, but the process
 * can still crash before resumeExecution() is called or while it's in
 * flight) -- with one structural difference: workflow_review_items uses a
 * three-state lifecycle (pending -> resume_pending -> resumed) where
 * resume_pending is the "decided but not yet resumed" signal; this table
 * has only the two terminal outcome values in `status`
 * (acknowledged/timed_out) and uses `resumed_at IS NULL` as that same
 * signal instead -- one fewer status value, identical safety property.
 *
 * attemptAcknowledgmentResume() is called from two sites that must never
 * drift apart:
 *   1. app/api/acknowledgments/[id]/ack/route.ts and
 *      app/api/acknowledgments/[id]/decide/route.ts -- inline, right after
 *      a fresh CAS to 'acknowledged' succeeds.
 *   2. recoverStuckAcknowledgmentResumes() below, invoked by
 *      app/api/cron/recover-acknowledgment-resumes -- a background sweep
 *      for the case where resume never got attempted (or crashed) and
 *      nobody retries interactively, mirroring
 *      lib/runtime/review-resume.ts's own recoverStuckReviewResumes().
 *
 *      Note: the TIMEOUT side's OWN resume (the durable timer -- see
 *      wait-for-acknowledgment.ts's doc comment) already goes through the
 *      EXISTING, separately-certified lib/runtime/retry-dispatcher.ts's
 *      dispatchDueRetries() infrastructure (queue-driven, via the worker)
 *      -- it does NOT call this module at all. This module exists
 *      specifically for the ACKNOWLEDGE side's own decide-then-resume gap,
 *      which retry-dispatcher.ts has no reason to know about.
 *
 * Duplicate-side-effect safety: identical to review-resume.ts -- before
 * EVER calling resumeExecution() again, checks
 * workflow_executions_v2.status/current_node_id. If the execution has
 * already moved past this exact node, resumeExecution() is NEVER called
 * again; only this row's resumed_at bookkeeping is caught up.
 */

export type AckItemForResume = {
  id: string;
  user_id: string;
  workflow_id: string;
  execution_id: string;
  node_id: string;
  node_name: string | null;
  deployment_version_id: string | null;
  mode: 'test' | 'live';
  resume_attempts?: number | null;
};

export type AttemptAckResumeResult =
  | { resumed: true; alreadyResumed?: boolean }
  | { resumed: false; error: string };

export async function attemptAcknowledgmentResume(item: AckItemForResume): Promise<AttemptAckResumeResult> {
  const db = createServiceClient();
  const nowIso = () => new Date().toISOString();

  const { data: execRow } = await db
    .from('workflow_executions_v2')
    .select('status, current_node_id')
    .eq('id', item.execution_id)
    .maybeSingle();

  const stillAtThisNode = Boolean(
    execRow && execRow.status === 'waiting' && item.node_name && execRow.current_node_id === item.node_name
  );

  if (!stillAtThisNode) {
    // A prior attempt already progressed the execution past this node (or
    // it ended for an unrelated reason) -- never re-invoke resumeExecution.
    // Only catch up this row's own bookkeeping.
    await db
      .from('workflow_acknowledgments')
      .update({ resumed_at: nowIso(), updated_at: nowIso() })
      .eq('id', item.id)
      .is('resumed_at', null);
    return { resumed: true, alreadyResumed: true };
  }

  const { data: workflow } = await db
    .from('workflows')
    .select('id, workflow_json')
    .eq('id', item.workflow_id)
    .eq('user_id', item.user_id)
    .maybeSingle();

  let workflowJson: unknown = workflow?.workflow_json;
  if (item.deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', item.deployment_version_id)
      .maybeSingle();
    if (version?.workflow_data) workflowJson = version.workflow_data;
  }

  if (!workflowJson) {
    const error = 'Workflow not found for resume';
    await db
      .from('workflow_acknowledgments')
      .update({ resume_attempts: (item.resume_attempts ?? 0) + 1, last_resume_error: error, updated_at: nowIso() })
      .eq('id', item.id)
      .is('resumed_at', null);
    return { resumed: false, error };
  }

  const executionManager = new ExecutionManager();
  try {
    await executionManager.resumeExecution({
      executionId: item.execution_id,
      userId: item.user_id,
      workflowJson,
      workflowId: item.workflow_id,
      mode: item.mode,
      inputData: {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from('workflow_acknowledgments')
      .update({ resume_attempts: (item.resume_attempts ?? 0) + 1, last_resume_error: message, updated_at: nowIso() })
      .eq('id', item.id)
      .is('resumed_at', null);
    return { resumed: false, error: message };
  }

  await db
    .from('workflow_acknowledgments')
    .update({ resumed_at: nowIso(), updated_at: nowIso() })
    .eq('id', item.id)
    .is('resumed_at', null);

  return { resumed: true };
}

export type RecoverStuckAcksResult = {
  scanned: number;
  claimed: number;
  recovered: number;
  skipped: number;
  failed: number;
};

/**
 * Background sweep for a terminal decision (acknowledged/timed_out) whose
 * resume was never confirmed -- mirrors lib/runtime/review-resume.ts's
 * recoverStuckReviewResumes() exactly (same optimistic-CAS claim pattern
 * via updated_at, same graceMs to avoid racing an in-flight request).
 */
export async function recoverStuckAcknowledgmentResumes(params?: {
  batchSize?: number;
  graceMs?: number;
}): Promise<RecoverStuckAcksResult> {
  const db = createServiceClient();
  const batchSize = params?.batchSize ?? 50;
  const graceMs = params?.graceMs ?? 60_000;
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();

  const result: RecoverStuckAcksResult = { scanned: 0, claimed: 0, recovered: 0, skipped: 0, failed: 0 };

  const { data: candidates } = await db
    .from('workflow_acknowledgments')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, mode, resume_attempts, updated_at')
    .in('status', ['acknowledged', 'timed_out'])
    .is('resumed_at', null)
    .lte('updated_at', cutoffIso)
    .limit(batchSize);

  const rows = (candidates ?? []) as Array<AckItemForResume & { updated_at: string }>;
  result.scanned = rows.length;

  for (const row of rows) {
    const { data: claimed } = await db
      .from('workflow_acknowledgments')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('resumed_at', null)
      .eq('updated_at', row.updated_at)
      .select('id')
      .maybeSingle();

    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    const outcome = await attemptAcknowledgmentResume(row);
    if (outcome.resumed) result.recovered += 1;
    else result.failed += 1;
  }

  return result;
}
