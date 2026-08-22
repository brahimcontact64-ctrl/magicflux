/**
 * Security tests — requiredProvidersFromWorkflow()
 *
 * Verifies that provider-requirement detection uses the same exact-allowlist
 * model as injectCredentialsIntoWorkflow() and the workflow-runtime handler
 * routing. A node type not in PROVIDER_NODE_ALLOWLIST must never be reported
 * as requiring an integration — regardless of what substrings its name contains.
 *
 * Consistency invariant tested in group C:
 *   For every node type T:
 *     requiredProvidersFromWorkflow([T]) returns providers P  ↔
 *     injectCredentialsIntoWorkflow([T], creds) injects credentials for P
 *
 * No node should require credentials that it cannot actually receive.
 * No node should receive credentials without being reported as requiring them.
 */

import { describe, it, expect } from 'vitest';
import {
  requiredProvidersFromWorkflow,
  injectCredentialsIntoWorkflow,
  PROVIDER_NODE_ALLOWLIST,
  type IntegrationRecord,
} from '../lib/integrations';

// ── Helpers ───────────────────────────────────────────────────────────────────

function requires(nodeType: string): string[] {
  return requiredProvidersFromWorkflow({
    name: 'test',
    nodes: [{ type: nodeType }],
    connections: {},
  });
}

const ALL_CREDS: IntegrationRecord[] = [
  { provider: 'shopify',  credentials: { admin_access_token: 'shpat_TEST', shop_domain: 'test.myshopify.com' } },
  { provider: 'slack',    credentials: { webhook_url: 'https://hooks.slack.com/TEST' } },
  { provider: 'gmail',    credentials: { smtp_pass: 'smtp_TEST', smtp_user: 'test@gmail.com', smtp_host: 'smtp.gmail.com', smtp_port: '587' } },
  { provider: 'airtable', credentials: { airtable_token: 'pat_TEST', base_id: 'appTEST' } },
];

function injectsCredentials(nodeType: string): boolean {
  // Include all known placeholders so any allowlisted type has something to substitute.
  // deepInject is scoped, so each type only substitutes its own provider's values.
  const result = injectCredentialsIntoWorkflow(
    {
      name: 'test',
      nodes: [{
        type: nodeType,
        parameters: {
          shopifyField:  '{{ $env.SHOPIFY_ACCESS_TOKEN }}',
          smtpField:     '{{ $env.SMTP_PASS }}',
          slackField:    '{{ $env.SLACK_WEBHOOK_URL }}',
          airtableField: '{{ $env.AIRTABLE_API_KEY }}',
        },
      }],
      connections: {},
    },
    ALL_CREDS
  );
  const node = ((result.nodes ?? []) as Array<Record<string, unknown>>)[0];
  const serialized = JSON.stringify(node);
  return (
    serialized.includes('shpat_TEST') ||
    serialized.includes('hooks.slack.com/TEST') ||
    serialized.includes('smtp_TEST') ||
    serialized.includes('pat_TEST') ||
    serialized.includes('appTEST')
  );
}

// ─── A: Legitimate allowlisted node types require the correct provider ─────────

describe('A — Legitimate nodes: correct provider requirements', () => {

  it('n8n-nodes-base.shopify → requires shopify', () => {
    expect(requires('n8n-nodes-base.shopify')).toContain('shopify');
    expect(requires('n8n-nodes-base.shopify')).not.toContain('slack');
  });

  it('n8n-nodes-base.shopifyTrigger → requires shopify', () => {
    expect(requires('n8n-nodes-base.shopifyTrigger')).toContain('shopify');
  });

  it('n8n-nodes-base.slack → requires slack', () => {
    expect(requires('n8n-nodes-base.slack')).toContain('slack');
    expect(requires('n8n-nodes-base.slack')).not.toContain('shopify');
  });

  it('n8n-nodes-base.slackTrigger → requires slack', () => {
    expect(requires('n8n-nodes-base.slackTrigger')).toContain('slack');
  });

  it('n8n-nodes-base.airtable → requires airtable', () => {
    expect(requires('n8n-nodes-base.airtable')).toContain('airtable');
  });

  it('n8n-nodes-base.airtableTrigger → requires airtable', () => {
    expect(requires('n8n-nodes-base.airtableTrigger')).toContain('airtable');
  });

  it('n8n-nodes-base.emailSend → requires gmail (canonical)', () => {
    const result = requires('n8n-nodes-base.emailSend');
    expect(result).toContain('gmail');
    expect(result).not.toContain('email'); // 'email' is suppressed — 'gmail' is canonical
  });

  it('n8n-nodes-base.emailReadImap → requires gmail', () => {
    expect(requires('n8n-nodes-base.emailReadImap')).toContain('gmail');
  });

  it('n8n-nodes-base.gmail → requires gmail', () => {
    expect(requires('n8n-nodes-base.gmail')).toContain('gmail');
  });

  it('n8n-nodes-base.gmailTrigger → requires gmail', () => {
    expect(requires('n8n-nodes-base.gmailTrigger')).toContain('gmail');
  });

  it('n8n-nodes-base.googleDrive → requires google_drive', () => {
    expect(requires('n8n-nodes-base.googleDrive')).toContain('google_drive');
  });

  it('n8n-nodes-base.googleDriveTrigger → requires google_drive', () => {
    expect(requires('n8n-nodes-base.googleDriveTrigger')).toContain('google_drive');
  });

  it('email alias: "email" never appears in returned array', () => {
    // All email-type nodes use 'gmail' as canonical
    const emailNodes = ['n8n-nodes-base.emailSend', 'n8n-nodes-base.emailReadImap',
                        'n8n-nodes-base.gmail', 'n8n-nodes-base.gmailTrigger'];
    for (const t of emailNodes) {
      expect(requires(t), `${t} must not return "email" alias`).not.toContain('email');
    }
  });

});

// ─── B: Fake/crafted node types require NOTHING ───────────────────────────────

describe('B — Crafted fake node types: no provider requirements', () => {

  const FAKE_NODES = [
    'n8n-nodes-base.shopifyFakeHttp',
    'n8n-nodes-base.slackCustom',
    'n8n-nodes-base.airtableProxy',
    'n8n-nodes-base.gmailWebhook',
    'n8n-nodes-base.emailFakeHttp',
    'n8n-nodes-base.shopifySlackIntegration',
    'company.shopifyProxy',
    'custom.slackNotifier',
    'my.airtableWriter',
    'evil.emailSender',
    'n8n-nodes-base.shopifySlackGmailAirtable',
    // n8n-nodes-base.httpRequest intentionally NOT listed here: it is now a
    // genuinely allowlisted type (PROVIDER_NODE_ALLOWLIST['custom']), the
    // generic HTTP node's optional API-key credential, resolved at runtime
    // exactly like 'openai' — never legacy-injected via
    // injectCredentialsIntoWorkflow() (see ACTIVE_PROVIDERS below, which
    // excludes both 'openai' and 'custom' for the same reason). See group C.
    'n8n-nodes-base.code',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.set',
    'n8n-nodes-base.merge',
  ];

  for (const nodeType of FAKE_NODES) {
    it(`"${nodeType.slice(0, 55)}" → requires nothing`, () => {
      expect(requires(nodeType)).toHaveLength(0);
    });
  }

});

// ─── C: Mixed-case, whitespace, unicode ───────────────────────────────────────

describe('C — Casing, whitespace, unicode variations', () => {

  it('N8N-NODES-BASE.SHOPIFY (uppercase) → requires shopify (case-insensitive match)', () => {
    expect(requires('N8N-NODES-BASE.SHOPIFY')).toContain('shopify');
  });

  it('n8n-NODES-base.Slack (mixed case) → requires slack', () => {
    expect(requires('n8n-NODES-base.Slack')).toContain('slack');
  });

  it('"n8n-nodes-base.shopify " (trailing space) → requires nothing', () => {
    expect(requires('n8n-nodes-base.shopify ')).toHaveLength(0);
  });

  it('" n8n-nodes-base.slack" (leading space) → requires nothing', () => {
    expect(requires(' n8n-nodes-base.slack')).toHaveLength(0);
  });

  it('"n8n-nodes-base.shopify\\t" (tab suffix) → requires nothing', () => {
    expect(requires('n8n-nodes-base.shopify\t')).toHaveLength(0);
  });

  it('"n8n-nodes-base.shopify\\nmalicious" (newline in type) → requires nothing', () => {
    expect(requires('n8n-nodes-base.shopify\nmalicious')).toHaveLength(0);
  });

  it('"n8n-nodes-base.ʃhopify" (unicode homoglyph) → requires nothing', () => {
    expect(requires('n8n-nodes-base.ʃhopify')).toHaveLength(0);
  });

  it('"n8n-nodes-base.slаck" (Cyrillic а) → requires nothing', () => {
    // Cyrillic 'а' (U+0430) looks like Latin 'a' but is a different character
    expect(requires('n8n-nodes-base.slаck')).toHaveLength(0);
  });

  it('"n8n-nodes-base.shopify.extra" (dotted suffix) → requires nothing', () => {
    expect(requires('n8n-nodes-base.shopify.extra')).toHaveLength(0);
  });

  it('"n8n-nodes-base.shopify/path" (slash suffix) → requires nothing', () => {
    expect(requires('n8n-nodes-base.shopify/path')).toHaveLength(0);
  });

  it('N8N-NODES-BASE.SHOPIFYFAKEHTTP (uppercase fake) → requires nothing', () => {
    expect(requires('N8N-NODES-BASE.SHOPIFYFAKEHTTP')).toHaveLength(0);
  });

});

// ─── D: Multi-node workflow — correct aggregation ────────────────────────────

describe('D — Multi-node workflows: correct provider aggregation', () => {

  it('Shopify + Slack workflow → requires [shopify, slack]', () => {
    const result = requiredProvidersFromWorkflow({
      name: 'test',
      nodes: [
        { type: 'n8n-nodes-base.shopify' },
        { type: 'n8n-nodes-base.slack' },
      ],
      connections: {},
    });
    expect(result).toContain('shopify');
    expect(result).toContain('slack');
    expect(result).toHaveLength(2);
  });

  it('Fake shopify node mixed with legitimate slack → only slack reported', () => {
    const result = requiredProvidersFromWorkflow({
      name: 'test',
      nodes: [
        { type: 'company.shopifyProxy' },    // fake — ignored
        { type: 'n8n-nodes-base.slack' },    // legitimate
      ],
      connections: {},
    });
    expect(result).not.toContain('shopify');
    expect(result).toContain('slack');
    expect(result).toHaveLength(1);
  });

  it('All fake nodes → empty requirements even if names suggest providers', () => {
    const result = requiredProvidersFromWorkflow({
      name: 'test',
      nodes: [
        { type: 'shopifyFakeHttp' },
        { type: 'n8n-nodes-base.slackCustom' },
        { type: 'n8n-nodes-base.airtableProxy' },
        { type: 'n8n-nodes-base.gmailWebhook' },
      ],
      connections: {},
    });
    expect(result).toHaveLength(0);
  });

  it('Duplicate legitimate nodes → each provider returned once', () => {
    const result = requiredProvidersFromWorkflow({
      name: 'test',
      nodes: [
        { type: 'n8n-nodes-base.shopify' },
        { type: 'n8n-nodes-base.shopify' },  // duplicate
        { type: 'n8n-nodes-base.shopifyTrigger' },
      ],
      connections: {},
    });
    expect(result.filter(p => p === 'shopify')).toHaveLength(1); // deduplicated
  });

  it('Empty workflow → no requirements', () => {
    expect(requiredProvidersFromWorkflow({ name: 'test', nodes: [], connections: {} })).toHaveLength(0);
  });

  it('null workflow → no requirements', () => {
    expect(requiredProvidersFromWorkflow(null)).toHaveLength(0);
  });

});

// ─── E: Consistency with injectCredentialsIntoWorkflow ───────────────────────
//
// For every node type in PROVIDER_NODE_ALLOWLIST: requiredProvidersFromWorkflow
// reports a requirement AND injectCredentialsIntoWorkflow injects credentials.
//
// For every fake/crafted node type: requiredProvidersFromWorkflow reports nothing
// AND injectCredentialsIntoWorkflow injects nothing.

describe('E — Consistency: requiredProviders ↔ injectCredentials (same allowlist)', () => {

  it('Every allowlisted node type: requires ≥1 provider', () => {
    const allAllowlisted = new Set<string>();
    for (const nodeSet of PROVIDER_NODE_ALLOWLIST.values()) {
      for (const t of nodeSet) allAllowlisted.add(t);
    }

    for (const nodeType of allAllowlisted) {
      const req = requires(nodeType);
      expect(req.length > 0, `${nodeType}: must require ≥1 provider`).toBe(true);
    }
  });

  it('Non-google_drive allowlisted types inject active credentials', () => {
    // google_drive is allowlisted but byProvider.google_drive is currently undefined
    // (no placeholder patterns in replaceEnvTokens) — injection is a no-op for that provider.
    // All other providers have active injection paths.
    const ACTIVE_PROVIDERS = ['shopify', 'slack', 'airtable', 'gmail', 'email'] as const;
    const activeNodes = new Set<string>();
    for (const p of ACTIVE_PROVIDERS) {
      for (const t of (PROVIDER_NODE_ALLOWLIST.get(p) ?? [])) activeNodes.add(t);
    }

    for (const nodeType of activeNodes) {
      const inj = injectsCredentials(nodeType);
      expect(inj, `${nodeType}: must receive injected credentials`).toBe(true);
    }
  });

  it('Every crafted/fake type: requires nothing AND injects nothing', () => {
    const FAKES = [
      'n8n-nodes-base.shopifyFakeHttp',
      'n8n-nodes-base.slackCustom',
      'n8n-nodes-base.airtableProxy',
      'n8n-nodes-base.gmailWebhook',
      'company.shopifyProxy',
      'custom.slackNotifier',
      // n8n-nodes-base.httpRequest excluded — see group B's comment; it now
      // genuinely requires 'custom' (runtime-resolved, never legacy-injected,
      // same pattern as 'openai').
      'n8n-nodes-base.code',
      'n8n-nodes-base.webhook',
      'n8n-nodes-base.shopify ',      // trailing space
      ' n8n-nodes-base.slack',         // leading space
      'n8n-nodes-base.shopify.extra',
    ];

    for (const nodeType of FAKES) {
      const req = requires(nodeType);
      const inj = injectsCredentials(nodeType);
      expect(req, `${nodeType.trim()}: must not require any provider`).toHaveLength(0);
      expect(inj, `${nodeType.trim()}: must not receive injected credentials`).toBe(false);
    }
  });

  it('httpRequest requires "custom" but (like openai) is never legacy-injected via injectCredentialsIntoWorkflow', () => {
    expect(requires('n8n-nodes-base.httpRequest')).toEqual(['custom']);
    expect(injectsCredentials('n8n-nodes-base.httpRequest')).toBe(false);
  });

  it('No fake node requires a provider it would receive (no phantom requirements)', () => {
    // Fake nodes that report no requirements also inject nothing
    const FAKES = [
      'n8n-nodes-base.shopifyFakeHttp',
      'n8n-nodes-base.slackCustom',
      'n8n-nodes-base.airtableProxy',
      'n8n-nodes-base.gmailWebhook',
      'company.shopifyProxy',
    ];

    for (const nodeType of FAKES) {
      const req = requires(nodeType);
      const inj = injectsCredentials(nodeType);
      expect(req, `${nodeType}: must have no requirements`).toHaveLength(0);
      expect(inj, `${nodeType}: must not inject credentials`).toBe(false);
    }
  });

  it('Active-injection nodes that report requirements also receive credentials', () => {
    const ACTIVE = [
      'n8n-nodes-base.shopify',
      'n8n-nodes-base.slack',
      'n8n-nodes-base.airtable',
      'n8n-nodes-base.emailSend',
      'n8n-nodes-base.gmail',
    ];

    for (const nodeType of ACTIVE) {
      const req = requires(nodeType);
      const inj = injectsCredentials(nodeType);
      expect(req.length > 0, `${nodeType}: must have requirements`).toBe(true);
      expect(inj, `${nodeType}: must inject credentials`).toBe(true);
    }
  });

});

// ─── F: PROVIDER_NODE_ALLOWLIST is exported and importable ───────────────────

describe('F — PROVIDER_NODE_ALLOWLIST is exported (shared source of truth)', () => {

  it('PROVIDER_NODE_ALLOWLIST is exported and has all six providers', () => {
    expect(PROVIDER_NODE_ALLOWLIST).toBeInstanceOf(Map);
    expect(PROVIDER_NODE_ALLOWLIST.has('shopify')).toBe(true);
    expect(PROVIDER_NODE_ALLOWLIST.has('slack')).toBe(true);
    expect(PROVIDER_NODE_ALLOWLIST.has('airtable')).toBe(true);
    expect(PROVIDER_NODE_ALLOWLIST.has('gmail')).toBe(true);
    expect(PROVIDER_NODE_ALLOWLIST.has('email')).toBe(true);
    expect(PROVIDER_NODE_ALLOWLIST.has('google_drive')).toBe(true);
  });

  it('gmail and email keys map to identical node-type sets', () => {
    const gmailSet = PROVIDER_NODE_ALLOWLIST.get('gmail')!;
    const emailSet = PROVIDER_NODE_ALLOWLIST.get('email')!;
    expect([...gmailSet].sort()).toEqual([...emailSet].sort());
  });

  it('All entries are lowercase (safe for direct Set.has() comparison)', () => {
    for (const [, nodeSet] of PROVIDER_NODE_ALLOWLIST) {
      for (const nodeType of nodeSet) {
        expect(nodeType, `"${nodeType}" must be lowercase`).toBe(nodeType.toLowerCase());
      }
    }
  });

});
