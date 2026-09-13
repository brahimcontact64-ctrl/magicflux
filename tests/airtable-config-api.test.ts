/**
 * Phase 9.9.3 — Airtable discovery + configuration-save API routes.
 *
 * Discovery routes (bases/tables/fields) never expose the stored token to
 * the browser -- only base/table/field metadata. The config-save route
 * re-verifies a proposed mapping against Airtable's real schema server-side
 * (mocked fetch here) before ever persisting it, and never lets a caller
 * touch a workflow they don't own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000f2';
const WORKFLOW_ID = 'wf-airtable-config-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  async then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return resolve({ data: m.map((r) => ({ ...r })), error: null });
  }
}

function freshTables(): Record<string, Row[]> {
  return {
    workflows: [
      {
        id: WORKFLOW_ID,
        user_id: OWNER_ID,
        workflow_json: {
          nodes: [
            { id: 'n1', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}' } } },
            { id: 'n2', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
          ],
          connections: {},
        },
      },
    ],
  };
}

let tables: Record<string, Row[]>;
let decryptedCreds: Record<string, string>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])) })),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/credentials/storage', () => ({
  getDecryptedProviderCredentials: vi.fn(async () => decryptedCreds),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const TABLES_RESPONSE = {
  tables: [
    {
      id: 'tblAAAAAAAAAAAAAA', name: 'Leads',
      fields: [
        { id: 'fldName', name: 'Full Name', type: 'singleLineText' },
        { id: 'fldEmail', name: 'Email Address', type: 'email' },
      ],
    },
  ],
};

beforeEach(async () => {
  tables = freshTables();
  decryptedCreds = { personal_access_token: 'pat-fake-token' };
  fetchMock.mockReset();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
});

describe('GET /api/integrations/airtable/bases', () => {
  it('unauthorized without a session', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { GET } = await import('../app/api/integrations/airtable/bases/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/bases')));
    expect(res.status).toBe(401);
  });

  it('409 when Airtable is not connected', async () => {
    decryptedCreds = {};
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/integrations/airtable/bases/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/bases')));
    expect(res.status).toBe(409);
  });

  it('returns real base metadata without ever including the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ bases: [{ id: 'appAAAAAAAAAAAAAA', name: 'CRM' }] }));
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/integrations/airtable/bases/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/bases')));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.bases).toEqual([{ id: 'appAAAAAAAAAAAAAA', name: 'CRM' }]);
    expect(JSON.stringify(body)).not.toContain('pat-fake-token');
  });
});

describe('GET /api/integrations/airtable/tables', () => {
  it('requires a baseId query parameter', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/integrations/airtable/tables/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/tables')));
    expect(res.status).toBe(400);
  });

  it('returns real tables with their real fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/integrations/airtable/tables/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/tables?baseId=appAAAAAAAAAAAAAA')));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tables[0].fields.map((f: { name: string }) => f.name)).toEqual(['Full Name', 'Email Address']);
  });
});

describe('GET /api/integrations/airtable/fields', () => {
  it('404s for a table that does not exist in the base', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { GET } = await import('../app/api/integrations/airtable/fields/route');
    const res = await GET(new NextRequest(new URL('http://localhost/api/integrations/airtable/fields?baseId=appAAAAAAAAAAAAAA&tableId=NoSuchTable')));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/workflows/[id]/airtable-config', () => {
  function makeReq(body: Record<string, unknown>) {
    return new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/airtable-config`), {
      method: 'PATCH', body: JSON.stringify(body),
    });
  }

  it('unauthorized without a session', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    const res = await PATCH(makeReq({ nodeId: 'n1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblAAAAAAAAAAAAAA', fieldMapping: {} }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(401);
  });

  it('cross-tenant: a different user cannot configure someone else\'s workflow -> 404, unchanged', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    const res = await PATCH(makeReq({ nodeId: 'n1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblAAAAAAAAAAAAAA', fieldMapping: { Name: 'Full Name' } }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown field in the mapping (does not persist anything)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    const res = await PATCH(makeReq({ nodeId: 'n1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblAAAAAAAAAAAAAA', fieldMapping: { Name: 'Phone Number' } }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    const airtableNode = (tables.workflows[0].workflow_json as { nodes: Array<Record<string, unknown>> }).nodes[0];
    expect((airtableNode.parameters as Record<string, unknown>).baseId).toBeUndefined();
  });

  it('rejects a node that is not an Airtable node', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    const res = await PATCH(makeReq({ nodeId: 'n2', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblAAAAAAAAAAAAAA', fieldMapping: {} }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
  });

  it('valid mapping: verifies against real schema, rewrites field keys to real names, persists baseId/tableId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES_RESPONSE));
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    const res = await PATCH(
      makeReq({ nodeId: 'n1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblAAAAAAAAAAAAAA', fieldMapping: { Name: 'Full Name', Email: 'Email Address' } }),
      { params: { id: WORKFLOW_ID } },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const savedNode = (tables.workflows[0].workflow_json as { nodes: Array<Record<string, unknown>> }).nodes[0];
    const params = savedNode.parameters as Record<string, unknown>;
    expect(params.baseId).toBe('appAAAAAAAAAAAAAA');
    expect(params.tableId).toBe('tblAAAAAAAAAAAAAA');
    expect((params.fields as Record<string, unknown>)['Full Name']).toBe('={{$json["name"]}}');
    expect((params.fields as Record<string, unknown>)['Email Address']).toBe('={{$json["email"]}}');
    expect(params.application).toBeUndefined();
    expect(params.applicationId).toBeUndefined();
  });
});
