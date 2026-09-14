/**
 * Phase 9.9.4B — Airtable "Test Action" defect fix
 * (lib/integration-verifier.ts's runIntegrationTestAction).
 *
 * The exact production regression: pressing "Test Action" reached the real,
 * genuinely-connected Airtable API but POSTed a record with hardcoded field
 * names ("Name", "Source") this code has no way of knowing exist in the
 * user's real, arbitrary table schema -- producing a real
 * 422 UNKNOWN_FIELD_NAME against a working integration. The fix: a
 * read-only connectivity check (Airtable's own list endpoint) that never
 * assumes/invents a field name and never writes anything.
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

const CREDS = { airtable_token: 'pat-super-secret-value', base_id: 'appieO90GKGdxIXtO', table_name: 'Leads' };

describe('runIntegrationTestAction -- airtable / create_test_record', () => {
  it('never sends a POST request -- read-only connectivity check only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    await runIntegrationTestAction('airtable', CREDS, 'create_test_record');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method ?? 'GET').not.toBe('POST');
  });

  it('never includes an invented "Source" or "_source" field anywhere in the request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    await runIntegrationTestAction('airtable', CREDS, 'create_test_record');

    const [url, init] = fetchMock.mock.calls[0];
    const bodyText = init?.body ? String(init.body) : '';
    expect(String(url)).not.toContain('Source');
    expect(bodyText).not.toContain('Source');
    expect(bodyText).not.toContain('_source');
  });

  it('never invents a "Name" field either -- no hardcoded field names at all', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    await runIntegrationTestAction('airtable', CREDS, 'create_test_record');

    const [, init] = fetchMock.mock.calls[0];
    const bodyText = init?.body ? String(init.body) : '';
    expect(bodyText).not.toContain('"Name"');
  });

  it('succeeds against ANY real schema, since it never references a field name -- an unusual/unknown schema still passes', async () => {
    // A table whose only real columns are totally unrelated to anything
    // MagicFlux would ever guess -- the connectivity check must not care.
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [{ id: 'rec1', fields: { 'Widget Count': 3, 'Ünïcödé Cölümn': 'x' } }] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    const result = await runIntegrationTestAction('airtable', CREDS, 'create_test_record');
    expect(result.ok).toBe(true);
  });

  it('reproduces the exact production regression scenario and confirms it no longer 422s', async () => {
    // Before the fix, this exact credentials/base/table shape (matching the
    // founder's real connected account) triggered a real
    // 422 UNKNOWN_FIELD_NAME: Unknown field name: "Source" against Airtable.
    // The fix makes this a read-only list call, which succeeds regardless.
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    const result = await runIntegrationTestAction('airtable', { airtable_token: 'pat-real', base_id: 'appieO90GKGdxIXtO', table_name: 'Leads' }, 'create_test_record');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').not.toBe('POST');
  });

  it('never leaves an unwanted record behind -- confirmed by making zero write calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [] }));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    await runIntegrationTestAction('airtable', CREDS, 'create_test_record');
    await runIntegrationTestAction('airtable', CREDS, 'create_test_record');

    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.method ?? 'GET').toUpperCase()).not.toBe('POST');
      expect((call[1]?.method ?? 'GET').toUpperCase()).not.toBe('DELETE');
    }
  });

  it('surfaces a real connection failure cleanly, still without ever writing anything', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('NOT_FOUND', false, 404));
    const { runIntegrationTestAction } = await import('../lib/integration-verifier');

    const result = await runIntegrationTestAction('airtable', CREDS, 'create_test_record');
    expect(result.ok).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').not.toBe('POST');
  });

  describe('Phase 9.9.4B -- PAT/token never reaches the response', () => {
    it('the request sends the token only in the Authorization header, never in the URL', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
      const { runIntegrationTestAction } = await import('../lib/integration-verifier');

      await runIntegrationTestAction('airtable', CREDS, 'create_test_record');

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).not.toContain(CREDS.airtable_token);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${CREDS.airtable_token}`);
    });

    it('a failed response is routed through the shared redaction utility (safeError), not returned raw', async () => {
      // Realistic upstream failure shape (Airtable never echoes the caller's
      // own token back, but its error bodies do sometimes embed doc URLs) --
      // confirms this path actually goes through redactText, the same
      // utility every other handler in this codebase relies on for this
      // exact guarantee, rather than surfacing the raw response body as-is.
      fetchMock.mockResolvedValueOnce(jsonResponse('See https://airtable.com/developers/web/api/errors for details', false, 401));
      const { runIntegrationTestAction } = await import('../lib/integration-verifier');

      const result = await runIntegrationTestAction('airtable', CREDS, 'create_test_record');
      expect(result.ok).toBe(false);
      expect(result.error ?? '').not.toContain('https://airtable.com');
      expect(result.error ?? '').toContain('[URL_REDACTED]');
    });
  });
});
