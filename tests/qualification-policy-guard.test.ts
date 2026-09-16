/**
 * Phase 9.9.10 -- qualification policy generation/activation-time guard
 * (lib/agent/qualification-policy-guard.ts).
 */

import { describe, it, expect } from 'vitest';
import { validateQualificationPolicyShape } from '../lib/agent/qualification-policy-guard';

const VALID_POLICY = {
  version: 1,
  allowedInputFields: ['budget_max'],
  fields: [{ field: 'budget_max', required: true, kind: 'numeric', positiveMin: 1000 }],
};

function classifierNode(qualificationPolicy: unknown) {
  return {
    id: '1',
    name: 'AI Classifier',
    type: 'magicflux-nodes.aiClassifier',
    parameters: { instruction: 'x', allowedLabels: ['Hot', 'Cold'], qualificationPolicy },
  };
}

describe('validateQualificationPolicyShape', () => {
  it('passes a node with a well-formed policy', () => {
    expect(validateQualificationPolicyShape([classifierNode(VALID_POLICY)])).toEqual({ ok: true });
  });

  it('passes a node with no qualificationPolicy at all', () => {
    expect(validateQualificationPolicyShape([{ id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Hot'] } }])).toEqual({ ok: true });
  });

  it('rejects a node whose policy is structurally invalid (wrong version)', () => {
    const result = validateQualificationPolicyShape([classifierNode({ ...VALID_POLICY, version: 2 })]);
    expect(result.ok).toBe(false);
  });

  it('rejects a node whose policy references only denylisted/out-of-allowlist fields', () => {
    const result = validateQualificationPolicyShape([
      classifierNode({ version: 1, allowedInputFields: ['access_token'], fields: [{ field: 'access_token', required: true, kind: 'numeric' }] }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('a non-aiClassifier node is never checked, regardless of its parameters', () => {
    expect(
      validateQualificationPolicyShape([{ id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { qualificationPolicy: { version: 99 } } }])
    ).toEqual({ ok: true });
  });

  it('tolerates malformed input gracefully', () => {
    expect(validateQualificationPolicyShape(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateQualificationPolicyShape([null, 42, 'x', {}])).toEqual({ ok: true });
  });
});
