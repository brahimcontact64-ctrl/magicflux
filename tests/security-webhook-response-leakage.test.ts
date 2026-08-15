/**
 * Phase 8.1 security — the webhook accept (202) response must never leak
 * secrets, internal DB fields, or raw workflow JSON.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const WORKFLOW_ID = 'wf-security-leakage';

type Row = Record<string, unknown>;

class FakeQuery {
  constructor(private rows: Row[]) {}
  private filters: Array<[string, unknown]> = [];
  private gteFilters: Array<[string, unknown]> = [];
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  gte(c: string, v: unknown) { this.gteFilters.push([c, v]); return this; }
  select() { return this; }
  private matched() {
    return this.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v) &&
      this.gteFilters.every(([c, v]) => String(r[c] ?? '') >= String(v)));
  }
  async maybeSingle() {
    const m = this.matched();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  async single() {
    const m = this.matched();
    return m[0] ? { data: { ...m[0] }, error: null } : { data: null, error: { code: 'PGRST116' } };
  }
  then<T>(resolve: (v: { data: Row[]; count: number; error: null }) => T): Promise<T> {
    const m = this.matched();
    return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), count: m.length, error: null }));
  }
  insert() { return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) }; }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])) })),
}));
vi.mock('@/lib/runtime/webhook-security', () => ({
  guardWebhookRequest: vi.fn(async () => ({ allowed: true, suspiciousScore: 0, requestHash: 'hash' })),
  suspiciousExecutionScore: vi.fn(() => 0),
}));
vi.mock('@/lib/runtime/execution-dispatch', () => ({
  dispatchProductionExecution: vi.fn(async () => ({ ok: true, duplicate: false, executionId: 'exec-1', status: 'queued' })),
}));

beforeEach(() => {
  tables = {
    workflows: [{
      id: WORKFLOW_ID,
      user_id: OWNER_ID,
      status: 'active',
      workflow_json: { nodes: [], connections: {}, security: { webhook_secret: 'super-secret-value' } },
      active_deployment_version_id: null,
    }],
    deployment_versions: [],
  };
});

describe('webhook accept response never leaks internal fields', () => {
  it('the 202 response body contains no secret, credential, or raw workflow_json field', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const req = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`), {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req, { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(202);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toMatch(/workflow_json/i);
    expect(serialized).not.toMatch(/user_id/i);
    expect(Object.keys(body).sort()).toEqual(['executionId', 'idempotencySource', 'live', 'status'].sort());
  });
});
