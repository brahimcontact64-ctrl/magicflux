/**
 * Durable AI Qualification Feedback -- workflow_qualification_decisions
 * (Phase 9.9.13).
 *
 * The ONE place a qualification decision row is ever inserted
 * (ai-classifier.ts, at real classification time) or updated
 * (human-review.ts, when it resumes and finds a `_qualificationDecisionId`
 * threaded through its input data -- see human-review.ts's own comment for
 * why that threading, not a node-id lookup, is how the two are linked).
 *
 * This module deliberately owns NO business logic about what a "good"
 * classification is -- it only persists what the classifier and the human
 * review handler already decided, generically, exactly like
 * wait-for-acknowledgment.ts's createChallengeRow() owns nothing about SLA
 * business rules either.
 */

import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { redact, REDACTED, isSensitiveKey, redactPiiPatterns } from '@/lib/security/redact';
import { isDenylistedFieldName } from '@/lib/security/field-denylist';
import type { QualificationSignal } from './qualification-policy';

const MAX_REASON_CHARS = 500;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Stable (key-order-independent) JSON serialization, so the same logical
 * config always hashes the same regardless of how the object was built.
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Part K -- an immutable identity for "the exact ruleset that produced this
 * decision", computed from only the fields that actually affect
 * classification behavior. Deliberately NOT deployment_version_id alone: a
 * redeploy can change unrelated downstream nodes without the qualification
 * rules changing at all, which would otherwise fragment "same policy"
 * history across deployment versions for no real reason. Two decisions
 * sharing this hash are structurally guaranteed to have been produced by
 * byte-identical classification rules.
 */
export function computeClassificationPolicyHash(config: {
  instruction: string;
  allowedLabels: string[];
  confidenceThreshold: number;
  qualificationPolicy: unknown;
}): string {
  const canonical = canonicalStringify({
    instruction: config.instruction,
    allowedLabels: [...config.allowedLabels].sort(),
    confidenceThreshold: config.confidenceThreshold,
    qualificationPolicy: config.qualificationPolicy ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Defense in depth, belt-and-suspenders (this project's own established
 * precedent -- see the RLS grants comments elsewhere -- of never relying on
 * exactly one layer): qualification-policy.ts's parseQualificationPolicy()
 * already drops any field name matching isDenylistedFieldName() from
 * "allowedInputFields" before a policy can even be saved, so a signal named
 * e.g. "api_key" should never structurally reach this function at all.
 * redact()'s own key-based matching cannot help here on its own, since a
 * QualificationSignal's shape is `{field, value}` -- the SENSITIVE-looking
 * name lives in a `field` VALUE, not an object key redact() would recurse
 * into. This explicitly checks each signal's own `field` name (the same two
 * checks the upstream parser already uses) and redacts `value` whenever it
 * matches, so a future bug or a different call path into this store still
 * cannot leak a credential-shaped value through this table.
 */
function redactSignals(signals: QualificationSignal[]): QualificationSignal[] {
  return signals.map((s) =>
    isSensitiveKey(s.field) || isDenylistedFieldName(s.field) ? { ...s, value: REDACTED } : redact(s)
  );
}

export type RecordQualificationDecisionParams = {
  userId: string;
  workflowId: string;
  executionId: string;
  classifierNodeId: string;
  classifierNodeName: string | null;
  deploymentVersionId: string | null;
  mode: 'live';
  classificationPolicyHash: string;
  aiClassification: string;
  aiConfidence: number;
  aiReason: string;
  positiveSignals: QualificationSignal[];
  negativeSignals: QualificationSignal[];
  missingRequiredFields: string[];
  contradictions: string[];
  qualificationStatus: 'classified' | 'needs_review' | 'needs_information' | null;
  needsReview: boolean;
};

export type RecordQualificationDecisionResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Idempotent: UNIQUE(execution_id, classifier_node_id) makes a retried or
 * concurrently-duplicated classifier invocation for the SAME execution safe
 * -- a duplicate insert is tolerated and the EXISTING row's real id is read
 * back and returned, never a second row (Part L: "execution retry cannot
 * double-count qualification", "concurrent persistence cannot double-count").
 */
export async function recordQualificationDecision(
  db: ReturnType<typeof createServiceClient>,
  params: RecordQualificationDecisionParams,
): Promise<RecordQualificationDecisionResult> {
  const { error: insertError } = await db.from('workflow_qualification_decisions').insert({
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: params.executionId,
    classifier_node_id: params.classifierNodeId,
    classifier_node_name: params.classifierNodeName,
    deployment_version_id: params.deploymentVersionId,
    mode: params.mode,
    classification_policy_hash: params.classificationPolicyHash,
    ai_classification: params.aiClassification,
    ai_confidence: params.aiConfidence,
    // Phase 9.9.13A Part F -- field-name redaction alone cannot protect
    // free text a MODEL generated from data that may itself contain PII
    // (e.g. a lead's email/phone handed to the classifier as evidence): the
    // model could echo it back verbatim into its own "reason" prose.
    // redactPiiPatterns() scans the TEXT ITSELF for email/phone shapes,
    // independent of and in addition to every key-based protection above.
    ai_reason: redactPiiPatterns(params.aiReason).slice(0, MAX_REASON_CHARS),
    positive_signals: redactSignals(params.positiveSignals),
    negative_signals: redactSignals(params.negativeSignals),
    missing_required_fields: params.missingRequiredFields,
    contradictions: params.contradictions.slice(0, 10).map((c) => redactPiiPatterns(c)),
    qualification_status: params.qualificationStatus,
    needs_review: params.needsReview,
    human_review_occurred: false,
    final_classification: params.aiClassification,
  });

  if (insertError && !String(insertError.message ?? '').toLowerCase().includes('duplicate')) {
    return { ok: false, error: 'Failed to create the durable qualification decision record.' };
  }

  const { data: row } = await db
    .from('workflow_qualification_decisions')
    .select('id')
    .eq('execution_id', params.executionId)
    .eq('classifier_node_id', params.classifierNodeId)
    .maybeSingle();

  if (!row?.id) {
    return { ok: false, error: 'Failed to read back the created qualification decision record.' };
  }

  return { ok: true, id: String((row as { id: unknown }).id) };
}

/**
 * Best-effort link from a resumed Human Review node back to the
 * qualification decision its upstream AI Classifier created. Guarded by
 * `human_review_occurred = false` -- a CAS that makes a duplicate resume of
 * the same review item a safe no-op, never a second feedback record or a
 * double-count (Part L). Never throws -- analytics bookkeeping must never
 * be the reason a workflow execution fails (same principle as
 * lib/agent/observability.ts's recordAiUsage()).
 *
 * Phase 9.9.13A Part B -- `execution_id` alone already makes cross-tenant/
 * cross-execution forgery structurally impossible (an execution id is
 * server-generated and belongs to exactly one workflow/user; an attacker's
 * own webhook-triggered execution can never equal a targeted victim's), but
 * `workflow_id` is filtered too anyway -- belt-and-suspenders, this
 * project's own established precedent (see this table's migration comment)
 * of never relying on exactly one scoping layer.
 */
export async function linkHumanReviewToQualificationDecision(
  db: ReturnType<typeof createServiceClient>,
  params: {
    qualificationDecisionId: string;
    workflowId: string;
    executionId: string;
    humanReviewNodeId: string;
    humanClassification: string;
    reviewedBy: string;
    reviewedAt: string;
  },
): Promise<void> {
  try {
    await db
      .from('workflow_qualification_decisions')
      .update({
        human_review_occurred: true,
        human_review_node_id: params.humanReviewNodeId,
        human_classification: params.humanClassification,
        human_reviewed_by: params.reviewedBy,
        human_reviewed_at: params.reviewedAt,
        final_classification: params.humanClassification,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.qualificationDecisionId)
      .eq('workflow_id', params.workflowId)
      .eq('execution_id', params.executionId)
      .eq('human_review_occurred', false);
  } catch {
    // Best-effort -- never fail the Human Review node's own resume over
    // analytics bookkeeping.
  }
}

export function asSafeRecord(v: unknown): Record<string, unknown> {
  return asRecord(v);
}
