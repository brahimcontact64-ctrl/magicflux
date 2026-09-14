/**
 * Durable Human Review / Approval -- magicflux-nodes.humanReview (Phase 9.9.2).
 *
 * The second real, reusable capability: pauses a workflow safely, creates a
 * durable review record a human can act on outside the execution, and
 * resumes the SAME execution once (and only once) a decision exists --
 * continuing only the branch matching that decision. Generic by design
 * (low-confidence AI classification, refund approval, risky order review,
 * content approval, sales escalation) -- nothing here is lead/order/content
 * specific.
 *
 * How pausing/resuming works (reuses the EXISTING waiting/resume mechanism,
 * invents no new one): returning { status: 'waiting' } with no nextRunAt
 * makes runtime/workflow-engine.ts persist next_run_at = NULL, which
 * lib/runtime/retry-dispatcher.ts's timer-based due-execution scan never
 * matches -- this node can ONLY resume via an explicit decision, never a
 * timer. On resume, the engine re-invokes this SAME node; the handler looks
 * up its own durable review row (keyed by (executionId, nodeId), the same
 * identity every invocation for this node in this execution shares) and
 * either waits again (still pending) or returns success with
 * _conditionBranch set to the decided outcome's index -- routing through
 * the exact same branch-dispatch logic an IF node uses (Phase 9.9.0).
 *
 * SECURITY JUSTIFICATION for the direct createServiceClient() use here
 * (a new pattern for this handler layer -- every other handler only calls
 * an external provider API): this handler runs server-side inside a
 * trusted execution context (the same runtime that already resolves
 * per-user integration credentials), and durable review state needs to
 * outlive a single handler invocation by design -- there is no other
 * mechanism in NodeHandlerContext for that. All queries are scoped to
 * context.userId (validated upstream by the execution's own auth boundary,
 * never client-supplied here), matching the justification already used by
 * lib/runtime/scheduler.ts and lib/runtime/retry-dispatcher.ts for the same
 * client.
 */

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { createServiceClient } from '@/lib/supabase-server';
import { redact } from '@/lib/security/redact';

const DEFAULT_OUTCOMES = ['approve', 'reject'];
const MAX_CONTEXT_CHARS = 4000;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type ReviewParams = {
  instruction: string;
  allowedOutcomes: string[];
  inputFields: string[] | null;
  outputField: string | null;
};

function parseParams(node: EngineNode): ReviewParams {
  const raw = asRecord(node.parameters);

  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';

  const outcomesRaw = Array.isArray(raw.allowedOutcomes) ? raw.allowedOutcomes : null;
  const allowedOutcomes = outcomesRaw
    ? Array.from(new Set(outcomesRaw.map((o) => String(o).trim()).filter(Boolean)))
    : [...DEFAULT_OUTCOMES];

  const inputFieldsRaw = Array.isArray(raw.inputFields) ? raw.inputFields : null;
  const inputFields = inputFieldsRaw ? inputFieldsRaw.map((f) => String(f).trim()).filter(Boolean) : null;

  // Phase 9.9.4C -- HUMAN DECISION AUTHORITY CONTRACT: mirrors
  // magicflux-nodes.aiClassifier's own "outputField" parameter name/meaning
  // -- the field this node's decision becomes canonical in. Only set when a
  // workflow wants the human's chosen outcome to become the field any
  // downstream node reads as "the classification" (e.g. an Airtable
  // Confidence/Classification mapping, or a rejoined classification-routing
  // chain). When present, the human's chosen outcome deterministically
  // overwrites exactly this one field on resume -- never any other -- so a
  // downstream reader sees the decision, not the AI classifier's now-
  // superseded value. Never applied unless explicitly configured.
  const outputFieldRaw = raw.outputField;
  const outputField = typeof outputFieldRaw === 'string' && outputFieldRaw.trim() ? outputFieldRaw.trim() : null;

  return { instruction, allowedOutcomes: allowedOutcomes.length > 0 ? allowedOutcomes : [...DEFAULT_OUTCOMES], inputFields, outputField };
}

/** Deep-redacts secrets (the one authoritative utility, shared with ai-classifier.ts and every other handler), then bounds size for jsonb storage. */
function buildSafeReviewContext(data: Record<string, unknown>, inputFields: string[] | null): Record<string, unknown> {
  const source = inputFields && inputFields.length > 0
    ? Object.fromEntries(inputFields.map((f) => [f, data[f]]))
    : data;
  const safe = redact(source);
  const json = JSON.stringify(safe);
  if (json.length > MAX_CONTEXT_CHARS) {
    return { truncated: true, preview: json.slice(0, 500) };
  }
  return safe as Record<string, unknown>;
}

type ReviewItemRow = { id: string; status: string; decision_outcome: string | null; allowed_outcomes: string[] | null };

export async function humanReviewHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext,
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);
  const params = parseParams(node);

  if (context.mode === 'test') {
    logs.push('Human Review: simulated in test mode -- auto-approved, no durable review record created.');
    const simulatedDecision = params.allowedOutcomes[0];
    return {
      status: 'simulated_success',
      outputData: {
        ...data,
        ...(params.outputField ? { [params.outputField]: simulatedDecision } : {}),
        decision: simulatedDecision,
        needs_review: false,
        reviewed_by: null,
        reviewed_at: null,
        _conditionBranch: 0,
      },
      logs,
    };
  }

  const nodeId = String(node.id ?? node.name ?? '').trim();
  if (!context.userId || !context.workflowId || !context.executionId || !nodeId) {
    const error = 'Human Review requires an active execution context (userId/workflowId/executionId).';
    logs.push(`Human Review: ${error}`);
    return { status: 'failed', outputData: null, logs, error };
  }

  const db = createServiceClient();

  const { data: existing, error: lookupError } = await db
    .from('workflow_review_items')
    .select('id, status, decision_outcome, allowed_outcomes')
    .eq('execution_id', context.executionId)
    .eq('node_id', nodeId)
    .maybeSingle();

  if (lookupError) {
    const error = 'Failed to look up the durable review record.';
    logs.push(`Human Review: ${error}`);
    return { status: 'failed', outputData: null, logs, error };
  }

  const row = existing as ReviewItemRow | null;

  if (row && row.status !== 'pending') {
    // Phase 9.9.2A -- the branch mapping is computed from the DB row's OWN
    // persisted allowed_outcomes (the exact snapshot taken when this review
    // item was created), never by re-parsing the node's live parameters at
    // resume time. The two should always agree (workflow_json is frozen
    // per deployment version), but the persisted column is the actual
    // guarantee, not an assumption.
    const persistedOutcomes = Array.isArray(row.allowed_outcomes) && row.allowed_outcomes.length > 0
      ? row.allowed_outcomes
      : params.allowedOutcomes;
    const outcomeIndex = persistedOutcomes.indexOf(row.decision_outcome ?? '');
    const branch = outcomeIndex >= 0 ? outcomeIndex : 0;
    logs.push(`Human Review: decision already recorded -- "${row.decision_outcome}". Continuing branch ${branch}.`);

    // Self-healing: reaching this code at all proves a resume attempt
    // reached this exact node again, so if our own bookkeeping is still at
    // 'resume_pending' (e.g. the decide route's own final update crashed
    // right after resumeExecution() itself succeeded), catch it up now --
    // belt-and-suspenders alongside lib/runtime/review-resume.ts's own
    // recovery paths. Best-effort: never fail the node over this.
    if (row.status === 'resume_pending') {
      try {
        await db
          .from('workflow_review_items')
          .update({ status: 'resumed', resumed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'resume_pending');
      } catch {
        // Best-effort -- lib/runtime/review-resume.ts's recovery paths
        // will catch this up if this update didn't land.
      }
    }

    return {
      status: 'success',
      outputData: {
        ...data,
        // Phase 9.9.4C -- deterministic, explicit, single-field overwrite
        // ONLY when the node opted in via "outputField" -- never applied by
        // default, and never touches any field other than this one.
        ...(params.outputField ? { [params.outputField]: row.decision_outcome } : {}),
        decision: row.decision_outcome,
        needs_review: false,
        _conditionBranch: branch,
      },
      logs,
    };
  }

  if (!row) {
    const reviewContext = buildSafeReviewContext(data, params.inputFields);
    const { error: insertError } = await db.from('workflow_review_items').insert({
      user_id: context.userId,
      workflow_id: context.workflowId,
      deployment_version_id: context.deploymentVersionId ?? null,
      execution_id: context.executionId,
      node_id: nodeId,
      node_name: node.name ?? null,
      status: 'pending',
      allowed_outcomes: params.allowedOutcomes,
      instruction: params.instruction || null,
      review_context: reviewContext,
      mode: context.mode,
    });

    // A concurrent duplicate insert (two parallel dispatches of the same
    // node, or a resume racing the original run) fails the (execution_id,
    // node_id) unique constraint -- that's fine, it just means the review
    // item already exists; treat it the same as finding it via the lookup
    // above rather than as a real error.
    if (insertError && !String(insertError.message ?? '').toLowerCase().includes('duplicate')) {
      const error = 'Failed to create the durable review record.';
      logs.push(`Human Review: ${error}`);
      return { status: 'failed', outputData: null, logs, error };
    }

    logs.push('Human Review: created a durable review item -- waiting for a human decision.');
  } else {
    logs.push('Human Review: a review item is already pending -- still waiting for a decision.');
  }

  return {
    status: 'waiting',
    outputData: data,
    logs,
    // Deliberately no nextRunAt -- see the module doc: this must only ever
    // resume via an explicit decision, never a timer.
  };
}
