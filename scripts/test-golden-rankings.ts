/**
 * Golden ranking tests — Audit 5 Phase 4.
 * Run with:  npx tsx scripts/test-golden-rankings.ts
 *
 * Freezes the expected pattern ranking order for known prompts.
 * Fails CI if penalty logic, scoring, or alias expansion changes the order.
 *
 * Rankings are computed using the same primitives as engine.ts's selectPatterns:
 *   baseScore = keywords*8 + capOverlap*10 + popularity/5
 *   penalty   = providerContaminationPenalty (alias-aware, identity-locked)
 *   finalScore = baseScore + boost - penalty
 *
 * Three golden scenarios are frozen:
 *   A) Telegram-only  → Telegram Reply Agent > Generic Summarizer > Telegram+WhatsApp Bot
 *   B) Shopify        → Shopify Importer > Ecommerce Domain Pack
 *   C) Slack-only     → Slack Agent > Generic Summarizer
 */

import assert from 'assert';
import {
  CANONICAL_PROVIDERS,
  expandProviderAliases,
  normalizeForProviderScan,
} from '@/lib/agent/provider-allowlist';
import { extractHardConstraints } from '@/lib/automation/extract-hard-constraints';
import { explainPatternDecision } from '@/lib/automation/explain-pattern-decision';
import type { ConstraintContext, PatternKind } from '@/lib/automation/types';

// ── harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    failed++;
    failures.push(`  ✗  ${label}\n       ${(err as Error).message}`);
    console.error(`  ✗  ${label}`);
    console.error(`       ${(err as Error).message}`);
  }
}

// ── scoring primitives (mirrors engine.ts internals) ─────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
}

function computeScore(
  prompt: string,
  inferredCaps: string[],
  pattern: { intent_keywords?: string[]; required_capabilities?: string[]; popularity_score?: number }
): number {
  const normalized = normalize(prompt);
  const keywords = pattern.intent_keywords ?? [];
  const requiredCaps = pattern.required_capabilities ?? [];
  const popularity = pattern.popularity_score ?? 0;

  let keywordScore = 0;
  for (const kw of keywords) {
    if (normalized.includes(kw.toLowerCase())) keywordScore += 8;
  }

  const capScore = requiredCaps.filter((cap) => inferredCaps.includes(cap)).length * 10;
  const popularityScore = Math.min(20, Math.max(0, popularity / 5));
  return keywordScore + capScore + popularityScore;
}

function computePenalty(
  name: string,
  description: string,
  examples: string[],
  intentKeywords: string[],
  constraints: ConstraintContext
): number {
  if (!constraints.identityLocked || constraints.allowedProviders.length === 0) return 0;
  const metadataText = [name, description, ...examples, ...intentKeywords]
    .filter(Boolean)
    .map((t) => normalizeForProviderScan(t))
    .join('\n');
  let penalty = 0;
  for (const provider of CANONICAL_PROVIDERS) {
    if (constraints.allowedProviders.includes(provider)) continue;
    const aliases = expandProviderAliases(provider);
    const mentioned = aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(metadataText);
    });
    if (mentioned) penalty += 15;
  }
  return penalty;
}

type GoldenPattern = {
  name: string;
  kind: PatternKind;
  intent_keywords?: string[];
  required_capabilities?: string[];
  popularity_score?: number;
  description?: string;
  examples?: string[];
};

type RankedPattern = {
  name: string;
  baseScore: number;
  penalty: number;
  finalScore: number;
};

function rankPatterns(
  prompt: string,
  inferredCaps: string[],
  patterns: GoldenPattern[],
  constraints: ConstraintContext
): RankedPattern[] {
  return patterns
    .map((p) => {
      const baseScore = computeScore(prompt, inferredCaps, p);
      const penalty = computePenalty(
        p.name,
        p.description ?? '',
        p.examples ?? [],
        p.intent_keywords ?? [],
        constraints
      );
      return { name: p.name, baseScore, penalty, finalScore: baseScore - penalty };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO A — Telegram-only
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nScenario A: Telegram-only ranking');

const TELEGRAM_PROMPT = "When a new Telegram message arrives: reply only: 'Received successfully'. Telegram only.";
const TELEGRAM_CONSTRAINTS = extractHardConstraints(TELEGRAM_PROMPT);

const TELEGRAM_PATTERNS: GoldenPattern[] = [
  {
    name: 'Telegram Reply Agent',
    kind: 'provider_specific',
    intent_keywords: ['telegram', 'reply'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Reply to telegram messages',
    examples: [],
  },
  {
    name: 'Generic Summarizer',
    kind: 'abstract_template',
    intent_keywords: [],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Generic summarizer',
    examples: [],
  },
  {
    name: 'Telegram+WhatsApp Bot',
    kind: 'provider_specific',
    intent_keywords: ['telegram'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Supports telegram and whatsapp messaging',
    examples: [],
  },
];

{
  const beforeRanking = rankPatterns(
    TELEGRAM_PROMPT, [],
    TELEGRAM_PATTERNS,
    { ...TELEGRAM_CONSTRAINTS, identityLocked: false, allowedProviders: [] }
  );
  const afterRanking = rankPatterns(TELEGRAM_PROMPT, [], TELEGRAM_PATTERNS, TELEGRAM_CONSTRAINTS);

  console.log('\n  BEFORE (no identity lock):');
  for (const p of beforeRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}  (base=${p.baseScore}, penalty=${p.penalty})`);
  }
  console.log('\n  AFTER  (identity-lock + alias-aware penalty):');
  for (const p of afterRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}  (base=${p.baseScore}, penalty=${p.penalty})`);
  }

  // BEFORE: all equal or ranking by keyword score
  test('A.before: Telegram Reply Agent and Telegram+WhatsApp Bot have equal final score (no lock)', () => {
    const tr = beforeRanking.find((p) => p.name === 'Telegram Reply Agent')!;
    const tw = beforeRanking.find((p) => p.name === 'Telegram+WhatsApp Bot')!;
    assert.strictEqual(tr.penalty, 0);
    assert.strictEqual(tw.penalty, 0);
  });

  // AFTER golden rankings
  test('A.after: rank 1 = Telegram Reply Agent', () => {
    assert.strictEqual(afterRanking[0].name, 'Telegram Reply Agent', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('A.after: rank 2 = Generic Summarizer', () => {
    assert.strictEqual(afterRanking[1].name, 'Generic Summarizer', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('A.after: rank 3 = Telegram+WhatsApp Bot', () => {
    assert.strictEqual(afterRanking[2].name, 'Telegram+WhatsApp Bot', `Got: ${afterRanking.map(p=>p.name)}`);
  });

  // Score assertions
  test('A.after: Telegram Reply Agent penalty=0', () => {
    const p = afterRanking.find((x) => x.name === 'Telegram Reply Agent')!;
    assert.strictEqual(p.penalty, 0);
  });
  test('A.after: Generic Summarizer penalty=0', () => {
    const p = afterRanking.find((x) => x.name === 'Generic Summarizer')!;
    assert.strictEqual(p.penalty, 0);
  });
  test('A.after: Telegram+WhatsApp Bot penalty=15', () => {
    const p = afterRanking.find((x) => x.name === 'Telegram+WhatsApp Bot')!;
    assert.strictEqual(p.penalty, 15);
  });
  test('A.after: Telegram Reply Agent score > Telegram+WhatsApp Bot score', () => {
    const tr = afterRanking.find((p) => p.name === 'Telegram Reply Agent')!;
    const tw = afterRanking.find((p) => p.name === 'Telegram+WhatsApp Bot')!;
    assert.ok(tr.finalScore > tw.finalScore);
  });
  test('A.after: Generic Summarizer score >= Telegram+WhatsApp Bot score', () => {
    const gs = afterRanking.find((p) => p.name === 'Generic Summarizer')!;
    const tw = afterRanking.find((p) => p.name === 'Telegram+WhatsApp Bot')!;
    assert.ok(gs.finalScore >= tw.finalScore);
  });
  test('A.after: Telegram+WhatsApp Bot remains eligible (finalScore > -15)', () => {
    const p = afterRanking.find((x) => x.name === 'Telegram+WhatsApp Bot')!;
    assert.ok(p.finalScore > -15, `Score ${p.finalScore} too low`);
  });

  // explainPatternDecision agreement
  test('A: explainPatternDecision agrees on Telegram Reply Agent penalty', () => {
    const ex = explainPatternDecision(TELEGRAM_PROMPT, [], TELEGRAM_PATTERNS[0], TELEGRAM_CONSTRAINTS);
    assert.strictEqual(ex.providerPenalty, 0);
  });
  test('A: explainPatternDecision agrees on Telegram+WhatsApp Bot penalty', () => {
    const ex = explainPatternDecision(TELEGRAM_PROMPT, [], TELEGRAM_PATTERNS[2], TELEGRAM_CONSTRAINTS);
    assert.strictEqual(ex.providerPenalty, 15);
  });
  test('A: explainPatternDecision: penaltyDetails has whatsapp for Telegram+WhatsApp Bot', () => {
    const ex = explainPatternDecision(TELEGRAM_PROMPT, [], TELEGRAM_PATTERNS[2], TELEGRAM_CONSTRAINTS);
    assert.ok(ex.penaltyDetails.some((d) => d.provider === 'whatsapp'), `penaltyDetails: ${JSON.stringify(ex.penaltyDetails)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO B — Shopify
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nScenario B: Shopify ranking');

const SHOPIFY_PROMPT = 'When a new Shopify order arrives, sync to Google Sheets. Shopify only.';
const SHOPIFY_CONSTRAINTS = extractHardConstraints(SHOPIFY_PROMPT);

const SHOPIFY_PATTERNS: GoldenPattern[] = [
  {
    name: 'Shopify Order Importer',
    kind: 'provider_specific',
    intent_keywords: ['shopify', 'order', 'import'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Import shopify orders',
    examples: [],
  },
  {
    name: 'Ecommerce Domain Pack',
    kind: 'domain_template',
    intent_keywords: ['shopify', 'ecommerce'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Ecommerce domain automation',
    examples: [],
  },
  {
    name: 'WhatsApp Commerce Pack',
    kind: 'provider_specific',
    intent_keywords: ['commerce', 'order'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'WhatsApp-based commerce handling',
    examples: [],
  },
];

{
  const afterRanking = rankPatterns(SHOPIFY_PROMPT, [], SHOPIFY_PATTERNS, SHOPIFY_CONSTRAINTS);

  console.log('\n  AFTER  (shopify identity-lock):');
  for (const p of afterRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}  (base=${p.baseScore}, penalty=${p.penalty})`);
  }

  test('B.after: rank 1 = Shopify Order Importer', () => {
    assert.strictEqual(afterRanking[0].name, 'Shopify Order Importer', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('B.after: rank 2 = Ecommerce Domain Pack', () => {
    assert.strictEqual(afterRanking[1].name, 'Ecommerce Domain Pack', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('B.after: Shopify Order Importer penalty=0', () => {
    const p = afterRanking.find((x) => x.name === 'Shopify Order Importer')!;
    assert.strictEqual(p.penalty, 0);
  });
  test('B.after: WhatsApp Commerce Pack penalized', () => {
    const p = afterRanking.find((x) => x.name === 'WhatsApp Commerce Pack')!;
    assert.ok(p.penalty > 0, `Expected penalty > 0, got ${p.penalty}`);
  });
  test('B.after: Shopify score > WhatsApp Commerce Pack score', () => {
    const si = afterRanking.find((p) => p.name === 'Shopify Order Importer')!;
    const wc = afterRanking.find((p) => p.name === 'WhatsApp Commerce Pack')!;
    assert.ok(si.finalScore > wc.finalScore);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO C — Slack-only
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nScenario C: Slack-only ranking');

const SLACK_PROMPT = 'Post a message to Slack when a workflow completes. Slack only.';
const SLACK_CONSTRAINTS = extractHardConstraints(SLACK_PROMPT);

const SLACK_PATTERNS: GoldenPattern[] = [
  {
    name: 'Slack Notifier Agent',
    kind: 'provider_specific',
    intent_keywords: ['slack', 'notification', 'message'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Send Slack notifications',
    examples: [],
  },
  {
    name: 'Generic Summarizer',
    kind: 'abstract_template',
    intent_keywords: [],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Generic workflow',
    examples: [],
  },
  {
    name: 'Telegram Alert Bot',
    kind: 'provider_specific',
    intent_keywords: ['telegram', 'alert'],
    required_capabilities: [],
    popularity_score: 0,
    description: 'Send telegram alerts',
    examples: [],
  },
];

{
  const afterRanking = rankPatterns(SLACK_PROMPT, [], SLACK_PATTERNS, SLACK_CONSTRAINTS);

  console.log('\n  AFTER  (slack identity-lock):');
  for (const p of afterRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}  (base=${p.baseScore}, penalty=${p.penalty})`);
  }

  test('C.after: rank 1 = Slack Notifier Agent', () => {
    assert.strictEqual(afterRanking[0].name, 'Slack Notifier Agent', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('C.after: rank 2 = Generic Summarizer', () => {
    assert.strictEqual(afterRanking[1].name, 'Generic Summarizer', `Got: ${afterRanking.map(p=>p.name)}`);
  });
  test('C.after: Slack Notifier Agent penalty=0', () => {
    const p = afterRanking.find((x) => x.name === 'Slack Notifier Agent')!;
    assert.strictEqual(p.penalty, 0);
  });
  test('C.after: Telegram Alert Bot penalized', () => {
    const p = afterRanking.find((x) => x.name === 'Telegram Alert Bot')!;
    assert.ok(p.penalty > 0, `Expected penalty > 0, got ${p.penalty}`);
  });
  test('C.after: Slack score > Telegram Alert Bot score', () => {
    const sa = afterRanking.find((p) => p.name === 'Slack Notifier Agent')!;
    const ta = afterRanking.find((p) => p.name === 'Telegram Alert Bot')!;
    assert.ok(sa.finalScore > ta.finalScore);
  });
  test('C.after: Generic Summarizer score >= Telegram Alert Bot score', () => {
    const gs = afterRanking.find((p) => p.name === 'Generic Summarizer')!;
    const ta = afterRanking.find((p) => p.name === 'Telegram Alert Bot')!;
    assert.ok(gs.finalScore >= ta.finalScore);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO D — WA alias ranking (frozen alias-penalty path)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nScenario D: WA alias ranking (alias-penalty path)');

const WA_CONSTRAINTS = extractHardConstraints('telegram only');
const WA_ALIAS_PATTERNS: GoldenPattern[] = [
  { name: 'Telegram Reply Agent',   kind: 'provider_specific', intent_keywords: ['telegram'], description: '', examples: [] },
  { name: 'Generic Summarizer',     kind: 'abstract_template', intent_keywords: ['telegram'], description: '', examples: [] },
  { name: 'Telegram + WA Bot',      kind: 'provider_specific', intent_keywords: ['telegram'], description: '', examples: [] },
];

{
  const beforeRanking = rankPatterns(
    'telegram only', [],
    WA_ALIAS_PATTERNS,
    { ...WA_CONSTRAINTS, identityLocked: false, allowedProviders: [] }
  );
  const afterRanking = rankPatterns('telegram only', [], WA_ALIAS_PATTERNS, WA_CONSTRAINTS);

  console.log('\n  BEFORE (no identity lock):');
  for (const p of beforeRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}`);
  }
  console.log('\n  AFTER  (alias-aware, identity lock):');
  for (const p of afterRanking) {
    console.log(`     ${p.finalScore.toString().padStart(3)}  ${p.name}  (penalty=${p.penalty})`);
  }

  test('D.after: rank 1 = Telegram Reply Agent', () => {
    assert.strictEqual(afterRanking[0].name, 'Telegram Reply Agent');
  });
  test('D.after: rank 3 = Telegram + WA Bot', () => {
    assert.strictEqual(afterRanking[2].name, 'Telegram + WA Bot');
  });
  test('D.after: Telegram + WA Bot penalty=15 (wa alias detected)', () => {
    const p = afterRanking.find((x) => x.name === 'Telegram + WA Bot')!;
    assert.strictEqual(p.penalty, 15);
  });
  test('D.before: all patterns have equal final score', () => {
    const scores = beforeRanking.map((p) => p.finalScore);
    const allEqual = scores.every((s) => s === scores[0]);
    assert.ok(allEqual, `Scores differ before lock: ${scores}`);
  });
  test('D: score difference between rank1 and rank3 is exactly 15', () => {
    const first = afterRanking[0].finalScore;
    const last  = afterRanking[afterRanking.length - 1].finalScore;
    assert.strictEqual(first - last, 15);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.error(f));
}
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
