/**
 * Negation-provider extraction + risk classification tests.
 * Run with:  npx tsx scripts/test-negation-provider.ts
 *
 * Validates:
 *   - isNegated() unit behaviour
 *   - parseRequestedProvidersFromPrompt() negation awareness
 *   - extractHardConstraints() forbiddenProviders population
 *   - classifyWorkflowRisk() thresholds
 */

import assert from 'assert';
import { isNegated, parseRequestedProvidersFromPrompt } from '@/lib/agent/provider-allowlist';
import {
  extractHardConstraints,
  buildProviderIntentGraph,
  computePatternRisk,
} from '@/lib/automation/extract-hard-constraints';
import { classifyWorkflowRisk } from '@/lib/builder/runtime-state';

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

// ── Section 1: isNegated unit tests ──────────────────────────────────────────

console.log('\nSection 1: isNegated() unit tests');

test('No Google Sheets → true', () => {
  assert.strictEqual(isNegated('No Google Sheets', 'Google Sheets'), true);
});

test('without Google Sheets → true', () => {
  assert.strictEqual(isNegated('without Google Sheets', 'Google Sheets'), true);
});

test('Absolutely no AI → true for OpenAI', () => {
  assert.strictEqual(isNegated('Absolutely no OpenAI', 'OpenAI'), true);
});

test('exclude OpenAI → true', () => {
  assert.strictEqual(isNegated('exclude OpenAI', 'OpenAI'), true);
});

test('excluding Slack → true', () => {
  assert.strictEqual(isNegated('excluding Slack', 'Slack'), true);
});

test('never use Slack → true', () => {
  assert.strictEqual(isNegated('never use Slack', 'Slack'), true);
});

test('disable Airtable → true', () => {
  assert.strictEqual(isNegated('disable Airtable', 'Airtable'), true);
});

test("don't use Telegram → true", () => {
  assert.strictEqual(isNegated("don't use Telegram", 'Telegram'), true);
});

test('Telegram + Google Sheets integration → false', () => {
  assert.strictEqual(isNegated('Telegram + Google Sheets integration', 'Google Sheets'), false);
});

test('Use Google Sheets for storage → false', () => {
  assert.strictEqual(isNegated('Use Google Sheets for storage', 'Google Sheets'), false);
});

test('No Sheets. Use Sheets for export → false (non-negated occurrence wins)', () => {
  assert.strictEqual(isNegated('No Sheets. Use Sheets for export.', 'Sheets'), false);
});

test('term absent → false', () => {
  assert.strictEqual(isNegated('Telegram only', 'Google Sheets'), false);
});

test('No Telegram. Use Telegram later → false', () => {
  assert.strictEqual(isNegated('No Telegram. Use Telegram later.', 'Telegram'), false);
});

test('Telegram only (no negation) → false', () => {
  assert.strictEqual(isNegated('Telegram only', 'Telegram'), false);
});

test('multi-line: \\nNo Google Sheets\\n → true', () => {
  assert.strictEqual(
    isNegated('When message arrives.\nNo Google Sheets.\nTelegram only.', 'Google Sheets'),
    true
  );
});

// ── Section 2: parseRequestedProvidersFromPrompt negation cases ───────────────

console.log('\nSection 2: parseRequestedProvidersFromPrompt — negated providers excluded');

const FULL_PROMPT =
  "When a new Telegram message arrives: reply only: 'Received successfully'\n" +
  'Absolutely no AI\n' +
  'No Google Sheets\n' +
  'No monitoring\n' +
  'No logging\n' +
  'No analytics\n' +
  'No extraction\n' +
  'Telegram only';

test('[full-prompt] google_sheets NOT in raw output', () => {
  const raw = parseRequestedProvidersFromPrompt(FULL_PROMPT);
  assert.ok(!raw.includes('google_sheets'), `got: ${JSON.stringify(raw)}`);
});

test('[full-prompt] telegram IS in raw output', () => {
  const raw = parseRequestedProvidersFromPrompt(FULL_PROMPT);
  assert.ok(raw.includes('telegram'), `got: ${JSON.stringify(raw)}`);
});

test('[full-prompt] raw output = ["telegram"]', () => {
  const raw = parseRequestedProvidersFromPrompt(FULL_PROMPT);
  assert.deepStrictEqual(raw, ['telegram'], `got: ${JSON.stringify(raw)}`);
});

test('No Airtable. Shopify only → airtable excluded, shopify present', () => {
  const raw = parseRequestedProvidersFromPrompt('No Airtable. Shopify only.');
  assert.ok(!raw.includes('airtable'), `airtable leaked: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('shopify'), `shopify missing: ${JSON.stringify(raw)}`);
});

test('No Slack. Forward Gmail to Slack → slack still included (non-negated occurrence)', () => {
  const raw = parseRequestedProvidersFromPrompt('No Slack alerts. Forward Gmail to Slack channel.');
  assert.ok(raw.includes('gmail'), `gmail missing: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('slack'), `slack missing (non-negated occurrence present): ${JSON.stringify(raw)}`);
});

test('without OpenAI. Use Claude → openai excluded, claude present', () => {
  const raw = parseRequestedProvidersFromPrompt('without OpenAI. Use Claude for summaries.');
  assert.ok(!raw.includes('openai'), `openai leaked: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('claude'), `claude missing: ${JSON.stringify(raw)}`);
});

test('No Stripe. Process Shopify orders → stripe excluded', () => {
  const raw = parseRequestedProvidersFromPrompt('No Stripe payments. Process Shopify orders.');
  assert.ok(!raw.includes('stripe'), `stripe leaked: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('shopify'), `shopify missing: ${JSON.stringify(raw)}`);
});

test('No HubSpot, no Airtable. Slack only → both excluded, slack present', () => {
  const raw = parseRequestedProvidersFromPrompt('No HubSpot. No Airtable. Slack only.');
  assert.ok(!raw.includes('hubspot'), `hubspot leaked: ${JSON.stringify(raw)}`);
  assert.ok(!raw.includes('airtable'), `airtable leaked: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('slack'), `slack missing: ${JSON.stringify(raw)}`);
});

test('Telegram bot (no negations) → telegram present', () => {
  const raw = parseRequestedProvidersFromPrompt('Build a Telegram bot that replies to messages.');
  assert.ok(raw.includes('telegram'), `got: ${JSON.stringify(raw)}`);
});

test('Shopify + HubSpot integration → both present', () => {
  const raw = parseRequestedProvidersFromPrompt('New Shopify order → add to HubSpot CRM.');
  assert.ok(raw.includes('shopify'), `shopify missing: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes('hubspot'), `hubspot missing: ${JSON.stringify(raw)}`);
});

// ── Section 3: extractHardConstraints — forbiddenProviders ────────────────────

console.log('\nSection 3: extractHardConstraints — forbiddenProviders');

test('[full-prompt] forbiddenProviders includes google_sheets', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('google_sheets'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] forbiddenProviders includes openai (no AI)', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('openai'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] forbiddenProviders includes claude (no AI)', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('claude'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] forbiddenProviders includes cloudflare_ai (no AI)', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('cloudflare_ai'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] forbiddenProviders includes elevenlabs (no AI)', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('elevenlabs'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] forbiddenProviders includes deepgram (no AI)', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenProviders.includes('deepgram'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('[full-prompt] requiredProviders = ["telegram"]', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.deepStrictEqual(c.requiredProviders, ['telegram'], `got: ${JSON.stringify(c.requiredProviders)}`);
});

test('[full-prompt] identityLocked = true', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.strictEqual(c.identityLocked, true);
});

test('[full-prompt] forbiddenCapabilities includes monitoring', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenCapabilities.includes('monitoring'), `got: ${JSON.stringify(c.forbiddenCapabilities)}`);
});

test('[full-prompt] forbiddenCapabilities includes analytics', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  assert.ok(c.forbiddenCapabilities.includes('analytics'), `got: ${JSON.stringify(c.forbiddenCapabilities)}`);
});

test('No Slack, no Airtable. Shopify only → both forbidden', () => {
  const c = extractHardConstraints('No Slack. No Airtable. Shopify only.');
  assert.ok(c.forbiddenProviders.includes('slack'), `slack missing: ${JSON.stringify(c.forbiddenProviders)}`);
  assert.ok(c.forbiddenProviders.includes('airtable'), `airtable missing: ${JSON.stringify(c.forbiddenProviders)}`);
  assert.ok(c.requiredProviders.includes('shopify'), `shopify missing: ${JSON.stringify(c.requiredProviders)}`);
});

test('Deduplication: repeated negation → no duplicates in forbiddenProviders', () => {
  const c = extractHardConstraints('No Slack. No Slack. Telegram only.');
  const count = c.forbiddenProviders.filter((p) => p === 'slack').length;
  assert.strictEqual(count, 1, `slack appears ${count} times`);
});

test('Deduplication: repeated provider → no duplicates in requiredProviders', () => {
  const c = extractHardConstraints('Telegram only. Use Telegram. Telegram.');
  const count = c.requiredProviders.filter((p) => p === 'telegram').length;
  assert.strictEqual(count, 1, `telegram appears ${count} times`);
});

// ── Section 4: classifyWorkflowRisk ──────────────────────────────────────────

console.log('\nSection 4: classifyWorkflowRisk');

test('1 provider, 1 capability, no AI/storage → Low', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['telegram'], ['send_message'], 0, 1, 0),
    'Low'
  );
});

test('1 provider, 2 capabilities, no AI → Low', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['telegram'], ['receive_message', 'send_message'], 0, 2, 0),
    'Low'
  );
});

test('0 providers, 1 capability, no AI → Low', () => {
  assert.strictEqual(
    classifyWorkflowRisk([], ['send_message'], 0, 1, 0),
    'Low'
  );
});

test('2 providers → not low fast-path (falls to node-count rules)', () => {
  const risk = classifyWorkflowRisk(['telegram', 'slack'], ['send_message'], 0, 1, 0);
  // 2 providers → fast-path skipped; actionCount=1, ai=0, branches=0 → Low
  assert.strictEqual(risk, 'Low');
});

test('1 provider, AI node → Medium (aiNodeCount=1)', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['openai'], ['chatbot'], 1, 1, 0),
    'Medium'
  );
});

test('1 provider, openai in providers list → Low fast-path skipped → AI flag', () => {
  // AI provider present: fast-path condition !containsAI fails → fall to node rules
  const risk = classifyWorkflowRisk(['openai'], ['chatbot'], 0, 1, 0);
  // actionCount=1, aiNodeCount=0, branches=0 → Low from node rules
  assert.strictEqual(risk, 'Low');
});

test('4+ actions → High', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['telegram', 'slack', 'hubspot'], ['send_message', 'crm', 'database_storage'], 0, 4, 0),
    'High'
  );
});

test('2+ branches → High', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['telegram', 'slack'], ['send_message'], 0, 3, 2),
    'High'
  );
});

test('2+ AI nodes → High', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['openai', 'claude'], ['chatbot', 'memory'], 2, 3, 0),
    'High'
  );
});

test('2 actions, no AI, no branches → Medium', () => {
  assert.strictEqual(
    classifyWorkflowRisk(['telegram', 'slack'], ['send_message', 'crm'], 0, 2, 0),
    'Medium'
  );
});

test('database_storage capability → fast-path blocked → node-count rules apply', () => {
  // containsStorage=true → fast-path fails; actionCount=1, ai=0, branches=0 → Low
  assert.strictEqual(
    classifyWorkflowRisk(['telegram'], ['send_message', 'database_storage'], 0, 1, 0),
    'Low'
  );
});

test('monitoring capability → fast-path blocked → node-count rules', () => {
  // containsMonitoring=true → fast-path fails; actionCount=1, ai=0, branches=0 → Low
  assert.strictEqual(
    classifyWorkflowRisk(['telegram'], ['send_message', 'monitoring'], 0, 1, 0),
    'Low'
  );
});

// ── Section 5: buildProviderIntentGraph — negation exclusion ──────────────────

console.log('\nSection 5: buildProviderIntentGraph — negated providers excluded');

test('[full-prompt] google_sheets NOT in intent graph (negated)', () => {
  const graph = buildProviderIntentGraph(FULL_PROMPT);
  const providers = graph.map((g) => g.provider);
  assert.ok(!providers.includes('google_sheets'), `google_sheets leaked into intent graph: ${JSON.stringify(providers)}`);
});

test('[full-prompt] telegram IS in intent graph', () => {
  const graph = buildProviderIntentGraph(FULL_PROMPT);
  const providers = graph.map((g) => g.provider);
  assert.ok(providers.includes('telegram'), `telegram missing from intent graph: ${JSON.stringify(providers)}`);
});

test('No Google Sheets. Telegram only → google_sheets absent from intent graph', () => {
  const graph = buildProviderIntentGraph('No Google Sheets. Telegram only.');
  const providers = graph.map((g) => g.provider);
  assert.ok(!providers.includes('google_sheets'), `google_sheets leaked: ${JSON.stringify(providers)}`);
  assert.ok(providers.includes('telegram'), `telegram missing: ${JSON.stringify(providers)}`);
});

test('Telegram + Google Sheets integration (no negation) → both in intent graph', () => {
  const graph = buildProviderIntentGraph('Telegram + Google Sheets integration.');
  const providers = graph.map((g) => g.provider);
  assert.ok(providers.includes('telegram'), `telegram missing: ${JSON.stringify(providers)}`);
  assert.ok(providers.includes('google_sheets'), `google_sheets missing (not negated): ${JSON.stringify(providers)}`);
});

test('No Slack. Forward Gmail to Slack → slack still in intent graph (non-negated occurrence)', () => {
  const graph = buildProviderIntentGraph('No Slack alerts. Forward Gmail to Slack channel.');
  const providers = graph.map((g) => g.provider);
  assert.ok(providers.includes('slack'), `slack missing (non-negated occurrence present): ${JSON.stringify(providers)}`);
});

// ── Section 6: extended forbidden provider prefixes ───────────────────────────

console.log('\nSection 6: extended forbidden provider prefix coverage');

test('"exclude Google Sheets" → google_sheets in forbiddenProviders', () => {
  const c = extractHardConstraints('exclude Google Sheets. Use Telegram.');
  assert.ok(c.forbiddenProviders.includes('google_sheets'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"excluding Slack" → slack in forbiddenProviders', () => {
  const c = extractHardConstraints('Build a workflow excluding Slack. Use Telegram.');
  assert.ok(c.forbiddenProviders.includes('slack'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"never use Slack" → slack in forbiddenProviders', () => {
  const c = extractHardConstraints('Send messages, never use Slack. Use Telegram.');
  assert.ok(c.forbiddenProviders.includes('slack'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"disable Airtable" → airtable in forbiddenProviders', () => {
  const c = extractHardConstraints('disable Airtable. Use Supabase.');
  assert.ok(c.forbiddenProviders.includes('airtable'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"remove Stripe" → stripe in forbiddenProviders', () => {
  const c = extractHardConstraints('remove Stripe from this workflow. Use Shopify.');
  assert.ok(c.forbiddenProviders.includes('stripe'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"don\'t use OpenAI" → openai in forbiddenProviders', () => {
  const c = extractHardConstraints("don't use OpenAI. Use Claude instead.");
  assert.ok(c.forbiddenProviders.includes('openai'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"absolutely no Airtable" → airtable in forbiddenProviders', () => {
  const c = extractHardConstraints('Absolutely no Airtable. Telegram only.');
  assert.ok(c.forbiddenProviders.includes('airtable'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

test('"without Hubspot" → hubspot in forbiddenProviders', () => {
  const c = extractHardConstraints('Forward emails without HubSpot. Telegram only.');
  assert.ok(c.forbiddenProviders.includes('hubspot'), `got: ${JSON.stringify(c.forbiddenProviders)}`);
});

// ── Section 7: computePatternRisk thresholds ──────────────────────────────────

console.log('\nSection 7: computePatternRisk thresholds');

test('Telegram-only, receive+send_message → risk low', () => {
  const c = extractHardConstraints(FULL_PROMPT);
  const risk = computePatternRisk(['receive_message', 'send_message'], c);
  assert.strictEqual(risk, 'low', `Expected low, got ${risk}`);
});

test('1 provider, 1 capability, no AI → low', () => {
  const c = extractHardConstraints('When Telegram message arrives, reply.');
  const risk = computePatternRisk(['send_message'], c);
  assert.strictEqual(risk, 'low', `Expected low, got ${risk}`);
});

test('0 providers, 1 capability, no AI → low (providerCount=0 ≤ 1)', () => {
  const c = extractHardConstraints('reply to messages');
  const risk = computePatternRisk(['send_message'], c);
  assert.strictEqual(risk, 'low', `Expected low, got ${risk}`);
});

test('AI capability → not low', () => {
  const c = extractHardConstraints('Summarize emails with OpenAI.');
  const risk = computePatternRisk(['chatbot', 'receive_message'], c);
  assert.notStrictEqual(risk, 'low', `Expected medium or high, got ${risk}`);
});

test('storage capability → not low', () => {
  const c = extractHardConstraints('When Telegram message arrives, save to database.');
  const risk = computePatternRisk(['receive_message', 'database_storage'], c);
  assert.notStrictEqual(risk, 'low', `Expected medium or high, got ${risk}`);
});

test('3+ capabilities → medium (not high unless > 6)', () => {
  const c = extractHardConstraints('Forward Gmail to Slack and save.');
  const risk = computePatternRisk(['receive_message', 'send_message', 'scheduling'], c);
  assert.strictEqual(risk, 'medium', `Expected medium, got ${risk}`);
});

test('7 capabilities → high', () => {
  const c = extractHardConstraints('complex multi-step workflow');
  const risk = computePatternRisk(['a', 'b', 'c', 'd', 'e', 'f', 'g'], c);
  assert.strictEqual(risk, 'high', `Expected high, got ${risk}`);
});

// ── results ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.error(f));
}
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
