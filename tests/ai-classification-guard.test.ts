/**
 * Phase 9.9.1 — AI classification product-truth guard.
 *
 * Root cause this pins the fix for: the Builder narrated "AI analyzes the
 * lead based on budget, urgency, and purchase intent" while the generated
 * graph contained zero AI-inference nodes -- an unsupported-capability
 * claim, not a cosmetic issue. validateAiClassificationClaim() is the
 * deterministic backstop: a request that plausibly claims AI-based
 * classification must be backed by a real magicflux-nodes.aiClassifier
 * node, or generation is rejected before persistence.
 */

import { describe, it, expect } from 'vitest';
import { claimsAiClassificationSemantics, validateAiClassificationClaim, MISSING_AI_CLASSIFIER_MESSAGE } from '../lib/agent/ai-classification-guard';

const CLASSIFIER_NODE = { id: '2', name: 'Classify Lead', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Hot', 'Warm', 'Cold'] } };
const IF_NODE = { id: '3', name: 'Route Hot', type: 'n8n-nodes-base.if', parameters: {} };
const WEBHOOK_NODE = { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };

const LEAD_ROUTING_PROMPT =
  'When a new lead arrives through a webhook, analyze the lead information and classify it as Hot, Warm, or Cold based on budget, urgency, and purchase intent.';

describe('claimsAiClassificationSemantics', () => {
  it('detects the exact production regression prompt', () => {
    expect(claimsAiClassificationSemantics(LEAD_ROUTING_PROMPT)).toBe(true);
  });

  it('detects intent detection requests', () => {
    expect(claimsAiClassificationSemantics('Detect the customer intent from their message and route accordingly.')).toBe(true);
  });

  it('detects sentiment-based routing requests', () => {
    expect(claimsAiClassificationSemantics('Route support tickets based on sentiment.')).toBe(true);
  });

  it('does not flag a purely deterministic branch as an AI classification claim', () => {
    expect(claimsAiClassificationSemantics('If the order amount is greater than 100, mark it as VIP.')).toBe(false);
  });

  it('does not flag an unrelated automation just because it mentions "AI" in passing', () => {
    expect(claimsAiClassificationSemantics('Use AI to draft a friendly reply to this email.')).toBe(false);
  });
});

describe('validateAiClassificationClaim', () => {
  it('rejects the exact production regression: claim present, no aiClassifier node in the graph', () => {
    const result = validateAiClassificationClaim(LEAD_ROUTING_PROMPT, 'Classify the lead and route it.', [WEBHOOK_NODE, IF_NODE]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(MISSING_AI_CLASSIFIER_MESSAGE);
  });

  it('accepts the claim when a real aiClassifier node is present in the graph', () => {
    const result = validateAiClassificationClaim(LEAD_ROUTING_PROMPT, 'Classify the lead and route it.', [WEBHOOK_NODE, CLASSIFIER_NODE, IF_NODE]);
    expect(result).toEqual({ ok: true });
  });

  it('never forces the node type onto a request with no AI-classification claim at all', () => {
    const result = validateAiClassificationClaim('If the order amount is greater than 100, mark it as VIP.', 'Branch on amount.', [WEBHOOK_NODE, IF_NODE]);
    expect(result).toEqual({ ok: true });
  });

  it('handles malformed/non-array nodes input safely', () => {
    const result = validateAiClassificationClaim(LEAD_ROUTING_PROMPT, '', undefined as unknown as unknown[]);
    expect(result.ok).toBe(false);
  });
});
