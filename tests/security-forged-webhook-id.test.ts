/**
 * Phase 8.1 security — a forged X-Shopify-Webhook-Id on an unsigned request
 * must never reach dispatch. Idempotency headers are hints for dedup, not
 * authentication — guardWebhookRequest's signature check (pre-existing,
 * unchanged) is what actually authenticates the sender, and it must run,
 * and deny, before dispatchProductionExecution is ever called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const WORKFLOW_ID = 'wf-security-forged';

type Row = Record<string, unknown>;

class FakeQuery {
  constructor(private rows: Row[]) {}
  private filters: Array<[string, unknown]> = [];
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  select() { return this; }
  async maybeSingle() {
    const m = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  insert() { return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) }; }
}

let tables: { workflows: Row[]; deployment_versions: Row[] };

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: 'workflows' | 'deployment_versions') => new FakeQuery(tables[name]) })),
}));

vi.mock('@/lib/runtime/webhook-security', () => ({
  guardWebhookRequest: vi.fn(async () => ({ allowed: false, reason: 'INVALID_SIGNATURE', suspiciousScore: 85, requestHash: 'hash' })),
  suspiciousExecutionScore: vi.fn(() => 0),
}));

const dispatchMock = vi.fn();
vi.mock('@/lib/runtime/execution-dispatch', () => ({ dispatchProductionExecution: dispatchMock }));

beforeEach(() => {
  tables = {
    workflows: [{ id: WORKFLOW_ID, user_id: OWNER_ID, status: 'active', workflow_json: { nodes: [], connections: {} }, active_deployment_version_id: null }],
    deployment_versions: [],
  };
  dispatchMock.mockReset();
});

describe('forged Shopify webhook ID cannot trigger an execution without a valid signature', () => {
  it('a forged X-Shopify-Webhook-Id header on an unsigned request is rejected before dispatch ever runs', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const req = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`), {
      method: 'POST',
      body: JSON.stringify({ malicious: true }),
      headers: { 'content-type': 'application/json', 'x-shopify-webhook-id': 'forged-evt-id-claiming-to-be-legit' },
    });

    const res = await POST(req, { params: { id: WORKFLOW_ID } });

    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
