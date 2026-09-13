import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { ExecutionManager } from '@/runtime/execution-manager';

/**
 * Phase 9.9.2A — crash-safe decision->resume for Human Review.
 *
 * The vulnerability this closes: a CAS pending->resume_pending durably
 * records the decision, but the process can still crash (or the network
 * can fail) BEFORE resumeExecution() is called, or while it's in flight.
 * Before this module, that left the review item permanently looking
 * "decided" while the execution stayed 'waiting' forever, with no way to
 * detect or recover it.
 *
 * attemptReviewResume() is the single place this actually happens, called
 * from two sites that must never drift apart:
 *   1. app/api/reviews/[id]/decide/route.ts -- inline, right after the
 *      decision is first persisted, and again (opportunistically) if a
 *      duplicate/retried request hits an item already at resume_pending.
 *   2. recoverStuckReviewResumes() below, invoked by
 *      app/api/cron/recover-review-resumes -- a background sweep for the
 *      case where nobody ever retries manually, mirroring
 *      lib/runtime/retry-dispatcher.ts's existing due-execution scan
 *      (same optimistic-CAS claim pattern, same production queue
 *      conventions -- no new polling mechanism invented).
 *
 * Duplicate-side-effect safety: before EVER calling resumeExecution()
 * again, this checks workflow_executions_v2.status/current_node_id for
 * the execution. If the execution has already moved past this exact node
 * (status isn't 'waiting', or current_node_id no longer equals this row's
 * node_id) -- proof a prior attempt already progressed the run, whether or
 * not this row's own bookkeeping caught up -- resumeExecution() is NEVER
 * called again; only this row's status is caught up to 'resumed'.
 * resumeExecution() is only (re)invoked when the execution is STILL
 * genuinely parked exactly at this review node.
 *
 * Phase 9.9.3.2 -- fixed a duplicate-guard identity mismatch found while
 * investigating human-decision routing integrity: `stillAtThisNode` used to
 * compare workflow_executions_v2.current_node_id against this row's
 * `node_id` column. The engine (runtime/workflow-engine.ts) always
 * populates current_node_id with the node's NAME (nodeMap/edgeMap/
 * checkpoints are all keyed by name, never id), while workflow_review_items
 * .node_id is the node's own `id` field (set by humanReviewHandler for its
 * OWN re-lookup, where id vs name doesn't matter there). Since a real
 * generated node's `id` ("4") and `name` ("Human Review") are virtually
 * never equal, this comparison was ALWAYS false -- meaning
 * attemptReviewResume() never once actually called resumeExecution() for a
 * real decision made through app/api/reviews/[id]/decide/route.ts; it
 * silently marked every review row "resumed" without the underlying
 * workflow execution ever progressing. Fixed by comparing against this
 * row's existing `node_name` column instead (already stored alongside
 * node_id for exactly this kind of need -- see app/api/reviews/route.ts),
 * matching the engine's own identity space.
 */

export type ReviewItemForResume = {
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

export type AttemptResumeResult =
  | { resumed: true; alreadyResumed?: boolean }
  | { resumed: false; error: string };

export async function attemptReviewResume(item: ReviewItemForResume): Promise<AttemptResumeResult> {
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
      .from('workflow_review_items')
      .update({ status: 'resumed', resumed_at: nowIso(), updated_at: nowIso() })
      .eq('id', item.id)
      .eq('status', 'resume_pending');
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
      .from('workflow_review_items')
      .update({ resume_attempts: (item.resume_attempts ?? 0) + 1, last_resume_error: error, updated_at: nowIso() })
      .eq('id', item.id)
      .eq('status', 'resume_pending');
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
      .from('workflow_review_items')
      .update({ resume_attempts: (item.resume_attempts ?? 0) + 1, last_resume_error: message, updated_at: nowIso() })
      .eq('id', item.id)
      .eq('status', 'resume_pending');
    return { resumed: false, error: message };
  }

  await db
    .from('workflow_review_items')
    .update({ status: 'resumed', resumed_at: nowIso(), updated_at: nowIso() })
    .eq('id', item.id)
    .eq('status', 'resume_pending');

  return { resumed: true };
}

export type RecoverStuckReviewsResult = {
  scanned: number;
  claimed: number;
  recovered: number;
  skipped: number;
  failed: number;
};

/**
 * Background sweep for resume_pending review items nobody has retried
 * manually. `graceMs` avoids racing an in-flight original decide request
 * (only sweeps rows whose bookkeeping hasn't moved in at least that long).
 * Claims via the SAME compare-and-swap pattern already proven by
 * lib/runtime/scheduler.ts's pollDueSchedules() and
 * lib/runtime/retry-dispatcher.ts's dispatchDueRetries() -- a concurrent
 * sweep, or an in-flight decide request, loses the race harmlessly.
 */
export async function recoverStuckReviewResumes(params?: {
  batchSize?: number;
  graceMs?: number;
}): Promise<RecoverStuckReviewsResult> {
  const db = createServiceClient();
  const batchSize = params?.batchSize ?? 50;
  const graceMs = params?.graceMs ?? 60_000;
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();

  const result: RecoverStuckReviewsResult = { scanned: 0, claimed: 0, recovered: 0, skipped: 0, failed: 0 };

  const { data: candidates } = await db
    .from('workflow_review_items')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, mode, resume_attempts, updated_at')
    .eq('status', 'resume_pending')
    .lte('updated_at', cutoffIso)
    .limit(batchSize);

  const rows = (candidates ?? []) as Array<ReviewItemForResume & { updated_at: string }>;
  result.scanned = rows.length;

  for (const row of rows) {
    const { data: claimed } = await db
      .from('workflow_review_items')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'resume_pending')
      .eq('updated_at', row.updated_at)
      .select('id')
      .maybeSingle();

    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    const outcome = await attemptReviewResume(row);
    if (outcome.resumed) result.recovered += 1;
    else result.failed += 1;
  }

  return result;
}
