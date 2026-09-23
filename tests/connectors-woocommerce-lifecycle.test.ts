/**
 * Phase 9.9.22 -- Part K/M: connect/test/disconnect lifecycle coverage --
 * repeated Connect clicks, partial subscription failure, revoked
 * credentials, a subscription deleted externally, and disconnect cleanup.
 * WooCommerce's REST API is mocked via a URL-routing fetch stub (never the
 * connector's own client/connector modules), so the real SSRF check, the
 * real signature/subscribe logic, and the real de-dup-before-create check
 * all run for real.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'a'.repeat(64);
  }
});

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const WORKFLOW_A = 'wf-lifecycle-a';
const STORE_URL = 'https://store.example.com';

vi.mock('node:dns', () => ({
  promises: { lookup: vi.fn(async () => [{ address: '203.0.113.10' }]) },
}));

type Row = Record<string, unknown>;

function makeFakeDb(tables: Record<string, Row[]>) {
  function builder(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    const eqFilters: Array<[string, unknown]> = [];

    const matched = () => rows.filter((r) => eqFilters.every(([c, v]) => r[c] === v));

    const api: Record<string, unknown> = {
      select() { mode = mode === 'insert' ? 'insert' : 'select'; return api; },
      update(p: Row) { mode = 'update'; patch = p; return api; },
      insert(p: Row) { mode = 'insert'; patch = p; return api; },
      delete() { mode = 'delete'; return api; },
      upsert(newRows: Row[], opts?: { onConflict?: string }) {
        const keys = (opts?.onConflict ?? '').split(',').filter(Boolean);
        for (const row of newRows) {
          const existing = keys.length > 0 ? rows.find((r) => keys.every((k) => r[k] === row[k])) : undefined;
          if (existing) Object.assign(existing, row);
          else rows.push({ id: `row-${rows.length + 1}`, ...row });
        }
        mode = 'select';
        return { then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve(resolve({ data: newRows, error: null })) };
      },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      maybeSingle: async () => {
        if (mode === 'insert') {
          const row = { id: `row-${rows.length + 1}`, ...patch };
          rows.push(row);
          return { data: row, error: null };
        }
        const m = matched();
        if (mode === 'update') m.forEach((r) => Object.assign(r, patch));
        if (mode === 'delete') { for (const r of m) rows.splice(rows.indexOf(r), 1); }
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      single: async () => {
        if (mode === 'insert') {
          const row = { id: `row-${rows.length + 1}`, ...patch };
          rows.push(row);
          return { data: row, error: null };
        }
        const m = matched();
        return { data: m[0] ? { ...m[0] } : null, error: m[0] ? null : { message: 'not found' } };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        if (mode === 'update') {
          const m = matched();
          m.forEach((r) => Object.assign(r, patch));
          return Promise.resolve(resolve({ data: m, error: null }));
        }
        if (mode === 'delete') {
          const m = matched();
          for (const r of m) rows.splice(rows.indexOf(r), 1);
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
let currentUserId: string | null;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb(tables)),
  getUserFromRequest: vi.fn(async () => (currentUserId ? { id: currentUserId, email: 'owner@test.local' } : null)),
}));

let nextWebhookId = 100;
let storeWebhooks: Array<{ id: number; topic: string; delivery_url: string; status: string }>;

async function defaultFetchImpl(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url);
  const method = init?.method ?? 'GET';

  if (u.pathname === '/wp-json/') {
    return { status: 200, headers: { get: () => null }, body: null, text: async () => '{}' };
  }
  if (u.pathname === '/wp-json/wc/v3/webhooks' && method === 'GET') {
    return { status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(storeWebhooks) };
  }
  if (u.pathname === '/wp-json/wc/v3/webhooks' && method === 'POST') {
    const body = JSON.parse(init!.body as string) as { topic: string; delivery_url: string };
    const webhook = { id: nextWebhookId++, topic: body.topic, delivery_url: body.delivery_url, status: 'active' };
    storeWebhooks.push(webhook);
    return { status: 201, headers: { get: () => null }, body: null, text: async () => JSON.stringify(webhook) };
  }
  if (u.pathname.startsWith('/wp-json/wc/v3/webhooks/') && method === 'DELETE') {
    const id = Number(u.pathname.split('/').pop());
    storeWebhooks = storeWebhooks.filter((w) => w.id !== id);
    return { status: 200, headers: { get: () => null }, body: null, text: async () => '{}' };
  }
  throw new Error(`Unhandled mock fetch: ${method} ${u.pathname}`);
}

const fetchMock = vi.fn(defaultFetchImpl);

beforeEach(() => {
  tables = { workflows: [{ id: WORKFLOW_A, user_id: OWNER_A }], platform_connections: [], integration_credentials: [] };
  currentUserId = OWNER_A;
  storeWebhooks = [];
  nextWebhookId = 100;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetchImpl);
});

function connectReq(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost/api/connectors/woocommerce/connect'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_CONNECT_BODY = { workflowId: WORKFLOW_A, storeUrl: STORE_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' };

describe('POST /api/connectors/woocommerce/connect', () => {
  it('creates the connection and exactly one WooCommerce webhook per default topic', async () => {
    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq(VALID_CONNECT_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('connected');
    expect(storeWebhooks.length).toBe(2); // order.created + customer.created
  });

  it('repeated Connect clicks never create duplicate WooCommerce webhook subscriptions (Part K)', async () => {
    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res1 = await POST(connectReq(VALID_CONNECT_BODY));
    expect(res1.status).toBe(200);
    expect(storeWebhooks.length).toBe(2);

    const res2 = await POST(connectReq(VALID_CONNECT_BODY));
    expect(res2.status).toBe(200);
    // Still exactly 2 -- the second call adopted the existing subscriptions
    // instead of creating new ones.
    expect(storeWebhooks.length).toBe(2);
    expect(tables.platform_connections.length).toBe(1); // still one connection row, not two
  });

  it('revoked/invalid credentials -> 400 CREDENTIALS_INVALID, no connection or subscription created', async () => {
    // Override just the credentials-list call to 401 -- everything else
    // (store reachability) still goes through the real default routing.
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if (u.pathname === '/wp-json/wc/v3/webhooks' && (init?.method ?? 'GET') === 'GET') {
        return { status: 401, headers: { get: () => null }, body: null, text: async () => '{}' };
      }
      return defaultFetchImpl(url, init);
    });

    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq(VALID_CONNECT_BODY));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('CREDENTIALS_INVALID');
    expect(tables.platform_connections.length).toBe(0);
    expect(storeWebhooks.length).toBe(0);
  });

  it('a read-only Consumer Key (list succeeds, create fails 403) -> partial-failure result, needs_attention persisted, no accumulation on retry', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      if (u.pathname === '/wp-json/') return { status: 200, headers: { get: () => null }, body: null, text: async () => '{}' };
      if (u.pathname === '/wp-json/wc/v3/webhooks' && method === 'GET') return { status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(storeWebhooks) };
      if (u.pathname === '/wp-json/wc/v3/webhooks' && method === 'POST') return { status: 403, headers: { get: () => null }, body: null, text: async () => '{}' };
      throw new Error(`unexpected ${method} ${u.pathname}`);
    });

    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq(VALID_CONNECT_BODY));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('SUBSCRIPTION_FAILED');
    expect(tables.platform_connections[0].status).toBe('needs_attention');
  });

  it('rejects an SSRF-unsafe store URL before any credential is saved', async () => {
    const dnsModule = await import('node:dns');
    vi.mocked(dnsModule.promises.lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);

    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq({ ...VALID_CONNECT_BODY, storeUrl: 'https://internal.example.com' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('STORE_UNREACHABLE');
    expect(tables.integration_credentials.length).toBe(0);
  });

  it('rejects an unsupported topic explicitly rather than silently ignoring it', async () => {
    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq({ ...VALID_CONNECT_BODY, topics: ['product.created'] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('UNSUPPORTED_TOPICS');
  });

  it('a non-owned workflow id is rejected (cross-tenant connect attempt)', async () => {
    currentUserId = 'attacker-user';
    const { POST } = await import('../app/api/connectors/woocommerce/connect/route');
    const res = await POST(connectReq(VALID_CONNECT_BODY));
    expect(res.status).toBe(404);
    expect(tables.platform_connections.length).toBe(0);
  });
});

describe('DELETE /api/connectors/woocommerce/[connectionId] -- disconnect cleanup', () => {
  it('removes the WooCommerce-side webhook subscription(s) and the connection row', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    const connectRes = await connect(connectReq(VALID_CONNECT_BODY));
    const { connectionId } = await connectRes.json();
    expect(storeWebhooks.length).toBe(2);

    const { DELETE } = await import('../app/api/connectors/woocommerce/[connectionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}`), { method: 'DELETE' });
    const res = await DELETE(req, { params: { connectionId } });

    expect(res.status).toBe(200);
    expect(storeWebhooks.length).toBe(0); // both subscriptions removed from the store
    expect(tables.platform_connections.length).toBe(0);
  });

  it('disconnect tolerates a subscription already deleted externally in WooCommerce (Part K)', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    const connectRes = await connect(connectReq(VALID_CONNECT_BODY));
    const { connectionId } = await connectRes.json();

    // Simulate the store owner deleting one subscription directly in WooCommerce.
    storeWebhooks = [];

    const { DELETE } = await import('../app/api/connectors/woocommerce/[connectionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}`), { method: 'DELETE' });
    const res = await DELETE(req, { params: { connectionId } });

    expect(res.status).toBe(200); // never fails just because the provider side was already gone
  });

  it('a non-owner cannot disconnect another tenant\'s connection', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    const connectRes = await connect(connectReq(VALID_CONNECT_BODY));
    const { connectionId } = await connectRes.json();

    currentUserId = 'attacker-user';
    const { DELETE } = await import('../app/api/connectors/woocommerce/[connectionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}`), { method: 'DELETE' });
    const res = await DELETE(req, { params: { connectionId } });

    expect(res.status).toBe(404);
    expect(storeWebhooks.length).toBe(2); // untouched -- the attacker's request never reached the real connection
  });
});

describe('POST /api/connectors/woocommerce/[connectionId]/test -- Test Connection', () => {
  it('reports "ready" for a healthy connection', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    const connectRes = await connect(connectReq(VALID_CONNECT_BODY));
    const { connectionId } = await connectRes.json();

    const { POST: test } = await import('../app/api/connectors/woocommerce/[connectionId]/test/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}/test`), { method: 'POST' });
    const res = await test(req, { params: { connectionId } });
    const body = await res.json();

    expect(body.stage).toBe('ready');
  });

  it('detects a subscription deleted externally in WooCommerce and reports subscription_invalid', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    const connectRes = await connect(connectReq(VALID_CONNECT_BODY));
    const { connectionId } = await connectRes.json();

    storeWebhooks = []; // deleted externally

    const { POST: test } = await import('../app/api/connectors/woocommerce/[connectionId]/test/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/${connectionId}/test`), { method: 'POST' });
    const res = await test(req, { params: { connectionId } });
    const body = await res.json();

    expect(body.stage).toBe('subscription_invalid');
  });
});

describe('GET /api/connectors/woocommerce/connect?workflowId=... -- Phase 9.9.22B workflow-scoped lookup', () => {
  it('reports connected:false when no connection exists yet', async () => {
    const { GET } = await import('../app/api/connectors/woocommerce/connect/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/connect?workflowId=${WORKFLOW_A}`));
    const res = await GET(req);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it('reports full status once a connection exists, never leaking credentials or the webhook secret', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    await connect(connectReq(VALID_CONNECT_BODY));

    const { GET } = await import('../app/api/connectors/woocommerce/connect/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/connect?workflowId=${WORKFLOW_A}`));
    const res = await GET(req);
    const body = await res.json();

    expect(body.connected).toBe(true);
    expect(body.status).toBe('connected');
    expect(body.storeUrl).toBe(STORE_URL);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('cs_test'); // the consumer secret used in VALID_CONNECT_BODY
    expect(raw.toLowerCase()).not.toContain('secret_encrypted');
  });

  it('a stranger looking up the same workflowId sees connected:false, never the real owner\'s connection', async () => {
    const { POST: connect } = await import('../app/api/connectors/woocommerce/connect/route');
    await connect(connectReq(VALID_CONNECT_BODY));

    currentUserId = 'attacker-user';
    const { GET } = await import('../app/api/connectors/woocommerce/connect/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/connect?workflowId=${WORKFLOW_A}`));
    const res = await GET(req);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it('requires authentication', async () => {
    currentUserId = null;
    const { GET } = await import('../app/api/connectors/woocommerce/connect/route');
    const req = new NextRequest(new URL(`http://localhost/api/connectors/woocommerce/connect?workflowId=${WORKFLOW_A}`));
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/connectors/woocommerce/validate -- Phase 9.9.22B pre-connect test', () => {
  function validateReq(body: Record<string, unknown>) {
    return new NextRequest(new URL('http://localhost/api/connectors/woocommerce/validate'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('reports ready for a reachable store with valid credentials, and persists nothing', async () => {
    const { POST } = await import('../app/api/connectors/woocommerce/validate/route');
    const res = await POST(validateReq({ storeUrl: STORE_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' }));
    const body = await res.json();
    expect(body.stage).toBe('ready');
    expect(tables.platform_connections.length).toBe(0);
    expect(tables.integration_credentials.length).toBe(0);
  });

  it('reports credentials_invalid for a rejected key, without creating anything', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = new URL(url);
      if (u.pathname === '/wp-json/') return { status: 200, headers: { get: () => null }, body: null, text: async () => '{}' };
      if (u.pathname === '/wp-json/wc/v3/webhooks' && (init?.method ?? 'GET') === 'GET') return { status: 401, headers: { get: () => null }, body: null, text: async () => '{}' };
      return defaultFetchImpl(url, init);
    });
    const { POST } = await import('../app/api/connectors/woocommerce/validate/route');
    const res = await POST(validateReq({ storeUrl: STORE_URL, consumerKey: 'wrong', consumerSecret: 'wrong' }));
    const body = await res.json();
    expect(body.stage).toBe('credentials_invalid');
  });

  it('rejects an SSRF-unsafe store URL before any credential is checked', async () => {
    const dnsModule = await import('node:dns');
    vi.mocked(dnsModule.promises.lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
    const { POST } = await import('../app/api/connectors/woocommerce/validate/route');
    const res = await POST(validateReq({ storeUrl: 'https://internal.example.com', consumerKey: 'ck', consumerSecret: 'cs' }));
    const body = await res.json();
    expect(body.stage).toBe('store_unreachable');
  });

  it('requires authentication', async () => {
    currentUserId = null;
    const { POST } = await import('../app/api/connectors/woocommerce/validate/route');
    const res = await POST(validateReq({ storeUrl: STORE_URL, consumerKey: 'ck', consumerSecret: 'cs' }));
    expect(res.status).toBe(401);
  });
});
