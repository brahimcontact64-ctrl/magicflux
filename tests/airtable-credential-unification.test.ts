/**
 * Phase 9.9.4B — Builder Airtable discovery unified with Settings' own
 * credential lookup.
 *
 * Root cause this exists to prevent: the Builder's discovery routes
 * (/api/integrations/airtable/{bases,tables,fields}, and the
 * airtable-config save route) called lib/credentials/storage.ts's
 * getDecryptedProviderCredentials(userId, 'airtable') directly, expecting a
 * 'personal_access_token' key from the `integration_credentials` table --
 * but Settings' actual Airtable connect flow (app/api/integrations/
 * shared.ts) writes the legacy `user_integrations` table under the key
 * 'airtable_token'. A real, verified Settings connection was therefore
 * completely invisible to the Builder, which reported "not connected"
 * forever. getConnectedAirtableToken() (lib/user-integrations.ts) is now
 * the one canonical lookup both paths agree on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])) })),
}));

beforeEach(() => {
  tables = { user_integrations: [] };
});

describe('getConnectedAirtableToken (lib/user-integrations.ts)', () => {
  it('recognizes a connection saved exactly the way Settings saves it (provider "airtable", key "airtable_token")', async () => {
    tables.user_integrations = [
      { id: '1', user_id: USER_ID, provider: 'airtable', name: null, credentials: { airtable_token: 'pat-real-token', base_id: 'appREAL00000000' }, status: 'connected', last_verified_at: '2026-01-01', created_at: '2026-01-01' },
    ];

    const { getConnectedAirtableToken } = await import('../lib/user-integrations');
    const token = await getConnectedAirtableToken(USER_ID);
    expect(token).toBe('pat-real-token');
  });

  it('also recognizes the personal_access_token key (a different storage path/rename)', async () => {
    tables.user_integrations = [
      { id: '1', user_id: USER_ID, provider: 'airtable', name: null, credentials: { personal_access_token: 'pat-other-token' }, status: 'connected', last_verified_at: '2026-01-01', created_at: '2026-01-01' },
    ];

    const { getConnectedAirtableToken } = await import('../lib/user-integrations');
    expect(await getConnectedAirtableToken(USER_ID)).toBe('pat-other-token');
  });

  it('returns null when no Airtable row exists at all', async () => {
    const { getConnectedAirtableToken } = await import('../lib/user-integrations');
    expect(await getConnectedAirtableToken(USER_ID)).toBeNull();
  });

  it('returns null for a row that exists but is not status "connected" (e.g. "invalid")', async () => {
    tables.user_integrations = [
      { id: '1', user_id: USER_ID, provider: 'airtable', name: null, credentials: { airtable_token: 'stale' }, status: 'invalid', last_verified_at: null, created_at: '2026-01-01' },
    ];
    const { getConnectedAirtableToken } = await import('../lib/user-integrations');
    expect(await getConnectedAirtableToken(USER_ID)).toBeNull();
  });

  it('never returns another user\'s token (scoped by user_id)', async () => {
    const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
    tables.user_integrations = [
      { id: '1', user_id: OTHER_USER, provider: 'airtable', name: null, credentials: { airtable_token: 'not-mine' }, status: 'connected', last_verified_at: '2026-01-01', created_at: '2026-01-01' },
    ];
    const { getConnectedAirtableToken } = await import('../lib/user-integrations');
    expect(await getConnectedAirtableToken(USER_ID)).toBeNull();
  });
});
