/**
 * Phase 9.9.3.2 — Human Review decision-authority routing guard.
 *
 * Detects the stale-reevaluation antipattern: Human Review's outcome ports
 * feeding a conditional node that re-checks the upstream aiClassifier's
 * original field, which would silently drop a disagreeing human decision
 * (the re-check node's own condition fails, its false branch is typically
 * empty, so nothing downstream runs). Generic -- traces whatever outputField
 * name the classifier actually used, not a hardcoded "classification".
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
const IF_HOT = { id: '4', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } };
const IF_WARM = { id: '5', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } };
const IF_COLD = { id: '6', name: 'If Cold', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Cold' }] } } };
const HOT_ACTION = { id: '7', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable', parameters: {} };
const WARM_ACTION = { id: '8', name: 'Airtable Warm', type: 'n8n-nodes-base.airtable', parameters: {} };
const COLD_ACTION = { id: '9', name: 'Airtable Cold', type: 'n8n-nodes-base.airtable', parameters: {} };

const ALL_NODES = [CLASSIFIER, NEEDS_REVIEW_IF, REVIEW, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION, WARM_ACTION, COLD_ACTION];

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

describe('validateHumanReviewOutcomeRouting', () => {
  it('passes a graph with no Human Review node', () => {
    expect(validateHumanReviewOutcomeRouting([CLASSIFIER], {})).toEqual({ ok: true });
  });

  it('passes a Human Review node with no upstream AI Classifier at all', () => {
    const connections = { 'Human Review': { main: [[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]] } };
    expect(validateHumanReviewOutcomeRouting([REVIEW, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION], connections)).toEqual({ ok: true });
  });

  it('rejects Human Review outcome ports feeding a re-check IF reading the classifier\'s original field', () => {
    const connections = baseConnections([[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]]);
    const result = validateHumanReviewOutcomeRouting(ALL_NODES, connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Human Review');
      expect(result.reason).toMatch(/classification/i);
      expect(result.reason).toMatch(/zero downstream actions/i);
    }
  });

  it('accepts the PREFERRED shape: Human Review outcome ports wired directly to terminal action nodes', () => {
    const connections = baseConnections([[{ node: 'Airtable Hot' }], [{ node: 'Airtable Warm' }], [{ node: 'Airtable Cold' }]]);
    expect(validateHumanReviewOutcomeRouting(ALL_NODES, connections)).toEqual({ ok: true });
  });

  it('accepts the ALTERNATIVE shape: overwriteField matches the classifier\'s outputField', () => {
    const reviewWithOverwrite = { ...REVIEW, parameters: { ...REVIEW.parameters, overwriteField: 'classification' } };
    const connections = baseConnections([[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]]);
    const nodes = [CLASSIFIER, NEEDS_REVIEW_IF, reviewWithOverwrite, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION, WARM_ACTION, COLD_ACTION];
    expect(validateHumanReviewOutcomeRouting(nodes, connections)).toEqual({ ok: true });
  });

  it('rejects when overwriteField is set but does NOT match the classifier\'s outputField (still stale)', () => {
    const reviewWithWrongOverwrite = { ...REVIEW, parameters: { ...REVIEW.parameters, overwriteField: 'decision_label' } };
    const connections = baseConnections([[{ node: 'If Hot' }], [{ node: 'If Warm' }], [{ node: 'If Cold' }]]);
    const nodes = [CLASSIFIER, NEEDS_REVIEW_IF, reviewWithWrongOverwrite, IF_HOT, IF_WARM, IF_COLD, HOT_ACTION, WARM_ACTION, COLD_ACTION];
    const result = validateHumanReviewOutcomeRouting(nodes, connections);
    expect(result.ok).toBe(false);
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
    const connections = baseConnections([[{ node: 'Airtable Hot' }], [{ node: 'Airtable Warm' }], [{ node: 'Airtable Cold' }]]);
    expect(validateHumanReviewOutcomeRouting(ALL_NODES, connections)).toEqual({ ok: true });
  });

  it('handles malformed/non-array input safely', () => {
    expect(validateHumanReviewOutcomeRouting(undefined as unknown as unknown[], {})).toEqual({ ok: true });
    expect(validateHumanReviewOutcomeRouting([null, 42, 'x', {}], {})).toEqual({ ok: true });
  });
});
