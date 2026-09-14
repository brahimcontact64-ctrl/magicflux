/**
 * Phase 9.9.3.2 / 9.9.4C — Human Review decision-authority routing guard.
 *
 * Two checks:
 *   1. Detects the stale-reevaluation antipattern: Human Review's outcome
 *      ports feeding a conditional node that re-checks the upstream
 *      aiClassifier's original field, which would silently drop a
 *      disagreeing human decision.
 *   2. (9.9.4C) Whenever Human Review's own allowedOutcomes are exactly the
 *      classifier's allowedLabels (a genuine classification review), its
 *      "outputField" MUST be configured to match the classifier's own
 *      "outputField" -- regardless of routing topology -- so downstream
 *      DATA (an Airtable mapping, a message template) reflects the human's
 *      decision, not just whichever branch happens to fire.
 * Generic -- traces whatever outputField name/labels the classifier and
 * review node actually declare, never hardcoded to classification/Hot-Warm-Cold.
 */

import { describe, it, expect } from 'vitest';
import { validateHumanReviewOutcomeRouting } from '../lib/agent/human-review-routing-guard';

const CLASSIFIER = {
  id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold: 0.6 },
};
const NEEDS_REVIEW_IF = {
  id: '2', name: 'Needs Review?', type: 'n8n-nodes-base.if',
  parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } },
};
const REVIEW = { id: '3', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Hot', 'Warm', 'Cold'] } };
const REVIEW_WITH_OUTPUT_FIELD = { ...REVIEW, parameters: { ...REVIEW.parameters, outputField: 'classification' } };
const IF_HOT = { id: '4', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } };
const IF_WARM = { id: '5', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } };
const IF_COLD = { id: '6', name: 'If Cold', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Cold' }] } } };
const HOT_ACTION = { id: '7', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable', parameters: {} };
const WARM_ACTION = { id: '8', name: 'Airtable Warm', type: 'n8n-nodes-base.airtable', parameters: {} };
const COLD_ACTION = { id: '9', name: 'Airtable Cold', type: 'n8n-nodes-base.airtable', parameters: {} };

function nodesWith(review: unknown) {
  return [CLASSIFIER, NEEDS_REVIEW_IF, review, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION, WARM_ACTION, COLD_ACTION];
}

function baseConnections(reviewMain: unknown) {
  return {
    'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
    'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'If Hot' }]] },
    'Human Review': { main: reviewMain },
    'If Hot': { main: [[{ node: 'Airtable Hot' }], []] },
    'If Warm': { main: [[{ node: 'Airtable Warm' }], []] },
    'If Cold': { main: [[{ node: 'Airtable Cold' }], []] },
  };
}

const DIRECT_PORTS = [[{ node: 'Airtable Hot' }], [{ node: 'Airtable Warm' }], [{ node: 'Airtable Cold' }]];
const RECHECK_PORTS = [[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]];

describe('validateHumanReviewOutcomeRouting', () => {
  it('passes a graph with no Human Review node', () => {
    expect(validateHumanReviewOutcomeRouting([CLASSIFIER], {})).toEqual({ ok: true });
  });

  it('passes a Human Review node with no upstream AI Classifier at all', () => {
    const connections = { 'Human Review': { main: [[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]] } };
    expect(validateHumanReviewOutcomeRouting([REVIEW, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION], connections)).toEqual({ ok: true });
  });

  describe('Phase 9.9.4C -- genuine classification review requires outputField', () => {
    it('rejects a classification review (outcomes == classifier labels) with no outputField, even with PREFERRED direct-port routing', () => {
      const connections = baseConnections(DIRECT_PORTS);
      const result = validateHumanReviewOutcomeRouting(nodesWith(REVIEW), connections);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.node).toBe('Human Review');
        expect(result.reason).toMatch(/outputField/);
        expect(result.reason).toMatch(/classification/i);
      }
    });

    it('rejects a classification review with no outputField even with the rejoined re-check-IF routing', () => {
      const connections = baseConnections(RECHECK_PORTS);
      const result = validateHumanReviewOutcomeRouting(nodesWith(REVIEW), connections);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/outputField/);
    });

    it('accepts a classification review WITH correct outputField, PREFERRED direct-port routing', () => {
      const connections = baseConnections(DIRECT_PORTS);
      expect(validateHumanReviewOutcomeRouting(nodesWith(REVIEW_WITH_OUTPUT_FIELD), connections)).toEqual({ ok: true });
    });

    it('accepts a classification review WITH correct outputField even when rejoining the re-check-IF chain (outputField makes it safe)', () => {
      const connections = baseConnections(RECHECK_PORTS);
      expect(validateHumanReviewOutcomeRouting(nodesWith(REVIEW_WITH_OUTPUT_FIELD), connections)).toEqual({ ok: true });
    });

    it('rejects when outputField is set but does NOT match the classifier\'s outputField', () => {
      const reviewWithWrongField = { ...REVIEW, parameters: { ...REVIEW.parameters, outputField: 'decision_label' } };
      const connections = baseConnections(DIRECT_PORTS);
      const result = validateHumanReviewOutcomeRouting(nodesWith(reviewWithWrongField), connections);
      expect(result.ok).toBe(false);
    });

    it('does not require outputField for a review unrelated to the classifier (different outcomes, e.g. approve/reject)', () => {
      const approvalReview = { id: '3', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['approve', 'reject'] } };
      const connections = {
        'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
        'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'If Hot' }]] },
        'Human Review': { main: [[{ node: 'Airtable Hot' }], [{ node: 'Airtable Cold' }]] },
      };
      expect(validateHumanReviewOutcomeRouting([CLASSIFIER, NEEDS_REVIEW_IF, approvalReview, HOT_ACTION, COLD_ACTION], connections)).toEqual({ ok: true });
    });
  });

  it('is generic across arbitrary outputField names and outcome labels, not hardcoded to classification/Hot/Warm/Cold', () => {
    const customClassifier = { id: '1', name: 'Sentiment Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Positive', 'Negative'], outputField: 'sentiment' } };
    const gate = { id: '2', name: 'Needs Review?', type: 'n8n-nodes-base.if', parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } } };
    const review = { id: '3', name: 'Sentiment Review', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Positive', 'Negative'] } };
    const recheck = { id: '4', name: 'If Positive', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["sentiment"]}}', operation: 'equal', value2: 'Positive' }] } } };
    const nodes = [customClassifier, gate, review, recheck];
    const connections = {
      'Sentiment Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Sentiment Review' }], [{ node: 'If Positive' }]] },
      'Sentiment Review': { main: [[{ node: 'If Positive' }], []] },
    };
    const result = validateHumanReviewOutcomeRouting(nodes, connections);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sentiment/i);
  });

  it('ignores a Human Review port target that is not a conditional node at all (e.g. a direct action node)', () => {
    const connections = baseConnections(DIRECT_PORTS);
    expect(validateHumanReviewOutcomeRouting(nodesWith(REVIEW_WITH_OUTPUT_FIELD), connections)).toEqual({ ok: true });
  });

  it('handles malformed/non-array input safely', () => {
    expect(validateHumanReviewOutcomeRouting(undefined as unknown as unknown[], {})).toEqual({ ok: true });
    expect(validateHumanReviewOutcomeRouting([null, 42, 'x', {}], {})).toEqual({ ok: true });
  });
});
