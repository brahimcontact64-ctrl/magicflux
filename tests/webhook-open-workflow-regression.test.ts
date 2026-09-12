/**
 * Phase 9.8.3 — production nav bug: after activation, the Builder's "Open
 * workflow" link pointed straight at the POST-only webhook endpoint
 * (/api/workflows/[id]/webhook). A Founder clicking it in a browser issued a
 * GET, which Chrome reported as HTTP 405. Investigation of the real
 * production workflow (owner: brahim.beldjilali.dev@gmail.com, workflow
 * "Customer Classification Webhook", status: active) confirmed 0 rows in
 * workflow_executions_v2 despite the accidental GET — the route module only
 * exports POST, so Next.js's framework-level 405 fires before any of this
 * route's own code (including dispatchProductionExecution) ever runs.
 *
 * The frontend fix (components/builder/chat-interface.tsx) is covered by
 * the A3 suite in builder-deterministic-activation.security.test.ts. This
 * file pins the three webhook-route-level invariants the incident's
 * required regression coverage calls for: a GET can never create an
 * execution, a valid POST still executes the active workflow, and
 * per-workflow tenant scoping is preserved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const OWNER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_A = 'wf-tenant-a-webhook';
const WORKFLOW_B = 'wf-tenant-b-webhook';

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
  guardWebhookRequest: vi.fn(async () => ({ allowed: true, reason: null, suspiciousScore: 0, requestHash: 'hash' })),
  suspiciousExecutionScore: vi.fn(() => 0),
}));

vi.mock('@/lib/billing/plan-limits', () => ({
  canExecuteWorkflow: vi.fn(async () => ({ allowed: true })),
  getPlanLimits: vi.fn(async () => ({ name: 'Pro' })),
}));

const dispatchMock = vi.fn(async (args: { userId: string; workflowId: string }) => ({
  ok: true as const,
  duplicate: false,
  executionId: `exec-${args.workflowId}`,
  status: 'queued',
}));
vi.mock('@/lib/runtime/execution-dispatch', () => ({ dispatchProductionExecution: dispatchMock }));

beforeEach(() => {
  tables = {
    workflows: [
      {
        id: WORKFLOW_A,
        user_id: OWNER_A,
        status: 'active',
        workflow_json: { nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST' } }], connections: {} },
        active_deployment_version_id: null,
      },
      {
        id: WORKFLOW_B,
        user_id: OWNER_B,
        status: 'active',
        workflow_json: { nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST' } }], connections: {} },
        active_deployment_version_id: null,
      },
    ],
    deployment_versions: [],
  };
  dispatchMock.mockClear();
});

describe('webhook route — regression coverage for the "Open workflow" nav incident', () => {
  it('#5: the route module exports no GET handler, so a browser GET can never reach dispatch (Next.js answers 405 before any route code runs)', async () => {
    const routeModule = await import('../app/api/workflows/[id]/webhook/route');
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('#6: a valid signed POST still executes the active workflow', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const req = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_A}/webhook`), {
      method: 'POST',
      body: JSON.stringify({ customer_name: 'Test', order_amount: 150 }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req, { params: { id: WORKFLOW_A } });

    expect(res.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_A, userId: OWNER_A }));
  });

  it('#7: tenant isolation — a POST to workflow A only ever dispatches against workflow A\'s own owner, never workflow B\'s', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');

    const reqA = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_A}/webhook`), {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    await POST(reqA, { params: { id: WORKFLOW_A } });
    expect(dispatchMock).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: WORKFLOW_A, userId: OWNER_A }));

    dispatchMock.mockClear();

    const reqB = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_B}/webhook`), {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    await POST(reqB, { params: { id: WORKFLOW_B } });
    expect(dispatchMock).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: WORKFLOW_B, userId: OWNER_B }));

    // Neither call ever crossed tenants.
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_A, userId: OWNER_B }));
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_B, userId: OWNER_A }));
  });

  it('#7b: an unknown/foreign workflow id is rejected with 404 before any dispatch, so a guessed id cannot trigger another tenant\'s workflow', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const req = new NextRequest(new URL('http://localhost/api/workflows/does-not-exist/webhook'), {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req, { params: { id: 'does-not-exist' } });

    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
