/**
 * Phase 9.9.3 — generation-time guard against invented Airtable ids.
 *
 * The exact production regression: a generated Airtable node with
 * baseId "app123456" (6 characters -- not the shape of a real Airtable
 * base id) that the runtime handler never even read, silently falling
 * back to whatever base the connected account happened to have. This
 * guard rejects generation before persistence rather than letting an
 * invented id (or a dead alias key) ever reach a workflow.
 */

import { describe, it, expect } from 'vitest';
import { validateNoInventedAirtableIds } from '../lib/agent/airtable-config-guard';

function airtableNode(overrides: Record<string, unknown> = {}) {
  return {
    id: '3', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable',
    parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}' }, ...overrides },
  };
}

describe('validateNoInventedAirtableIds', () => {
  it('accepts empty baseId/tableId -- the expected "needs configuration" state', () => {
    const result = validateNoInventedAirtableIds([airtableNode({ baseId: '', tableId: '' })]);
    expect(result).toEqual({ ok: true });
  });

  it('accepts a node with no baseId/tableId keys at all', () => {
    const result = validateNoInventedAirtableIds([airtableNode()]);
    expect(result).toEqual({ ok: true });
  });

  it('rejects the exact production regression: an invented, wrong-shaped base id', () => {
    const result = validateNoInventedAirtableIds([airtableNode({ baseId: 'app123456' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invented base id/);
  });

  it('rejects an invented, wrong-shaped table id', () => {
    const result = validateNoInventedAirtableIds([airtableNode({ baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblXXXXXXXXXXXXXX-not-real' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invented table id/);
  });

  it('accepts a real-shaped base id and table id (e.g. surviving a regeneration after real configuration)', () => {
    const result = validateNoInventedAirtableIds([airtableNode({ baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblBBBBBBBBBBBBBB' })]);
    expect(result).toEqual({ ok: true });
  });

  it('ignores non-Airtable nodes entirely', () => {
    const result = validateNoInventedAirtableIds([{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }]);
    expect(result).toEqual({ ok: true });
  });

  it('handles malformed/non-array input safely', () => {
    expect(validateNoInventedAirtableIds(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateNoInventedAirtableIds([null, 42, 'x', {}])).toEqual({ ok: true });
  });
});
