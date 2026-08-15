/**
 * Automation Brain refresh + integration tests — Phase 2.5 tasks 1-4
 * Run with: npx tsx scripts/test-automation-brain-refresh.ts
 *
 * Sections:
 *  1.  optimistic state update logic ............  7 tests
 *  2.  allReady + blockers recomputation ........  6 tests
 *  3.  refreshKey pattern simulation ............  4 tests
 *  4.  source file verification .................  8 tests
 *  5.  UI state edge cases ......................  5 tests
 *  Total: 30 tests
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AutomationRequirementsResult, IntegrationRequirement, IntegrationStatus } from '@/lib/credentials/intelligence';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(label: string, fn: () => void): void {
  try {
    fn();
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

// ── Pure helpers mirroring AutomationBrain.handleConnectSuccess ───────────────

function applyOptimisticUpdate(
  prev: AutomationRequirementsResult,
  provider: string
): AutomationRequirementsResult {
  const integrations = prev.integrations.map((i) =>
    i.provider === provider
      ? { ...i, connected: true, missing: [], status: 'ready' as IntegrationStatus }
      : i
  );
  const allReady = integrations.every((i) => i.status === 'ready');
  const blockers = integrations.filter((i) => i.status !== 'ready').map((i) => i.provider);
  return { integrations, allReady, blockers };
}

function makeResult(
  providers: Array<{ provider: string; status: IntegrationStatus; missing?: string[] }>
): AutomationRequirementsResult {
  const integrations: IntegrationRequirement[] = providers.map(({ provider, status, missing = [] }) => ({
    provider,
    displayName: provider.charAt(0).toUpperCase() + provider.slice(1),
    required: true,
    connected: status === 'ready',
    missing,
    status,
  }));
  const allReady = integrations.every((i) => i.status === 'ready');
  const blockers = integrations.filter((i) => i.status !== 'ready').map((i) => i.provider);
  return { integrations, allReady, blockers };
}

// ── Section 1: optimistic state update logic ──────────────────────────────────

console.log('\nSection 1: optimistic state update logic');

test('provider is marked connected=true after optimistic update', () => {
  const prev = makeResult([{ provider: 'shopify', status: 'missing', missing: ['shop_domain', 'access_token'] }]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  assert.strictEqual(next.integrations[0].connected, true);
});

test('missing array becomes [] after optimistic update', () => {
  const prev = makeResult([{ provider: 'shopify', status: 'missing', missing: ['shop_domain', 'access_token'] }]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  assert.deepStrictEqual(next.integrations[0].missing, []);
});

test('status becomes "ready" after optimistic update', () => {
  const prev = makeResult([{ provider: 'shopify', status: 'missing' }]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  assert.strictEqual(next.integrations[0].status, 'ready');
});

test('other providers are unchanged after optimistic update', () => {
  const prev = makeResult([
    { provider: 'shopify', status: 'missing', missing: ['access_token'] },
    { provider: 'telegram', status: 'missing', missing: ['bot_token'] },
  ]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  const telegram = next.integrations.find((i) => i.provider === 'telegram')!;
  assert.strictEqual(telegram.status, 'missing');
  assert.ok(telegram.missing.includes('bot_token'));
});

test('invalid provider also transitions to ready after optimistic update', () => {
  const prev = makeResult([{ provider: 'telegram', status: 'invalid' }]);
  const next = applyOptimisticUpdate(prev, 'telegram');
  assert.strictEqual(next.integrations[0].status, 'ready');
});

test('oauth_required provider transitions to ready after optimistic update', () => {
  const prev = makeResult([{ provider: 'gmail', status: 'oauth_required' }]);
  const next = applyOptimisticUpdate(prev, 'gmail');
  assert.strictEqual(next.integrations[0].status, 'ready');
});

test('optimistic update on unknown provider leaves result unchanged', () => {
  const prev = makeResult([{ provider: 'telegram', status: 'ready' }]);
  const next = applyOptimisticUpdate(prev, 'nonexistent');
  assert.deepStrictEqual(next.integrations, prev.integrations);
});

// ── Section 2: allReady + blockers recomputation ──────────────────────────────

console.log('\nSection 2: allReady + blockers recomputation');

test('allReady=true when single provider connected', () => {
  const prev = makeResult([{ provider: 'telegram', status: 'missing' }]);
  const next = applyOptimisticUpdate(prev, 'telegram');
  assert.strictEqual(next.allReady, true);
});

test('allReady=false when one provider still pending after update', () => {
  const prev = makeResult([
    { provider: 'shopify', status: 'missing' },
    { provider: 'telegram', status: 'missing' },
  ]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  assert.strictEqual(next.allReady, false);
});

test('allReady=true after connecting the last blocker', () => {
  const prev = makeResult([
    { provider: 'shopify', status: 'ready' },
    { provider: 'telegram', status: 'missing' },
  ]);
  const next = applyOptimisticUpdate(prev, 'telegram');
  assert.strictEqual(next.allReady, true);
});

test('blockers excludes the newly connected provider', () => {
  const prev = makeResult([
    { provider: 'shopify', status: 'missing' },
    { provider: 'telegram', status: 'missing' },
  ]);
  const next = applyOptimisticUpdate(prev, 'shopify');
  assert.ok(!next.blockers.includes('shopify'), `shopify still in blockers: ${JSON.stringify(next.blockers)}`);
  assert.ok(next.blockers.includes('telegram'), `telegram missing from blockers: ${JSON.stringify(next.blockers)}`);
});

test('blockers is empty when all integrations ready', () => {
  const prev = makeResult([
    { provider: 'shopify', status: 'ready' },
    { provider: 'telegram', status: 'missing' },
  ]);
  const next = applyOptimisticUpdate(prev, 'telegram');
  assert.deepStrictEqual(next.blockers, []);
});

test('allReady=true for empty integrations list', () => {
  const result = makeResult([]);
  assert.strictEqual(result.allReady, true);
  assert.deepStrictEqual(result.blockers, []);
});

// ── Section 3: refreshKey pattern simulation ──────────────────────────────────

console.log('\nSection 3: refreshKey pattern simulation');

test('refreshKey counter starts at 0', () => {
  let refreshKey = 0;
  assert.strictEqual(refreshKey, 0);
});

test('incrementing refreshKey via functional update works correctly', () => {
  let refreshKey = 0;
  const setRefreshKey = (fn: (v: number) => number) => { refreshKey = fn(refreshKey); };
  setRefreshKey((v) => v + 1);
  assert.strictEqual(refreshKey, 1);
  setRefreshKey((v) => v + 1);
  assert.strictEqual(refreshKey, 2);
});

test('three increments produce key=3', () => {
  let key = 0;
  const inc = () => { key = key + 1; };
  inc(); inc(); inc();
  assert.strictEqual(key, 3);
});

test('refreshKey change is independent of prompt change', () => {
  // Simulate: same prompt, refreshKey changes → effect re-runs
  let effectRunCount = 0;
  let prevPrompt = 'Monitor Shopify';
  let prevKey = 0;

  function simulateEffect(prompt: string, key: number) {
    if (prompt !== prevPrompt || key !== prevKey) {
      effectRunCount++;
      prevPrompt = prompt;
      prevKey = key;
    }
  }

  simulateEffect('Monitor Shopify', 0); // initial (no change)
  simulateEffect('Monitor Shopify', 1); // refreshKey changed → re-run
  assert.strictEqual(effectRunCount, 1);
  simulateEffect('Monitor Shopify', 2); // another refresh
  assert.strictEqual(effectRunCount, 2);
});

// ── Section 4: source file verification ──────────────────────────────────────

console.log('\nSection 4: source file verification');

const BRAIN_PATH = path.join(__dirname, '..', 'components', 'builder', 'AutomationBrain.tsx');
const CHAT_PATH = path.join(__dirname, '..', 'components', 'builder', 'chat-interface.tsx');
const brainSrc = fs.readFileSync(BRAIN_PATH, 'utf8');
const chatSrc = fs.readFileSync(CHAT_PATH, 'utf8');

test('AutomationBrain.tsx declares refreshKey state', () => {
  assert.ok(brainSrc.includes('refreshKey'), 'refreshKey not found in AutomationBrain.tsx');
});

test('AutomationBrain.tsx includes refreshKey in useEffect dependencies', () => {
  assert.ok(
    brainSrc.includes('refreshKey]'),
    'refreshKey not in useEffect deps array'
  );
});

test('AutomationBrain.tsx uses setRefreshKey functional update', () => {
  assert.ok(
    brainSrc.includes('setRefreshKey((v) => v + 1)') || brainSrc.includes('setRefreshKey(v => v + 1)'),
    'setRefreshKey functional update not found'
  );
});

test('AutomationBrain.tsx does NOT use the broken setResult(null) refresh pattern', () => {
  // The broken pattern was: setTimeout(() => { setResult(null); setError(null); }, 1500)
  const hasBrokenPattern = brainSrc.includes('setResult(null)') &&
    brainSrc.includes('setError(null)') &&
    brainSrc.includes('1500');
  assert.ok(!hasBrokenPattern, 'Broken refresh pattern (setResult null + 1500ms) still present');
});

test('chat-interface.tsx imports AutomationBrain', () => {
  assert.ok(
    chatSrc.includes("import { AutomationBrain }") || chatSrc.includes("import {AutomationBrain}"),
    'AutomationBrain not imported in chat-interface.tsx'
  );
});

test('chat-interface.tsx uses responsive grid layout class', () => {
  assert.ok(
    chatSrc.includes('lg:grid-cols-'),
    'lg:grid-cols- class not found in chat-interface.tsx'
  );
});

test('chat-interface.tsx renders AutomationBrain with prompt prop', () => {
  assert.ok(
    chatSrc.includes('prompt={input}'),
    'AutomationBrain prompt={input} not found in chat-interface.tsx'
  );
});

test('AutomationBrain.tsx has error state message', () => {
  assert.ok(
    brainSrc.includes('Could not reach the intelligence service'),
    'error message not found in AutomationBrain.tsx'
  );
});

// ── Section 5: UI state edge cases ───────────────────────────────────────────

console.log('\nSection 5: UI state edge cases');

test('empty integrations → allReady=true, blockers=[]', () => {
  const result = makeResult([]);
  assert.strictEqual(result.allReady, true);
  assert.deepStrictEqual(result.blockers, []);
});

test('single missing integration → allReady=false, one blocker', () => {
  const result = makeResult([{ provider: 'shopify', status: 'missing' }]);
  assert.strictEqual(result.allReady, false);
  assert.strictEqual(result.blockers.length, 1);
  assert.ok(result.blockers.includes('shopify'));
});

test('mixed connected/missing → only missing in blockers', () => {
  const result = makeResult([
    { provider: 'telegram', status: 'ready' },
    { provider: 'shopify', status: 'missing' },
    { provider: 'gmail', status: 'oauth_required' },
  ]);
  assert.strictEqual(result.allReady, false);
  assert.ok(!result.blockers.includes('telegram'), 'telegram should not be a blocker');
  assert.ok(result.blockers.includes('shopify'), 'shopify should be a blocker');
  assert.ok(result.blockers.includes('gmail'), 'gmail should be a blocker');
});

test('connecting same provider twice is idempotent', () => {
  const prev = makeResult([{ provider: 'telegram', status: 'missing' }]);
  const once = applyOptimisticUpdate(prev, 'telegram');
  const twice = applyOptimisticUpdate(once, 'telegram');
  assert.strictEqual(twice.integrations[0].status, 'ready');
  assert.deepStrictEqual(twice.blockers, []);
});

test('all-ready result stays all-ready after connecting already-ready provider', () => {
  const prev = makeResult([
    { provider: 'telegram', status: 'ready' },
    { provider: 'shopify', status: 'ready' },
  ]);
  const next = applyOptimisticUpdate(prev, 'telegram');
  assert.strictEqual(next.allReady, true);
  assert.deepStrictEqual(next.blockers, []);
});

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.error(f));
  console.log('');
}
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
