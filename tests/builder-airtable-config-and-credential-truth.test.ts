/**
 * Phase 9.9.8 — Builder Action Configuration UX.
 *
 * Two independent fixes covered here:
 *
 * 1. lib/airtable/node-config-status.ts -- the pure status rule the new
 *    Builder Airtable configuration panel (components/builder/
 *    airtable-node-config-panel.tsx) uses to compute each of the four
 *    required states (Unconfigured / Configured / Schema changed /
 *    Credential missing) for every Hot/Warm/Cold Airtable node
 *    independently. Extracted as a pure function specifically so this is
 *    testable without rendering React.
 *
 * 2. lib/agent/provider-credential-registry.ts -- the Builder's per-node
 *    "Configure X" required-field text had drifted from the real,
 *    canonical credential contract each provider's actual working
 *    connection uses (lib/credentials/provider-registry.ts): Gmail no
 *    longer asks for OAuth client_id/client_secret/refresh_token/SMTP
 *    fields as if those were still required (Gmail's real, current
 *    connection is a single Google OAuth grant -- Phase 9.9.7A/B), and
 *    Slack no longer asks for a signing_secret it never actually
 *    reads/validates anywhere in this codebase.
 */

import { describe, it, expect } from 'vitest';
import { computeAirtableNodeStatus } from '../lib/airtable/node-config-status';
import { getProviderCredentialSchema } from '../lib/agent/provider-credential-registry';

describe('computeAirtableNodeStatus', () => {
  it('credential_missing when Airtable is not connected, regardless of any other field', () => {
    expect(
      computeAirtableNodeStatus({ airtableConnected: false, baseId: 'appXXXXXXXXXXXXXX', tableId: 'tblXXXXXXXXXXXXXX', fieldKeys: ['Name'], liveFieldNames: ['Name'] })
    ).toBe('credential_missing');
  });

  it('unconfigured when connected but no base/table has been selected yet', () => {
    expect(
      computeAirtableNodeStatus({ airtableConnected: true, baseId: '', tableId: '', fieldKeys: ['name', 'email'], liveFieldNames: null })
    ).toBe('unconfigured');
  });

  it('unconfigured when only one of base/table is selected', () => {
    expect(
      computeAirtableNodeStatus({ airtableConnected: true, baseId: 'appXXXXXXXXXXXXXX', tableId: '', fieldKeys: ['name'], liveFieldNames: null })
    ).toBe('unconfigured');
  });

  it('configured when base/table are selected and every mapped field name still exists on the real live table', () => {
    expect(
      computeAirtableNodeStatus({
        airtableConnected: true,
        baseId: 'appXXXXXXXXXXXXXX',
        tableId: 'tblXXXXXXXXXXXXXX',
        fieldKeys: ['Name', 'Email', 'Classification'],
        liveFieldNames: ['Name', 'Email', 'Classification', 'Confidence'],
      })
    ).toBe('configured');
  });

  it('schema_changed when a previously-mapped field name no longer exists on the real live table (renamed/deleted)', () => {
    // Reproduces the real production draft's exact field ("Confidance", a
    // typo) against a hypothetical corrected live schema ("Confidence").
    expect(
      computeAirtableNodeStatus({
        airtableConnected: true,
        baseId: 'appXXXXXXXXXXXXXX',
        tableId: 'tblXXXXXXXXXXXXXX',
        fieldKeys: ['Name', 'Email', 'Confidance', 'Classification'],
        liveFieldNames: ['Name', 'Email', 'Confidence', 'Classification'],
      })
    ).toBe('schema_changed');
  });

  it('schema_changed (fails closed, never silently "configured") when the live schema could not be verified at all', () => {
    expect(
      computeAirtableNodeStatus({
        airtableConnected: true,
        baseId: 'appXXXXXXXXXXXXXX',
        tableId: 'tblXXXXXXXXXXXXXX',
        fieldKeys: ['Name'],
        liveFieldNames: null,
      })
    ).toBe('schema_changed');
  });

  it('schema_changed when base/table are set but no fields have ever been mapped (empty fieldKeys never counts as "configured")', () => {
    expect(
      computeAirtableNodeStatus({
        airtableConnected: true,
        baseId: 'appXXXXXXXXXXXXXX',
        tableId: 'tblXXXXXXXXXXXXXX',
        fieldKeys: [],
        liveFieldNames: ['Name', 'Email'],
      })
    ).toBe('schema_changed');
  });

  it('Hot, Warm, and Cold nodes with identical baseId/tableId but different per-node status are each computed independently', () => {
    const hot = computeAirtableNodeStatus({ airtableConnected: true, baseId: 'appXXXXXXXXXXXXXX', tableId: 'tblXXXXXXXXXXXXXX', fieldKeys: ['Name'], liveFieldNames: ['Name'] });
    const warm = computeAirtableNodeStatus({ airtableConnected: true, baseId: '', tableId: '', fieldKeys: ['name'], liveFieldNames: null });
    const cold = computeAirtableNodeStatus({ airtableConnected: true, baseId: 'appXXXXXXXXXXXXXX', tableId: 'tblXXXXXXXXXXXXXX', fieldKeys: ['Renamed'], liveFieldNames: ['Name'] });
    expect({ hot, warm, cold }).toEqual({ hot: 'configured', warm: 'unconfigured', cold: 'schema_changed' });
  });
});

describe('lib/agent/provider-credential-registry.ts -- Builder credential-schema product truth (Phase 9.9.8)', () => {
  it('gmail no longer asks for OAuth client_id/client_secret/refresh_token or SMTP fields as its default requirement', () => {
    const schema = getProviderCredentialSchema('gmail');
    const keys = schema.map((f) => f.key);
    expect(keys).not.toContain('client_id');
    expect(keys).not.toContain('client_secret');
    expect(keys).not.toContain('refresh_token');
    expect(keys).not.toContain('auth_type');
    expect(keys).not.toContain('smtp_host');
    expect(keys).not.toContain('smtp_pass');
  });

  it('gmail\'s only real requirement is the canonical Google OAuth grant', () => {
    const schema = getProviderCredentialSchema('gmail');
    expect(schema).toEqual([{ key: 'oauth_google_gmail', label: 'Google OAuth', required: true }]);
  });

  it('the legacy "email" alias resolves to the same corrected gmail schema, not a stale duplicate', () => {
    expect(getProviderCredentialSchema('email')).toEqual(getProviderCredentialSchema('gmail'));
  });

  it('slack no longer requires a signing_secret (never read/validated anywhere in the real Slack connection path)', () => {
    const schema = getProviderCredentialSchema('slack');
    const keys = schema.map((f) => f.key);
    expect(keys).not.toContain('signing_secret');
    expect(schema).toEqual([{ key: 'bot_token', label: 'Bot Token', required: true }]);
  });

  it('other providers are unaffected by this fix (spot check: airtable, openai unchanged)', () => {
    expect(getProviderCredentialSchema('airtable')).toEqual([
      { key: 'airtable_token', label: 'Airtable Token', required: true },
      { key: 'base_id', label: 'Base ID', required: true },
    ]);
    expect(getProviderCredentialSchema('openai')).toEqual([{ key: 'api_key', label: 'API Key', required: true }]);
  });
});
