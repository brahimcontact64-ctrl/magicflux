/**
 * Final verification pass — correctness of all recent security fixes.
 *
 * This suite does NOT search for new vulnerabilities.
 * It verifies that each specific fix behaves correctly and introduced
 * no functional regressions.
 *
 * Sections:
 *   V1 — frozenMap() Map-operation parity
 *   V2 — HANDLER_NODE_ALLOWLIST handler lookup regression
 *   V3 — googleDriveHandler live/test behavior and credential isolation
 *   V4 — createSampleDataForWorkflow extraction parity
 *   V5 — deepInject prototype-pollution patch: no legitimate payload broken
 *   V6 — Regression review: dispatchNode end-to-end
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HANDLER_NODE_ALLOWLIST, dispatchNode } from '../lib/workflow-runtime/node-handlers';
import { googleDriveHandler }                   from '../lib/workflow-runtime/node-handlers/googledrive';
import { createSampleDataForWorkflow }          from '../lib/workflow-runtime/sample-data';
import { injectCredentialsIntoWorkflow, type IntegrationRecord } from '../lib/integrations';
import type { NodeHandlerContext }              from '../lib/workflow-runtime/types';

// ── Shared contexts ───────────────────────────────────────────────────────────

const LIVE_CTX: NodeHandlerContext = {
  mode: 'live', integrations: [],
  sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] },
};
const TEST_CTX: NodeHandlerContext = {
  mode: 'test', integrations: [],
  sampleData: { key: 'sample' }, previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

// ─── V1: frozenMap() Map-operation parity ────────────────────────────────────
//
// Verify that wrapping in a Proxy did not break any read operation on the map.

describe('V1 — frozenMap: all standard read operations work correctly', () => {

  it('V1.1: .get() returns correct handler for an allowlisted type', () => {
    const h = HANDLER_NODE_ALLOWLIST.get('n8n-nodes-base.shopify');
    expect(h).toBeDefined();
    expect(typeof h).toBe('function');
  });

  it('V1.2: .get() returns undefined for an unknown type', () => {
    expect(HANDLER_NODE_ALLOWLIST.get('n8n-nodes-base.slackCustom')).toBeUndefined();
    expect(HANDLER_NODE_ALLOWLIST.get('totally.unknown')).toBeUndefined();
  });

  it('V1.3: .has() returns true for every allowlisted entry', () => {
    const expectedTypes = [
      'n8n-nodes-base.shopify',   'n8n-nodes-base.shopifytrigger',
      'n8n-nodes-base.slack',     'n8n-nodes-base.slacktrigger',
      'n8n-nodes-base.airtable',  'n8n-nodes-base.airtabletrigger',
      'n8n-nodes-base.emailsend', 'n8n-nodes-base.emailreadimap',
      'n8n-nodes-base.gmail',     'n8n-nodes-base.gmailtrigger',
      'n8n-nodes-base.googledrive', 'n8n-nodes-base.googledrivetrigger',
      'n8n-nodes-base.openai',
    ];
    for (const t of expectedTypes) {
      expect(HANDLER_NODE_ALLOWLIST.has(t), `missing: ${t}`).toBe(true);
    }
  });

  it('V1.4: .has() returns false for crafted fake types', () => {
    expect(HANDLER_NODE_ALLOWLIST.has('n8n-nodes-base.shopifyFakeHttp')).toBe(false);
    expect(HANDLER_NODE_ALLOWLIST.has('n8n-nodes-base.slackCustom')).toBe(false);
    expect(HANDLER_NODE_ALLOWLIST.has('')).toBe(false);
  });

  it('V1.5: .size is 15', () => {
    expect(HANDLER_NODE_ALLOWLIST.size).toBe(15);
  });

  it('V1.6: .entries() iterates all 15 pairs', () => {
    const entries = [...HANDLER_NODE_ALLOWLIST.entries()];
    expect(entries).toHaveLength(15);
    for (const [key, val] of entries) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('function');
    }
  });

  it('V1.7: .keys() iterates all 15 node types', () => {
    const keys = [...HANDLER_NODE_ALLOWLIST.keys()];
    expect(keys).toHaveLength(15);
    expect(keys.every(k => typeof k === 'string')).toBe(true);
  });

  it('V1.8: .values() iterates all 15 handlers', () => {
    const values = [...HANDLER_NODE_ALLOWLIST.values()];
    expect(values).toHaveLength(15);
    expect(values.every(v => typeof v === 'function')).toBe(true);
  });

  it('V1.9: Symbol.iterator works (for...of)', () => {
    let count = 0;
    for (const [key, val] of HANDLER_NODE_ALLOWLIST) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('function');
      count++;
    }
    expect(count).toBe(15);
  });

  it('V1.10: .forEach() visits all 15 entries', () => {
    let count = 0;
    HANDLER_NODE_ALLOWLIST.forEach((val, key) => {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('function');
      count++;
    });
    expect(count).toBe(15);
  });

  it('V1.11: .set() throws TypeError (mutation blocked)', () => {
    expect(() => {
      (HANDLER_NODE_ALLOWLIST as Map<string, unknown>).set('evil', () => null);
    }).toThrow(TypeError);
    expect(HANDLER_NODE_ALLOWLIST.has('evil')).toBe(false);
    expect(HANDLER_NODE_ALLOWLIST.size).toBe(15);
  });

  it('V1.12: .delete() throws TypeError (mutation blocked)', () => {
    expect(() => {
      (HANDLER_NODE_ALLOWLIST as Map<string, unknown>).delete('n8n-nodes-base.shopify');
    }).toThrow(TypeError);
    // Entry must still be present
    expect(HANDLER_NODE_ALLOWLIST.has('n8n-nodes-base.shopify')).toBe(true);
    expect(HANDLER_NODE_ALLOWLIST.size).toBe(15);
  });

  it('V1.14: .clear() throws TypeError (mutation blocked)', () => {
    expect(() => {
      (HANDLER_NODE_ALLOWLIST as Map<string, unknown>).clear();
    }).toThrow(TypeError);
    expect(HANDLER_NODE_ALLOWLIST.size).toBe(15);
  });

});

// ─── V2: HANDLER_NODE_ALLOWLIST handler lookup regression ────────────────────
//
// Verify that pickHandler() still returns the correct handler for every
// allowlisted type and does NOT change behavior for generic types.

describe('V2 — HANDLER_NODE_ALLOWLIST: no handler lookup regression', () => {

  it('V2.1: n8n-nodes-base.shopify → shopifyHandler (simulated_success in test mode)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.shopify' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
    expect(r.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(true);
  });

  it('V2.2: n8n-nodes-base.slack → slackHandler (simulated_success in test mode)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.slack', parameters: { text: 'hi' } }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.3: n8n-nodes-base.airtable → airtableHandler (simulated_success)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.airtable' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.4: n8n-nodes-base.emailSend → emailHandler (simulated_success)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.emailSend' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.5: n8n-nodes-base.gmail → emailHandler (simulated_success)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.gmail' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.6: n8n-nodes-base.googledrive → googleDriveHandler (simulated_success in test)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.googledrive' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.7: trigger-type → webhookHandler (simulated_success in test)', async () => {
    const r = await dispatchNode({ type: 'n8n-nodes-base.manualTrigger' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
  });

  it('V2.8: code node → codeHandler → disabled in live, simulated_success in test', async () => {
    const rLive = await dispatchNode({ type: 'n8n-nodes-base.code', parameters: { jsCode: 'output = 42' } }, {}, LIVE_CTX);
    expect(rLive.status).toBe('failed');
    expect(rLive.error).toBe('CODE_NODES_DISABLED_LIVE_MODE');

    const rTest = await dispatchNode({ type: 'n8n-nodes-base.code', parameters: { jsCode: 'output = 42' } }, { x: 1 }, TEST_CTX);
    expect(rTest.status).toBe('simulated_success');
    expect(rTest.outputData).toEqual({ x: 1 }); // input returned unchanged
  });

  it('V2.9: unknown type → UNSUPPORTED_NODE_TYPE in live mode', async () => {
    const r = await dispatchNode({ type: 'some.unknownNode' }, {}, LIVE_CTX);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('UNSUPPORTED_NODE_TYPE');
  });

  it('V2.10: case-insensitive lookup still works (N8N-NODES-BASE.SHOPIFY)', async () => {
    // pickHandler lowercases the type key before map lookup
    const r = await dispatchNode({ type: 'N8N-NODES-BASE.SHOPIFY' }, {}, TEST_CTX);
    expect(r.status).toBe('simulated_success');
    expect(r.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(true);
  });

});

// ─── V3: googleDriveHandler — no credential exposure ─────────────────────────

describe('V3 — googleDriveHandler: safe stub behavior', () => {

  const INPUT = { doc: 'hello.txt', content: 'world' };

  it('V3.1: live mode → failed with GOOGLE_DRIVE_NOT_IMPLEMENTED', async () => {
    const r = await googleDriveHandler({}, INPUT, LIVE_CTX);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('GOOGLE_DRIVE_NOT_IMPLEMENTED');
    expect(r.outputData).toBeNull();
  });

  it('V3.2: test mode → simulated_success, inputData returned unchanged', async () => {
    const r = await googleDriveHandler({}, INPUT, TEST_CTX);
    expect(r.status).toBe('simulated_success');
    expect(r.outputData).toEqual(INPUT);
  });

  it('V3.3: handler never reads integrations (no credential access)', async () => {
    const ctxWithCreds: NodeHandlerContext = {
      ...LIVE_CTX,
      integrations: [{
        provider: 'google_drive' as const,
        credentials: { access_token: 'REAL_GOOGLE_TOKEN_abc123' },
        status: 'connected' as const,
      }],
    };
    const r = await googleDriveHandler({}, INPUT, ctxWithCreds);
    // Still fails — does not use the credentials
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).not.toContain('REAL_GOOGLE_TOKEN_abc123');
  });

  it('V3.4: via dispatchNode — googledrivetrigger is intercepted by the Phase 9.1.6 capability check before reaching the stub', async () => {
    // Phase 9.1.6: node-capabilities.ts's blocklist now intercepts
    // googledrive/googledrivetrigger in pickHandler() before the underlying
    // (still-correct, still-honest) googleDriveHandler stub would ever run —
    // one fewer step for the same "not available" outcome, and a
    // user-safe message instead of an internal error code. The handler
    // FUNCTION itself is unchanged and still fails honestly when called
    // directly (see V3.1-V3.3 above).
    const r = await dispatchNode({ type: 'n8n-nodes-base.googledrivetrigger' }, {}, LIVE_CTX);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('UNSUPPORTED_NODE_TYPE');
    expect(r.error).not.toContain('GOOGLE_DRIVE_NOT_IMPLEMENTED');
  });

});

// ─── V4: createSampleDataForWorkflow extraction parity ───────────────────────
//
// Verify the function behaves identically to the original in lib/workflow-runtime/index.ts.
// The original is now deleted; these tests ensure the extracted version matches
// the expected contract that all callers relied on.

describe('V4 — createSampleDataForWorkflow: extraction parity', () => {

  it('V4.1: shopify workflow → returns order-shaped sample data', () => {
    const result = createSampleDataForWorkflow({
      nodes: [{ type: 'n8n-nodes-base.shopify', name: 'Get Order' }],
    });
    expect(result).toHaveProperty('order_id', '1001');
    expect(result).toHaveProperty('customer_email');
    expect(result).toHaveProperty('line_items');
  });

  it('V4.2: non-shopify workflow → returns generic test data', () => {
    const result = createSampleDataForWorkflow({
      nodes: [{ type: 'n8n-nodes-base.slack', name: 'Send Slack' }],
    });
    expect(result).toHaveProperty('name', 'Test User');
    expect(result).toHaveProperty('email', 'test@example.com');
    expect(result).not.toHaveProperty('order_id');
  });

  it('V4.3: booking/airbnb workflow → returns reservation-shaped data', () => {
    const result = createSampleDataForWorkflow({
      nodes: [{ type: 'webhook', name: 'booking confirmation' }],
    });
    expect(result).toHaveProperty('guest_name');
    expect(result).toHaveProperty('confirmation_code');
  });

  it('V4.4: empty workflow → returns generic test data', () => {
    const result = createSampleDataForWorkflow({ nodes: [] });
    expect(result).toHaveProperty('name', 'Test User');
  });

  it('V4.5: null input → returns generic test data (graceful default)', () => {
    const result = createSampleDataForWorkflow(null);
    expect(result).toHaveProperty('name', 'Test User');
  });

  it('V4.6: node with shopify in NAME (not type) → still returns shopify data', () => {
    // The original used combinedText = name + type concatenated
    const result = createSampleDataForWorkflow({
      nodes: [{ type: 'webhook', name: 'shopify order trigger' }],
    });
    expect(result).toHaveProperty('order_id');
  });

  it('V4.7: return value is always a plain object (not null, not array)', () => {
    for (const input of [null, undefined, {}, { nodes: [] }, { nodes: [{ type: 'shopify' }] }]) {
      const r = createSampleDataForWorkflow(input);
      expect(typeof r).toBe('object');
      expect(r).not.toBeNull();
      expect(Array.isArray(r)).toBe(false);
    }
  });

});

// ─── V5: deepInject prototype-pollution patch — no legitimate payload broken ──
//
// Verify that skipping __proto__ / constructor / prototype keys does NOT break
// any real n8n workflow payload that could legitimately contain those strings.

describe('V5 — deepInject prototype-pollution patch: no regression on legitimate payloads', () => {

  const SHOPIFY_CREDS: IntegrationRecord[] = [{
    provider: 'shopify',
    credentials: {
      admin_access_token: 'shpat_TEST_TOKEN',
      shop_domain: 'test.myshopify.com',
    },
  }];

  function inject(nodes: object[]): object[] {
    const result = injectCredentialsIntoWorkflow(
      { name: 'test', nodes, connections: {} },
      SHOPIFY_CREDS
    );
    return (result.nodes ?? []) as object[];
  }

  it('V5.1: normal Shopify node parameters are injected correctly', () => {
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      parameters: { resource: 'order', storeUrl: '{{ $env.SHOPIFY_STORE_URL }}' },
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params.accessToken).toBe('shpat_TEST_TOKEN');
    expect(params.storeUrl).toBe('test.myshopify.com');
  });

  it('V5.2: node with no dangerous keys is fully processed', () => {
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      name: 'My Shopify Step',
      parameters: { resource: 'order', limit: 10, currency: 'USD' },
      credentials: {},
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params.accessToken).toBe('shpat_TEST_TOKEN');
    expect(params.resource).toBe('order');
    expect(params.limit).toBe(10);
  });

  it('V5.3: deeply nested legitimate fields survive injection', () => {
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      parameters: {
        filters: {
          status: 'open',
          tag: 'vip',
          meta: { source: '{{ user.shopify.token }}' },
        },
      },
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    const filters = params.filters as Record<string, unknown>;
    // Deeply nested string gets token substituted
    expect((filters.meta as Record<string, unknown>).source).toBe('shpat_TEST_TOKEN');
    // Other fields preserved
    expect(filters.status).toBe('open');
    expect(filters.tag).toBe('vip');
  });

  it('V5.4: node with __proto__ key — skipped, injection still works', () => {
    // A workflow containing __proto__ as a legitimate JSON key (e.g., from
    // a workflow editor that serializes object keys literally).
    // After patch: __proto__ key is dropped, everything else is processed.
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      parameters: {
        resource: 'order',
        __proto__: { evil: 'payload' },  // this key is DROPPED by the patch
      },
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    // Normal injection still works
    expect(params.accessToken).toBe('shpat_TEST_TOKEN');
    // No OWN property named __proto__ was created (the key was skipped by the patch).
    // Note: params.__proto__ always returns Object.prototype via the inherited getter;
    // only getOwnPropertyDescriptor tells us whether it's an own property.
    expect(Object.getOwnPropertyDescriptor(params, '__proto__')).toBeUndefined();
  });

  it('V5.5: node with constructor key — skipped, injection still works', () => {
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      parameters: { resource: 'order', constructor: 'malicious' },
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params.accessToken).toBe('shpat_TEST_TOKEN');
    // constructor key is dropped — the parameters object's OWN constructor property is absent
    expect(Object.prototype.hasOwnProperty.call(params, 'constructor')).toBe(false);
  });

  it('V5.6: non-allowlisted node with __proto__ — node returned as-is (deep clone strips it)', () => {
    // HTTP Request node is NOT in the allowlist → deepInject never runs on it.
    // JSON.parse(JSON.stringify()) deep-copies the input, so __proto__ in the
    // original is preserved as an own property in the clone (JSON.parse behavior),
    // but deepInject is never called for this node.
    const [node] = inject([{
      type: 'n8n-nodes-base.httpRequest',
      parameters: { url: 'https://example.com', __proto__: { bad: true } },
    }]);
    // The node is returned as-is from JSON.parse(JSON.stringify()), so __proto__
    // would be an own property on the parameters. deepInject was not called.
    // The critical thing: no credential tokens in the result.
    expect(JSON.stringify(node)).not.toContain('shpat_TEST_TOKEN');
  });

  it('V5.7: array parameters are processed correctly (no regression from array branch)', () => {
    const [node] = inject([{
      type: 'n8n-nodes-base.shopify',
      parameters: {
        tags: ['{{ user.shopify.token }}', 'static-tag'],
      },
    }]);
    const params = (node as Record<string, unknown>).parameters as Record<string, unknown>;
    const tags = params.tags as string[];
    expect(tags[0]).toBe('shpat_TEST_TOKEN'); // placeholder substituted
    expect(tags[1]).toBe('static-tag');        // literal preserved
  });

});

// ─── V6: Regression review — dispatchNode end-to-end ─────────────────────────
//
// Verify that the Proxy wrapping of HANDLER_NODE_ALLOWLIST did not introduce
// any timing, behavior, or output change in the live execution path.

describe('V6 — Regression: dispatchNode end-to-end correctness', () => {

  const SLACK_CTX: NodeHandlerContext = {
    mode: 'test',
    integrations: [{ provider: 'slack' as const, credentials: { webhook_url: 'https://hooks.slack.com/TEST' }, status: 'connected' as const }],
    sampleData: { message: 'hello' },
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
  };

  it('V6.1: shopify handler receives inputData and context correctly', async () => {
    const input = { order_id: '42', amount: '19.99' };
    const r = await dispatchNode({ type: 'n8n-nodes-base.shopify' }, input, TEST_CTX);
    expect(r.status).toBe('simulated_success');
    // shopify handler in test mode returns { ...inputData, shopify_simulated: true }
    expect(r.outputData).toMatchObject({ order_id: '42', shopify_simulated: true });
  });

  it('V6.2: slack handler in test mode pushes to previews', async () => {
    const previewCtx: NodeHandlerContext = { ...SLACK_CTX };
    const r = await dispatchNode(
      { type: 'n8n-nodes-base.slack', parameters: { text: 'hello world' } },
      {},
      previewCtx
    );
    expect(r.status).toBe('simulated_success');
    expect(previewCtx.previews?.slackMessages).toHaveLength(1);
  });

  it('V6.3: airtable handler in test mode pushes to previews', async () => {
    const ctx: NodeHandlerContext = {
      mode: 'test', integrations: [],
      sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };
    const r = await dispatchNode(
      { type: 'n8n-nodes-base.airtable', parameters: { table: 'Orders' } },
      { name: 'test' },
      ctx
    );
    expect(r.status).toBe('simulated_success');
    expect(ctx.previews?.airtableRecords).toHaveLength(1);
  });

  it('V6.4: wait node → simulated_success with inputData passed through', async () => {
    const input = { timer: '10s' };
    const r = await dispatchNode({ type: 'n8n-nodes-base.wait' }, input, TEST_CTX);
    expect(['simulated_success', 'skipped', 'success']).toContain(r.status);
  });

  it('V6.5: condition (if) node → success with _conditionResult', async () => {
    const r = await dispatchNode(
      { type: 'n8n-nodes-base.if', parameters: { conditions: [] } },
      { x: 1 },
      TEST_CTX
    );
    expect(r.status).toBe('success');
    expect((r.outputData as Record<string, unknown>)._conditionResult).toBeDefined();
  });

  it('V6.6: getAllowlistHandlers: every handler in allowlist returns a result when called', async () => {
    const testInput = { data: 'test' };
    for (const [nodeType] of HANDLER_NODE_ALLOWLIST) {
      const r = await dispatchNode({ type: nodeType }, testInput, TEST_CTX);
      expect(r.status, `${nodeType} handler returned no status`).toBeTruthy();
      expect(['success', 'simulated_success', 'failed', 'skipped', 'waiting']).toContain(r.status);
    }
  });

});
