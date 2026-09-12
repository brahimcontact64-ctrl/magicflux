/**
 * Phase 9.8.4 — per-workflow webhook authentication.
 *
 * Root cause of the "always 401" incident: app/api/workflows/[id]/webhook/
 * route.ts fell back to a single GLOBAL env var (MAGICFLUX_WEBHOOK_SECRET)
 * whenever a workflow had no secret of its own -- a credential no external
 * caller could ever know, shared across every tenant. Fixed by:
 *   - removing the global fallback (auth now depends solely on the
 *     workflow's own security.webhook_secret)
 *   - auto-provisioning a unique per-workflow secret at activation time
 *     (lib/workflow/webhook-secret.ts), backfilling it on-demand for
 *     already-active workflows via GET /api/workflows/[id]/webhook-secret
 *   - adding a simple X-MagicFlux-Webhook-Secret static-header auth path
 *     alongside the existing full-HMAC signature path
 *   - a rotate action that invalidates the old value immediately, in place
 *
 * This suite covers the full required regression matrix: auth outcomes,
 * execution creation exactly on success, tenant isolation, rotation,
 * ownership-gated reveal, and secret redaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const OWNER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_A = 'wf-auth-a';
const WORKFLOW_B = 'wf-auth-b';
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);

type Row = Record<string, unknown>;

/** Generic fake Supabase query builder: supports select/update/insert with
 *  eq/gte filtering and both .maybeSingle() and bare-await (thenable) modes,
 *  mutating the shared `tables` object in place so persistence is observable. */
function makeFakeDb(tables: Record<string, Row[]>) {
  function builder(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    let mode: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    const eqFilters: Array<[string, unknown]> = [];
    const gteFilters: Array<[string, unknown]> = [];

    const matched = () =>
      rows.filter(
        (r) =>
          eqFilters.every(([c, v]) => r[c] === v) &&
          gteFilters.every(([c, v]) => String(r[c] ?? '') >= String(v)),
      );

    const api: Record<string, unknown> = {
      select() { mode = 'select'; return api; },
      update(p: Row) { mode = 'update'; patch = p; return api; },
      insert(row: Row) { mode = 'insert'; patch = row; return api; },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      gte(c: string, v: unknown) { gteFilters.push([c, v]); return api; },
      maybeSingle: async () => {
        const m = matched();
        if (mode === 'update') {
          m.forEach((r) => Object.assign(r, patch));
          return { data: m[0] ? { ...m[0] } : null, error: null };
        }
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then(resolve: (v: { data: Row[]; count: number; error: null }) => unknown) {
        if (mode === 'update') {
          const m = matched();
          m.forEach((r) => Object.assign(r, patch));
          return Promise.resolve(resolve({ data: m, count: m.length, error: null }));
        }
        if (mode === 'insert') {
          const row = { ...patch };
          rows.push(row);
          insertLog.push({ table, row });
          return Promise.resolve(resolve({ data: [row], count: 1, error: null }));
        }
        const m = matched();
        return Promise.resolve(resolve({ data: m, count: m.length, error: null }));
      },
    };
    return api;
  }

  return { from: (table: string) => builder(table) };
}

let tables: Record<string, Row[]>;
let insertLog: Array<{ table: string; row: Row }>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb(tables)),
  getUserFromRequest: vi.fn(),
}));

const dispatchMock = vi.fn(async (args: { userId: string; workflowId: string }) => ({
  ok: true as const,
  duplicate: false,
  executionId: `exec-${args.workflowId}`,
  status: 'queued',
}));
vi.mock('@/lib/runtime/execution-dispatch', () => ({ dispatchProductionExecution: dispatchMock }));

vi.mock('@/lib/billing/plan-limits', () => ({
  canExecuteWorkflow: vi.fn(async () => ({ allowed: true })),
  getPlanLimits: vi.fn(async () => ({ name: 'Pro' })),
}));

function webhookWorkflow(id: string, userId: string, secret: string | null): Row {
  return {
    id,
    user_id: userId,
    status: 'active',
    workflow_json: {
      nodes: [
        { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: { method: 'POST' } },
      ],
      connections: {},
      ...(secret ? { security: { webhook_secret: secret } } : {}),
    },
    active_deployment_version_id: null,
  };
}

beforeEach(() => {
  tables = {
    workflows: [webhookWorkflow(WORKFLOW_A, OWNER_A, SECRET_A), webhookWorkflow(WORKFLOW_B, OWNER_B, SECRET_B)],
    deployment_versions: [],
    runtime_webhook_request_log: [],
    runtime_webhook_nonces: [],
    runtime_security_alerts: [],
  };
  insertLog = [];
  dispatchMock.mockClear();
});

function postReq(workflowId: string, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return new NextRequest(new URL(`http://localhost/api/workflows/${workflowId}/webhook`), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('webhook route — per-workflow auth (real guardWebhookRequest, no mock)', () => {
  it('#1: POST with no credential at all -> 401, no execution created', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(postReq(WORKFLOW_A), { params: { id: WORKFLOW_A } });
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('#2: POST with the wrong static secret -> 401, no execution created', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': 'totally-wrong-value' }),
      { params: { id: WORKFLOW_A } },
    );
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('#3: POST with the correct X-MagicFlux-Webhook-Secret header -> accepted, exactly one execution created', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': SECRET_A }, { customer_name: 'Brahim Test', order_amount: 150 }),
      { params: { id: WORKFLOW_A } },
    );
    expect(res.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_A, userId: OWNER_A }));
  });

  it('#4: the existing full-HMAC signature path still works unchanged', async () => {
    const { createHmac } = await import('node:crypto');
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');

    const rawBody = JSON.stringify({ ok: true });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-hmac-still-works';
    const canonical = `${timestamp}.${nonce}.${rawBody}`;
    const signature = createHmac('sha256', SECRET_A).update(canonical).digest('hex');

    const req = new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_A}/webhook`), {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-mf-signature': signature,
        'x-mf-timestamp': timestamp,
        'x-mf-nonce': nonce,
      },
    });

    const res = await POST(req, { params: { id: WORKFLOW_A } });
    expect(res.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('#5: GET still has no route handler (Next.js 405s before any code runs, no execution possible)', async () => {
    const routeModule = await import('../app/api/workflows/[id]/webhook/route');
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined();
  });

  it('#9: tenant isolation — workflow A\'s secret does not authenticate against workflow B, and vice versa', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');

    const crossRes = await POST(
      postReq(WORKFLOW_B, { 'x-magicflux-webhook-secret': SECRET_A }),
      { params: { id: WORKFLOW_B } },
    );
    expect(crossRes.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();

    const ownRes = await POST(
      postReq(WORKFLOW_B, { 'x-magicflux-webhook-secret': SECRET_B }),
      { params: { id: WORKFLOW_B } },
    );
    expect(ownRes.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_B, userId: OWNER_B }));
  });

  it('#10: the plaintext secret never appears in runtime_webhook_request_log or runtime_security_alerts rows', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    // One failed, one successful call -- exercise both logging branches.
    await POST(postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': 'wrong' }), { params: { id: WORKFLOW_A } });
    await POST(postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': SECRET_A }), { params: { id: WORKFLOW_A } });

    const relevant = insertLog.filter((e) => e.table === 'runtime_webhook_request_log' || e.table === 'runtime_security_alerts');
    expect(relevant.length).toBeGreaterThan(0);
    for (const entry of relevant) {
      const serialized = JSON.stringify(entry.row);
      expect(serialized).not.toContain(SECRET_A);
    }
  });
});

describe('lib/workflow/webhook-secret.ts — provisioning and rotation', () => {
  it('generates and persists a secret exactly once for a webhook workflow that has none', async () => {
    tables.workflows = [webhookWorkflow('wf-new', OWNER_A, null)];
    const { ensureWebhookSecret } = await import('../lib/workflow/webhook-secret');

    const first = await ensureWebhookSecret(OWNER_A, 'wf-new');
    expect(first.hasWebhookTrigger).toBe(true);
    expect(first.secret).toBeTruthy();
    expect(first.secret!.length).toBeGreaterThanOrEqual(32);

    const second = await ensureWebhookSecret(OWNER_A, 'wf-new');
    expect(second.secret).toBe(first.secret); // never regenerated
  });

  it('does nothing for a workflow with no webhook trigger', async () => {
    tables.workflows = [{ id: 'wf-no-webhook', user_id: OWNER_A, status: 'active', workflow_json: { nodes: [], connections: {} }, active_deployment_version_id: null }];
    const { ensureWebhookSecret } = await import('../lib/workflow/webhook-secret');
    const result = await ensureWebhookSecret(OWNER_A, 'wf-no-webhook');
    expect(result).toEqual({ hasWebhookTrigger: false, secret: null });
  });

  it('also patches the frozen active deployment version, so the runtime sees the same secret it validates against', async () => {
    tables.workflows = [{ ...webhookWorkflow('wf-frozen', OWNER_A, null), active_deployment_version_id: 'dep-1' }];
    tables.deployment_versions = [{ id: 'dep-1', workflow_data: { nodes: [{ type: 'n8n-nodes-base.webhook' }], connections: {} } }];

    const { ensureWebhookSecret } = await import('../lib/workflow/webhook-secret');
    const result = await ensureWebhookSecret(OWNER_A, 'wf-frozen');

    const frozen = tables.deployment_versions[0].workflow_data as { security?: { webhook_secret?: string } };
    expect(frozen.security?.webhook_secret).toBe(result.secret);
  });

  it('#6 (rotation invalidates old secret): the old secret stops working immediately after rotation, with no new workflow created', async () => {
    const { rotateWebhookSecret } = await import('../lib/workflow/webhook-secret');
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');

    // Old secret works before rotation.
    const before = await POST(postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': SECRET_A }), { params: { id: WORKFLOW_A } });
    expect(before.status).toBe(202);

    const workflowCountBefore = tables.workflows.length;
    const rotated = await rotateWebhookSecret(OWNER_A, WORKFLOW_A);
    expect(rotated.secret).toBeTruthy();
    expect(rotated.secret).not.toBe(SECRET_A);
    expect(tables.workflows.length).toBe(workflowCountBefore); // no second workflow row

    dispatchMock.mockClear();
    const afterOld = await POST(postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': SECRET_A }), { params: { id: WORKFLOW_A } });
    expect(afterOld.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();

    const afterNew = await POST(postReq(WORKFLOW_A, { 'x-magicflux-webhook-secret': rotated.secret! }), { params: { id: WORKFLOW_A } });
    expect(afterNew.status).toBe(202);
  });
});

describe('GET/POST /api/workflows/[id]/webhook-secret — ownership-gated reveal and rotation', () => {
  function authedReq(method: 'GET' | 'POST', body?: Record<string, unknown>) {
    return new NextRequest(new URL(`http://localhost/api/workflows/${WORKFLOW_A}/webhook-secret`), {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
  }

  it('#11: the real owner can reveal their own workflow\'s secret', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_A, email: 'a@test.local' } as never);

    const { GET } = await import('../app/api/workflows/[id]/webhook-secret/route');
    const res = await GET(authedReq('GET'), { params: { id: WORKFLOW_A } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.secret).toBe(SECRET_A);
  });

  it('#11: a non-owner cannot read or reveal another workflow\'s secret (404, not the victim\'s value)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'attacker-user', email: 'attacker@test.local' } as never);

    const { GET } = await import('../app/api/workflows/[id]/webhook-secret/route');
    const res = await GET(authedReq('GET'), { params: { id: WORKFLOW_A } });
    const body = await res.json().catch(() => null);

    expect(res.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(SECRET_A);
  });

  it('a non-owner cannot rotate another workflow\'s secret', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'attacker-user', email: 'attacker@test.local' } as never);

    const { POST } = await import('../app/api/workflows/[id]/webhook-secret/route');
    const res = await POST(authedReq('POST', { action: 'rotate' }), { params: { id: WORKFLOW_A } });

    expect(res.status).toBe(404);
    // The victim's real secret must be untouched.
    const workflowRow = tables.workflows.find((w) => w.id === WORKFLOW_A) as { workflow_json: { security?: { webhook_secret?: string } } };
    expect(workflowRow.workflow_json.security?.webhook_secret).toBe(SECRET_A);
  });

  it('an unauthenticated request is rejected before any workflow lookup', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { GET } = await import('../app/api/workflows/[id]/webhook-secret/route');
    const res = await GET(authedReq('GET'), { params: { id: WORKFLOW_A } });
    expect(res.status).toBe(401);
  });
});

describe('secret redaction coverage', () => {
  it('webhook_secret is in the redaction key-set used across logs/errors', async () => {
    const { isSensitiveKey } = await import('../lib/security/redact');
    expect(isSensitiveKey('webhook_secret')).toBe(true);
    expect(isSensitiveKey('webhookSecret')).toBe(true);
  });
});
