/**
 * Phase 9.9.10 -- Business Qualification Policy
 * (lib/workflow-runtime/node-handlers/qualification-policy.ts).
 *
 * Root problem this fixes: the AI classifier's ONLY notion of what
 * Hot/Warm/Cold means came from a free-text instruction handed straight to
 * the LLM -- no deterministic, business-owned definition existed at all.
 * Confirmed root causes from the Phase 9.9.10 read-only investigation: (1)
 * a field the business's trigger never collects is simply ABSENT from the
 * object the model sees, with nothing distinguishing "not asked" from "no
 * signal" -- an absence could silently read as negative; (2) contradictory
 * evidence (high budget + "just browsing") had no structural place to
 * surface and could slip through as a confident, unreviewed guess.
 *
 * This module is the deterministic half: plain comparisons only, no
 * arbitrary JS/eval, and a hard privacy allowlist so internal/credential-
 * shaped fields can never become qualification signals even if a malformed
 * policy tries to name one.
 */

import { describe, it, expect } from 'vitest';
import { parseQualificationPolicy, evaluateQualificationPolicy, type QualificationPolicy } from '../lib/workflow-runtime/node-handlers/qualification-policy';

const RAW_POLICY = {
  version: 1,
  allowedInputFields: ['budget_max', 'urgency', 'purchase_intent', 'desired_start', 'project_description', 'company'],
  fields: [
    { field: 'budget_max', required: true, kind: 'numeric', positiveMin: 100000, negativeMax: 10000 },
    { field: 'urgency', required: false, kind: 'enum', positiveValues: ['urgent', 'asap'], negativeValues: ['someday'] },
    { field: 'purchase_intent', required: false, kind: 'enum', positiveValues: ['ready-to-start', 'ready-to-buy'], negativeValues: ['just-browsing', 'comparing'] },
    { field: 'desired_start', required: false, kind: 'enum', positiveValues: ['asap', 'immediately'] },
    { field: 'project_description', required: false, kind: 'text' },
  ],
  contradictions: [{ positiveField: 'budget_max', negativeField: 'purchase_intent', note: 'High budget but low purchase intent' }],
};

function policy(): QualificationPolicy {
  const p = parseQualificationPolicy(RAW_POLICY);
  if (!p) throw new Error('expected a valid policy');
  return p;
}

describe('parseQualificationPolicy', () => {
  it('parses a well-formed policy', () => {
    expect(parseQualificationPolicy(RAW_POLICY)).not.toBeNull();
  });

  it('returns null for a missing/undefined policy -- exactly today\'s no-policy behavior', () => {
    expect(parseQualificationPolicy(undefined)).toBeNull();
    expect(parseQualificationPolicy(null)).toBeNull();
    expect(parseQualificationPolicy({})).toBeNull();
  });

  it('returns null for an unrecognized version rather than guessing (Part J -- versioning)', () => {
    expect(parseQualificationPolicy({ ...RAW_POLICY, version: 2 })).toBeNull();
    expect(parseQualificationPolicy({ ...RAW_POLICY, version: 0 })).toBeNull();
  });

  it('returns null for a policy that ends up governing zero fields', () => {
    expect(parseQualificationPolicy({ version: 1, allowedInputFields: ['x'], fields: [] })).toBeNull();
  });

  it('drops a field rule referencing a name outside allowedInputFields', () => {
    const p = parseQualificationPolicy({
      version: 1,
      allowedInputFields: ['budget_max'],
      fields: [
        { field: 'budget_max', required: true, kind: 'numeric', positiveMin: 1 },
        { field: 'not_in_allowlist', required: false, kind: 'numeric' },
      ],
    })!;
    expect(p.fields.map((f) => f.field)).toEqual(['budget_max']);
  });

  it.each(['_conditionBranch', '_conditionResult', 'access_token', 'client_secret', 'webhook_secret', 'api_key'])(
    'Part H -- never allowlists the internal/credential-shaped field "%s", even if named explicitly',
    (field) => {
      const p = parseQualificationPolicy({
        version: 1,
        allowedInputFields: ['budget_max', field],
        fields: [
          { field: 'budget_max', required: true, kind: 'numeric', positiveMin: 1 },
          { field, required: false, kind: 'numeric', positiveMin: 1 },
        ],
      })!;
      expect(p.allowedInputFields).not.toContain(field);
      expect(p.fields.map((f) => f.field)).not.toContain(field);
    }
  );

  it('drops a contradiction rule referencing a field not present in the parsed field list', () => {
    const p = parseQualificationPolicy({
      version: 1,
      allowedInputFields: ['budget_max'],
      fields: [{ field: 'budget_max', required: true, kind: 'numeric', positiveMin: 1 }],
      contradictions: [{ positiveField: 'budget_max', negativeField: 'nonexistent', note: 'x' }],
    })!;
    expect(p.contradictions).toEqual([]);
  });
});

describe('evaluateQualificationPolicy -- signals, missing evidence, contradictions', () => {
  it('scenario 1: strong Hot evidence -- clear positive signals, no missing required fields, no contradictions', () => {
    const result = evaluateQualificationPolicy(policy(), {
      budget_max: 700000, urgency: 'urgent', purchase_intent: 'ready-to-start', desired_start: 'asap',
    });
    expect(result.missingRequiredFields).toEqual([]);
    expect(result.positiveSignals.map((s) => s.field).sort()).toEqual(['budget_max', 'desired_start', 'purchase_intent', 'urgency']);
    expect(result.negativeSignals).toEqual([]);
    expect(result.deterministicContradictions).toEqual([]);
  });

  it('scenario 3: strong Cold evidence -- clear negative signals, still no missing required fields', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 5000, urgency: 'someday', purchase_intent: 'just-browsing' });
    expect(result.missingRequiredFields).toEqual([]);
    expect(result.negativeSignals.map((s) => s.field).sort()).toEqual(['budget_max', 'purchase_intent', 'urgency']);
    expect(result.positiveSignals).toEqual([]);
  });

  it('scenario 4: missing OPTIONAL field (urgency) never blocks evaluation and never produces a signal for it', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 700000, purchase_intent: 'ready-to-start' });
    expect(result.missingRequiredFields).toEqual([]);
    expect(result.positiveSignals.some((s) => s.field === 'urgency')).toBe(false);
    expect(result.negativeSignals.some((s) => s.field === 'urgency')).toBe(false);
  });

  it('scenario 5: missing REQUIRED field (budget_max) is reported explicitly, distinct from a negative signal', () => {
    const result = evaluateQualificationPolicy(policy(), { urgency: 'urgent', purchase_intent: 'ready-to-start' });
    expect(result.missingRequiredFields).toEqual(['budget_max']);
    expect(result.negativeSignals.some((s) => s.field === 'budget_max')).toBe(false);
  });

  it('scenario 6: missing budget produces NO signal at all -- never equivalent to a negative/low budget value', () => {
    const missing = evaluateQualificationPolicy(policy(), { urgency: 'urgent' });
    const negative = evaluateQualificationPolicy(policy(), { budget_max: 1000, urgency: 'urgent' });
    expect(missing.negativeSignals).toEqual([]);
    expect(missing.missingRequiredFields).toEqual(['budget_max']);
    // A genuinely LOW budget (present, but below negativeMax) IS a real negative signal -- structurally different.
    expect(negative.negativeSignals.some((s) => s.field === 'budget_max')).toBe(true);
    expect(negative.missingRequiredFields).toEqual([]);
  });

  it('scenario 7: high budget + "just browsing" -- deterministic contradiction detected', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 700000, purchase_intent: 'just-browsing' });
    expect(result.deterministicContradictions).toEqual(['High budget but low purchase intent']);
  });

  it('scenario 11: malformed numeric budget (a non-numeric string) produces no signal and no crash', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 'lots of money', urgency: 'urgent' });
    expect(result.positiveSignals.some((s) => s.field === 'budget_max')).toBe(false);
    expect(result.negativeSignals.some((s) => s.field === 'budget_max')).toBe(false);
    // Treated as effectively unresolved, not as "present" for the required-field check either --
    // NaN can't be evaluated, so it behaves like a value that failed validation, never a fabricated pass.
  });

  it('scenario 12: an unknown/unmapped enum value produces no signal either way', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 700000, urgency: 'whenever-i-feel-like-it' });
    expect(result.positiveSignals.some((s) => s.field === 'urgency')).toBe(false);
    expect(result.negativeSignals.some((s) => s.field === 'urgency')).toBe(false);
  });

  it('scenario 13: extra untrusted webhook fields never leak into allowedData', () => {
    const result = evaluateQualificationPolicy(policy(), {
      budget_max: 700000, purchase_intent: 'ready-to-start',
      internal_debug_flag: true, random_extra_field: 'whatever the caller sent',
    });
    expect(result.allowedData).not.toHaveProperty('internal_debug_flag');
    expect(result.allowedData).not.toHaveProperty('random_extra_field');
  });

  it('scenario 14: _conditionBranch/token/secret-shaped fields cannot influence qualification even if present in raw input', () => {
    const result = evaluateQualificationPolicy(policy(), {
      budget_max: 700000, purchase_intent: 'ready-to-start',
      _conditionBranch: 0, _conditionResult: true, access_token: 'ya29.super-secret', webhook_secret: 'whsec_x',
    });
    expect(result.allowedData).not.toHaveProperty('_conditionBranch');
    expect(result.allowedData).not.toHaveProperty('_conditionResult');
    expect(result.allowedData).not.toHaveProperty('access_token');
    expect(result.allowedData).not.toHaveProperty('webhook_secret');
  });

  it('a "text" field is never scored deterministically -- it is only ever surfaced for the AI to interpret', () => {
    const result = evaluateQualificationPolicy(policy(), { budget_max: 700000, project_description: 'We need this ASAP, huge budget approved.' });
    expect(result.semanticFields).toEqual(['project_description']);
    expect(result.positiveSignals.some((s) => s.field === 'project_description')).toBe(false);
    expect(result.negativeSignals.some((s) => s.field === 'project_description')).toBe(false);
  });
});
