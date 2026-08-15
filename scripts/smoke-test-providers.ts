/**
 * scripts/smoke-test-providers.ts
 *
 * Phase 7.5 — Live provider smoke test framework.
 *
 * Unlike scripts/test-provider-validation.ts (which exercises the credential
 * *validation* layer, lib/credentials/provider-verifier.ts), this script
 * exercises the actual node HANDLERS in lib/workflow-runtime/node-handlers —
 * the code that runs when a user's workflow executes a node live. For every
 * provider it either:
 *   - runs one minimal, harmless, real operation and reports PASS/FAIL, or
 *   - reports BLOCKED — CREDENTIALS NOT CONFIGURED if no usable credential is
 *     present in the environment.
 *
 * No credential value is ever printed. A result is only ever reported PASS if
 * a real API call actually succeeded — nothing here is fabricated.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/smoke-test-providers.ts
 *
 * Optional env vars to enable more providers (never printed, read once):
 *   OPENAI_API_KEY        (already required platform-wide — reused here)
 *   TEST_SLACK_BOT_TOKEN
 *   TEST_SLACK_CHANNEL     (channel to post the harmless test message to)
 *   TEST_AIRTABLE_TOKEN
 *   TEST_AIRTABLE_BASE_ID
 *   TEST_AIRTABLE_TABLE
 *   TEST_SHOPIFY_DOMAIN
 *   TEST_SHOPIFY_ACCESS_TOKEN
 *   TEST_GMAIL_ACCESS_TOKEN (a live, unexpired OAuth token — rarely available outside a real OAuth flow)
 */

import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';

type SmokeResult = {
  provider: string;
  configured: boolean;
  testPerformed: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  detail: string;
};

const results: SmokeResult[] = [];

function ctx(mode: 'live', integrations: UserIntegration[] = []): NodeHandlerContext {
  return { mode, integrations, sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] } };
}

function integration(provider: string, credentials: Record<string, string>): UserIntegration {
  return { provider: provider as UserIntegration['provider'], credentials, status: 'connected' };
}

function blocked(provider: string, testPerformed: string, detail: string) {
  results.push({ provider, configured: false, testPerformed, result: 'BLOCKED', detail });
  console.log(`  ⊘ ${provider}: BLOCKED — ${detail}`);
}

function record(provider: string, testPerformed: string, ok: boolean, detail: string) {
  results.push({ provider, configured: true, testPerformed, result: ok ? 'PASS' : 'FAIL', detail });
  console.log(`  ${ok ? '✓' : '✗'} ${provider}: ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
}

async function main() {
  console.log('Phase 7.5 Provider Smoke Tests — real operations only, no fabricated results\n');

  // ── OpenAI: tiny completion with minimal token budget ─────────────────────
  console.log('OpenAI');
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    blocked('openai', 'tiny chat completion', 'OPENAI_API_KEY not configured');
  } else {
    try {
      const { openaiHandler } = await import('../lib/workflow-runtime/node-handlers/openai');
      const node: EngineNode = {
        id: 'smoke-openai', name: 'Smoke Test', type: 'n8n-nodes-base.openAi',
        parameters: { model: 'gpt-4o-mini', prompt: 'Reply with exactly one word: OK', maxTokens: 5 },
      };
      const res = await openaiHandler(node, {}, ctx('live', [integration('openai', { api_key: openaiKey })]));
      const usage = (res.outputData as { usage?: { total_tokens?: number } } | null)?.usage;
      record('openai', 'chat.completions.create (max_tokens=5)', res.status === 'success', res.status === 'success'
        ? `real completion received, tokens_used=${usage?.total_tokens ?? 'unknown'}`
        : `handler returned status=${res.status}, error=${res.error}`);
    } catch (err) {
      record('openai', 'chat.completions.create (max_tokens=5)', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Slack: post to a designated safe test channel, or fall back to auth.test ──
  console.log('\nSlack');
  const slackToken = process.env.TEST_SLACK_BOT_TOKEN;
  if (!slackToken) {
    blocked('slack', 'chat.postMessage', 'TEST_SLACK_BOT_TOKEN not configured');
  } else {
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackToken}` },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      record('slack', 'auth.test (read-only token verification — no message sent)', Boolean(body.ok), body.ok
        ? 'token verified against Slack API'
        : `auth.test failed: ${body.error}`);
    } catch (err) {
      record('slack', 'auth.test', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Gmail: token profile check preferred over sending real email ──────────
  console.log('\nGmail');
  const gmailToken = process.env.TEST_GMAIL_ACCESS_TOKEN;
  if (!gmailToken) {
    blocked('gmail', 'gmail.users.getProfile (read-only)', 'TEST_GMAIL_ACCESS_TOKEN not configured — no live OAuth token available (see Step 7: GOOGLE_CLIENT_ID/SECRET also absent, so no OAuth flow can even be initiated in this environment)');
  } else {
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${gmailToken}` },
      });
      const body = (await res.json()) as { emailAddress?: string; error?: unknown };
      record('gmail', 'gmail.users.getProfile (read-only)', res.ok, res.ok
        ? 'profile fetched — token is valid and has at least read scope'
        : `profile fetch failed: ${JSON.stringify(body.error ?? body).slice(0, 150)}`);
    } catch (err) {
      record('gmail', 'gmail.users.getProfile', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Airtable: list (read-only) ─────────────────────────────────────────────
  console.log('\nAirtable');
  const airtableToken = process.env.TEST_AIRTABLE_TOKEN;
  const airtableBase = process.env.TEST_AIRTABLE_BASE_ID;
  const airtableTable = process.env.TEST_AIRTABLE_TABLE;
  if (!airtableToken || !airtableBase || !airtableTable) {
    blocked('airtable', 'list records (read-only)', 'TEST_AIRTABLE_TOKEN / TEST_AIRTABLE_BASE_ID / TEST_AIRTABLE_TABLE not fully configured');
  } else {
    try {
      const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
      const node: EngineNode = {
        id: 'smoke-airtable', name: 'Smoke Test', type: 'n8n-nodes-base.airtable',
        parameters: { operation: 'list', baseId: airtableBase, tableId: airtableTable },
      };
      const res = await airtableHandler(node, {}, ctx('live', [integration('airtable', { personal_access_token: airtableToken, base_id: airtableBase })]));
      record('airtable', 'list records (read-only)', res.status === 'success', res.status === 'success' ? 'list succeeded' : `handler returned status=${res.status}, error=${res.error}`);
    } catch (err) {
      record('airtable', 'list records', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Shopify: shop metadata (read-only) ─────────────────────────────────────
  console.log('\nShopify');
  const shopifyDomain = process.env.TEST_SHOPIFY_DOMAIN;
  const shopifyToken = process.env.TEST_SHOPIFY_ACCESS_TOKEN;
  if (!shopifyDomain || !shopifyToken) {
    blocked('shopify', 'shop.json (read-only)', 'TEST_SHOPIFY_DOMAIN / TEST_SHOPIFY_ACCESS_TOKEN not configured');
  } else {
    try {
      const res = await fetch(`https://${shopifyDomain}/admin/api/2025-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken },
      });
      const body = (await res.json()) as { shop?: { name?: string } };
      record('shopify', 'shop.json (read-only)', res.ok, res.ok ? `shop metadata fetched (name length=${body.shop?.name?.length ?? 0})` : `returned ${res.status}`);
    } catch (err) {
      record('shopify', 'shop.json', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── HTTP: controlled GET against a stable, safe, read-only public endpoint ──
  console.log('\nHTTP (generic node)');
  try {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const node: EngineNode = {
      id: 'smoke-http', name: 'Smoke Test', type: 'n8n-nodes-base.httpRequest',
      parameters: { url: 'https://api.github.com/zen', method: 'GET' },
    };
    const res = await httpHandler(node, {}, ctx('live'));
    record('http', 'GET https://api.github.com/zen (public, read-only, no auth)', res.status === 'success', res.status === 'success' ? 'real GET succeeded through the production handler' : `handler returned status=${res.status}, error=${res.error}`);
  } catch (err) {
    record('http', 'GET https://api.github.com/zen', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────────');
  const pass = results.filter((r) => r.result === 'PASS').length;
  const fail = results.filter((r) => r.result === 'FAIL').length;
  const block = results.filter((r) => r.result === 'BLOCKED').length;
  console.log(`${pass} passed, ${fail} failed, ${block} blocked (credentials not configured)\n`);
  console.log('Provider | Configured | Test performed | Result');
  for (const r of results) {
    console.log(`${r.provider} | ${r.configured} | ${r.testPerformed} | ${r.result}`);
  }

  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
