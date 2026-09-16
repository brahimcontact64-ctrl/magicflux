/**
 * Phase 9.9.11 -- Part F: Airtable business (CRM) deduplication
 * (lib/workflow-runtime/node-handlers/airtable-dedupe.ts and its wiring
 * into airtableHandler's 'create' operation).
 *
 * Deliberately separate from technical/transport idempotency
 * (tests/idempotency.test.ts, tests/provider-outcome-classification.test.ts):
 * this answers "does this submission describe a lead the business ALREADY
 * has a record for", never "is this the same webhook delivery/retry". A
 * customer submitting again on a genuinely separate real occasion (a
 * different event, a different execution) must still be recognized as the
 * SAME lead by business identity while remaining a completely NEW,
 * successful technical execution -- these tests prove both halves.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';
import { parseAirtableDedupePolicy, buildIdentityFilterFormula, normalizeIdentityValue } from '../lib/workflow-runtime/node-handlers/airtable-dedupe';

// ─── Pure-function tests ────────────────────────────────────────────────────

describe('parseAirtableDedupePolicy', () => {
  it('returns null when absent -- exactly today\'s create-only behavior', () => {
    expect(parseAirtableDedupePolicy(undefined)).toBeNull();
    expect(parseAirtableDedupePolicy(null)).toBeNull();
  });

  it('returns null for an unrecognized version', () => {
    expect(parseAirtableDedupePolicy({ version: 2, identityFields: ['Email'] })).toBeNull();
  });

  it('returns null when identityFields is empty -- a policy that identifies nothing is not a policy', () => {
    expect(parseAirtableDedupePolicy({ version: 1, identityFields: [] })).toBeNull();
  });

  it('defaults onMatch to "create" when omitted', () => {
    expect(parseAirtableDedupePolicy({ version: 1, identityFields: ['Email'] })?.onMatch).toBe('create');
  });

  it('parses a well-formed update policy', () => {
    const p = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email', 'Phone'], onMatch: 'update' });
    expect(p).toEqual({ version: 1, identityFields: ['Email', 'Phone'], onMatch: 'update' });
  });
});

describe('normalizeIdentityValue', () => {
  it('trims and lowercases so casing/whitespace never creates a false non-match', () => {
    expect(normalizeIdentityValue(' Jane@Example.com ')).toBe('jane@example.com');
  });
  it('handles missing/null values as an empty string, never "null"/"undefined"', () => {
    expect(normalizeIdentityValue(null)).toBe('');
    expect(normalizeIdentityValue(undefined)).toBe('');
  });
});

describe('buildIdentityFilterFormula', () => {
  it('builds a single-field exact-match formula', () => {
    const policy = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email'] })!;
    expect(buildIdentityFilterFormula(policy, { Email: 'Jane@Example.com' })).toBe('LOWER({Email}) = "jane@example.com"');
  });

  it('builds a composite AND() formula for multiple identity fields', () => {
    const policy = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email', 'Phone'] })!;
    const formula = buildIdentityFilterFormula(policy, { Email: 'a@b.com', Phone: '555-1234' });
    expect(formula).toBe('AND(LOWER({Email}) = "a@b.com", LOWER({Phone}) = "555-1234")');
  });

  it('excludes an identity field whose current value is empty/missing -- never matches every blank-field record', () => {
    const policy = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email', 'Phone'] })!;
    expect(buildIdentityFilterFormula(policy, { Email: 'a@b.com' })).toBe('LOWER({Email}) = "a@b.com"');
  });

  it('returns null when NO identity field has a value on this submission -- caller must fall back to a plain create', () => {
    const policy = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email'] })!;
    expect(buildIdentityFilterFormula(policy, {})).toBeNull();
  });

  it('escapes a double quote in the identity value so it cannot break out of the formula string', () => {
    const policy = parseAirtableDedupePolicy({ version: 1, identityFields: ['Email'] })!;
    const formula = buildIdentityFilterFormula(policy, { Email: 'a"OR"1"="1' });
    expect(formula).toBe('LOWER({Email}) = "a\\"or\\"1\\"=\\"1"');
  });
});

// ─── Handler-level integration tests ────────────────────────────────────────

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] }, ...overrides };
}
function integration(provider: string, credentials: Record<string, string>): UserIntegration {
  return { provider: provider as UserIntegration['provider'], credentials, status: 'connected' };
}
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return { ok: init?.ok ?? true, status: init?.status ?? 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function nodeWithDedupe(onMatch: 'create' | 'update' | 'append' = 'update'): EngineNode {
  return {
    id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable',
    parameters: {
      baseId: 'app1', tableId: 'tbl1', operation: 'create',
      fields: { Email: '={{$json["email"]}}', Name: '={{$json["name"]}}' },
      dedupe: { version: 1, identityFields: ['Email'], onMatch },
    },
  };
}

describe('airtableHandler create + dedupe policy configured', () => {
  it('no existing match: creates a new record exactly as before, tags the result as a fresh create', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ records: [] })) // dedupe search: no match
      .mockResolvedValueOnce(jsonResponse({ id: 'recNEW' })); // create
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const result = await airtableHandler(nodeWithDedupe('update'), { email: 'new@example.com', name: 'Brand New' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(result.status).toBe('success');
    const out = result.outputData as Record<string, unknown>;
    expect(out.airtable_id).toBe('recNEW');
    expect(out.airtable_dedupe_matched).toBe(false);
    expect(out.airtable_dedupe_action).toBe('create');
    expect(fetchMock).toHaveBeenCalledTimes(2); // search + create, never a third call
  });

  it('existing match + onMatch:"update": updates the existing record instead of creating a duplicate', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: 'recEXISTING' }] })) // dedupe search: match found
      .mockResolvedValueOnce(jsonResponse({ id: 'recEXISTING' })); // update (PATCH)
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const result = await airtableHandler(nodeWithDedupe('update'), { email: 'existing@example.com', name: 'Updated Name' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(result.status).toBe('success');
    const out = result.outputData as Record<string, unknown>;
    expect(out.airtable_id).toBe('recEXISTING');
    expect(out.airtable_dedupe_matched).toBe(true);
    expect(out.airtable_dedupe_action).toBe('update');
    // Confirms a PATCH (update), never a second POST (create) for the same lead.
    const patchCall = fetchMock.mock.calls[1];
    expect(patchCall[1].method).toBe('PATCH');
  });

  it('existing match + onMatch:"create" (explicit): still creates a new row -- the business explicitly wants every submission as its own record', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: 'recEXISTING' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recNEW2' }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const result = await airtableHandler(nodeWithDedupe('create'), { email: 'existing@example.com', name: 'Again' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).airtable_id).toBe('recNEW2');
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall[1].method).toBe('POST');
  });

  it('a submission whose identity field resolves to an empty value falls back to a plain create, no search call made', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'recNEW3' }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    // "email" IS present (satisfies the strict fields mapping) but resolves
    // to an empty string -- there is genuinely no identity value to search by.
    const result = await airtableHandler(nodeWithDedupe('update'), { email: '', name: 'No Email Provided' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no dedupe search attempted -- nothing to search by
  });

  it('an indeterminate dedupe lookup (network throw) fails CLOSED -- never creates, to avoid risking a business duplicate', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const result = await airtableHandler(nodeWithDedupe('update'), { email: 'x@example.com', name: 'X' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the create was never attempted
  });

  it('a node with NO dedupe parameter behaves exactly as before -- no search call, no new output fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'recPLAIN' }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const node: EngineNode = { id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: { Email: '={{$json["email"]}}' } } };
    const result = await airtableHandler(node, { email: 'a@b.com' }, baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.outputData).not.toHaveProperty('airtable_dedupe_matched');
    expect(result.outputData).not.toHaveProperty('airtable_dedupe_action');
  });
});

// ─── Part L: business dedupe vs. technical duplicate isolation ─────────────

describe('business dedupe identity is independent of technical/execution identity (Part L)', () => {
  it('two DIFFERENT executions (different technical event/execution identity) with the SAME lead email are correctly recognized as the same business identity by the dedupe lookup, not rejected as a technical duplicate', async () => {
    // Execution A: first submission, no match, creates.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ records: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recA' }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] });
    const first = await airtableHandler(nodeWithDedupe('update'), { email: 'repeat@example.com', name: 'First Visit' }, ctx);
    expect((first.outputData as Record<string, unknown>).airtable_dedupe_matched).toBe(false);

    // Execution B: a genuinely SEPARATE later submission (different
    // execution entirely -- this is not a retry of execution A) from the
    // SAME real person -- the dedupe lookup now finds A's record and
    // updates it, business-identity-aware, while technically this is a
    // completely independent, successful execution (never blocked/rejected
    // as if it were a duplicate delivery of execution A).
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: 'recA' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recA' }));
    const second = await airtableHandler(nodeWithDedupe('update'), { email: 'repeat@example.com', name: 'Second Visit' }, ctx);

    expect(second.status).toBe('success'); // NOT rejected/suppressed as a technical duplicate
    expect((second.outputData as Record<string, unknown>).airtable_dedupe_matched).toBe(true);
    expect((second.outputData as Record<string, unknown>).airtable_id).toBe('recA'); // same business record, updated
  });
});
