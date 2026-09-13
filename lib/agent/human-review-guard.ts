/**
 * Phase 9.9.2 -- Human Review product-truth guard.
 *
 * Mirrors lib/agent/ai-classification-guard.ts's reasoning exactly: the
 * Builder must never narrate "flagged for human review" unless the
 * generated graph contains a real magicflux-nodes.humanReview node backed
 * by a durable review record -- never a Set-node placeholder or an IF node
 * checking a field nothing computes.
 */

import { HUMAN_REVIEW_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';

export const MISSING_HUMAN_REVIEW_MESSAGE =
  'This request asks for human review/approval, but the generated workflow has no real, durable review step -- only a deterministic placeholder. MagicFlux will not represent this as a real human-in-the-loop gate.';

// Deliberately targeted: the vocabulary a founder actually uses to ask for
// a human-in-the-loop gate (low-confidence review, refund/order/content
// approval, escalation) -- not a general "review"/"check" mention.
const HUMAN_REVIEW_CLAIM_MARKERS =
  /\bhuman\s+review\b|\bhuman-in-the-loop\b|\bmanual\s+review\b|\bflag(?:ged)?\s+for\s+review\b|\bneeds?\s+review\b|\brequires?\s+approval\b|\bneeds?\s+approval\b|\brequires?\s+human\s+approval\b|\bapprove\/reject\b|\bescalat(?:e|ion)\s+to\s+(?:a\s+)?human\b|\bhuman\s+approv(?:e|al|es)\b/i;

/** True when `text` plausibly asks for a human-in-the-loop review/approval gate. */
export function claimsHumanReviewSemantics(text: string): boolean {
  return HUMAN_REVIEW_CLAIM_MARKERS.test(text ?? '');
}

export type HumanReviewClaimValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates that a generated graph backs up any human-review claim in the
 * request with a real magicflux-nodes.humanReview node. A request with no
 * such claim always passes -- this never forces the node type onto
 * unrelated automations.
 */
export function validateHumanReviewClaim(
  rawUserIntent: string,
  nodesDescription: string,
  nodes: unknown[]
): HumanReviewClaimValidation {
  const claimText = `${rawUserIntent ?? ''} ${nodesDescription ?? ''}`;
  if (!claimsHumanReviewSemantics(claimText)) return { ok: true };

  const hasReviewNode = (Array.isArray(nodes) ? nodes : []).some((n) => {
    if (!n || typeof n !== 'object') return false;
    const type = String((n as Record<string, unknown>).type ?? '');
    return type.toLowerCase() === HUMAN_REVIEW_NODE_TYPE.toLowerCase();
  });

  if (hasReviewNode) return { ok: true };
  return { ok: false, reason: MISSING_HUMAN_REVIEW_MESSAGE };
}
