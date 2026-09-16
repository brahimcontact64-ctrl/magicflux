/**
 * Phase 9.9.11A -- Part 9: Airtable business-dedupe product-truth guard
 * (lib/agent/airtable-dedupe-guard.ts).
 */

import { describe, it, expect } from 'vitest';
import { validateAirtableDedupeClaim } from '../lib/agent/airtable-dedupe-guard';

function airtableNode(dedupe: unknown) {
  return {
    id: '1', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable',
    parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: {}, dedupe },
  };
}

describe('validateAirtableDedupeClaim', () => {
  it('passes a node with no dedupe parameter at all', () => {
    expect(validateAirtableDedupeClaim([{ id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: {} }])).toEqual({ ok: true });
  });

  it('passes a node whose dedupe.onMatch is "update"', () => {
    expect(validateAirtableDedupeClaim([airtableNode({ version: 1, identityFields: ['Email'], onMatch: 'update' })])).toEqual({ ok: true });
  });

  it('passes a node whose dedupe.onMatch is "create"', () => {
    expect(validateAirtableDedupeClaim([airtableNode({ version: 1, identityFields: ['Email'], onMatch: 'create' })])).toEqual({ ok: true });
  });

  it('rejects a node whose dedupe.onMatch is "append" -- must never silently persist as plain create', () => {
    const result = validateAirtableDedupeClaim([airtableNode({ version: 1, identityFields: ['Email'], onMatch: 'append' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/append/);
    expect(result.reason).toMatch(/not yet implemented/);
  });

  it('a non-Airtable node is never checked, regardless of its parameters', () => {
    expect(
      validateAirtableDedupeClaim([{ id: '1', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { dedupe: { onMatch: 'append' } } }])
    ).toEqual({ ok: true });
  });

  it('tolerates malformed input gracefully', () => {
    expect(validateAirtableDedupeClaim(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateAirtableDedupeClaim([null, 42, 'x', {}])).toEqual({ ok: true });
  });
});
