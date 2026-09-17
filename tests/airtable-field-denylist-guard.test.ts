/**
 * Phase 9.9.13A Part B -- Airtable field-mapping denylist guard.
 * Mirrors notification-content-guard.test.ts's own coverage, applied to
 * Airtable "fields" mappings instead of Gmail/Slack message parameters.
 */

import { describe, it, expect } from 'vitest';
import { validateAirtableFieldDenylist } from '../lib/agent/airtable-field-denylist-guard';

describe('validateAirtableFieldDenylist', () => {
  it('passes a graph with no Airtable node', () => {
    expect(validateAirtableFieldDenylist([{ id: '1', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: {} }])).toEqual({ ok: true });
  });

  it('passes an Airtable node whose fields only reference real business fields', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}' } } };
    expect(validateAirtableFieldDenylist([node])).toEqual({ ok: true });
  });

  it('rejects a mapping referencing _conditionBranch', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Branch: '={{$json["_conditionBranch"]}}' } } };
    const result = validateAirtableFieldDenylist([node]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.node).toBe('Save');
  });

  it('rejects a mapping referencing _qualificationDecisionId', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Ref: '={{$json["_qualificationDecisionId"]}}' } } };
    expect(validateAirtableFieldDenylist([node]).ok).toBe(false);
  });

  it('rejects a mapping referencing a credential-shaped field name', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Key: '={{$json["api_key"]}}' } } };
    expect(validateAirtableFieldDenylist([node]).ok).toBe(false);
  });

  it('rejects a denylisted reference EMBEDDED inside a larger template string, not just a whole-value reference', () => {
    const node = { id: '1', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Note: 'ref: {{$json["_qualificationDecisionId"]}}' } } };
    expect(validateAirtableFieldDenylist([node]).ok).toBe(false);
  });

  it('malformed/empty nodes never throw', () => {
    expect(validateAirtableFieldDenylist(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateAirtableFieldDenylist([null, 42, 'x', {}])).toEqual({ ok: true });
  });
});
