/**
 * Automation Brain UI logic tests — Phase 2.5
 * Run with: npx tsx scripts/test-automation-brain-ui.ts
 *
 * Tests the pure helpers from lib/credentials/automation-brain-utils.ts
 * and integration with provider-registry/intelligence types.
 *
 * Sections:
 *  1.  getStatusConfig — colour/label mapping ............ 8 tests
 *  2.  isOAuthOnlyProvider ..............................  6 tests
 *  3.  getConnectButtonLabel ............................  4 tests
 *  4.  shouldShowConnectButton ..........................  4 tests
 *  5.  canSubmitForm ....................................  7 tests
 *  6.  STATUS_CONFIG completeness .......................  3 tests
 *  7.  Provider-registry integration ....................  6 tests
 *  Total: 38 tests
 */

import assert from 'assert';
import {
  DEBOUNCE_MS,
  STATUS_CONFIG,
  getStatusConfig,
  isOAuthOnlyProvider,
  getConnectButtonLabel,
  shouldShowConnectButton,
  canSubmitForm,
  type StatusConfig,
} from '@/lib/credentials/automation-brain-utils';
import {
  getRequiredCredentials,
  getOptionalCredentials,
} from '@/lib/credentials/provider-registry';
import type { IntegrationStatus } from '@/lib/credentials/intelligence';

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

const ALL_STATUSES: IntegrationStatus[] = ['ready', 'missing', 'invalid', 'oauth_required'];

// ── Section 1: getStatusConfig ────────────────────────────────────────────────

console.log('\nSection 1: getStatusConfig — colour / label mapping');

test('ready → green colour class', () => {
  const cfg = getStatusConfig('ready');
  assert.ok(cfg.colorClass.includes('emerald'), `colorClass: ${cfg.colorClass}`);
});

test('ready → label is "Ready"', () => {
  assert.strictEqual(getStatusConfig('ready').label, 'Ready');
});

test('missing → amber colour class', () => {
  const cfg = getStatusConfig('missing');
  assert.ok(cfg.colorClass.includes('amber'), `colorClass: ${cfg.colorClass}`);
});

test('missing → label contains "Missing"', () => {
  assert.ok(getStatusConfig('missing').label.toLowerCase().includes('missing'));
});

test('invalid → red colour class', () => {
  const cfg = getStatusConfig('invalid');
  assert.ok(cfg.colorClass.includes('red'), `colorClass: ${cfg.colorClass}`);
});

test('invalid → label is "Invalid"', () => {
  assert.strictEqual(getStatusConfig('invalid').label, 'Invalid');
});

test('oauth_required → blue colour class', () => {
  const cfg = getStatusConfig('oauth_required');
  assert.ok(cfg.colorClass.includes('blue'), `colorClass: ${cfg.colorClass}`);
});

test('oauth_required → label contains "oauth" (case-insensitive)', () => {
  assert.ok(getStatusConfig('oauth_required').label.toLowerCase().includes('oauth'));
});

// ── Section 2: isOAuthOnlyProvider ────────────────────────────────────────────

console.log('\nSection 2: isOAuthOnlyProvider');

test('all oauth fields → true', () => {
  assert.strictEqual(isOAuthOnlyProvider([{ source: 'oauth' }]), true);
});

test('all api_key fields → false', () => {
  assert.strictEqual(isOAuthOnlyProvider([{ source: 'api_key' }]), false);
});

test('mixed oauth + api_key → false', () => {
  assert.strictEqual(
    isOAuthOnlyProvider([{ source: 'oauth' }, { source: 'api_key' }]),
    false
  );
});

test('empty array → false (no fields cannot be OAuth-only)', () => {
  assert.strictEqual(isOAuthOnlyProvider([]), false);
});

test('gmail required fields → isOAuthOnlyProvider=true', () => {
  const fields = getRequiredCredentials('gmail');
  assert.strictEqual(isOAuthOnlyProvider(fields), true);
});

test('telegram required fields → isOAuthOnlyProvider=false', () => {
  const fields = getRequiredCredentials('telegram');
  assert.strictEqual(isOAuthOnlyProvider(fields), false);
});

// ── Section 3: getConnectButtonLabel ──────────────────────────────────────────

console.log('\nSection 3: getConnectButtonLabel');

test('missing → "Connect"', () => {
  assert.strictEqual(getConnectButtonLabel('missing'), 'Connect');
});

test('invalid → "Reconnect"', () => {
  assert.strictEqual(getConnectButtonLabel('invalid'), 'Reconnect');
});

test('oauth_required → "Connect with OAuth"', () => {
  assert.strictEqual(getConnectButtonLabel('oauth_required'), 'Connect with OAuth');
});

test('ready → still returns a string (any value)', () => {
  const label = getConnectButtonLabel('ready');
  assert.strictEqual(typeof label, 'string');
});

// ── Section 4: shouldShowConnectButton ───────────────────────────────────────

console.log('\nSection 4: shouldShowConnectButton');

test('ready → false (button hidden when already connected)', () => {
  assert.strictEqual(shouldShowConnectButton('ready'), false);
});

test('missing → true', () => {
  assert.strictEqual(shouldShowConnectButton('missing'), true);
});

test('invalid → true', () => {
  assert.strictEqual(shouldShowConnectButton('invalid'), true);
});

test('oauth_required → true', () => {
  assert.strictEqual(shouldShowConnectButton('oauth_required'), true);
});

// ── Section 5: canSubmitForm ──────────────────────────────────────────────────

console.log('\nSection 5: canSubmitForm');

test('all required fields filled → true', () => {
  const fields = [{ key: 'bot_token', required: true }, { key: 'chat_id', required: true }];
  const values = { bot_token: 'abc', chat_id: '123' };
  assert.strictEqual(canSubmitForm(fields, values), true);
});

test('one required field empty → false', () => {
  const fields = [{ key: 'bot_token', required: true }, { key: 'chat_id', required: true }];
  const values = { bot_token: 'abc' };
  assert.strictEqual(canSubmitForm(fields, values), false);
});

test('required field with whitespace only → false', () => {
  const fields = [{ key: 'api_key', required: true }];
  const values = { api_key: '   ' };
  assert.strictEqual(canSubmitForm(fields, values), false);
});

test('optional field empty, required filled → true', () => {
  const fields = [
    { key: 'secret_key', required: true },
    { key: 'webhook_secret', required: false },
  ];
  const values = { secret_key: 'sk_live_abc' };
  assert.strictEqual(canSubmitForm(fields, values), true);
});

test('no fields → true (nothing required)', () => {
  assert.strictEqual(canSubmitForm([], {}), true);
});

test('only optional fields, all empty → true', () => {
  const fields = [{ key: 'webhook_secret', required: false }];
  assert.strictEqual(canSubmitForm(fields, {}), true);
});

test('telegram registry fields + all values present → true', () => {
  const fields = getRequiredCredentials('telegram');
  const values = Object.fromEntries(fields.map((f) => [f.key, 'test-value']));
  assert.strictEqual(canSubmitForm(fields, values), true);
});

// ── Section 6: STATUS_CONFIG completeness ────────────────────────────────────

console.log('\nSection 6: STATUS_CONFIG completeness');

test('DEBOUNCE_MS is 500', () => {
  assert.strictEqual(DEBOUNCE_MS, 500);
});

test('STATUS_CONFIG has entries for all 4 statuses', () => {
  for (const status of ALL_STATUSES) {
    assert.ok(STATUS_CONFIG[status], `missing entry for ${status}`);
  }
});

test('every StatusConfig entry has required fields', () => {
  const requiredKeys: (keyof StatusConfig)[] = [
    'label',
    'colorClass',
    'bgClass',
    'borderClass',
    'iconName',
  ];
  for (const status of ALL_STATUSES) {
    const cfg = STATUS_CONFIG[status];
    for (const key of requiredKeys) {
      assert.ok(cfg[key], `STATUS_CONFIG[${status}].${key} is falsy`);
    }
  }
});

// ── Section 7: Provider-registry integration ──────────────────────────────────

console.log('\nSection 7: Provider-registry integration');

test('shopify fields are NOT OAuth-only → correct status derivation for missing', () => {
  const fields = getRequiredCredentials('shopify');
  assert.strictEqual(isOAuthOnlyProvider(fields), false);
});

test('canva fields → isOAuthOnlyProvider=true', () => {
  const fields = getRequiredCredentials('canva');
  assert.strictEqual(isOAuthOnlyProvider(fields), true);
});

test('google_sheets fields → isOAuthOnlyProvider=true', () => {
  const fields = getRequiredCredentials('google_sheets');
  assert.strictEqual(isOAuthOnlyProvider(fields), true);
});

test('stripe: canSubmitForm true when secret_key provided (webhook_secret optional)', () => {
  const required = getRequiredCredentials('stripe');
  const optional = getOptionalCredentials('stripe');
  const allFields = [...required, ...optional];
  const values = { secret_key: 'sk_live_abc' };
  assert.strictEqual(canSubmitForm(allFields, values), true);
});

test('stripe: canSubmitForm false when secret_key missing', () => {
  const allFields = [...getRequiredCredentials('stripe'), ...getOptionalCredentials('stripe')];
  assert.strictEqual(canSubmitForm(allFields, {}), false);
});

test('whatsapp: canSubmitForm false when any of 3 required fields missing', () => {
  const fields = getRequiredCredentials('whatsapp');
  assert.strictEqual(fields.length, 3);
  const partial = { business_account_id: 'id', phone_number_id: 'pid' };
  assert.strictEqual(canSubmitForm(fields, partial), false);
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
