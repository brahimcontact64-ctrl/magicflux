/**
 * Telegram-only architectural invariant tests.
 * Run with:  npx tsx scripts/test-telegram-only.ts
 *
 * Verifies that the full "No X / Telegram only" prompt never leaks forbidden
 * providers or capabilities through any pipeline stage.
 *
 * Prompt under test:
 *   "When a new Telegram message arrives: reply only: 'Received successfully'.
 *    Absolutely no AI. No Google Sheets. No monitoring. No logging. No analytics.
 *    No extraction. Telegram only."
 */

import assert from 'assert';
import {
  extractHardConstraints,
  filterProviders,
  filterCapabilities,
  isProviderAllowed,
  isCapabilityAllowed,
  violatesConstraints,
} from '@/lib/automation/extract-hard-constraints';
import { enforceHardConstraintsInvariant } from '@/lib/automation/engine';
import type { AutomationBrainResult, ConstraintContext, ProviderResolution, CapabilityInference } from '@/lib/automation/types';

const TELEGRAM_ONLY_PROMPT =
  "When a new Telegram message arrives: reply only: 'Received successfully'. " +
  "Absolutely no AI. No Google Sheets. No monitoring. No logging. No analytics. " +
  "No extraction. Telegram only.";

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

// ── helpers ───────────────────────────────────────────────────────────────────

function makeResolution(provider: string, capabilities: string[] = [], confidence = 80): ProviderResolution {
  return { provider, capabilities, confidence };
}

function makeCapability(key: string, confidence = 85): CapabilityInference {
  return { key, reason: 'test', confidence };
}

function makeBrain(
  constraints: ConstraintContext,
  providers: string[],
  capabilities: string[]
): AutomationBrainResult {
  return {
    inferredIntent: TELEGRAM_ONLY_PROMPT,
    capabilities: capabilities.map((k) => makeCapability(k)),
    activatedSkillPacks: [],
    matchedPatterns: [],
    providerResolutions: providers.map((p) => makeResolution(p)),
    composition: {
      blocks: [],
      expectedInputs: [],
      expectedOutputs: [],
      executionFrequency: 'Event-driven',
      risks: [],
      estimatedCostUsd: 0,
      complexity: 'simple',
      latencyEstimateMs: 0,
    },
    constraintContext: constraints,
    providerIntentGraph: [],
    credentialIntelligence: [],
  };
}

// ── section 1: extractHardConstraints ─────────────────────────────────────────

console.log('\nextractHardConstraints — Telegram-only prompt');

const constraints = extractHardConstraints(TELEGRAM_ONLY_PROMPT);

test('allowedProviders contains only telegram', () => {
  assert.deepStrictEqual(constraints.allowedProviders, ['telegram'],
    `Expected ["telegram"], got ${JSON.stringify(constraints.allowedProviders)}`);
});

test('identityLocked is true', () => {
  assert.strictEqual(constraints.identityLocked, true,
    `Expected identityLocked=true, got ${constraints.identityLocked}`);
});

test('requiredProviders contains telegram', () => {
  assert.ok(constraints.requiredProviders.includes('telegram'),
    `telegram not in requiredProviders: ${JSON.stringify(constraints.requiredProviders)}`);
});

test('google_sheets is NOT in requiredProviders', () => {
  assert.ok(!constraints.requiredProviders.includes('google_sheets'),
    `google_sheets leaked into requiredProviders: ${JSON.stringify(constraints.requiredProviders)}`);
});

test('google_sheets is in forbiddenProviders', () => {
  assert.ok(constraints.forbiddenProviders.includes('google_sheets'),
    `google_sheets not in forbiddenProviders: ${JSON.stringify(constraints.forbiddenProviders)}`);
});

test('monitoring is in forbiddenCapabilities', () => {
  assert.ok(constraints.forbiddenCapabilities.includes('monitoring'),
    `monitoring not in forbiddenCapabilities: ${JSON.stringify(constraints.forbiddenCapabilities)}`);
});

test('database_storage is in forbiddenCapabilities', () => {
  assert.ok(constraints.forbiddenCapabilities.includes('database_storage'),
    `database_storage not in forbiddenCapabilities: ${JSON.stringify(constraints.forbiddenCapabilities)}`);
});

test('analytics is in forbiddenCapabilities', () => {
  assert.ok(constraints.forbiddenCapabilities.includes('analytics'),
    `analytics not in forbiddenCapabilities: ${JSON.stringify(constraints.forbiddenCapabilities)}`);
});

test('reporting is in forbiddenCapabilities', () => {
  assert.ok(constraints.forbiddenCapabilities.includes('reporting'),
    `reporting not in forbiddenCapabilities: ${JSON.stringify(constraints.forbiddenCapabilities)}`);
});

test('AI capabilities are all forbidden (chatbot, memory, vision_analysis, vector_search)', () => {
  const aiForbidden = ['chatbot', 'memory', 'vision_analysis', 'vector_search'];
  for (const cap of aiForbidden) {
    assert.ok(constraints.forbiddenCapabilities.includes(cap),
      `AI capability "${cap}" not in forbiddenCapabilities`);
  }
});

test('executionMode is event-driven', () => {
  assert.strictEqual(constraints.executionMode, 'event-driven');
});

test('triggerMode is message', () => {
  assert.strictEqual(constraints.triggerMode, 'message');
});

test('actionMode is reply', () => {
  assert.strictEqual(constraints.actionMode, 'reply');
});

// ── section 2: filterProviders ────────────────────────────────────────────────

console.log('\nfilterProviders — identity lock enforcement');

test('filterProviders([telegram, whatsapp, slack]) → [telegram]', () => {
  const result = filterProviders(['telegram', 'whatsapp', 'slack'], constraints);
  assert.deepStrictEqual(result, ['telegram'],
    `Expected ["telegram"], got ${JSON.stringify(result)}`);
});

test('filterProviders([supabase, internal_runtime]) → []', () => {
  const result = filterProviders(['supabase', 'internal_runtime'], constraints);
  assert.deepStrictEqual(result, [],
    `Expected [], got ${JSON.stringify(result)}`);
});

test('filterProviders([google_sheets]) → [] (forbidden)', () => {
  const result = filterProviders(['google_sheets'], constraints);
  assert.deepStrictEqual(result, [],
    `Expected [], got ${JSON.stringify(result)}`);
});

test('filterProviders([whatsapp]) → [] (not in allowlist)', () => {
  const result = filterProviders(['whatsapp'], constraints);
  assert.deepStrictEqual(result, [],
    `Expected [], got ${JSON.stringify(result)}`);
});

test('isProviderAllowed("telegram") → true', () => {
  assert.strictEqual(isProviderAllowed('telegram', constraints), true);
});

test('isProviderAllowed("whatsapp") → false', () => {
  assert.strictEqual(isProviderAllowed('whatsapp', constraints), false);
});

test('isProviderAllowed("google_sheets") → false', () => {
  assert.strictEqual(isProviderAllowed('google_sheets', constraints), false);
});

test('isProviderAllowed("supabase") → false', () => {
  assert.strictEqual(isProviderAllowed('supabase', constraints), false);
});

// ── section 3: filterCapabilities ─────────────────────────────────────────────

console.log('\nfilterCapabilities — forbidden capability enforcement');

test('filterCapabilities([monitoring]) → [] (forbidden)', () => {
  const result = filterCapabilities(['monitoring'], constraints);
  assert.ok(!result.includes('monitoring'),
    `monitoring leaked through filterCapabilities: ${JSON.stringify(result)}`);
});

test('filterCapabilities([database_storage]) → [] (forbidden)', () => {
  const result = filterCapabilities(['database_storage'], constraints);
  assert.ok(!result.includes('database_storage'),
    `database_storage leaked: ${JSON.stringify(result)}`);
});

test('filterCapabilities([analytics]) → [] (forbidden)', () => {
  const result = filterCapabilities(['analytics'], constraints);
  assert.ok(!result.includes('analytics'),
    `analytics leaked: ${JSON.stringify(result)}`);
});

test('isCapabilityAllowed("send_message") → true', () => {
  assert.strictEqual(isCapabilityAllowed('send_message', constraints), true);
});

test('isCapabilityAllowed("receive_message") → true', () => {
  assert.strictEqual(isCapabilityAllowed('receive_message', constraints), true);
});

test('isCapabilityAllowed("monitoring") → false', () => {
  assert.strictEqual(isCapabilityAllowed('monitoring', constraints), false);
});

test('isCapabilityAllowed("chatbot") → false (AI disabled)', () => {
  assert.strictEqual(isCapabilityAllowed('chatbot', constraints), false);
});

// ── section 4: violatesConstraints ────────────────────────────────────────────

console.log('\nviolatesConstraints — gate function');

test('telegram + send_message + receive_message → does not violate', () => {
  const result = violatesConstraints('test', constraints, ['telegram'], ['send_message', 'receive_message']);
  assert.strictEqual(result, false);
});

test('whatsapp + send_message → violates (provider not allowed)', () => {
  const result = violatesConstraints('test', constraints, ['whatsapp'], ['send_message']);
  assert.strictEqual(result, true);
});

test('telegram + monitoring → violates (capability forbidden)', () => {
  const result = violatesConstraints('test', constraints, ['telegram'], ['monitoring']);
  assert.strictEqual(result, true);
});

test('google_sheets + sync → violates (provider forbidden)', () => {
  const result = violatesConstraints('test', constraints, ['google_sheets'], ['sync']);
  assert.strictEqual(result, true);
});

// ── section 5: enforceHardConstraintsInvariant ────────────────────────────────

console.log('\nenforceHardConstraintsInvariant — contamination stripping');

test('strips whatsapp from providerResolutions', () => {
  const contaminated = makeBrain(constraints, ['telegram', 'whatsapp', 'supabase'], ['send_message', 'receive_message']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const providers = clean.providerResolutions.map((r) => r.provider);
  assert.ok(!providers.includes('whatsapp'),
    `whatsapp survived invariant: ${JSON.stringify(providers)}`);
  assert.ok(!providers.includes('supabase'),
    `supabase survived invariant: ${JSON.stringify(providers)}`);
});

test('retains telegram in providerResolutions', () => {
  const contaminated = makeBrain(constraints, ['telegram', 'whatsapp'], ['send_message', 'receive_message']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const providers = clean.providerResolutions.map((r) => r.provider);
  assert.ok(providers.includes('telegram'),
    `telegram was incorrectly removed: ${JSON.stringify(providers)}`);
});

test('strips monitoring from capabilities', () => {
  const contaminated = makeBrain(constraints, ['telegram'], ['send_message', 'receive_message', 'monitoring', 'database_storage', 'analytics']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const caps = clean.capabilities.map((c) => c.key);
  assert.ok(!caps.includes('monitoring'), `monitoring survived invariant: ${JSON.stringify(caps)}`);
  assert.ok(!caps.includes('database_storage'), `database_storage survived invariant: ${JSON.stringify(caps)}`);
  assert.ok(!caps.includes('analytics'), `analytics survived invariant: ${JSON.stringify(caps)}`);
});

test('retains send_message and receive_message after invariant', () => {
  const contaminated = makeBrain(constraints, ['telegram'], ['send_message', 'receive_message', 'monitoring']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const caps = clean.capabilities.map((c) => c.key);
  assert.ok(caps.includes('send_message'), `send_message removed: ${JSON.stringify(caps)}`);
  assert.ok(caps.includes('receive_message'), `receive_message removed: ${JSON.stringify(caps)}`);
});

test('strips google_sheets from providerResolutions (forbidden provider)', () => {
  const contaminated = makeBrain(constraints, ['telegram', 'google_sheets'], ['send_message']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const providers = clean.providerResolutions.map((r) => r.provider);
  assert.ok(!providers.includes('google_sheets'),
    `google_sheets survived invariant: ${JSON.stringify(providers)}`);
});

test('strips chatbot from capabilities (AI forbidden)', () => {
  const contaminated = makeBrain(constraints, ['telegram'], ['send_message', 'receive_message', 'chatbot']);
  const clean = enforceHardConstraintsInvariant(contaminated);
  const caps = clean.capabilities.map((c) => c.key);
  assert.ok(!caps.includes('chatbot'),
    `chatbot survived invariant (AI should be forbidden): ${JSON.stringify(caps)}`);
});

// ── section 6: combined provider + capability clean state ─────────────────────

console.log('\nCombined invariant: clean brain has correct provider+capability sets');

test('clean brain: only telegram in providerResolutions', () => {
  const contaminated = makeBrain(
    constraints,
    ['telegram', 'whatsapp', 'supabase', 'google_sheets'],
    ['send_message', 'receive_message', 'monitoring', 'database_storage']
  );
  const clean = enforceHardConstraintsInvariant(contaminated);
  const providers = clean.providerResolutions.map((r) => r.provider);
  assert.deepStrictEqual(providers, ['telegram'],
    `Expected ["telegram"], got ${JSON.stringify(providers)}`);
});

test('clean brain: only send_message + receive_message in capabilities', () => {
  const contaminated = makeBrain(
    constraints,
    ['telegram'],
    ['send_message', 'receive_message', 'monitoring', 'database_storage', 'analytics', 'chatbot']
  );
  const clean = enforceHardConstraintsInvariant(contaminated);
  const caps = clean.capabilities.map((c) => c.key).sort();
  assert.deepStrictEqual(caps, ['receive_message', 'send_message'],
    `Expected ["receive_message","send_message"], got ${JSON.stringify(caps)}`);
});

test('clean brain: forbiddenProviders ∩ providerResolutions == []', () => {
  const contaminated = makeBrain(
    constraints,
    ['telegram', 'whatsapp', 'slack', 'supabase', 'openai', 'google_sheets'],
    ['send_message']
  );
  const clean = enforceHardConstraintsInvariant(contaminated);
  const resolvedProviders = new Set(clean.providerResolutions.map((r) => r.provider));
  for (const forbidden of clean.constraintContext.forbiddenProviders) {
    assert.ok(!resolvedProviders.has(forbidden),
      `INVARIANT VIOLATED: forbidden provider "${forbidden}" found in providerResolutions`);
  }
});

test('clean brain: forbiddenCapabilities ∩ capabilities == []', () => {
  const contaminated = makeBrain(
    constraints,
    ['telegram'],
    ['send_message', 'receive_message', 'monitoring', 'analytics', 'reporting', 'database_storage', 'chatbot', 'memory']
  );
  const clean = enforceHardConstraintsInvariant(contaminated);
  const capKeys = new Set(clean.capabilities.map((c) => c.key));
  for (const forbidden of clean.constraintContext.forbiddenCapabilities) {
    assert.ok(!capKeys.has(forbidden),
      `INVARIANT VIOLATED: forbidden capability "${forbidden}" found in capabilities`);
  }
});

// ── section 7: provider inference — PROVIDER_BY_CAPABILITY candidates gated ───

console.log('\nProvider inference regression: PROVIDER_BY_CAPABILITY candidates gated by identity lock');

// These are the exact candidate arrays from PROVIDER_BY_CAPABILITY in engine.ts.
// resolveProviders() calls filterProviders(candidates, constraints) as its FIRST step,
// before any exactMention/requiredProvider/fallback logic.
// If whatsapp survives filterProviders, it can reach providers[0] and enter providerResolutions.

test('receive_message candidates [telegram, whatsapp] → only telegram survives', () => {
  const result = filterProviders(['telegram', 'whatsapp'], constraints);
  assert.deepStrictEqual(result, ['telegram'],
    `WhatsApp leaked through receive_message candidates: ${JSON.stringify(result)}`);
});

test('send_message candidates [telegram, whatsapp, slack] → only telegram survives', () => {
  const result = filterProviders(['telegram', 'whatsapp', 'slack'], constraints);
  assert.deepStrictEqual(result, ['telegram'],
    `WhatsApp/Slack leaked through send_message candidates: ${JSON.stringify(result)}`);
});

test('customer_notifications candidates [whatsapp, email] → empty (neither in allowlist)', () => {
  const result = filterProviders(['whatsapp', 'email'], constraints);
  assert.deepStrictEqual(result, [],
    `customer_notifications candidates not fully blocked: ${JSON.stringify(result)}`);
});

test('whatsapp_sales candidates [whatsapp] → empty', () => {
  const result = filterProviders(['whatsapp'], constraints);
  assert.deepStrictEqual(result, [],
    `whatsapp_sales candidate not blocked: ${JSON.stringify(result)}`);
});

test('kitchen_alerts candidates [slack, whatsapp] → empty', () => {
  const result = filterProviders(['slack', 'whatsapp'], constraints);
  assert.deepStrictEqual(result, [],
    `kitchen_alerts candidates not fully blocked: ${JSON.stringify(result)}`);
});

test('voice_orders candidates [deepgram, whatsapp] → empty', () => {
  const result = filterProviders(['deepgram', 'whatsapp'], constraints);
  assert.deepStrictEqual(result, [],
    `voice_orders candidates not fully blocked: ${JSON.stringify(result)}`);
});

test('identity lock preconditions: allowedProviders non-empty + identityLocked=true', () => {
  // Both conditions are required to enforce the strict allowlist in filterProviders.
  // If allowedProviders is empty, the allowlist check is skipped entirely.
  // If identityLocked is false, resolveProviders can fall back to providers[0]=whatsapp.
  assert.ok(constraints.allowedProviders.length > 0,
    `allowedProviders must be non-empty to enforce allowlist filtering, got ${JSON.stringify(constraints.allowedProviders)}`);
  assert.strictEqual(constraints.identityLocked, true,
    `identityLocked must be true to gate providers[0] fallback in resolveProviders`);
});

test('receive_message resolution path: whatsapp never reaches providers[0] fallback', () => {
  // Simulate the first step of resolveProviders for receive_message:
  //   candidates = filterProviders(['telegram','whatsapp'], constraints)
  // With allowedProviders=['telegram'], whatsapp is excluded before fallback is considered.
  // identityLocked=true then blocks providers[0] as a second safety gate.
  const candidates = filterProviders(['telegram', 'whatsapp'], constraints);
  assert.ok(!candidates.includes('whatsapp'),
    `whatsapp in candidates before fallback: ${JSON.stringify(candidates)}`);
  assert.ok(candidates.includes('telegram'),
    `telegram missing from candidates: ${JSON.stringify(candidates)}`);
  // The identity-lock fallback guard: even if candidates were unexpected,
  // identityLocked=true means providers[0] path is skipped.
  assert.strictEqual(constraints.identityLocked, true,
    'identityLocked must be true as second guard against providers[0] fallback');
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
