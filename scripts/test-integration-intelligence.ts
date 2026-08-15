/**
 * Integration Intelligence test suite — Phase 2
 * Run with: npx tsx scripts/test-integration-intelligence.ts
 *
 * Sections:
 *  1.  parseRequestedProvidersFromPrompt ................  7 tests
 *  2.  OAuth provider detection via status derivation ...  5 tests
 *  3.  computeIntegrationStatus .........................  9 tests
 *  4.  computeIntegrationRequirements (pure) ............ 10 tests
 *  5.  AutomationRequirementsResult shape ................  6 tests
 *  6.  Route module structure ...........................  4 tests
 *  Total: 41 tests
 */

if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = 'a'.repeat(64);
}

import assert from 'assert';
import {
  computeIntegrationStatus,
  computeIntegrationRequirements,
  type IntegrationStatus,
  type IntegrationRequirement,
  type AutomationRequirementsResult,
} from '@/lib/credentials/intelligence';
import { parseRequestedProvidersFromPrompt } from '@/lib/agent/provider-allowlist';
import { getRequiredCredentials, getProviderDisplayName } from '@/lib/credentials/provider-registry';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    const msg = (err as Error).message;
    console.error(`       ${msg}`);
    failures.push(`  ✗  ${label}\n       ${msg}`);
    failed++;
  }
}

// Helper: build a minimal ProviderCredentialSummary-like object
function makeSummary(
  provider: string,
  ready: boolean,
  missingSources: string[] = []
) {
  return {
    provider,
    displayName: getProviderDisplayName(provider),
    ready,
    missing: missingSources.map((source, i) => ({
      key: `field_${i}`,
      source,
      label: `Field ${i}`,
      secret: source !== 'manual',
      description: '',
      required: true,
    })),
    optional: [] as Array<{ key: string; source: string; label: string; secret: boolean; description: string; required: boolean }>,
    confidence: 100,
  };
}

// Helper: build real summary from registry fields
function makeSummaryFromRegistry(provider: string, connected: boolean) {
  const required = getRequiredCredentials(provider);
  return {
    provider,
    displayName: getProviderDisplayName(provider),
    ready: connected,
    missing: connected ? [] : required.map((f) => ({
      key: f.key,
      source: f.source,
      label: f.label,
      secret: f.secret,
      description: f.description,
      required: f.required,
    })),
    optional: [] as Array<{ key: string; source: string; label: string; secret: boolean; description: string; required: boolean }>,
    confidence: 100,
  };
}

async function main(): Promise<void> {

// ── Section 1: parseRequestedProvidersFromPrompt ──────────────────────────────

console.log('\nSection 1: parseRequestedProvidersFromPrompt');

await test('single provider: "Monitor Shopify orders" → [shopify]', () => {
  const result = parseRequestedProvidersFromPrompt('Monitor Shopify orders');
  assert.ok(result.includes('shopify'), `got: ${JSON.stringify(result)}`);
});

await test('two providers: "Shopify orders → Telegram alerts" → [shopify, telegram]', () => {
  const result = parseRequestedProvidersFromPrompt('Monitor Shopify orders and send Telegram alerts');
  assert.ok(result.includes('shopify'), `shopify missing: ${JSON.stringify(result)}`);
  assert.ok(result.includes('telegram'), `telegram missing: ${JSON.stringify(result)}`);
});

await test('case-insensitive: "SHOPIFY" and "TELEGRAM" are detected', () => {
  const result = parseRequestedProvidersFromPrompt('Use SHOPIFY with TELEGRAM notifications');
  assert.ok(result.includes('shopify'), `shopify missing: ${JSON.stringify(result)}`);
  assert.ok(result.includes('telegram'), `telegram missing: ${JSON.stringify(result)}`);
});

await test('empty string → []', () => {
  const result = parseRequestedProvidersFromPrompt('');
  assert.deepStrictEqual(result, []);
});

await test('no known providers → []', () => {
  const result = parseRequestedProvidersFromPrompt('sync the database and send an internal report');
  assert.deepStrictEqual(result, []);
});

await test('negated provider excluded: "No Telegram. Use Slack." → telegram excluded, slack included', () => {
  const result = parseRequestedProvidersFromPrompt('No Telegram. Use Slack for notifications.');
  assert.ok(!result.includes('telegram'), `telegram should be excluded: ${JSON.stringify(result)}`);
  assert.ok(result.includes('slack'), `slack missing: ${JSON.stringify(result)}`);
});

await test('duplicate mention is deduplicated: "Shopify + Shopify" → [shopify] once', () => {
  const result = parseRequestedProvidersFromPrompt('Watch Shopify orders and process Shopify webhooks');
  assert.strictEqual(result.filter(p => p === 'shopify').length, 1);
});

// ── Section 2: OAuth provider detection via status derivation ─────────────────

console.log('\nSection 2: OAuth provider detection via status derivation');

await test('gmail not connected (oauth field) → oauth_required', () => {
  const summary = makeSummaryFromRegistry('gmail', false);
  const status = computeIntegrationStatus(summary);
  assert.strictEqual(status, 'oauth_required');
});

await test('google_sheets not connected (oauth field) → oauth_required', () => {
  const summary = makeSummaryFromRegistry('google_sheets', false);
  const status = computeIntegrationStatus(summary);
  assert.strictEqual(status, 'oauth_required');
});

await test('canva not connected (oauth field) → oauth_required', () => {
  const summary = makeSummaryFromRegistry('canva', false);
  const status = computeIntegrationStatus(summary);
  assert.strictEqual(status, 'oauth_required');
});

await test('telegram not connected (token field) → missing, not oauth_required', () => {
  const summary = makeSummaryFromRegistry('telegram', false);
  const status = computeIntegrationStatus(summary);
  assert.strictEqual(status, 'missing');
});

await test('shopify not connected (manual + api_key) → missing', () => {
  const summary = makeSummaryFromRegistry('shopify', false);
  const status = computeIntegrationStatus(summary);
  assert.strictEqual(status, 'missing');
});

// ── Section 3: computeIntegrationStatus ──────────────────────────────────────

console.log('\nSection 3: computeIntegrationStatus');

await test('ready=false, single oauth source → oauth_required', () => {
  const summary = makeSummary('gmail', false, ['oauth']);
  assert.strictEqual(computeIntegrationStatus(summary), 'oauth_required');
});

await test('ready=false, single api_key source → missing', () => {
  const summary = makeSummary('openai', false, ['api_key']);
  assert.strictEqual(computeIntegrationStatus(summary), 'missing');
});

await test('ready=false, mixed sources (not all oauth) → missing', () => {
  const summary = makeSummary('shopify', false, ['manual', 'api_key']);
  assert.strictEqual(computeIntegrationStatus(summary), 'missing');
});

await test('ready=false, token source → missing', () => {
  const summary = makeSummary('telegram', false, ['token']);
  assert.strictEqual(computeIntegrationStatus(summary), 'missing');
});

await test('ready=true, no verification → ready', () => {
  const summary = makeSummary('telegram', true, []);
  assert.strictEqual(computeIntegrationStatus(summary), 'ready');
});

await test('ready=true, verification=healthy → ready', () => {
  const summary = makeSummary('telegram', true, []);
  assert.strictEqual(computeIntegrationStatus(summary, 'healthy'), 'ready');
});

await test('ready=true, verification=unknown → ready', () => {
  const summary = makeSummary('telegram', true, []);
  assert.strictEqual(computeIntegrationStatus(summary, 'unknown'), 'ready');
});

await test('ready=true, verification=invalid → invalid', () => {
  const summary = makeSummary('telegram', true, []);
  assert.strictEqual(computeIntegrationStatus(summary, 'invalid'), 'invalid');
});

await test('ready=true, verification=expired → invalid', () => {
  const summary = makeSummary('telegram', true, []);
  assert.strictEqual(computeIntegrationStatus(summary, 'expired'), 'invalid');
});

// ── Section 4: computeIntegrationRequirements ─────────────────────────────────

console.log('\nSection 4: computeIntegrationRequirements (pure)');

await test('shopify not connected → connected=false, missing=[shop_domain, access_token]', () => {
  const summaries = [makeSummaryFromRegistry('shopify', false)];
  const results = computeIntegrationRequirements(['shopify'], summaries);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.provider, 'shopify');
  assert.strictEqual(r.connected, false);
  assert.ok(r.missing.includes('shop_domain'), `missing shop_domain: ${JSON.stringify(r.missing)}`);
  assert.ok(r.missing.includes('access_token'), `missing access_token: ${JSON.stringify(r.missing)}`);
});

await test('telegram connected → connected=true, missing=[]', () => {
  const summaries = [makeSummaryFromRegistry('telegram', true)];
  const results = computeIntegrationRequirements(['telegram'], summaries);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.connected, true);
  assert.deepStrictEqual(r.missing, []);
});

await test('gmail not connected → status=oauth_required', () => {
  const summaries = [makeSummaryFromRegistry('gmail', false)];
  const results = computeIntegrationRequirements(['gmail'], summaries);
  assert.strictEqual(results[0].status, 'oauth_required');
});

await test('mixed: shopify disconnected + telegram connected', () => {
  const summaries = [
    makeSummaryFromRegistry('shopify', false),
    makeSummaryFromRegistry('telegram', true),
  ];
  const results = computeIntegrationRequirements(['shopify', 'telegram'], summaries);
  assert.strictEqual(results.length, 2);
  const shopify = results.find(r => r.provider === 'shopify')!;
  const telegram = results.find(r => r.provider === 'telegram')!;
  assert.ok(shopify, 'shopify missing');
  assert.strictEqual(shopify.connected, false);
  assert.ok(telegram, 'telegram missing');
  assert.strictEqual(telegram.connected, true);
  assert.strictEqual(telegram.status, 'ready');
});

await test('duplicate providers in input → deduplicated in output', () => {
  const summaries = [makeSummaryFromRegistry('telegram', true)];
  const results = computeIntegrationRequirements(['telegram', 'telegram', 'telegram'], summaries);
  assert.strictEqual(results.length, 1);
});

await test('empty providers → []', () => {
  const results = computeIntegrationRequirements([], []);
  assert.deepStrictEqual(results, []);
});

await test('provider absent from summaries → not-connected, uses registry for missing keys', () => {
  const results = computeIntegrationRequirements(['telegram'], []);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.connected, false);
  assert.ok(r.missing.includes('bot_token'), `bot_token missing: ${JSON.stringify(r.missing)}`);
  assert.ok(r.missing.includes('chat_id'), `chat_id missing: ${JSON.stringify(r.missing)}`);
});

await test('verificationMap applied: connected + invalid status → status=invalid', () => {
  const summaries = [makeSummaryFromRegistry('telegram', true)];
  const verMap = new Map([['telegram', 'invalid' as const]]);
  const results = computeIntegrationRequirements(['telegram'], summaries, verMap);
  assert.strictEqual(results[0].status, 'invalid');
});

await test('each result has correct shape: provider, displayName, required, connected, missing, status', () => {
  const summaries = [makeSummaryFromRegistry('slack', false)];
  const results = computeIntegrationRequirements(['slack'], summaries);
  const r = results[0];
  assert.ok('provider' in r, 'provider missing');
  assert.ok('displayName' in r, 'displayName missing');
  assert.ok('required' in r, 'required missing');
  assert.ok('connected' in r, 'connected missing');
  assert.ok('missing' in r, 'missing missing');
  assert.ok('status' in r, 'status missing');
  assert.strictEqual(r.required, true);
});

await test('required=true for all detected providers', () => {
  const summaries = [
    makeSummaryFromRegistry('shopify', false),
    makeSummaryFromRegistry('telegram', true),
  ];
  const results = computeIntegrationRequirements(['shopify', 'telegram'], summaries);
  assert.ok(results.every(r => r.required === true), 'Not all required=true');
});

// ── Section 5: AutomationRequirementsResult shape ──────────────────────────────

console.log('\nSection 5: AutomationRequirementsResult shape');

await test('shape has integrations, allReady, blockers fields', () => {
  const result: AutomationRequirementsResult = {
    integrations: [],
    allReady: true,
    blockers: [],
  };
  assert.ok('integrations' in result);
  assert.ok('allReady' in result);
  assert.ok('blockers' in result);
});

await test('allReady=true when integrations is empty', () => {
  const summaries: ReturnType<typeof makeSummaryFromRegistry>[] = [];
  const integrations = computeIntegrationRequirements([], summaries);
  const allReady = integrations.every(i => i.status === 'ready');
  assert.strictEqual(allReady, true);
});

await test('allReady=false when any integration is not ready', () => {
  const summaries = [makeSummaryFromRegistry('shopify', false)];
  const integrations = computeIntegrationRequirements(['shopify'], summaries);
  const allReady = integrations.every(i => i.status === 'ready');
  assert.strictEqual(allReady, false);
});

await test('blockers contains providers whose status is not ready', () => {
  const summaries = [
    makeSummaryFromRegistry('shopify', false),
    makeSummaryFromRegistry('telegram', true),
  ];
  const integrations = computeIntegrationRequirements(['shopify', 'telegram'], summaries);
  const blockers = integrations.filter(i => i.status !== 'ready').map(i => i.provider);
  assert.ok(blockers.includes('shopify'), `shopify not in blockers: ${JSON.stringify(blockers)}`);
  assert.ok(!blockers.includes('telegram'), `telegram wrongly in blockers: ${JSON.stringify(blockers)}`);
});

await test('allReady=true when all providers are connected with healthy status', () => {
  const summaries = [
    makeSummaryFromRegistry('telegram', true),
    makeSummaryFromRegistry('slack', true),
  ];
  const verMap = new Map([['telegram', 'healthy' as const], ['slack', 'healthy' as const]]);
  const integrations = computeIntegrationRequirements(['telegram', 'slack'], summaries, verMap);
  const allReady = integrations.every(i => i.status === 'ready');
  assert.strictEqual(allReady, true);
});

await test('oauth provider contributes to blockers when not connected', () => {
  const summaries = [makeSummaryFromRegistry('gmail', false)];
  const integrations = computeIntegrationRequirements(['gmail'], summaries);
  const blockers = integrations.filter(i => i.status !== 'ready').map(i => i.provider);
  assert.ok(blockers.includes('gmail'), `gmail missing from blockers: ${JSON.stringify(blockers)}`);
  assert.strictEqual(integrations[0].status, 'oauth_required');
});

// ── Section 6: Route module structure ─────────────────────────────────────────

console.log('\nSection 6: Route module structure');

await test('intelligence route module imports without errors', async () => {
  const mod = await import('@/app/api/integrations/intelligence/route');
  assert.ok(mod, 'module failed to load');
});

await test('GET handler is exported from intelligence route', async () => {
  const mod = await import('@/app/api/integrations/intelligence/route');
  assert.strictEqual(typeof mod.GET, 'function', 'GET not exported');
});

await test('POST handler is exported from intelligence route', async () => {
  const mod = await import('@/app/api/integrations/intelligence/route');
  assert.strictEqual(typeof mod.POST, 'function', 'POST not exported');
});

await test('analyzeAutomationRequirements is exported from intelligence.ts', async () => {
  const mod = await import('@/lib/credentials/intelligence');
  assert.strictEqual(typeof mod.analyzeAutomationRequirements, 'function');
});

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.error(f));
  console.log('');
}
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end main

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
