/**
 * Phase 9.9.3 — Airtable schema-aware configuration.
 *
 * lib/airtable/schema.ts wraps Airtable's real Metadata API
 * (bases/tables/fields) and validates a proposed mapping against it. All
 * network calls are mocked here (fetch); no live Airtable API is ever
 * contacted by these tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('listAirtableBases', () => {
  it('returns the real bases this token can access', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ bases: [{ id: 'appAAAAAAAAAAAAAA', name: 'CRM', permissionLevel: 'create' }] }));
    const { listAirtableBases } = await import('../lib/airtable/schema');
    const bases = await listAirtableBases('pat_fake_token');
    expect(bases).toEqual([{ id: 'appAAAAAAAAAAAAAA', name: 'CRM', permissionLevel: 'create' }]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/meta/bases'), expect.objectContaining({ headers: { Authorization: 'Bearer pat_fake_token' } }));
  });

  it('never leaks the token in a thrown error message', async () => {
    fetchMock.mockResolvedValue(jsonResponse('unauthorized', false, 401));
    const { listAirtableBases } = await import('../lib/airtable/schema');
    let thrown: unknown;
    await listAirtableBases('pat_super_secret_token').catch((err) => { thrown = err; });
    expect(thrown, 'listAirtableBases should have thrown on a 401').toBeDefined();
    expect(String(thrown)).not.toContain('pat_super_secret_token');
  });
});

describe('listAirtableTables / getAirtableTableFields', () => {
  const TABLES_RESPONSE = {
    tables: [
      {
        id: 'tblAAAAAAAAAAAAAA', name: 'Leads',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldEmail', name: 'Email', type: 'email' },
          { id: 'fldScore', name: 'Score', type: 'formula' },
        ],
      },
    ],
  };

  it('lists real tables with their real fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { listAirtableTables } = await import('../lib/airtable/schema');
    const tables = await listAirtableTables('token', 'appAAAAAAAAAAAAAA');
    expect(tables).toHaveLength(1);
    expect(tables[0].fields.map((f) => f.name)).toEqual(['Name', 'Email', 'Score']);
  });

  it('getAirtableTableFields returns null for a table that does not exist in the base', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getAirtableTableFields } = await import('../lib/airtable/schema');
    const fields = await getAirtableTableFields('token', 'appAAAAAAAAAAAAAA', 'DoesNotExist');
    expect(fields).toBeNull();
  });

  it('getAirtableTableFields resolves by table name or id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getAirtableTableFields } = await import('../lib/airtable/schema');
    const fields = await getAirtableTableFields('token', 'appAAAAAAAAAAAAAA', 'Leads');
    expect(fields?.map((f) => f.name)).toEqual(['Name', 'Email', 'Score']);
  });
});

describe('validateAirtableMapping', () => {
  const TABLES_RESPONSE = {
    tables: [
      {
        id: 'tblAAAAAAAAAAAAAA', name: 'Leads',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldEmail', name: 'Email', type: 'email' },
          { id: 'fldScore', name: 'Score', type: 'formula' },
        ],
      },
    ],
  };

  it('valid mapping: every field key is a real, writable field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result = await validateAirtableMapping('token', 'appAAAAAAAAAAAAAA', 'Leads', ['Name', 'Email']);
    expect(result.ok).toBe(true);
  });

  it('invalid base: the base lookup itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('not found', false, 404));
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result = await validateAirtableMapping('token', 'appNONEXISTENT00', 'Leads', ['Name']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Could not verify Airtable base/);
  });

  it('invalid table: the base is real but the table is not', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result = await validateAirtableMapping('token', 'appAAAAAAAAAAAAAA', 'NoSuchTable', ['Name']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/was not found in Airtable base/);
  });

  it('unknown field: rejects a field key that is not in the real table schema', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result = await validateAirtableMapping('token', 'appAAAAAAAAAAAAAA', 'Leads', ['Name', 'PhoneNumber']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknownFields).toEqual(['PhoneNumber']);
      expect(result.reason).toMatch(/Unknown Airtable field/);
    }
  });

  it('incompatible field type: rejects mapping onto a read-only/computed field (formula)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result = await validateAirtableMapping('token', 'appAAAAAAAAAAAAAA', 'Leads', ['Name', 'Score']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.readonlyFields).toEqual(['Score']);
      expect(result.reason).toMatch(/read-only\/computed/);
    }
  });

  it('rejects an empty baseId/tableId without making any network call', async () => {
    const { validateAirtableMapping } = await import('../lib/airtable/schema');
    const result1 = await validateAirtableMapping('token', '', 'Leads', ['Name']);
    const result2 = await validateAirtableMapping('token', 'appAAAAAAAAAAAAAA', '', ['Name']);
    expect(result1.ok).toBe(false);
    expect(result2.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isWritableAirtableFieldType', () => {
  it('classifies every known read-only/computed Airtable field type as not writable', async () => {
    const { isWritableAirtableFieldType } = await import('../lib/airtable/schema');
    for (const type of ['formula', 'rollup', 'count', 'autoNumber', 'createdTime', 'lastModifiedTime', 'button']) {
      expect(isWritableAirtableFieldType(type)).toBe(false);
    }
  });

  it('classifies ordinary field types as writable', async () => {
    const { isWritableAirtableFieldType } = await import('../lib/airtable/schema');
    for (const type of ['singleLineText', 'email', 'number', 'checkbox', 'singleSelect', 'date']) {
      expect(isWritableAirtableFieldType(type)).toBe(true);
    }
  });
});
