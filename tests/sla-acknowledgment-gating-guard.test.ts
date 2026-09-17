/**
 * Phase 9.9.13 Part J -- SLA acknowledgment gating guard.
 *
 * Proves: an SLA node (createAcknowledgmentChallenge / waitForAcknowledgment)
 * downstream of a multi-label AI Classifier must be reachable ONLY through a
 * conditional gate checking the classifier's own field -- never
 * unconditionally from every classification outcome (Warm/Cold must never
 * silently get the same SLA treatment as Hot).
 */

import { describe, it, expect } from 'vitest';
import { validateSlaAcknowledgmentGating } from '../lib/agent/sla-acknowledgment-gating-guard';

const CLASSIFIER = {
  id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold: 0.6 },
};
const SINGLE_LABEL_CLASSIFIER = {
  id: '1b', name: 'Sentiment', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify.', allowedLabels: ['Positive'], outputField: 'classification', confidenceThreshold: 0.6 },
};
const IF_HOT = { id: '2', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } };
const IF_WARM = { id: '3', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } };
const AIRTABLE_HOT = { id: '4', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable', parameters: {} };
const AIRTABLE_WARM = { id: '5', name: 'Airtable Warm', type: 'n8n-nodes-base.airtable', parameters: {} };
const AIRTABLE_COLD = { id: '6', name: 'Airtable Cold', type: 'n8n-nodes-base.airtable', parameters: {} };
const CHALLENGE = { id: '7', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes: 15 } };
const WAIT_ACK = { id: '8', name: 'Wait For Acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes: 15 } };
const GMAIL = { id: '9', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: {} };

describe('validateSlaAcknowledgmentGating', () => {
  it('passes a graph with no SLA node at all', () => {
    expect(validateSlaAcknowledgmentGating([CLASSIFIER, AIRTABLE_HOT], {})).toEqual({ ok: true });
  });

  it('passes an SLA node with no upstream AI Classifier', () => {
    const connections = { 'Airtable Hot': { main: [[{ node: 'Create Acknowledgment Challenge' }]] } };
    expect(validateSlaAcknowledgmentGating([AIRTABLE_HOT, CHALLENGE], connections)).toEqual({ ok: true });
  });

  it('passes an SLA node downstream of a SINGLE-label classifier (nothing to gate)', () => {
    const connections = {
      'Sentiment': { main: [[{ node: 'Create Acknowledgment Challenge' }]] },
    };
    expect(validateSlaAcknowledgmentGating([SINGLE_LABEL_CLASSIFIER, CHALLENGE], connections)).toEqual({ ok: true });
  });

  it('passes the correct reference topology: SLA node reachable ONLY through "If Hot"', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'If Hot' }], [{ node: 'If Warm' }]] },
      'If Hot': { main: [[{ node: 'Create Acknowledgment Challenge' }], []] },
      'If Warm': { main: [[{ node: 'Airtable Warm' }], []] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Airtable Hot' }]] },
    };
    expect(
      validateSlaAcknowledgmentGating([CLASSIFIER, IF_HOT, IF_WARM, CHALLENGE, AIRTABLE_HOT, AIRTABLE_WARM], connections)
    ).toEqual({ ok: true });
  });

  it('rejects an SLA node wired UNCONDITIONALLY straight off the classifier (no gate at all)', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'Create Acknowledgment Challenge' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Airtable Hot' }]] },
    };
    const result = validateSlaAcknowledgmentGating([CLASSIFIER, CHALLENGE, AIRTABLE_HOT], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Create Acknowledgment Challenge');
      expect(result.reason).toMatch(/without passing through any conditional/i);
    }
  });

  it('rejects an SLA node reachable via a path that never crosses ANY gate on the classifier field, even when a separate gated path also exists', () => {
    const UNRELATED_IF = { id: '10', name: 'Has Budget?', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["budget"]}}', operation: 'equal', value2: 'high' }] } } };
    const connections = {
      'AI Classifier': { main: [[{ node: 'If Hot' }], [{ node: 'Has Budget?' }]] },
      'If Hot': { main: [[{ node: 'Create Acknowledgment Challenge' }], []] },
      // "Has Budget?" does not reference the classifier's own field at all --
      // crossing it must NOT count as a qualifying gate.
      'Has Budget?': { main: [[{ node: 'Create Acknowledgment Challenge' }], [{ node: 'Airtable Warm' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Airtable Hot' }]] },
    };
    const result = validateSlaAcknowledgmentGating([CLASSIFIER, IF_HOT, UNRELATED_IF, CHALLENGE, AIRTABLE_HOT, AIRTABLE_WARM], connections);
    expect(result.ok).toBe(false);
  });

  it('rejects a self-contained waitForAcknowledgment node reachable unconditionally', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'Gmail' }]] },
      'Gmail': { main: [[{ node: 'Wait For Acknowledgment' }]] },
    };
    const result = validateSlaAcknowledgmentGating([CLASSIFIER, GMAIL, WAIT_ACK], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.node).toBe('Wait For Acknowledgment');
  });

  it('passes when Cold correctly has no SLA node at all (only Hot does)', () => {
    const connections = {
      'AI Classifier': { main: [[{ node: 'If Hot' }], [{ node: 'If Warm' }]] },
      'If Hot': { main: [[{ node: 'Create Acknowledgment Challenge' }], []] },
      'If Warm': { main: [[{ node: 'Airtable Warm' }], [{ node: 'Airtable Cold' }]] },
      'Create Acknowledgment Challenge': { main: [[{ node: 'Airtable Hot' }]] },
    };
    expect(
      validateSlaAcknowledgmentGating([CLASSIFIER, IF_HOT, IF_WARM, CHALLENGE, AIRTABLE_HOT, AIRTABLE_WARM, AIRTABLE_COLD], connections)
    ).toEqual({ ok: true });
  });

  it('malformed/empty nodes and connections never throw', () => {
    expect(validateSlaAcknowledgmentGating(undefined as unknown as unknown[], {})).toEqual({ ok: true });
    expect(validateSlaAcknowledgmentGating([null, 42, 'x', {}], {})).toEqual({ ok: true });
  });
});
