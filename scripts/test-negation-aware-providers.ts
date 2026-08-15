/**
 * Negation-aware provider injection tests.
 * Run with:  npx tsx scripts/test-negation-aware-providers.ts
 *
 * Verifies that parseRequestedProvidersFromPrompt() output, when filtered
 * through extractHardConstraints(), never injects negated providers into
 * args.requested_providers (which the executor validates against the graph).
 *
 * This is the exact path fixed in lib/agent/loop.ts:
 *   const constrainedProviders = constraints?.identityLocked && allowedProviders.length > 0
 *     ? constraints.allowedProviders
 *     : filterProviders(requestedProvidersFromPrompt, constraints);
 */

import assert from 'assert';
import { parseRequestedProvidersFromPrompt } from '@/lib/agent/provider-allowlist';
import {
  extractHardConstraints,
  filterProviders,
} from '@/lib/automation/extract-hard-constraints';

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

// ── helper: simulate exactly what loop.ts now does ───────────────────────────

function constrainedProvidersForPrompt(prompt: string): string[] {
  const rawProviders = parseRequestedProvidersFromPrompt(prompt);
  const constraints = extractHardConstraints(prompt);

  if (constraints.identityLocked && constraints.allowedProviders.length > 0) {
    return constraints.allowedProviders;
  }
  return filterProviders(rawProviders, constraints);
}

// ── section 1: Telegram only ─────────────────────────────────────────────────

console.log('\nTelegram-only prompt');

const TELEGRAM_ONLY =
  "When a new Telegram message arrives: reply only: 'Received successfully'. " +
  "Absolutely no AI. No Google Sheets. No monitoring. No logging. No analytics. " +
  "No extraction. Telegram only.";

test('raw parseRequestedProvidersFromPrompt does NOT include google_sheets (negation-aware)', () => {
  const raw = parseRequestedProvidersFromPrompt(TELEGRAM_ONLY);
  assert.ok(!raw.includes('google_sheets'),
    `google_sheets must not appear in raw output — it is negated: got ${JSON.stringify(raw)}`);
});

test('raw parseRequestedProvidersFromPrompt includes telegram', () => {
  const raw = parseRequestedProvidersFromPrompt(TELEGRAM_ONLY);
  assert.ok(raw.includes('telegram'),
    `Expected telegram in raw output: got ${JSON.stringify(raw)}`);
});

test('constrained output = ["telegram"] only', () => {
  const result = constrainedProvidersForPrompt(TELEGRAM_ONLY);
  assert.deepStrictEqual(result, ['telegram'],
    `Expected ["telegram"], got ${JSON.stringify(result)}`);
});

test('constrained output does NOT contain google_sheets', () => {
  const result = constrainedProvidersForPrompt(TELEGRAM_ONLY);
  assert.ok(!result.includes('google_sheets'),
    `google_sheets leaked into constrained output: ${JSON.stringify(result)}`);
});

test('identityLocked=true for Telegram-only prompt', () => {
  const constraints = extractHardConstraints(TELEGRAM_ONLY);
  assert.strictEqual(constraints.identityLocked, true);
});

// ── section 2: No Slack, Email only ─────────────────────────────────────────

console.log('\nNo Slack / Email only prompt');

const NO_SLACK_EMAIL_ONLY =
  'When a new email arrives in Gmail, summarize it and send a digest. ' +
  'No Slack. Email only.';

test('raw output includes gmail', () => {
  const raw = parseRequestedProvidersFromPrompt(NO_SLACK_EMAIL_ONLY);
  assert.ok(raw.includes('gmail'),
    `Expected gmail in raw output: ${JSON.stringify(raw)}`);
});

test('constrained output does NOT contain slack', () => {
  const result = constrainedProvidersForPrompt(NO_SLACK_EMAIL_ONLY);
  assert.ok(!result.includes('slack'),
    `slack leaked into constrained output: ${JSON.stringify(result)}`);
});

test('constrained output contains gmail', () => {
  const result = constrainedProvidersForPrompt(NO_SLACK_EMAIL_ONLY);
  assert.ok(result.includes('gmail'),
    `gmail was incorrectly removed: ${JSON.stringify(result)}`);
});

test('identityLocked=true for email-only prompt', () => {
  const constraints = extractHardConstraints(NO_SLACK_EMAIL_ONLY);
  assert.strictEqual(constraints.identityLocked, true,
    `Expected identityLocked=true, got ${constraints.identityLocked}`);
});

// ── section 3: No Airtable, Shopify only ────────────────────────────────────

console.log('\nNo Airtable / Shopify only prompt');

const NO_AIRTABLE_SHOPIFY_ONLY =
  'When a new Shopify order comes in, process it and update inventory. ' +
  'No Airtable. Shopify only.';

test('raw output includes shopify', () => {
  const raw = parseRequestedProvidersFromPrompt(NO_AIRTABLE_SHOPIFY_ONLY);
  assert.ok(raw.includes('shopify'),
    `Expected shopify in raw output: ${JSON.stringify(raw)}`);
});

test('constrained output does NOT contain airtable', () => {
  const result = constrainedProvidersForPrompt(NO_AIRTABLE_SHOPIFY_ONLY);
  assert.ok(!result.includes('airtable'),
    `airtable leaked into constrained output: ${JSON.stringify(result)}`);
});

test('constrained output contains shopify', () => {
  const result = constrainedProvidersForPrompt(NO_AIRTABLE_SHOPIFY_ONLY);
  assert.ok(result.includes('shopify'),
    `shopify was incorrectly removed: ${JSON.stringify(result)}`);
});

test('identityLocked=true for shopify-only prompt', () => {
  const constraints = extractHardConstraints(NO_AIRTABLE_SHOPIFY_ONLY);
  assert.strictEqual(constraints.identityLocked, true,
    `Expected identityLocked=true, got ${constraints.identityLocked}`);
});

// ── section 4: No OpenAI, Telegram only ─────────────────────────────────────

console.log('\nNo OpenAI / Telegram only prompt');

const NO_OPENAI_TELEGRAM_ONLY =
  'When a Telegram message arrives, reply with a fixed response. ' +
  'No OpenAI. No AI at all. Telegram only.';

test('raw output includes telegram', () => {
  const raw = parseRequestedProvidersFromPrompt(NO_OPENAI_TELEGRAM_ONLY);
  assert.ok(raw.includes('telegram'),
    `Expected telegram in raw output: ${JSON.stringify(raw)}`);
});

test('constrained output does NOT contain openai', () => {
  const result = constrainedProvidersForPrompt(NO_OPENAI_TELEGRAM_ONLY);
  assert.ok(!result.includes('openai'),
    `openai leaked into constrained output: ${JSON.stringify(result)}`);
});

test('constrained output = ["telegram"]', () => {
  const result = constrainedProvidersForPrompt(NO_OPENAI_TELEGRAM_ONLY);
  assert.deepStrictEqual(result, ['telegram'],
    `Expected ["telegram"], got ${JSON.stringify(result)}`);
});

test('identityLocked=true for no-AI telegram-only prompt', () => {
  const constraints = extractHardConstraints(NO_OPENAI_TELEGRAM_ONLY);
  assert.strictEqual(constraints.identityLocked, true);
});

// ── section 5: multi-provider without identity lock ──────────────────────────

console.log('\nMulti-provider (no identity lock) — negation still enforced');

const SLACK_GMAIL_NO_AIRTABLE =
  'Forward new Gmail emails to Slack. No Airtable.';

test('constrained output contains both gmail and slack', () => {
  const result = constrainedProvidersForPrompt(SLACK_GMAIL_NO_AIRTABLE);
  assert.ok(result.includes('gmail'), `gmail missing: ${JSON.stringify(result)}`);
  assert.ok(result.includes('slack'), `slack missing: ${JSON.stringify(result)}`);
});

test('constrained output does NOT contain airtable', () => {
  const result = constrainedProvidersForPrompt(SLACK_GMAIL_NO_AIRTABLE);
  assert.ok(!result.includes('airtable'),
    `airtable leaked even without identity lock: ${JSON.stringify(result)}`);
});

test('identityLocked=false for multi-provider prompt', () => {
  const constraints = extractHardConstraints(SLACK_GMAIL_NO_AIRTABLE);
  assert.strictEqual(constraints.identityLocked, false,
    `Expected identityLocked=false for multi-provider prompt`);
});

// ── section 6: no negation — provider survives ───────────────────────────────

console.log('\nNo negation — provider passes through normally');

test('Shopify + HubSpot (no negation): both survive', () => {
  const result = constrainedProvidersForPrompt(
    'When a new Shopify order is placed, add the customer to HubSpot CRM.'
  );
  assert.ok(result.includes('shopify'), `shopify missing: ${JSON.stringify(result)}`);
  assert.ok(result.includes('hubspot'), `hubspot missing: ${JSON.stringify(result)}`);
});

test('Telegram bot (no negation): telegram survives', () => {
  const result = constrainedProvidersForPrompt(
    'Build a Telegram bot that replies to messages automatically.'
  );
  assert.ok(result.includes('telegram'), `telegram missing: ${JSON.stringify(result)}`);
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
