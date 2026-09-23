/**
 * Phase 9.9.22 -- Part M: adversarial coverage for the WooCommerce inbound
 * receiver route (app/api/connectors/woocommerce/[connectionId]/receive).
 * Real signature verification and real normalization run in every test
 * (no mocking of lib/connectors/woocommerce/*) -- only persistence
 * (Supabase) and the final dispatch call are mocked, exactly matching the
 * established convention in tests/webhook-per-workflow-auth.security.test.ts
 * for the generic webhook route.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptSecretValue } from '@/lib/security/encryption';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'a'.repeat(64);
  }
});

const SECRET = 'wc-connector-secret-abc123';
const CONNECTION_A = 'conn-aaaa';
const CONNECTION_B = 'conn-bbbb';
const WORKFLOW_A = 'wf-aaaa';
const WORKFLOW_B = 'wf-bbbb';
const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const OWNER_B = '00000000-0000-4000-8000-0000000000b2';

type Row = Record<string, unknown>;

function makeFakeDb(tables: Record<string, Row[]>) {
  function builder(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    let mode: 'select' | 'update' = 'select';
    let patch: Row = {};
    const eqFilters: Array<[string, unknown]> = [];

    const matched = () => rows.filter((r) => eqFilters.every(([c, v]) => r[c] === v));

    const api: Record<string, unknown> = {
      select() { mode = 'select'; return api; },
      update(p: Row) { mode = 'update'; patch = p; return api; },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      maybeSingle: async () => {
        const m = matched();
        if (mode === 'update') {
          m.forEach((r) => Object.assign(r, patch));
        }
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        if (mode === 'update') {
          const m = matched();
          m.forEach((r) => Object.assign(r, patch));
          return Promise.resolve(resolve({ data: m, error: null }));
        }
        return Promise.resolve(resolve({ data: matched(), error: null }));
      },
    };
    return api;
  }
  return { from: (table: string) => builder(table) };
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb(tables)),
  getUserFromRequest: vi.fn(),
}));

const dispatchMock = vi.fn(async (args: { workflowId: string; idempotencyKey: string }) => ({
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

function connectionRow(id: string, workflowId: string, userId: string, secret: string, subscriptions: Record<string, string> = { 'order.created': '10' }): Row {
  return {
    id,
    user_id: userId,
    workflow_id: workflowId,
    platform: 'woocommerce',
    status: 'connected',
    store_url: 'https://store.example.com',
    webhook_secret_encrypted: encryptSecretValue(secret),
    provider_subscriptions: subscriptions,
    topics: Object.keys(subscriptions),
    last_verified_at: null,
    last_event_at: null,
    last_error: null,
    error_category: null,
  };
}

function activeWorkflowRow(id: string, userId: string, requiredEmail = true): Row {
  return {
    id,
    user_id: userId,
    status: 'active',
    active_deployment_version_id: null,
    workflow_json: {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.webhook', parameters: {} },
        requiredEmail
          ? { id: '2', type: 'n8n-nodes-base.slack', parameters: { text: '={{$json["email"]}}' } }
          : { id: '2', type: 'n8n-nodes-base.slack', parameters: { text: 'no fields required' } },
      ],
    },
  };
}

function orderPayload(email = 'jane@example.com') {
  return JSON.stringify({ id: 1, status: 'processing', billing: { email, first_name: 'Jane', last_name: 'Doe' } });
}

function postReq(connectionId: string, headers: Record<string, string>, body: string) {
  return new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}/receive`), {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function importRoute() {
  return import('../app/api/connectors/woocommerce/[connectionId]/receive/route');
}

beforeEach(() => {
  tables = {
    platform_connections: [connectionRow(CONNECTION_A, WORKFLOW_A, OWNER_A, SECRET), connectionRow(CONNECTION_B, WORKFLOW_B, OWNER_B, 'different-secret')],
    workflows: [activeWorkflowRow(WORKFLOW_A, OWNER_A), activeWorkflowRow(WORKFLOW_B, OWNER_B)],
    deployment_versions: [],
  };
  dispatchMock.mockClear();
});

async function signedReq(connectionId: string, secret: string, body: string, extraHeaders: Record<string, string> = {}) {
  const { computeWooCommerceSignature } = await import('@/lib/connectors/woocommerce/signature');
  const sig = computeWooCommerceSignature(body, secret);
  return postReq(connectionId, { 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'delivery-1', ...extraHeaders }, body);
}

describe('POST /api/connectors/woocommerce/[connectionId]/receive -- adversarial coverage', () => {
  it('valid signature + supported topic + all required fields present -> 202, dispatches exactly once', async () => {
    const { POST } = await importRoute();
    const req = await signedReq(CONNECTION_A, SECRET, orderPayload());
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_A, userId: OWNER_A }));
    // Slower than the rest of this suite -- first test to pull in the full
    // route module graph (Next.js request/response, the connector registry,
    // trigger-field derivation) cold; every later test benefits from the
    // already-warm module cache.
  }, 15000);

  it('invalid signature -> 401, never dispatches', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = postReq(CONNECTION_A, { 'x-wc-webhook-signature': 'aW52YWxpZC1zaWduYXR1cmU=', 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'delivery-inv-1' }, body);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('Phase 9.9.22B Live Certification Failure #2: an invalid signature persists a SAFE diagnostic summary (delivery id, topic, body length, signature-present) and never leaks the signature, secret, or payload content', async () => {
    const { POST } = await importRoute();
    const body = orderPayload('super-secret-customer@example.com');
    const req = postReq(CONNECTION_A, { 'x-wc-webhook-signature': 'aW52YWxpZC1zaWduYXR1cmU=', 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'delivery-diag-1' }, body);
    await POST(req, { params: { connectionId: CONNECTION_A } });

    const row = tables.platform_connections.find((r) => r.id === CONNECTION_A) as { last_error: string; error_category: string; webhook_secret_encrypted: string };
    expect(row.error_category).toBe('invalid_signature');
    expect(row.last_error).toContain('delivery-diag-1');
    expect(row.last_error).toContain('order.created');
    expect(row.last_error).toContain('signaturePresent=true');
    // Never the signature value, the encrypted/decrypted secret, or the payload's own sensitive content.
    expect(row.last_error).not.toContain('aW52YWxpZC1zaWduYXR1cmU=');
    expect(row.last_error).not.toContain(SECRET);
    expect(row.last_error).not.toContain(row.webhook_secret_encrypted);
    expect(row.last_error).not.toContain('super-secret-customer@example.com');
  });

  it('Phase 9.9.22B Live Certification Failure #3: a MISSING signature header is rejected with its own error code and logged, but deliberately does NOT overwrite connection health -- unrelated scanner/bot noise on the public receive URL must never make a healthy connection look broken', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = postReq(CONNECTION_A, { 'x-wc-webhook-topic': 'order.created' }, body); // no signature header at all
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    const payload = await res.json();

    expect(res.status).toBe(401);
    expect(payload.error).toBe('MISSING_WOOCOMMERCE_SIGNATURE');

    const row = tables.platform_connections.find((r) => r.id === CONNECTION_A) as { last_error: string | null; error_category: string | null; status: string };
    expect(row.last_error).toBeNull(); // untouched -- the connection's own row never had one to begin with in this fixture
    expect(row.error_category).toBeNull();
    expect(row.status).toBe('connected'); // untouched
  });

  it('a signature that IS present but WRONG still updates connection health (distinct from the missing-header case above)', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = postReq(CONNECTION_A, { 'x-wc-webhook-signature': 'd0hhdGV2ZXI=', 'x-wc-webhook-topic': 'order.created' }, body);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    const payload = await res.json();

    expect(res.status).toBe(401);
    expect(payload.error).toBe('INVALID_WOOCOMMERCE_SIGNATURE');

    const row = tables.platform_connections.find((r) => r.id === CONNECTION_A) as { error_category: string; status: string };
    expect(row.error_category).toBe('invalid_signature');
    expect(row.status).toBe('needs_attention');
  });

  it('tampered body (signature computed on a different body) -> 401, never dispatches', async () => {
    const { POST } = await importRoute();
    const { computeWooCommerceSignature } = await import('@/lib/connectors/woocommerce/signature');
    const originalBody = orderPayload('real@example.com');
    const sig = computeWooCommerceSignature(originalBody, SECRET);
    const tamperedBody = orderPayload('attacker-injected@evil.com');
    const req = postReq(CONNECTION_A, { 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'order.created' }, tamperedBody);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('wrong tenant/connection: connection B\'s secret does not authenticate against connection A', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = await signedReq(CONNECTION_A, 'different-secret', body); // connection B's real secret
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('cross-tenant: a correctly-signed request against an unknown connection id is rejected, not silently matched to any tenant', async () => {
    const { POST } = await importRoute();
    const req = await signedReq('does-not-exist', SECRET, orderPayload());
    const res = await POST(req, { params: { connectionId: 'does-not-exist' } });
    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('duplicate delivery: the SAME delivery id produces the SAME idempotency key across two separate requests', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req1 = await signedReq(CONNECTION_A, SECRET, body, { 'x-wc-webhook-delivery-id': 'delivery-dup-1' });
    await POST(req1, { params: { connectionId: CONNECTION_A } });
    const firstKey = dispatchMock.mock.calls[0][0].idempotencyKey;

    dispatchMock.mockClear();
    const req2 = await signedReq(CONNECTION_A, SECRET, body, { 'x-wc-webhook-delivery-id': 'delivery-dup-1' });
    await POST(req2, { params: { connectionId: CONNECTION_A } });
    const secondKey = dispatchMock.mock.calls[0][0].idempotencyKey;

    // Real duplicate suppression happens inside dispatchProductionExecution's
    // own atomic reservation (already covered by tests/idempotency.test.ts);
    // this proves THIS route feeds it the identical key both times, which is
    // the precondition for that suppression to actually fire.
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toContain(CONNECTION_A);
    expect(firstKey).toContain('delivery-dup-1');
  });

  it('a DIFFERENT delivery id for the same connection produces a DIFFERENT idempotency key', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req1 = await signedReq(CONNECTION_A, SECRET, body, { 'x-wc-webhook-delivery-id': 'delivery-x' });
    await POST(req1, { params: { connectionId: CONNECTION_A } });
    const key1 = dispatchMock.mock.calls[0][0].idempotencyKey;

    dispatchMock.mockClear();
    const req2 = await signedReq(CONNECTION_A, SECRET, body, { 'x-wc-webhook-delivery-id': 'delivery-y' });
    await POST(req2, { params: { connectionId: CONNECTION_A } });
    const key2 = dispatchMock.mock.calls[0][0].idempotencyKey;

    expect(key1).not.toBe(key2);
  });

  it('oversized payload (Content-Length lie) -> 413, never dispatches', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = await signedReq(CONNECTION_A, SECRET, body, { 'content-length': String(2 * 1024 * 1024) });
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(413);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('oversized payload (real body over the cap, honest Content-Length) -> 413', async () => {
    const { POST } = await importRoute();
    const hugeBody = JSON.stringify({ billing: { email: 'a@b.com' }, filler: 'x'.repeat(2 * 1024 * 1024) });
    const req = await signedReq(CONNECTION_A, SECRET, hugeBody);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(413);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('unsupported event/topic -> acknowledged (200) but never dispatched, never mis-mapped', async () => {
    const { POST } = await importRoute();
    const body = JSON.stringify({ id: 1, name: 'Widget' });
    const req = await signedReq(CONNECTION_A, SECRET, body, { 'x-wc-webhook-topic': 'product.created' });
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.skipped).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('malformed JSON body -> normalize() fails closed, acknowledged without dispatch (signature still verified on the raw bytes first)', async () => {
    const { POST } = await importRoute();
    const malformed = '{not valid json';
    const req = await signedReq(CONNECTION_A, SECRET, malformed);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(200);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('WooCommerce connectivity ping ({"webhook_id": N}) is acknowledged, never dispatched', async () => {
    const { POST } = await importRoute();
    const ping = JSON.stringify({ webhook_id: 10 });
    const req = await signedReq(CONNECTION_A, SECRET, ping);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ping).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('a required workflow field missing from the event -> 422 MAPPING_INCOMPLETE, never dispatched with malformed data', async () => {
    const { POST } = await importRoute();
    const orderWithoutEmail = JSON.stringify({ id: 1, status: 'processing', billing: { first_name: 'Jane' } });
    const req = await signedReq(CONNECTION_A, SECRET, orderWithoutEmail);
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(422);
    const payload = await res.json();
    expect(payload.error).toBe('MAPPING_INCOMPLETE');
    expect(payload.missingFields).toContain('email');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('the target workflow is not active -> 422, never dispatched (connector never bypasses the runtime\'s own activation gate)', async () => {
    tables.workflows = [{ ...activeWorkflowRow(WORKFLOW_A, OWNER_A), status: 'draft' }];
    const { POST } = await importRoute();
    const req = await signedReq(CONNECTION_A, SECRET, orderPayload());
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(422);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('Phase 9.9.22B Live Certification Failure #3: a genuinely SIGNED, verified event rejected only because the workflow is not active updates connection health with its own distinct category -- proving the connector itself is healthy even though nothing dispatched', async () => {
    tables.workflows = [{ ...activeWorkflowRow(WORKFLOW_A, OWNER_A), status: 'error' }];
    const { POST } = await importRoute();
    const req = await signedReq(CONNECTION_A, SECRET, orderPayload());
    const res = await POST(req, { params: { connectionId: CONNECTION_A } });
    expect(res.status).toBe(422);
    expect(dispatchMock).not.toHaveBeenCalled();

    const row = tables.platform_connections.find((r) => r.id === CONNECTION_A) as { error_category: string; last_error: string; last_verified_at: string | null };
    expect(row.error_category).toBe('workflow_not_active');
    expect(row.last_error).toContain('verified successfully');
    expect(row.last_verified_at).not.toBeNull(); // proves signature verification itself succeeded
  });

  it('an unknown connection id (deleted/never existed) -> 404, never dispatched', async () => {
    const { POST } = await importRoute();
    const body = orderPayload();
    const req = postReq('nonexistent-connection', { 'x-wc-webhook-signature': 'irrelevant', 'x-wc-webhook-topic': 'order.created' }, body);
    const res = await POST(req, { params: { connectionId: 'nonexistent-connection' } });
    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
