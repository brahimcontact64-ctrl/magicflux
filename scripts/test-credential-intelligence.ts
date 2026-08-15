/**
 * Credential Intelligence test suite.
 * Run with:  npx tsx scripts/test-credential-intelligence.ts
 *
 * Validates:
 *  - provider-registry: getProviderCredentials, getRequiredCredentials, getOptionalCredentials
 *  - intelligence: resolveCredentialRequirements, resolveMissingCredentials,
 *                  checkDeploymentCredentials, buildCredentialSummary
 *  - adversarial: invalid providers, duplicates, empty lists, mixed oauth/token/manual
 */

import assert from 'assert';
import {
  getProviderCredentials,
  getRequiredCredentials,
  getOptionalCredentials,
  providerHasCredentials,
  getProviderDisplayName,
} from '@/lib/credentials/provider-registry';
import {
  resolveCredentialRequirements,
  resolveMissingCredentials,
  checkDeploymentCredentials,
  buildCredentialSummary,
} from '@/lib/credentials/intelligence';

// ── harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`  ✗  ${label}\n       ${(err as Error).message}`);
  }
}

// ── Section 1: provider-registry — field definitions ─────────────────────────

console.log('\nSection 1: provider-registry field definitions');

test('telegram: 2 required fields', () => {
  const fields = getProviderCredentials('telegram');
  assert.strictEqual(fields.length, 2);
  assert.ok(fields.every(f => f.required));
});

test('telegram bot_token: secret=true, source=token', () => {
  const field = getProviderCredentials('telegram').find(f => f.key === 'bot_token');
  assert.ok(field, 'bot_token missing');
  assert.strictEqual(field.secret, true);
  assert.strictEqual(field.source, 'token');
});

test('telegram chat_id: secret=false, source=manual', () => {
  const field = getProviderCredentials('telegram').find(f => f.key === 'chat_id');
  assert.ok(field, 'chat_id missing');
  assert.strictEqual(field.secret, false);
  assert.strictEqual(field.source, 'manual');
});

test('gmail: oauth_google required, source=oauth', () => {
  const fields = getProviderCredentials('gmail');
  assert.strictEqual(fields.length, 1);
  assert.strictEqual(fields[0].key, 'oauth_google');
  assert.strictEqual(fields[0].source, 'oauth');
  assert.strictEqual(fields[0].required, true);
});

test('slack: bot_token required, source=token, secret=true', () => {
  const field = getProviderCredentials('slack')[0];
  assert.ok(field);
  assert.strictEqual(field.key, 'bot_token');
  assert.strictEqual(field.source, 'token');
  assert.strictEqual(field.secret, true);
});

test('shopify: 2 fields — shop_domain (manual) + access_token (api_key)', () => {
  const fields = getProviderCredentials('shopify');
  assert.strictEqual(fields.length, 2);
  const domain = fields.find(f => f.key === 'shop_domain')!;
  const token = fields.find(f => f.key === 'access_token')!;
  assert.strictEqual(domain.source, 'manual');
  assert.strictEqual(domain.secret, false);
  assert.strictEqual(token.source, 'api_key');
  assert.strictEqual(token.secret, true);
});

test('airtable: personal_access_token (api_key, secret) + base_id (manual)', () => {
  const fields = getProviderCredentials('airtable');
  const pat = fields.find(f => f.key === 'personal_access_token')!;
  const base = fields.find(f => f.key === 'base_id')!;
  assert.ok(pat, 'personal_access_token missing');
  assert.ok(base, 'base_id missing');
  assert.strictEqual(pat.source, 'api_key');
  assert.strictEqual(base.source, 'manual');
});

test('hubspot: access_token required, source=api_key', () => {
  const field = getProviderCredentials('hubspot')[0];
  assert.ok(field);
  assert.strictEqual(field.key, 'access_token');
  assert.strictEqual(field.source, 'api_key');
  assert.strictEqual(field.required, true);
});

test('openai: api_key required, source=api_key, secret=true', () => {
  const field = getProviderCredentials('openai')[0];
  assert.ok(field);
  assert.strictEqual(field.source, 'api_key');
  assert.strictEqual(field.secret, true);
});

test('claude: api_key required, source=api_key, secret=true', () => {
  const field = getProviderCredentials('claude')[0];
  assert.ok(field);
  assert.strictEqual(field.source, 'api_key');
  assert.strictEqual(field.secret, true);
});

test('stripe: secret_key required + webhook_secret optional', () => {
  const required = getRequiredCredentials('stripe');
  const optional = getOptionalCredentials('stripe');
  assert.strictEqual(required.length, 1);
  assert.strictEqual(required[0].key, 'secret_key');
  assert.strictEqual(optional.length, 1);
  assert.strictEqual(optional[0].key, 'webhook_secret');
});

test('google_sheets: oauth_google required, source=oauth', () => {
  const field = getProviderCredentials('google_sheets')[0];
  assert.ok(field);
  assert.strictEqual(field.source, 'oauth');
  assert.strictEqual(field.required, true);
});

test('google_drive: oauth_google required, source=oauth', () => {
  const field = getProviderCredentials('google_drive')[0];
  assert.ok(field);
  assert.strictEqual(field.source, 'oauth');
});

test('facebook: access_token (token) + page_id (manual)', () => {
  const fields = getProviderCredentials('facebook');
  const at = fields.find(f => f.key === 'access_token')!;
  const pid = fields.find(f => f.key === 'page_id')!;
  assert.ok(at, 'access_token missing');
  assert.strictEqual(at.source, 'token');
  assert.ok(pid, 'page_id missing');
  assert.strictEqual(pid.source, 'manual');
});

test('twitter: bearer_token required, source=api_key', () => {
  const field = getProviderCredentials('twitter')[0];
  assert.ok(field);
  assert.strictEqual(field.key, 'bearer_token');
  assert.strictEqual(field.source, 'api_key');
});

test('elevenlabs: api_key required', () => {
  const field = getProviderCredentials('elevenlabs')[0];
  assert.ok(field);
  assert.strictEqual(field.key, 'api_key');
});

test('deepgram: api_key required', () => {
  const field = getProviderCredentials('deepgram')[0];
  assert.ok(field);
  assert.strictEqual(field.key, 'api_key');
});

test('cloudflare_ai: account_id (manual) + api_token (token)', () => {
  const fields = getProviderCredentials('cloudflare_ai');
  const account = fields.find(f => f.key === 'account_id')!;
  const token = fields.find(f => f.key === 'api_token')!;
  assert.ok(account, 'account_id missing');
  assert.strictEqual(account.source, 'manual');
  assert.ok(token, 'api_token missing');
  assert.strictEqual(token.source, 'token');
});

test('whatsapp: 3 fields — business_account_id, phone_number_id, access_token', () => {
  const fields = getProviderCredentials('whatsapp');
  assert.strictEqual(fields.length, 3);
  const keys = fields.map(f => f.key);
  assert.ok(keys.includes('business_account_id'), 'business_account_id missing');
  assert.ok(keys.includes('phone_number_id'), 'phone_number_id missing');
  assert.ok(keys.includes('access_token'), 'access_token missing');
});

test('canva: oauth_access_token required, source=oauth', () => {
  const field = getProviderCredentials('canva')[0];
  assert.ok(field);
  assert.strictEqual(field.source, 'oauth');
});

test('supabase: project_url (manual) + anon_key (api_key)', () => {
  const fields = getProviderCredentials('supabase');
  const url = fields.find(f => f.key === 'project_url')!;
  const key = fields.find(f => f.key === 'anon_key')!;
  assert.ok(url, 'project_url missing');
  assert.strictEqual(url.source, 'manual');
  assert.ok(key, 'anon_key missing');
  assert.strictEqual(key.source, 'api_key');
});

// ── Section 2: provider aliases ───────────────────────────────────────────────

console.log('\nSection 2: provider alias resolution');

test('alias "email" resolves to gmail credentials', () => {
  const fields = getProviderCredentials('email');
  assert.ok(fields.length > 0, 'no fields for email alias');
  assert.strictEqual(fields[0].key, 'oauth_google');
});

test('alias "smtp" resolves to gmail credentials', () => {
  const fields = getProviderCredentials('smtp');
  assert.ok(fields.length > 0, 'no fields for smtp alias');
});

test('providerHasCredentials returns true for telegram', () => {
  assert.strictEqual(providerHasCredentials('telegram'), true);
});

test('providerHasCredentials returns false for unknown provider', () => {
  assert.strictEqual(providerHasCredentials('unknownxyz'), false);
});

test('getProviderDisplayName returns human-readable label', () => {
  assert.strictEqual(getProviderDisplayName('telegram'), 'Telegram');
  assert.strictEqual(getProviderDisplayName('google_sheets'), 'Google Sheets');
  assert.strictEqual(getProviderDisplayName('cloudflare_ai'), 'Cloudflare AI');
});

// ── Section 3: resolveCredentialRequirements ──────────────────────────────────

console.log('\nSection 3: resolveCredentialRequirements');

test('telegram → result with 2 missing fields, ready=false', () => {
  const results = resolveCredentialRequirements(['telegram']);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.provider, 'telegram');
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.missing.length, 2);
  assert.ok(r.missing.some(f => f.key === 'bot_token'), 'bot_token missing');
  assert.ok(r.missing.some(f => f.key === 'chat_id'), 'chat_id missing');
});

test('gmail → 1 missing oauth field, ready=false', () => {
  const results = resolveCredentialRequirements(['gmail']);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].missing.length, 1);
  assert.strictEqual(results[0].missing[0].key, 'oauth_google');
  assert.strictEqual(results[0].ready, false);
});

test('shopify + hubspot → 2 results, both not ready', () => {
  const results = resolveCredentialRequirements(['shopify', 'hubspot']);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(r => !r.ready));
});

test('empty providers → empty results', () => {
  const results = resolveCredentialRequirements([]);
  assert.deepStrictEqual(results, []);
});

test('unknown provider is filtered out', () => {
  const results = resolveCredentialRequirements(['unknownxyz']);
  assert.deepStrictEqual(results, []);
});

test('duplicate providers deduplicated', () => {
  const results = resolveCredentialRequirements(['telegram', 'telegram', 'telegram']);
  assert.strictEqual(results.length, 1);
});

test('mixed oauth/token/manual: gmail + telegram + shopify', () => {
  const results = resolveCredentialRequirements(['gmail', 'telegram', 'shopify']);
  assert.strictEqual(results.length, 3);
  const gmail = results.find(r => r.provider === 'gmail')!;
  const telegram = results.find(r => r.provider === 'telegram')!;
  const shopify = results.find(r => r.provider === 'shopify')!;
  assert.strictEqual(gmail.missing[0].source, 'oauth');
  assert.ok(telegram.missing.some(f => f.source === 'token'));
  assert.ok(shopify.missing.some(f => f.source === 'api_key'));
});

// ── Section 4: resolveMissingCredentials ──────────────────────────────────────

console.log('\nSection 4: resolveMissingCredentials');

test('telegram connected → ready=true, missing=[]', () => {
  const results = resolveMissingCredentials(['telegram'], ['telegram']);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ready, true);
  assert.deepStrictEqual(results[0].missing, []);
});

test('telegram NOT connected → ready=false, missing has fields', () => {
  const results = resolveMissingCredentials(['telegram'], []);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ready, false);
  assert.ok(results[0].missing.length > 0);
});

test('gmail + slack, only slack connected → gmail missing, slack ready', () => {
  const results = resolveMissingCredentials(['gmail', 'slack'], ['slack']);
  const gmail = results.find(r => r.provider === 'gmail')!;
  const slack = results.find(r => r.provider === 'slack')!;
  assert.ok(gmail, 'gmail missing from results');
  assert.strictEqual(gmail.ready, false);
  assert.ok(gmail.missing.length > 0);
  assert.ok(slack, 'slack missing from results');
  assert.strictEqual(slack.ready, true);
  assert.deepStrictEqual(slack.missing, []);
});

test('all providers connected → all ready', () => {
  const providers = ['telegram', 'gmail', 'shopify'];
  const results = resolveMissingCredentials(providers, providers);
  assert.ok(results.every(r => r.ready), `Not all ready: ${JSON.stringify(results.map(r => r.provider + ':' + r.ready))}`);
});

test('empty providers → empty results', () => {
  const results = resolveMissingCredentials([], ['telegram']);
  assert.deepStrictEqual(results, []);
});

// ── Section 5: checkDeploymentCredentials ─────────────────────────────────────

console.log('\nSection 5: checkDeploymentCredentials');

test('telegram connected → canDeploy=true, missingProviders=[]', () => {
  const result = checkDeploymentCredentials(['telegram'], ['telegram']);
  assert.strictEqual(result.canDeploy, true);
  assert.deepStrictEqual(result.missingProviders, []);
});

test('telegram NOT connected → canDeploy=false, missingProviders=[telegram]', () => {
  const result = checkDeploymentCredentials(['telegram'], []);
  assert.strictEqual(result.canDeploy, false);
  assert.ok(result.missingProviders.includes('telegram'), `got: ${JSON.stringify(result.missingProviders)}`);
});

test('gmail + slack, only gmail connected → canDeploy=false, slack in missing', () => {
  const result = checkDeploymentCredentials(['gmail', 'slack'], ['gmail']);
  assert.strictEqual(result.canDeploy, false);
  assert.ok(result.missingProviders.includes('slack'));
  assert.ok(!result.missingProviders.includes('gmail'));
});

test('empty providers list → canDeploy=true (no requirements)', () => {
  const result = checkDeploymentCredentials([], []);
  assert.strictEqual(result.canDeploy, true);
  assert.deepStrictEqual(result.missingProviders, []);
});

test('only unknown providers → canDeploy=true (no registry entry = no requirement)', () => {
  const result = checkDeploymentCredentials(['unknownxyz'], []);
  assert.strictEqual(result.canDeploy, true);
});

// ── Section 6: buildCredentialSummary ─────────────────────────────────────────

console.log('\nSection 6: buildCredentialSummary');

test('all ready → "All integrations connected"', () => {
  const results = resolveMissingCredentials(['telegram'], ['telegram']);
  const summary = buildCredentialSummary(results);
  assert.strictEqual(summary, 'All integrations connected');
});

test('telegram not ready → includes "Bot Token" and "Chat ID"', () => {
  const results = resolveMissingCredentials(['telegram'], []);
  const summary = buildCredentialSummary(results);
  assert.ok(summary.includes('Bot Token'), `summary missing Bot Token: "${summary}"`);
  assert.ok(summary.includes('Chat ID'), `summary missing Chat ID: "${summary}"`);
});

test('gmail not ready → includes "Google OAuth"', () => {
  const results = resolveMissingCredentials(['gmail'], []);
  const summary = buildCredentialSummary(results);
  assert.ok(summary.includes('Google OAuth'), `summary missing Google OAuth: "${summary}"`);
});

test('gmail + slack both missing → summary includes both', () => {
  const results = resolveMissingCredentials(['gmail', 'slack'], []);
  const summary = buildCredentialSummary(results);
  assert.ok(summary.includes('Gmail'), `summary missing Gmail: "${summary}"`);
  assert.ok(summary.includes('Slack'), `summary missing Slack: "${summary}"`);
});

test('empty results → "All integrations connected"', () => {
  const summary = buildCredentialSummary([]);
  assert.strictEqual(summary, 'All integrations connected');
});

// ── Section 7: adversarial inputs ─────────────────────────────────────────────

console.log('\nSection 7: adversarial inputs');

test('null-like provider strings are skipped gracefully', () => {
  const results = resolveCredentialRequirements(['', ' ', '  ']);
  assert.deepStrictEqual(results, []);
});

test('mixed valid + invalid providers: only valid ones returned', () => {
  const results = resolveCredentialRequirements(['telegram', 'totally_fake_provider_xyz', 'gmail']);
  const providers = results.map(r => r.provider);
  assert.ok(providers.includes('telegram'), 'telegram missing');
  assert.ok(providers.includes('gmail'), 'gmail missing');
  assert.ok(!providers.includes('totally_fake_provider_xyz'), 'fake provider leaked');
});

test('connectedProviders with case mismatch still resolves correctly', () => {
  const results = resolveMissingCredentials(['TELEGRAM'], ['telegram']);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ready, true);
});

test('deployment check: all invalid providers → canDeploy=true', () => {
  const result = checkDeploymentCredentials(['bogus1', 'bogus2'], []);
  assert.strictEqual(result.canDeploy, true);
  assert.deepStrictEqual(result.missingProviders, []);
});

test('stripe: only secret_key is required; webhook_secret is optional', () => {
  const results = resolveMissingCredentials(['stripe'], []);
  const r = results[0];
  const missingKeys = r.missing.map(f => f.key);
  const optionalKeys = r.optional.map(f => f.key);
  assert.ok(missingKeys.includes('secret_key'), 'secret_key should be missing');
  assert.ok(!missingKeys.includes('webhook_secret'), 'webhook_secret should not be required');
  assert.ok(optionalKeys.includes('webhook_secret'), 'webhook_secret should be optional');
});

test('whatsapp: all 3 fields required, all appear in missing when not connected', () => {
  const results = resolveMissingCredentials(['whatsapp'], []);
  const r = results[0];
  assert.strictEqual(r.missing.length, 3);
  const keys = r.missing.map(f => f.key);
  assert.ok(keys.includes('business_account_id'));
  assert.ok(keys.includes('phone_number_id'));
  assert.ok(keys.includes('access_token'));
});

test('cloudflare_ai: both fields required, mixed source types', () => {
  const results = resolveMissingCredentials(['cloudflare_ai'], []);
  const r = results[0];
  const sources = r.missing.map(f => f.source);
  assert.ok(sources.includes('manual'), 'account_id should be manual');
  assert.ok(sources.includes('token'), 'api_token should be token');
});

test('large provider list: no duplicates in results', () => {
  const providers = ['telegram', 'gmail', 'slack', 'shopify', 'airtable', 'hubspot', 'openai', 'claude', 'stripe', 'telegram'];
  const results = resolveCredentialRequirements(providers);
  const seen = new Set(results.map(r => r.provider));
  assert.strictEqual(results.length, seen.size, 'duplicate providers in results');
});

// ── results ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.error(f));
}
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
