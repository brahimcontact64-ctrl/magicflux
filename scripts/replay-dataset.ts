/**
 * Replay dataset — Audit 5 Phase 2.
 * Run with:  npx tsx scripts/replay-dataset.ts
 *
 * Saves a set of reference fixtures to scripts/replay-fixtures.json, then
 * re-runs the same prompts through the in-memory pipeline and verifies the
 * output is identical. Run after any change to the constraint / penalty /
 * normalization pipeline to detect unintended regressions.
 *
 * Structure:
 *   { prompt, constraints, providerFilterResults, penaltyResults, timestamp }
 *
 * Usage:
 *   npx tsx scripts/replay-dataset.ts          — generate + verify
 *   npx tsx scripts/replay-dataset.ts --save   — (re)generate fixtures only
 *   npx tsx scripts/replay-dataset.ts --verify — verify against saved fixtures
 */

import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  CANONICAL_PROVIDERS,
  expandProviderAliases,
  normalizeForProviderScan,
} from '@/lib/agent/provider-allowlist';
import {
  extractHardConstraints,
  filterProviders,
  filterCapabilities,
} from '@/lib/automation/extract-hard-constraints';
import type { ConstraintContext } from '@/lib/automation/types';

const FIXTURES_PATH = path.join(__dirname, 'replay-fixtures.json');

// ── types ─────────────────────────────────────────────────────────────────────

type ProviderFilterResult = {
  candidates: string[];
  surviving: string[];
};

type PenaltyResult = {
  patternName: string;
  penalty: number;
};

type ReplayFixture = {
  prompt: string;
  constraints: {
    requiredProviders: string[];
    allowedProviders: string[];
    forbiddenProviders: string[];
    requiredCapabilities: string[];
    forbiddenCapabilities: string[];
    executionMode: string;
    triggerMode: string;
    actionMode: string;
    identityLocked: boolean;
  };
  providerFilterResults: ProviderFilterResult[];
  penaltyResults: PenaltyResult[];
  normalizationResults: Array<{ input: string; output: string }>;
  timestamp: string;
};

// ── test prompts to replay ────────────────────────────────────────────────────

const REPLAY_PROMPTS: string[] = [
  // Core identity-lock scenarios
  'telegram only',
  'slack only',
  'shopify only',
  'gmail only',
  'whatsapp only',
  'openai only',
  'google sheets only',
  'stripe only',
  'airtable only',
  'hubspot only',

  // With negations
  'telegram only. No whatsapp.',
  'slack only. No hubspot. No airtable.',
  'shopify only. No openai.',
  'telegram only. No AI. No monitoring. No logging.',
  'whatsapp only. No meta messaging. No telegram.',

  // Multi-provider
  'Forward Gmail to Slack. No Airtable.',
  'Shopify + HubSpot integration',
  'Telegram + Google Sheets. No AI.',
  'Stripe + Shopify. No Slack.',

  // Alias forms
  'WA only',
  'tg only',
  'chatgpt only',
  'gpt only',
  'hub spot only',
  'google drive only',
  'gdrive only',

  // Capability prohibitions
  'telegram only. No AI. No monitoring. No extraction.',
  'When a message arrives.',
  'Every day at 9am.',

  // Malformed / variant
  'Use telegram_bot only',
  'WA-Business only',
  'GPT-4 workflow',

  // Mixed language
  'Telegram seulement, pas WhatsApp',
  'telegram only. no whatsapp whatsoever.',
];

// ── penalty helper ────────────────────────────────────────────────────────────

const TEST_PATTERN_NAMES = [
  'Telegram Reply Agent',
  'Telegram+WhatsApp Bot',
  'Telegram + WA Bot',
  'Generic Summarizer',
  'WhatsApp Commerce Pack',
  'Slack Notifier',
  'GPT-4 Bot',
  'hub-spot integration',
  'whatsapp_commerce',
  'telegram_bot',
];

function computePenalty(patternName: string, constraints: ConstraintContext): number {
  if (!constraints.identityLocked || constraints.allowedProviders.length === 0) return 0;
  const normalized = normalizeForProviderScan(patternName);
  let penalty = 0;
  for (const provider of CANONICAL_PROVIDERS) {
    if (constraints.allowedProviders.includes(provider)) continue;
    const aliases = expandProviderAliases(provider);
    const mentioned = aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(normalized);
    });
    if (mentioned) penalty += 15;
  }
  return penalty;
}

// ── normalization cases ───────────────────────────────────────────────────────

const NORM_INPUTS = [
  'WA-Business', 'telegram_bot', 'GPT-4', 'hub-spot', 'whatsapp_commerce',
  'FACEBOOK_BOT', 'google_sheets_sync', 'Open-AI', 'Canva-Design', 'slack-notify',
];

// ── capture fixtures ──────────────────────────────────────────────────────────

function captureFixture(prompt: string): ReplayFixture {
  const constraints = extractHardConstraints(prompt);

  const providerFilterResults: ProviderFilterResult[] = [
    { candidates: CANONICAL_PROVIDERS.slice(0, 5), surviving: filterProviders(CANONICAL_PROVIDERS.slice(0, 5), constraints) },
    { candidates: ['telegram', 'whatsapp', 'slack'], surviving: filterProviders(['telegram', 'whatsapp', 'slack'], constraints) },
    { candidates: ['openai', 'claude', 'supabase'],  surviving: filterProviders(['openai', 'claude', 'supabase'], constraints) },
  ];

  const penaltyResults: PenaltyResult[] = TEST_PATTERN_NAMES.map((name) => ({
    patternName: name,
    penalty: computePenalty(name, constraints),
  }));

  const normalizationResults = NORM_INPUTS.map((input) => ({
    input,
    output: normalizeForProviderScan(input),
  }));

  return {
    prompt,
    constraints: {
      requiredProviders: constraints.requiredProviders,
      allowedProviders: constraints.allowedProviders,
      forbiddenProviders: constraints.forbiddenProviders,
      requiredCapabilities: constraints.requiredCapabilities,
      forbiddenCapabilities: constraints.forbiddenCapabilities,
      executionMode: constraints.executionMode,
      triggerMode: constraints.triggerMode,
      actionMode: constraints.actionMode,
      identityLocked: constraints.identityLocked,
    },
    providerFilterResults,
    penaltyResults,
    normalizationResults,
    timestamp: new Date().toISOString(),
  };
}

// ── save ──────────────────────────────────────────────────────────────────────

function saveFixtures(): void {
  console.log(`Generating ${REPLAY_PROMPTS.length} fixtures...`);
  const fixtures: ReplayFixture[] = REPLAY_PROMPTS.map((prompt) => {
    const f = captureFixture(prompt);
    console.log(`  saved: "${prompt.slice(0, 60)}"`);
    return f;
  });
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2), 'utf-8');
  console.log(`\nSaved ${fixtures.length} fixtures to ${FIXTURES_PATH}`);
}

// ── verify ────────────────────────────────────────────────────────────────────

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

function verifyFixtures(): void {
  if (!fs.existsSync(FIXTURES_PATH)) {
    console.log('No fixtures found. Run with --save first, or run without flags to generate+verify.');
    saveFixtures();
  }

  const saved: ReplayFixture[] = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8'));
  console.log(`\nReplaying ${saved.length} fixtures...`);

  for (const fixture of saved) {
    const label = `"${fixture.prompt.slice(0, 50)}"`;
    const current = captureFixture(fixture.prompt);

    // Constraints
    test(`${label}: requiredProviders match`, () => {
      assert.deepStrictEqual(current.constraints.requiredProviders, fixture.constraints.requiredProviders);
    });
    test(`${label}: allowedProviders match`, () => {
      assert.deepStrictEqual(current.constraints.allowedProviders, fixture.constraints.allowedProviders);
    });
    test(`${label}: forbiddenProviders match`, () => {
      assert.deepStrictEqual(current.constraints.forbiddenProviders, fixture.constraints.forbiddenProviders);
    });
    test(`${label}: forbiddenCapabilities match`, () => {
      assert.deepStrictEqual(current.constraints.forbiddenCapabilities, fixture.constraints.forbiddenCapabilities);
    });
    test(`${label}: identityLocked match`, () => {
      assert.strictEqual(current.constraints.identityLocked, fixture.constraints.identityLocked);
    });
    test(`${label}: executionMode match`, () => {
      assert.strictEqual(current.constraints.executionMode, fixture.constraints.executionMode);
    });

    // Provider filter results
    for (let i = 0; i < fixture.providerFilterResults.length; i++) {
      const saved_r = fixture.providerFilterResults[i];
      const cur_r = current.providerFilterResults[i];
      test(`${label}: filterProviders[${i}] match`, () => {
        assert.deepStrictEqual(cur_r.surviving, saved_r.surviving);
      });
    }

    // Penalty results
    for (const savedPenalty of fixture.penaltyResults) {
      const curPenalty = current.penaltyResults.find((p) => p.patternName === savedPenalty.patternName);
      test(`${label}: penalty("${savedPenalty.patternName}") match`, () => {
        assert.ok(curPenalty !== undefined, `penalty result missing for "${savedPenalty.patternName}"`);
        assert.strictEqual(curPenalty!.penalty, savedPenalty.penalty);
      });
    }

    // Normalization
    for (const savedNorm of fixture.normalizationResults) {
      const curNorm = current.normalizationResults.find((n) => n.input === savedNorm.input);
      test(`${label}: normalizeForProviderScan("${savedNorm.input}") match`, () => {
        assert.ok(curNorm !== undefined);
        assert.strictEqual(curNorm!.output, savedNorm.output);
      });
    }
  }

  if (failures.length > 0) {
    console.log('\nFailed replays:');
    failures.forEach((f) => console.error(f));
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Replay results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nREGRESSION: Current output differs from saved fixtures.');
    process.exit(1);
  } else {
    console.log('\nAll fixtures match. Pipeline is stable.');
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--save')) {
  saveFixtures();
} else if (args.includes('--verify')) {
  verifyFixtures();
} else {
  // Default: generate if not present, then verify
  if (!fs.existsSync(FIXTURES_PATH)) {
    saveFixtures();
  }
  verifyFixtures();
}
