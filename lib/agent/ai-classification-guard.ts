/**
 * Phase 9.9.1 -- AI Classification product-truth guard.
 *
 * Root cause this exists to prevent: the Builder narrating "AI analyzes the
 * lead based on budget, urgency, and purchase intent" (and generating a
 * node literally named "Lead Classification") when the actual generated
 * graph contained zero AI-inference nodes -- just a deterministic IF
 * branching on a field ($json.classification) nothing ever computed. That
 * is an unsupported-capability claim, not a cosmetic naming issue.
 *
 * This is a deterministic, fail-closed backstop: whenever the founder's own
 * raw request plausibly claims AI-based classification/decision-making
 * semantics, the generated graph MUST contain a real
 * magicflux-nodes.aiClassifier node (the one supported AI structured
 * classification capability -- see
 * lib/workflow-runtime/node-handlers/ai-classifier.ts). If it doesn't, the
 * generation is rejected rather than silently persisted as something the
 * runtime cannot actually do the way it's described.
 */

import { AI_CLASSIFIER_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';

export const MISSING_AI_CLASSIFIER_MESSAGE =
  'This request asks for AI-based classification/decision-making, but the generated workflow has no real AI classification step -- only deterministic branching. MagicFlux will not represent this as AI-powered analysis.';

// Deliberately broad-but-targeted: matches the vocabulary a founder actually
// uses to ask for AI-based classification/decision-making (lead scoring,
// intent detection, sentiment/category routing, confidence-gated review) --
// not a general "AI" or "smart" mention, which says nothing about whether a
// real inference step is required.
const AI_CLASSIFICATION_CLAIM_MARKERS =
  /\bclassify\b|\bclassification\b|\bclassified\b|\bclassifier\b|\bintent\b|\bsentiment\b|\bcategoriz(?:e|ation)\b.{0,30}\b(?:ai|automatically|analy[sz]e)\b|\banaly[sz](?:e|ing).{0,40}\b(?:classify|classification)\b|\bscore\s+confiden(?:t|ce)\b|\bconfidence\s+scor(?:e|ing)\b/i;

/** True when `text` plausibly asks for AI-based classification/decision-making, per the vocabulary above. */
export function claimsAiClassificationSemantics(text: string): boolean {
  return AI_CLASSIFICATION_CLAIM_MARKERS.test(text ?? '');
}

export type AiClassificationClaimValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates that a generated graph backs up any AI-classification claim in
 * the request with a real magicflux-nodes.aiClassifier node. A request with
 * no such claim always passes -- this never forces the node type onto
 * unrelated automations.
 */
export function validateAiClassificationClaim(
  rawUserIntent: string,
  nodesDescription: string,
  nodes: unknown[]
): AiClassificationClaimValidation {
  const claimText = `${rawUserIntent ?? ''} ${nodesDescription ?? ''}`;
  if (!claimsAiClassificationSemantics(claimText)) return { ok: true };

  const hasClassifierNode = (Array.isArray(nodes) ? nodes : []).some((n) => {
    if (!n || typeof n !== 'object') return false;
    const type = String((n as Record<string, unknown>).type ?? '');
    return type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase();
  });

  if (hasClassifierNode) return { ok: true };
  return { ok: false, reason: MISSING_AI_CLASSIFIER_MESSAGE };
}
