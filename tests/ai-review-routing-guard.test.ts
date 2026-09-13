/**
 * Phase 9.9.3.1 — AI Classifier -> Human Review routing, product-truth guard.
 *
 * Structural port-count validation (branch-connection-guard.ts) already
 * rejects a multi-port classifier wiring. This guard catches the remaining
 * gap: a SINGLE-port direct edge from magicflux-nodes.aiClassifier straight
 * to magicflux-nodes.humanReview, which is structurally "valid" (one port)
 * but still product-false -- Human Review must always be reached through a
 * real IF node reading "needs_review", never wired as if the classifier
 * itself could route there.
 */

import { describe, it, expect } from 'vitest';
import { validateAiReviewRoutingContract } from '../lib/agent/ai-review-routing-guard';

const CLASSIFIER = {
  id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify the lead.', allowedLabels: ['Hot', 'Warm', 'Cold'], confidenceThreshold: 0.6 },
};
const REVIEW = { id: '2', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: {} };
const NEEDS_REVIEW_IF = {
  id: '3', name: 'Needs Review?', type: 'n8n-nodes-base.if',
  parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } },
};
const UNRELATED_IF = { id: '4', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: {} } };
const ACTION = { id: '5', name: 'Confident Path Action', type: 'n8n-nodes-base.set', parameters: {} };

describe('validateAiReviewRoutingContract', () => {
  it('passes a graph with no classifier and no review node', () => {
    expect(validateAiReviewRoutingContract([ACTION], {})).toEqual({ ok: true });
  });

  it('passes a classifier with no human review node in the graph at all', () => {
    const connections = { 'AI Classifier': { main: [[{ node: 'Confident Path Action' }]] } };
    expect(validateAiReviewRoutingContract([CLASSIFIER, ACTION], connections)).toEqual({ ok: true });
  });

  it('passes a human review node with no classifier in the graph at all', () => {
    expect(validateAiReviewRoutingContract([REVIEW], {})).toEqual({ ok: true });
  });

  it('rejects a direct single-port edge from the classifier straight to Human Review', () => {
    const connections = { 'AI Classifier': { main: [[{ node: 'Human Review' }]] } };
    const result = validateAiReviewRoutingContract([CLASSIFIER, REVIEW], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('AI Classifier');
      expect(result.reason).toMatch(/directly to Human Review/i);
    }
  });

  it('rejects the exact Phase 9.9.4 multi-port shape too (belt-and-suspenders alongside the structural guard)', () => {
    const connections = {
      'AI Classifier': {
        main: [[{ node: 'Confident Path Action' }], [{ node: 'Human Review' }]],
      },
    };
    const result = validateAiReviewRoutingContract([CLASSIFIER, REVIEW, ACTION], connections);
    expect(result.ok).toBe(false);
  });

  it('rejects a classifier that reaches Human Review indirectly without a needs_review gate in between', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'If Hot' }]] },
      'If Hot': { main: [[{ node: 'Human Review' }], []] },
    };
    const result = validateAiReviewRoutingContract([CLASSIFIER, UNRELATED_IF, REVIEW], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/needs_review/i);
  });

  it('accepts the corrected topology: AI Classifier -> IF needs_review -> Human Review', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'Confident Path Action' }]] },
    };
    const result = validateAiReviewRoutingContract([CLASSIFIER, NEEDS_REVIEW_IF, REVIEW, ACTION], connections);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a needs_review-shaped IF gate name/type that does not actually read needs_review in its parameters', () => {
    const fakeGate = { id: '6', name: 'Needs Review?', type: 'n8n-nodes-base.if', parameters: { conditions: {} } };
    const connections = {
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], []] },
    };
    const result = validateAiReviewRoutingContract([CLASSIFIER, fakeGate, REVIEW], connections);
    expect(result.ok).toBe(false);
  });
});
