/**
 * Phase 9.9.2 — Human Review product-truth guard.
 *
 * Mirrors ai-classification-guard.test.ts: a request that plausibly claims
 * human review/approval semantics must be backed by a real
 * magicflux-nodes.humanReview node, or generation is rejected.
 */

import { describe, it, expect } from 'vitest';
import { claimsHumanReviewSemantics, validateHumanReviewClaim, MISSING_HUMAN_REVIEW_MESSAGE } from '../lib/agent/human-review-guard';

const REVIEW_NODE = { id: '3', name: 'Review Lead', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'x', allowedOutcomes: ['approve', 'reject'] } };
const SET_NODE = { id: '4', name: 'Flag for Review', type: 'n8n-nodes-base.set', parameters: { fields: { Review: 'Required' } } };
const WEBHOOK_NODE = { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };

const CLAIM_PROMPT = 'If the AI cannot classify the lead confidently, flag it for human review instead of guessing.';

describe('claimsHumanReviewSemantics', () => {
  it('detects the exact production regression phrase', () => {
    expect(claimsHumanReviewSemantics(CLAIM_PROMPT)).toBe(true);
  });

  it('detects "requires approval"', () => {
    expect(claimsHumanReviewSemantics('Refunds over $500 require approval before processing.')).toBe(true);
  });

  it('detects "escalate to a human"', () => {
    expect(claimsHumanReviewSemantics('Escalate to a human if the order looks risky.')).toBe(true);
  });

  it('does not flag an automation with no review/approval semantics at all', () => {
    expect(claimsHumanReviewSemantics('If the order amount is greater than 100, mark it as VIP.')).toBe(false);
  });

  it('does not flag a passing mention of "review" unrelated to a human-in-the-loop gate', () => {
    expect(claimsHumanReviewSemantics('Post a review summary to Slack every morning.')).toBe(false);
  });
});

describe('validateHumanReviewClaim', () => {
  it('rejects the exact production regression: claim present, only a Set-node placeholder in the graph', () => {
    const result = validateHumanReviewClaim(CLAIM_PROMPT, 'Flag uncertain leads for review.', [WEBHOOK_NODE, SET_NODE]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(MISSING_HUMAN_REVIEW_MESSAGE);
  });

  it('accepts the claim when a real humanReview node is present', () => {
    const result = validateHumanReviewClaim(CLAIM_PROMPT, 'Flag uncertain leads for review.', [WEBHOOK_NODE, REVIEW_NODE]);
    expect(result).toEqual({ ok: true });
  });

  it('never forces the node type onto a request with no review claim at all', () => {
    const result = validateHumanReviewClaim('If the order amount is greater than 100, mark it as VIP.', 'Branch on amount.', [WEBHOOK_NODE]);
    expect(result).toEqual({ ok: true });
  });

  it('handles malformed/non-array nodes input safely', () => {
    const result = validateHumanReviewClaim(CLAIM_PROMPT, '', undefined as unknown as unknown[]);
    expect(result.ok).toBe(false);
  });
});
