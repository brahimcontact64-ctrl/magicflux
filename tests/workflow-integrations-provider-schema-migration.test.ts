/**
 * Phase 9.9.8D — workflow_integrations.provider CHECK constraint migration.
 *
 * Root cause this migration fixes: the live constraint
 * (workflow_integrations_provider_check) did not include 'gmail' at all,
 * so a genuine Gmail OAuth credential (Phase 9.9.8C's discovery/attach fix)
 * could be discovered and pass every application-level check, then fail at
 * the database with a check_violation on the final INSERT/UPDATE.
 *
 * Verified against production, read-only, before AND after applying
 * supabase/migrations/20260916134334_widen_workflow_integrations_provider_check_add_gmail.sql
 * via `supabase db dump`: the entire public schema diff was exactly one
 * line -- this constraint gaining 'gmail' -- confirming no RLS/grant/FK/
 * index on this table (or any other table) was touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS } from '../lib/integrations';

const PREVIOUSLY_ALLOWED = ['email', 'shopify', 'slack', 'airtable', 'twilio', 'webhook'];

describe('WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS -- mirrors the live DB CHECK constraint', () => {
  it('gmail is now accepted', () => {
    expect(WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has('gmail')).toBe(true);
  });

  it('every previously-allowed provider is still accepted (nothing was narrowed)', () => {
    for (const provider of PREVIOUSLY_ALLOWED) {
      expect(WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has(provider)).toBe(true);
    }
  });

  it('an arbitrary/unsupported provider value is still rejected', () => {
    expect(WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has('totally-bogus-provider')).toBe(false);
    expect(WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has('openai')).toBe(false);
    expect(WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has('')).toBe(false);
  });

  it('is exactly the 7 expected values -- no accidental extra/missing entries', () => {
    expect([...WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS].sort()).toEqual(
      [...PREVIOUSLY_ALLOWED, 'gmail'].sort()
    );
  });
});

// ─── Route-level: the early allowlist check actually fires in the real handler ──

const OWNER_ID = '00000000-0000-4000-8000-0000000000b1';
const WORKFLOW_ID = 'wf-provider-allowlist-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  async then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return resolve({ data: this.matched().map((r) => ({ ...r })), error: null });
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    const rows = this.tables.get(name)!;
    return {
      select: () => new FakeQuery(rows),
      insert: (row: Row) => {
        const saved = { id: `fake-${rows.length}`, ...row };
        rows.push(saved);
        return { select: () => ({ maybeSingle: async () => ({ data: { ...saved }, error: null }) }) };
      },
    };
  }
}

const fakeDb = new FakeDb();
const mockGetUserFromRequest = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

vi.mock('@/lib/credentials/storage', () => ({
  getCredentialRowById: vi.fn(async () => null),
  verifyProviderConnection: vi.fn(async () => ({ connected: false, missing: [] })),
}));

function makeReq(body: Record<string, unknown>) {
  return new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/integrations`), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/workflows/[id]/integrations -- early rejection of an unsupported raw provider value', () => {
  beforeEach(() => {
    fakeDb.tables.clear();
    fakeDb.tables.set('workflows', [{ id: WORKFLOW_ID, user_id: OWNER_ID, integrations: ['gmail'] }]);
    fakeDb.tables.set('user_integrations', [
      { id: 'int-bogus-1', user_id: OWNER_ID, provider: 'not-a-real-provider', status: 'connected' },
    ]);
    mockGetUserFromRequest.mockReset();
    mockGetUserFromRequest.mockResolvedValue({ id: OWNER_ID });
  });

  it('rejects a credential whose raw provider is outside the allowlist, before ever attempting the database write', async () => {
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq({ provider: 'not-a-real-provider', integrationId: 'int-bogus-1' }), { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('PROVIDER_NOT_YET_ALLOWED');
    // No row was ever written for the rejected value.
    expect(fakeDb.tables.get('workflow_integrations') ?? []).toHaveLength(0);
  });

  it('gmail itself is NOT rejected by the allowlist check (only genuinely unsupported values are)', async () => {
    fakeDb.tables.set('user_integrations', [
      { id: 'int-gmail-1', user_id: OWNER_ID, provider: 'gmail', status: 'connected' },
    ]);
    const { POST } = await import('../app/api/workflows/[id]/integrations/route');
    const res = await POST(makeReq({ provider: 'gmail', integrationId: 'int-gmail-1' }), { params: { id: WORKFLOW_ID } });

    // Never the allowlist-specific 409 -- gmail is accepted at this layer;
    // the real DB round trip is covered in tests/workflow-gmail-oauth-attachment.test.ts.
    if (res.status !== 200) {
      const body = await res.json();
      expect(body.error).not.toBe('PROVIDER_NOT_YET_ALLOWED');
    }
  });
});

describe('Phase 9.9.8D migration file -- exact, minimal, non-destructive constraint change', () => {
  const migrationPath = path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260916134334_widen_workflow_integrations_provider_check_add_gmail.sql'
  );
  const source = fs.readFileSync(migrationPath, 'utf8');
  // The file's own explanatory header comment quotes the OLD constraint
  // (without 'gmail') for context -- strip comment lines before asserting
  // anything about the ACTUAL SQL, so that quoted text can never be
  // mistaken for the real statements below it.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('touches only workflow_integrations_provider_check -- no other ALTER/CREATE/DROP statement', () => {
    const alterStatements = code.match(/^ALTER TABLE\b.*$/gm) ?? [];
    expect(alterStatements.length).toBeGreaterThan(0);
    for (const stmt of alterStatements) {
      expect(stmt).toMatch(/workflow_integrations/i);
    }
    expect(code).not.toMatch(/DROP TABLE/i);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/GRANT\b/i);
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(code).not.toMatch(/FOREIGN KEY/i);
  });

  it('drops and recreates exactly one constraint, workflow_integrations_provider_check', () => {
    expect(code).toMatch(/DROP CONSTRAINT\s+"workflow_integrations_provider_check"/);
    expect(code).toMatch(/ADD CONSTRAINT\s*\r?\n?\s*"workflow_integrations_provider_check"/);
  });

  it('the new CHECK preserves every previously-allowed value and adds exactly "gmail"', () => {
    for (const provider of PREVIOUSLY_ALLOWED) {
      expect(code).toMatch(new RegExp(`'${provider}'::"text"`));
    }
    expect(code).toMatch(/'gmail'::"text"/);
    // Never aliases gmail to email, and never introduces an unrelated value
    // -- extracted from the ADD CONSTRAINT's own ARRAY[...], never the
    // header comment's quoted OLD definition.
    const addConstraintSection = code.slice(code.indexOf('ADD CONSTRAINT'));
    const arrayMatch = addConstraintSection.match(/ARRAY\[([\s\S]*?)\]/);
    expect(arrayMatch).not.toBeNull();
    const values = (arrayMatch![1].match(/'([a-z]+)'::"text"/g) ?? []).map((v) => v.match(/'([a-z]+)'/)![1]);
    expect(values.sort()).toEqual([...PREVIOUSLY_ALLOWED, 'gmail'].sort());
  });
});
