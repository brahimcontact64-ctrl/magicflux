/**
 * Phase 9.9.4D — Airtable semantic field-preservation guard
 * (lib/agent/airtable-persistence-guard.ts).
 *
 * The exact production regression: adding a "Confidence" mapping (Phase
 * 9.9.4C) caused "Email" to silently disappear from the SAME Airtable
 * node's "fields" on the next regeneration -- because field selection was
 * entirely up to the LLM's own free-form judgment, re-improvised from
 * prompt prose every time. This guard replaces that with a deterministic
 * completeness check against two EXPLICIT sources: the tool's own
 * "record_identity_fields" argument, and whatever an upstream aiClassifier
 * node guarantees (its outputField + "confidence").
 */

import { describe, it, expect } from 'vitest';
import { validateAirtablePersistenceCompleteness } from '../lib/agent/airtable-persistence-guard';

const CLASSIFIER = {
  id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify.', allowedLabels: ['Hot', 'Warm', 'Cold'], outputField: 'classification', confidenceThreshold: 0.6 },
};

function airtableNode(fields: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: '2', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields, ...overrides } };
}

const CLASSIFIER_CONNECTIONS = { 'AI Classifier': { main: [[{ node: 'Save to Airtable' }]] } };

describe('validateAirtablePersistenceCompleteness', () => {
  it('passes a graph with no Airtable node at all', () => {
    expect(validateAirtablePersistenceCompleteness([CLASSIFIER], {}, ['name', 'email'])).toEqual({ ok: true });
  });

  it('passes an unrelated workflow with no recordIdentityFields and no upstream classifier -- never forced to contain lead-specific fields', () => {
    const node = airtableNode({ Title: '={{$json["title"]}}' });
    expect(validateAirtablePersistenceCompleteness([node], {})).toEqual({ ok: true });
    // Explicitly confirm it does NOT require "name"/"email"/"classification"/"confidence" out of nowhere.
    expect(validateAirtablePersistenceCompleteness([node], {}, [])).toEqual({ ok: true });
  });

  it('rejects when a declared record_identity_field is missing from the mapping', () => {
    const node = airtableNode({ Name: '={{$json["name"]}}' });
    const result = validateAirtablePersistenceCompleteness([node], {}, ['name', 'email']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Save to Airtable');
      expect(result.reason).toMatch(/email/i);
    }
  });

  it('accepts when all declared record_identity_fields are present, regardless of destination key names', () => {
    const node = airtableNode({ 'Lead Name': '={{$json["name"]}}', 'Contact Email': '={{$json["email"]}}' });
    expect(validateAirtablePersistenceCompleteness([node], {}, ['name', 'email'])).toEqual({ ok: true });
  });

  it('rejects when the upstream classifier\'s outputField is missing, even with no recordIdentityFields declared', () => {
    const node = airtableNode({ Name: '={{$json["name"]}}' });
    const result = validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/classification/i);
  });

  it('rejects when "confidence" is missing even though classification is present', () => {
    const node = airtableNode({ Classification: '={{$json["classification"]}}' });
    const result = validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/confidence/i);
  });

  describe('Phase 9.9.4D exact regression: adding Confidence must not remove Email', () => {
    it('rejects the exact regressed shape -- Confidence added, Email dropped', () => {
      const node = airtableNode({ 'Lead Name': '={{$json["name"]}}', Confidence: '={{$json["confidence"]}}', Classification: '={{$json["classification"]}}' });
      const result = validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, ['name', 'email']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/email/i);
    });

    it('accepts the fully correct shape -- name, email, classification, AND confidence all present', () => {
      const node = airtableNode({
        'Lead Name': '={{$json["name"]}}',
        'Email Address': '={{$json["email"]}}',
        Classification: '={{$json["classification"]}}',
        Confidence: '={{$json["confidence"]}}',
      });
      const result = validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, ['name', 'email']);
      expect(result).toEqual({ ok: true });
    });

    it('rejects the Phase 9.9.4 original shape too -- Email present but Confidence missing (pre-9.9.4C regression)', () => {
      const node = airtableNode({ Name: '={{$json["name"]}}', Email: '={{$json["email"]}}', Classification: '={{$json["classification"]}}' });
      const result = validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, ['name', 'email']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/confidence/i);
    });
  });

  it('checks every Airtable node independently -- one correct node does not excuse another missing a field', () => {
    const good = airtableNode({ Name: '={{$json["name"]}}', Email: '={{$json["email"]}}', Classification: '={{$json["classification"]}}', Confidence: '={{$json["confidence"]}}' }, {});
    const bad = { id: '3', name: 'Save to Airtable (Warm)', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}', Classification: '={{$json["classification"]}}', Confidence: '={{$json["confidence"]}}' } } };
    const connections = { 'AI Classifier': { main: [[{ node: 'Save to Airtable' }, { node: 'Save to Airtable (Warm)' }]] } };
    const result = validateAirtablePersistenceCompleteness([CLASSIFIER, good, bad], connections, ['name', 'email']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.node).toBe('Save to Airtable (Warm)');
  });

  it('is generic across arbitrary identity field sets and classifier output fields, not hardcoded to name/email/classification/confidence', () => {
    const orderClassifier = { id: '1', name: 'Risk Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Low', 'High'], outputField: 'risk_level' } };
    const node = { id: '2', name: 'Save Order', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { OrderId: '={{$json["order_id"]}}' } } };
    const connections = { 'Risk Classifier': { main: [[{ node: 'Save Order' }]] } };
    const result = validateAirtablePersistenceCompleteness([orderClassifier, node], connections, ['order_id']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/risk_level/i);
  });

  it('list/get/delete Airtable operations are exempt (they never write a record)', () => {
    const node = airtableNode({ Name: '={{$json["name"]}}' }, { operation: 'list' });
    expect(validateAirtablePersistenceCompleteness([CLASSIFIER, node], CLASSIFIER_CONNECTIONS, ['name', 'email'])).toEqual({ ok: true });
  });

  it('handles malformed/non-array input safely', () => {
    expect(validateAirtablePersistenceCompleteness(undefined as unknown as unknown[], {}, ['name'])).toEqual({ ok: true });
    expect(validateAirtablePersistenceCompleteness([null, 42, 'x', {}], {}, ['name'])).toEqual({ ok: true });
  });
});
