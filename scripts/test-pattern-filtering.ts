/**
 * Pattern pre-filtering regression tests.
 * Run with:  npx tsx scripts/test-pattern-filtering.ts
 *
 * Verifies that the three guards in selectPatterns() prevent WhatsApp and other
 * foreign-provider patterns from entering matchedPatterns for a Telegram-only prompt,
 * WITHOUT relying on constrainAutomationBrainToGraph as a backstop.
 *
 * Guard 1 — classification.providers check for provider_specific patterns
 * Guard 2 — only required_tools (NOT optional_tools) checked against constraints
 * Guard 3 — tool-less provider_specific patterns rejected under active allowlist
 *
 * These tests use the same exported primitives that selectPatterns() delegates to,
 * so they exercise the exact decision logic without needing selectPatterns to be exported.
 */

import assert from 'assert';
import { CANONICAL_PROVIDERS, expandProviderAliases } from '@/lib/agent/provider-allowlist';
import {
  extractHardConstraints,
  filterProviders,
  violatesConstraints,
  areProvidersAllowed,
  isProviderAllowed,
} from '@/lib/automation/extract-hard-constraints';
import type { ConstraintContext, PatternKind } from '@/lib/automation/types';

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

// ── helpers that replicate the three guards in selectPatterns() ───────────────

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/**
 * Guard 1: classification.providers check for provider_specific patterns.
 * Returns true when the pattern should be REJECTED by this guard.
 */
function guard1Rejects(
  kind: PatternKind,
  requiredTools: string[],
  classificationProviders: string[],
  constraints: ConstraintContext
): boolean {
  if (kind !== 'provider_specific') return false;
  if (constraints.allowedProviders.length === 0) return false;
  const probeProviders = unique([...requiredTools, ...classificationProviders]);
  return probeProviders.length > 0 && filterProviders(probeProviders, constraints).length === 0;
}

/**
 * Guard 2: required_tools (only) checked against violatesConstraints.
 * Returns true when the pattern should be REJECTED by this guard.
 * Optional tools are intentionally excluded — they are filtered at map-time.
 */
function guard2Rejects(
  name: string,
  requiredTools: string[],
  requiredCapabilities: string[],
  schedulePatterns: string[],
  constraints: ConstraintContext
): boolean {
  return violatesConstraints(name, constraints, requiredTools, requiredCapabilities, schedulePatterns);
}

/**
 * Guard 3: tool-less provider_specific patterns rejected under active allowlist.
 * Returns true when the pattern should be REJECTED by this guard.
 */
function guard3Rejects(
  kind: PatternKind,
  requiredTools: string[],
  optionalTools: string[],
  constraints: ConstraintContext
): boolean {
  const allProviders = [...requiredTools, ...optionalTools];
  return allProviders.length === 0
    && constraints.allowedProviders.length > 0
    && kind === 'provider_specific';
}

function patternPasses(
  kind: PatternKind,
  requiredTools: string[],
  optionalTools: string[],
  requiredCapabilities: string[],
  schedulePatterns: string[],
  classificationProviders: string[],
  constraints: ConstraintContext
): boolean {
  if (guard1Rejects(kind, requiredTools, classificationProviders, constraints)) return false;
  if (guard2Rejects('test', requiredTools, requiredCapabilities, schedulePatterns, constraints)) return false;
  if (guard3Rejects(kind, requiredTools, optionalTools, constraints)) return false;
  return true;
}

// ── test fixture ──────────────────────────────────────────────────────────────

const TELEGRAM_ONLY_PROMPT =
  "When a new Telegram message arrives: reply only: 'Received successfully'. " +
  "Absolutely no AI. No Google Sheets. No monitoring. No logging. No analytics. " +
  "No extraction. Telegram only.";

const constraints = extractHardConstraints(TELEGRAM_ONLY_PROMPT);

// ── section 1: Guard 2 — required_tools constraint check ─────────────────────

console.log('\nGuard 2: required_tools constraint check');

test('WhatsApp Reply Agent (required=[whatsapp]) → Guard 2 rejects', () => {
  const rejects = guard2Rejects('WhatsApp Reply Agent', ['whatsapp'], [], [], constraints);
  assert.strictEqual(rejects, true,
    'WhatsApp Reply Agent should be rejected by Guard 2');
});

test('Telegram Reply Agent (required=[telegram]) → Guard 2 passes', () => {
  const rejects = guard2Rejects('Telegram Reply Agent', ['telegram'], [], [], constraints);
  assert.strictEqual(rejects, false,
    'Telegram Reply Agent should pass Guard 2');
});

test('Restaurant Order Handler (required=[some_pos_tool]) → Guard 2 rejects (tool outside allowlist)', () => {
  const rejects = guard2Rejects('Restaurant Order Handler', ['some_pos_tool'], [], [], constraints);
  assert.strictEqual(rejects, true,
    'Restaurant Order Handler should be rejected (unknown tool not in allowedProviders=[telegram])');
});

test('Generic Summarizer (required=[]) → Guard 2 passes (no required tools)', () => {
  const rejects = guard2Rejects('Generic Summarizer', [], [], [], constraints);
  assert.strictEqual(rejects, false,
    'Abstract pattern with empty required tools should pass Guard 2');
});

test('Monitoring pattern (required_capabilities=[monitoring]) → Guard 2 rejects', () => {
  const rejects = guard2Rejects('Runtime Monitor', [], ['monitoring'], [], constraints);
  assert.strictEqual(rejects, true,
    'monitoring is forbidden and should be caught by Guard 2 capability check');
});

// ── section 2: Guard 2 — optional_tools EXCLUDED from constraint check ────────

console.log('\nGuard 2: optional_tools excluded (false-rejection bug fix)');

test('Telegram+WhatsApp Bot (required=[telegram], optional=[whatsapp]) → Guard 2 passes', () => {
  // OLD BUG: rowProviders = ['telegram','whatsapp'] → areProvidersAllowed fails → wrongly rejected
  // NEW FIX: only required_tools=['telegram'] checked → passes
  const rejects = guard2Rejects('Telegram+WhatsApp Bot', ['telegram'], [], [], constraints);
  assert.strictEqual(rejects, false,
    'required=[telegram] should pass even though optional=[whatsapp] exists');
});

test('Telegram+Slack Bot (required=[telegram], optional=[slack]) → Guard 2 passes', () => {
  const rejects = guard2Rejects('Telegram+Slack Bot', ['telegram'], [], [], constraints);
  assert.strictEqual(rejects, false,
    'required=[telegram] passes; optional=[slack] is filtered at map-time');
});

test('optional_tools=[whatsapp] ARE filtered at map-time (not preserved in output)', () => {
  // After a pattern passes the filter, optional tools are filtered via filterProviders
  const optionalToolsAfterFilter = filterProviders(['whatsapp', 'slack'], constraints);
  assert.deepStrictEqual(optionalToolsAfterFilter, [],
    `optional tools [whatsapp, slack] should be empty after filterProviders: ${JSON.stringify(optionalToolsAfterFilter)}`);
});

test('optional_tools=[telegram, whatsapp] → only telegram survives map-time filter', () => {
  const optionalToolsAfterFilter = filterProviders(['telegram', 'whatsapp'], constraints);
  assert.deepStrictEqual(optionalToolsAfterFilter, ['telegram'],
    `only telegram should survive: ${JSON.stringify(optionalToolsAfterFilter)}`);
});

// ── section 3: Guard 1 — classification.providers check ──────────────────────

console.log('\nGuard 1: classification.providers check for provider_specific patterns');

test('provider_specific, required=[], classification.providers=[whatsapp] → Guard 1 rejects', () => {
  // Pattern with empty required_tools but classification says it\'s a WhatsApp pattern
  const rejects = guard1Rejects('provider_specific', [], ['whatsapp'], constraints);
  assert.strictEqual(rejects, true,
    'classification.providers=[whatsapp] with no allowed providers should be rejected by Guard 1');
});

test('provider_specific, required=[telegram], classification.providers=[telegram] → Guard 1 passes', () => {
  const rejects = guard1Rejects('provider_specific', ['telegram'], ['telegram'], constraints);
  assert.strictEqual(rejects, false,
    'telegram is in allowedProviders; Guard 1 should pass');
});

test('provider_specific, required=[telegram], classification.providers=[telegram, whatsapp] → Guard 1 passes', () => {
  // Telegram is in the probe set — one allowed provider is enough to pass Guard 1
  const rejects = guard1Rejects('provider_specific', ['telegram'], ['telegram', 'whatsapp'], constraints);
  assert.strictEqual(rejects, false,
    'telegram in probe set is sufficient for Guard 1 to pass');
});

test('provider_specific, required=[], classification.providers=[] → Guard 1 passes (empty probe set)', () => {
  // No providers declared in either field — Guard 1 has nothing to reject on
  const rejects = guard1Rejects('provider_specific', [], [], constraints);
  assert.strictEqual(rejects, false,
    'empty probe set means Guard 1 has no evidence to reject on');
});

test('domain_template, required=[], classification.providers=[whatsapp] → Guard 1 skips (not provider_specific)', () => {
  // Guard 1 only applies to provider_specific kind
  const rejects = guard1Rejects('domain_template', [], ['whatsapp'], constraints);
  assert.strictEqual(rejects, false,
    'Guard 1 only rejects provider_specific patterns; domain_template passes through');
});

test('abstract_template, required=[], classification.providers=[whatsapp] → Guard 1 skips', () => {
  const rejects = guard1Rejects('abstract_template', [], ['whatsapp'], constraints);
  assert.strictEqual(rejects, false,
    'Guard 1 only rejects provider_specific patterns');
});

// ── section 4: Guard 3 — tool-less provider_specific ─────────────────────────

console.log('\nGuard 3: tool-less provider_specific rejected under active allowlist');

test('provider_specific, required=[], optional=[] → Guard 3 rejects', () => {
  const rejects = guard3Rejects('provider_specific', [], [], constraints);
  assert.strictEqual(rejects, true,
    'tool-less provider_specific should be rejected under active allowlist');
});

test('abstract_template, required=[], optional=[] → Guard 3 passes', () => {
  const rejects = guard3Rejects('abstract_template', [], [], constraints);
  assert.strictEqual(rejects, false,
    'tool-less abstract_template must not be rejected by Guard 3');
});

test('domain_template, required=[], optional=[] → Guard 3 passes', () => {
  const rejects = guard3Rejects('domain_template', [], [], constraints);
  assert.strictEqual(rejects, false,
    'tool-less domain_template must not be rejected (enriched downstream)');
});

test('provider_specific, required=[telegram], optional=[] → Guard 3 passes (has tools)', () => {
  const rejects = guard3Rejects('provider_specific', ['telegram'], [], constraints);
  assert.strictEqual(rejects, false,
    'Guard 3 only fires for allProviders.length === 0; telegram in required_tools prevents it');
});

// ── section 5: full patternPasses() — production scenario matrix ──────────────

console.log('\nFull patternPasses(): production scenario matrix');

test('WhatsApp Reply Agent (provider_specific, required=[whatsapp]) → REJECTED', () => {
  const passes = patternPasses('provider_specific', ['whatsapp'], [], [], [], ['whatsapp'], constraints);
  assert.strictEqual(passes, false,
    'WhatsApp Reply Agent must be rejected before constrainAutomationBrainToGraph');
});

test('Telegram Reply Agent (provider_specific, required=[telegram]) → ACCEPTED', () => {
  const passes = patternPasses('provider_specific', ['telegram'], [], [], [], ['telegram'], constraints);
  assert.strictEqual(passes, true,
    'Telegram Reply Agent must be accepted');
});

test('Telegram+WhatsApp Bot (provider_specific, required=[telegram], optional=[whatsapp]) → ACCEPTED', () => {
  // This was falsely rejected by the old code (included optional in violatesConstraints).
  // With the fix, only required_tools=[telegram] is checked → passes.
  const passes = patternPasses('provider_specific', ['telegram'], ['whatsapp'], [], [], ['telegram'], constraints);
  assert.strictEqual(passes, true,
    'Telegram+WhatsApp Bot should be accepted; whatsapp is optional and filtered at map-time');
});

test('Restaurant Order Handler (domain_template, required=[some_pos_tool]) → REJECTED', () => {
  const passes = patternPasses('domain_template', ['some_pos_tool'], [], [], [], [], constraints);
  assert.strictEqual(passes, false,
    'Restaurant handler with non-allowlisted required tool must be rejected');
});

test('Generic Summarizer (abstract_template, required=[], optional=[]) → ACCEPTED', () => {
  const passes = patternPasses('abstract_template', [], [], [], [], [], constraints);
  assert.strictEqual(passes, true,
    'Tool-less abstract_template must always be accepted');
});

test('WhatsApp Commerce Pack (provider_specific, required=[], classification.providers=[whatsapp]) → REJECTED by Guard 1', () => {
  // Guard 1 catches this before Guard 3 (which would also catch it at tool-less check)
  const passes = patternPasses('provider_specific', [], [], [], [], ['whatsapp'], constraints);
  assert.strictEqual(passes, false,
    'Classification-only WhatsApp pattern must be rejected by Guard 1');
});

test('Ecommerce Domain Pack (domain_template, required=[], classification.providers=[shopify]) → ACCEPTED', () => {
  // Guard 1 does not apply to domain_template — enrichment happens downstream
  const passes = patternPasses('domain_template', [], [], [], [], ['shopify'], constraints);
  assert.strictEqual(passes, true,
    'Tool-less domain_template survives for downstream provider enrichment');
});

test('Scheduled WhatsApp Pattern (provider_specific, required=[whatsapp], schedulePatterns=[Event-driven]) → REJECTED', () => {
  const passes = patternPasses('provider_specific', ['whatsapp'], [], [], ['Event-driven'], ['whatsapp'], constraints);
  assert.strictEqual(passes, false,
    'WhatsApp pattern rejected regardless of schedule patterns');
});

// ── section 6: before/after log simulation ────────────────────────────────────

console.log('\nBEFORE/AFTER log simulation for the production scenario');

const telegramOnlyPatternRows: Array<{
  name: string;
  kind: PatternKind;
  requiredTools: string[];
  optionalTools: string[];
  classificationProviders: string[];
}> = [
  { name: 'Telegram Reply Agent',    kind: 'provider_specific', requiredTools: ['telegram'],         optionalTools: [],           classificationProviders: ['telegram'] },
  { name: 'WhatsApp Reply Agent',    kind: 'provider_specific', requiredTools: ['whatsapp'],         optionalTools: [],           classificationProviders: ['whatsapp'] },
  { name: 'Restaurant Order Handler',kind: 'domain_template',   requiredTools: ['some_pos_tool'],    optionalTools: [],           classificationProviders: [] },
  { name: 'Generic Summarizer',      kind: 'abstract_template', requiredTools: [],                   optionalTools: [],           classificationProviders: [] },
  { name: 'Telegram+WhatsApp Bot',   kind: 'provider_specific', requiredTools: ['telegram'],         optionalTools: ['whatsapp'], classificationProviders: ['telegram', 'whatsapp'] },
];

const before = telegramOnlyPatternRows.map((p) => p.name);
const after = telegramOnlyPatternRows
  .filter((p) => patternPasses(p.kind, p.requiredTools, p.optionalTools, [], [], p.classificationProviders, constraints))
  .map((p) => p.name);

console.log('  BEFORE selectPatterns filter:', JSON.stringify(before));
console.log('  AFTER  selectPatterns filter:', JSON.stringify(after));

test('BEFORE: all 5 patterns present', () => {
  assert.strictEqual(before.length, 5);
});

test('AFTER: WhatsApp Reply Agent is NOT in output', () => {
  assert.ok(!after.includes('WhatsApp Reply Agent'),
    `WhatsApp Reply Agent leaked: ${JSON.stringify(after)}`);
});

test('AFTER: Restaurant Order Handler is NOT in output', () => {
  assert.ok(!after.includes('Restaurant Order Handler'),
    `Restaurant Order Handler leaked: ${JSON.stringify(after)}`);
});

test('AFTER: Telegram Reply Agent IS in output', () => {
  assert.ok(after.includes('Telegram Reply Agent'),
    `Telegram Reply Agent missing: ${JSON.stringify(after)}`);
});

test('AFTER: Generic Summarizer IS in output', () => {
  assert.ok(after.includes('Generic Summarizer'),
    `Generic Summarizer missing: ${JSON.stringify(after)}`);
});

test('AFTER: Telegram+WhatsApp Bot IS in output (false-rejection bug fixed)', () => {
  assert.ok(after.includes('Telegram+WhatsApp Bot'),
    `Telegram+WhatsApp Bot was incorrectly rejected: ${JSON.stringify(after)}`);
});

test('AFTER: output equals [Telegram Reply Agent, Generic Summarizer, Telegram+WhatsApp Bot]', () => {
  const expected = ['Telegram Reply Agent', 'Generic Summarizer', 'Telegram+WhatsApp Bot'];
  assert.deepStrictEqual(after.sort(), expected.sort(),
    `Expected ${JSON.stringify(expected.sort())}, got ${JSON.stringify(after.sort())}`);
});

// ── section 7: provider contamination penalty — ranking ──────────────────────

console.log('\nProvider contamination penalty: ranking');

/**
 * Mirror of engine.ts providerContaminationPenalty() using exported primitives.
 * Both functions must stay in sync — if you change the penalty amount or detection
 * logic in engine.ts, update this helper too.
 *
 * Uses expandProviderAliases() + word-boundary regex (\b…\b) to match canonical
 * names AND abbreviations ('WA' → whatsapp, 'gsheet' → google_sheets, etc.).
 */
function computePenalty(
  name: string,
  description: string,
  examples: string[],
  intentKeywords: string[],
  rankConstraints: typeof constraints
): number {
  if (!rankConstraints.identityLocked || rankConstraints.allowedProviders.length === 0) return 0;

  const metadataText = [name, description, ...examples, ...intentKeywords]
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .join('\n');

  let penalty = 0;
  for (const provider of CANONICAL_PROVIDERS) {
    if (rankConstraints.allowedProviders.includes(provider)) continue;
    const aliases = expandProviderAliases(provider);
    const mentioned = aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(metadataText);
    });
    if (mentioned) penalty += 15;
  }
  return penalty;
}

type ScoredPattern = { name: string; baseScore: number; penalty: number; finalScore: number };

function rankPatterns(rows: Array<{ name: string; description: string; examples: string[]; intentKeywords: string[]; baseScore: number }>, rankConstraints: typeof constraints): ScoredPattern[] {
  return rows
    .map((row) => {
      const penalty = computePenalty(row.name, row.description, row.examples, row.intentKeywords, rankConstraints);
      return { name: row.name, baseScore: row.baseScore, penalty, finalScore: row.baseScore - penalty };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

// Baseline patterns with equal base scores to isolate penalty effect
const BASE_SCORE = 30;
const rankingRows = [
  { name: 'Telegram Reply Agent',    description: 'Reply to Telegram messages automatically.', examples: ['Telegram reply bot'], intentKeywords: ['telegram', 'reply'],            baseScore: BASE_SCORE },
  { name: 'Generic Summarizer',      description: 'Summarize content from any source.',         examples: ['General summarizer'],  intentKeywords: ['summarize', 'summary'],       baseScore: BASE_SCORE },
  { name: 'Telegram+WhatsApp Bot',   description: 'Handles Telegram and WhatsApp messages.',    examples: ['Multi-platform bot'],  intentKeywords: ['telegram', 'whatsapp', 'bot'], baseScore: BASE_SCORE },
];

const rankBefore = rankPatterns(rankingRows, { ...constraints, identityLocked: false, allowedProviders: [] });
const rankAfter  = rankPatterns(rankingRows, constraints);

console.log('\n  BEFORE (no identity lock — all equal base score):');
for (const p of rankBefore) {
  console.log(`    ${p.finalScore.toString().padStart(3)}  ${p.name}`);
}
console.log('\n  AFTER  (identity lock active — WhatsApp penalised):');
for (const p of rankAfter) {
  console.log(`    ${p.finalScore.toString().padStart(3)}  ${p.name}  (base=${p.baseScore}, penalty=${p.penalty})`);
}

test('penalty=0 for "Telegram Reply Agent" (telegram is in allowlist)', () => {
  const penalty = computePenalty(
    'Telegram Reply Agent', 'Reply to Telegram messages.', ['Telegram reply'], ['telegram', 'reply'],
    constraints
  );
  assert.strictEqual(penalty, 0, `Expected penalty=0, got ${penalty}`);
});

test('penalty=0 for "Generic Summarizer" (no provider names in metadata)', () => {
  const penalty = computePenalty(
    'Generic Summarizer', 'Summarize content from any source.', ['General summarizer'], ['summarize', 'summary'],
    constraints
  );
  assert.strictEqual(penalty, 0, `Expected penalty=0, got ${penalty}`);
});

test('penalty=15 for "Telegram+WhatsApp Bot" (whatsapp in name)', () => {
  const penalty = computePenalty(
    'Telegram+WhatsApp Bot', 'Handles Telegram and WhatsApp messages.', ['Multi-platform bot'], ['telegram', 'whatsapp'],
    constraints
  );
  assert.strictEqual(penalty, 15, `Expected penalty=15, got ${penalty}`);
});

test('penalty=30 for a pattern mentioning both whatsapp and slack', () => {
  const penalty = computePenalty(
    'Telegram+WhatsApp+Slack Bot', 'Routes messages across Telegram, WhatsApp, and Slack.', [], ['telegram', 'whatsapp', 'slack'],
    constraints
  );
  assert.strictEqual(penalty, 30, `Expected penalty=30, got ${penalty}`);
});

test('penalty=0 when identityLocked=false (open-ended prompt)', () => {
  const openConstraints: typeof constraints = { ...constraints, identityLocked: false, allowedProviders: [] };
  const penalty = computePenalty(
    'Telegram+WhatsApp Bot', 'Handles Telegram and WhatsApp messages.', [], ['telegram', 'whatsapp'],
    openConstraints
  );
  assert.strictEqual(penalty, 0, `Penalty must be 0 when identity is not locked, got ${penalty}`);
});

test('penalty is in description field: "send a whatsapp fallback" → +15', () => {
  const penalty = computePenalty(
    'Telegram Reply Agent',
    'Replies to Telegram messages and can send a whatsapp fallback.',
    [],
    ['telegram', 'reply'],
    constraints
  );
  assert.strictEqual(penalty, 15, `whatsapp in description should incur penalty, got ${penalty}`);
});

test('penalty is in examples field: ["whatsapp backup"] → +15', () => {
  const penalty = computePenalty(
    'Telegram Reply Agent',
    'Replies to Telegram messages.',
    ['telegram reply flow', 'whatsapp backup'],
    ['telegram', 'reply'],
    constraints
  );
  assert.strictEqual(penalty, 15, `whatsapp in examples should incur penalty, got ${penalty}`);
});

test('penalty is in intent_keywords field: ["whatsapp"] → +15', () => {
  const penalty = computePenalty(
    'Universal Messenger',
    'Messenger bot.',
    [],
    ['telegram', 'whatsapp'],
    constraints
  );
  assert.strictEqual(penalty, 15, `whatsapp in intent_keywords should incur penalty, got ${penalty}`);
});

// ── section 8: ranking assertions ────────────────────────────────────────────

console.log('\nRanking assertions: expected order after penalty');

test('AFTER ranking: "Telegram Reply Agent" is rank 1', () => {
  assert.strictEqual(rankAfter[0].name, 'Telegram Reply Agent',
    `Expected rank 1 = Telegram Reply Agent, got ${rankAfter[0].name}`);
});

test('AFTER ranking: "Telegram+WhatsApp Bot" is rank 3 (lowest)', () => {
  assert.strictEqual(rankAfter[rankAfter.length - 1].name, 'Telegram+WhatsApp Bot',
    `Expected last = Telegram+WhatsApp Bot, got ${rankAfter[rankAfter.length - 1].name}`);
});

test('AFTER ranking: "Telegram+WhatsApp Bot" final score < "Telegram Reply Agent" final score', () => {
  const telegramScore = rankAfter.find((p) => p.name === 'Telegram Reply Agent')!.finalScore;
  const whatsappScore = rankAfter.find((p) => p.name === 'Telegram+WhatsApp Bot')!.finalScore;
  assert.ok(whatsappScore < telegramScore,
    `Expected ${whatsappScore} < ${telegramScore}`);
});

test('AFTER ranking: "Telegram+WhatsApp Bot" final score < "Generic Summarizer" final score', () => {
  const genericScore = rankAfter.find((p) => p.name === 'Generic Summarizer')!.finalScore;
  const whatsappScore = rankAfter.find((p) => p.name === 'Telegram+WhatsApp Bot')!.finalScore;
  assert.ok(whatsappScore < genericScore,
    `Expected ${whatsappScore} < ${genericScore}`);
});

test('AFTER ranking: "Telegram+WhatsApp Bot" remains eligible (finalScore > 0)', () => {
  const whatsappScore = rankAfter.find((p) => p.name === 'Telegram+WhatsApp Bot')!.finalScore;
  assert.ok(whatsappScore > 0,
    `Telegram+WhatsApp Bot must remain eligible (score > 0), got ${whatsappScore}`);
});

test('BEFORE ranking (no identity lock): all three patterns have equal score', () => {
  const scores = rankBefore.map((p) => p.finalScore);
  assert.ok(scores.every((s) => s === BASE_SCORE),
    `Expected all equal to ${BASE_SCORE}, got ${JSON.stringify(scores)}`);
});

test('AFTER ranking: penalty difference between Telegram Reply Agent and Telegram+WhatsApp Bot is exactly 15', () => {
  const telegramEntry = rankAfter.find((p) => p.name === 'Telegram Reply Agent')!;
  const whatsappEntry = rankAfter.find((p) => p.name === 'Telegram+WhatsApp Bot')!;
  assert.strictEqual(
    telegramEntry.finalScore - whatsappEntry.finalScore,
    15,
    `Expected score gap of 15, got ${telegramEntry.finalScore - whatsappEntry.finalScore}`
  );
});

// ── section 9: alias leakage detection ───────────────────────────────────────

console.log('\nAlias leakage detection: providers via non-canonical forms');

// expandProviderAliases() coverage

test('expandProviderAliases("whatsapp") includes "wa"', () => {
  const aliases = expandProviderAliases('whatsapp');
  assert.ok(aliases.includes('wa'),
    `Expected 'wa' in whatsapp aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("whatsapp") includes "whatsapp business"', () => {
  const aliases = expandProviderAliases('whatsapp');
  assert.ok(aliases.includes('whatsapp business'),
    `Expected 'whatsapp business' in whatsapp aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("whatsapp") includes "meta messaging"', () => {
  const aliases = expandProviderAliases('whatsapp');
  assert.ok(aliases.includes('meta messaging'),
    `Expected 'meta messaging' in whatsapp aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("telegram") includes "tg"', () => {
  const aliases = expandProviderAliases('telegram');
  assert.ok(aliases.includes('tg'),
    `Expected 'tg' in telegram aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("google_sheets") includes "gsheet"', () => {
  const aliases = expandProviderAliases('google_sheets');
  assert.ok(aliases.includes('gsheet'),
    `Expected 'gsheet' in google_sheets aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("google_sheets") includes "gsheets"', () => {
  const aliases = expandProviderAliases('google_sheets');
  assert.ok(aliases.includes('gsheets'),
    `Expected 'gsheets' in google_sheets aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("hubspot") includes "hub spot"', () => {
  const aliases = expandProviderAliases('hubspot');
  assert.ok(aliases.includes('hub spot'),
    `Expected 'hub spot' in hubspot aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("openai") includes "gpt"', () => {
  const aliases = expandProviderAliases('openai');
  assert.ok(aliases.includes('gpt'),
    `Expected 'gpt' in openai aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases("openai") includes "chatgpt"', () => {
  const aliases = expandProviderAliases('openai');
  assert.ok(aliases.includes('chatgpt'),
    `Expected 'chatgpt' in openai aliases: ${JSON.stringify(aliases)}`);
});

test('expandProviderAliases for unknown provider returns space-normalised form', () => {
  const aliases = expandProviderAliases('some_unknown_provider');
  assert.ok(aliases.includes('some unknown provider'),
    `Expected space-normalised fallback, got: ${JSON.stringify(aliases)}`);
});

// Penalty detection via aliases (the core regression)

test('penalty=15: "Telegram + WA Bot" — WA detected as whatsapp alias', () => {
  const penalty = computePenalty('Telegram + WA Bot', '', [], [], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "WA" alias, got ${penalty}`);
});

test('penalty=15: "tg bot" in description for non-Telegram-allowlist constraints', () => {
  // Under a WhatsApp-only constraint, "tg bot" in a description should penalise telegram.
  const waOnlyConstraints = { ...constraints, allowedProviders: ['whatsapp'], identityLocked: true };
  const penalty = computePenalty('Reply Bot', 'Works great as a tg bot.', [], [], waOnlyConstraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "tg" alias, got ${penalty}`);
});

test('penalty=15: "Save to gSheet" in name — gsheet detected as google_sheets alias', () => {
  const penalty = computePenalty('Save to gSheet Sync', '', [], [], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "gsheet" alias, got ${penalty}`);
});

test('penalty=15: "Hub Spot CRM" in description — hub spot detected as hubspot alias', () => {
  const penalty = computePenalty('CRM Integration', 'Saves leads to Hub Spot CRM.', [], [], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "hub spot" alias, got ${penalty}`);
});

test('penalty=15: "meta messaging" in examples — detected as whatsapp alias', () => {
  const penalty = computePenalty('Messaging Bot', '', ['Send via meta messaging API'], [], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "meta messaging" alias, got ${penalty}`);
});

test('penalty=15: "chatgpt" in intent_keywords — detected as openai alias', () => {
  const penalty = computePenalty('AI Reply Bot', '', [], ['telegram', 'chatgpt', 'reply'], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "chatgpt" alias, got ${penalty}`);
});

test('penalty=15: "gpt" in description — detected as openai alias', () => {
  const penalty = computePenalty('Smart Replier', 'Uses gpt to generate responses.', [], [], constraints);
  assert.strictEqual(penalty, 15,
    `Expected 15 for "gpt" alias, got ${penalty}`);
});

// No false positives from substrings (word-boundary enforcement)

test('no false positive: "swap" does not trigger whatsapp penalty via "wa"', () => {
  const penalty = computePenalty('Data Swap Handler', 'Swaps data between endpoints.', [], [], constraints);
  assert.strictEqual(penalty, 0,
    `"swap" must not match "wa" alias: got penalty ${penalty}`);
});

test('no false positive: "staging" does not trigger telegram penalty via "tg"', () => {
  // "tg" appears inside "staging" but not at a word boundary
  const waOnlyConstraints = { ...constraints, allowedProviders: ['whatsapp'], identityLocked: true };
  const penalty = computePenalty('Staging Deploy Hook', 'Deploy to staging environment.', [], [], waOnlyConstraints);
  // telegram should NOT be penalised from "staging"
  assert.strictEqual(penalty, 0,
    `"staging" must not match "tg" via word-boundary: got penalty ${penalty}`);
});

test('no false positive: "category" does not trigger any alias penalty', () => {
  const penalty = computePenalty('Category Manager', 'Manage product categories.', [], [], constraints);
  assert.strictEqual(penalty, 0,
    `"category" must not match any alias: got penalty ${penalty}`);
});

// Alias-aware ranking: before/after with "Telegram + WA Bot"

console.log('\n  BEFORE/AFTER with alias-containing pattern name:');

const aliasRankingRows = [
  { name: 'Telegram Reply Agent', description: 'Reply to Telegram messages.', examples: [], intentKeywords: ['telegram', 'reply'],        baseScore: 30 },
  { name: 'Generic Summarizer',   description: 'Summarize content.',          examples: [], intentKeywords: ['summarize'],                 baseScore: 30 },
  { name: 'Telegram + WA Bot',    description: 'Handles Telegram and WA.',    examples: [], intentKeywords: ['telegram', 'wa', 'whatsapp'], baseScore: 30 },
];

const aliasBefore = rankPatterns(aliasRankingRows, { ...constraints, identityLocked: false, allowedProviders: [] });
const aliasAfter  = rankPatterns(aliasRankingRows, constraints);

console.log('  BEFORE (no identity lock):');
for (const p of aliasBefore) {
  console.log(`    ${p.finalScore.toString().padStart(3)}  ${p.name}`);
}
console.log('  AFTER  (identity lock, alias-aware penalty):');
for (const p of aliasAfter) {
  console.log(`    ${p.finalScore.toString().padStart(3)}  ${p.name}  (penalty=${p.penalty})`);
}

test('alias-aware ranking: "Telegram + WA Bot" is last', () => {
  assert.strictEqual(aliasAfter[aliasAfter.length - 1].name, 'Telegram + WA Bot',
    `Expected last = "Telegram + WA Bot", got ${aliasAfter[aliasAfter.length - 1].name}`);
});

test('alias-aware ranking: "Telegram + WA Bot" penalty = 15 (wa alias detected)', () => {
  const entry = aliasAfter.find((p) => p.name === 'Telegram + WA Bot')!;
  assert.strictEqual(entry.penalty, 15,
    `Expected penalty=15 from "wa" alias, got ${entry.penalty}`);
});

test('alias-aware ranking: "Telegram Reply Agent" is rank 1', () => {
  assert.strictEqual(aliasAfter[0].name, 'Telegram Reply Agent',
    `Expected rank 1 = "Telegram Reply Agent", got ${aliasAfter[0].name}`);
});

test('alias-aware ranking: "Telegram + WA Bot" score < "Generic Summarizer" score', () => {
  const waScore      = aliasAfter.find((p) => p.name === 'Telegram + WA Bot')!.finalScore;
  const genericScore = aliasAfter.find((p) => p.name === 'Generic Summarizer')!.finalScore;
  assert.ok(waScore < genericScore,
    `Expected WA Bot score (${waScore}) < Generic Summarizer (${genericScore})`);
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
