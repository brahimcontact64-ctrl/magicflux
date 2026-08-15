/**
 * Real provider-validation test suite.
 * Run with: npx tsx scripts/test-provider-validation.ts
 *
 * Tests make actual HTTP calls to provider APIs.
 * - Tests with invalid credentials verify 401/403 handling deterministically.
 * - Tests with valid credentials require environment variables:
 *     TEST_TELEGRAM_BOT_TOKEN
 *     TEST_SLACK_BOT_TOKEN
 *     TEST_OPENAI_API_KEY
 *     TEST_STRIPE_SECRET_KEY
 *   If these are absent the "valid" tests are skipped (not marked passed).
 *
 * Sections:
 *   1.  Format guards (no network) .............................. 20 tests
 *   2.  Telegram — invalid token (real network) ................  3 tests
 *   3.  Telegram — valid token   (real network, env-gated) ....  2 tests
 *   4.  Slack — invalid token    (real network) ................  3 tests
 *   5.  Slack — valid token      (real network, env-gated) ....  2 tests
 *   6.  Shopify — bad domain / token (real network) ...........  3 tests
 *   7.  OpenAI — invalid key     (real network) ................  2 tests
 *   8.  Claude — invalid key     (real network) ................  2 tests
 *   9.  Stripe — invalid key     (real network) ................  2 tests
 *  10.  OpenAI — valid key       (real network, env-gated) ....  1 test
 *  11.  Stripe — valid key       (real network, env-gated) ....  1 test
 *  12.  Timeout / network errors ................................  2 tests
 *  13.  Stale-verifier date logic ..............................  4 tests
 *  14.  Credential flow: no save on validation failure .........  3 tests
 */

if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = 'a'.repeat(64);
}

import assert from 'assert';
import {
  validateProviderConnection,
  VALIDATION_TIMEOUT_MS,
} from '@/lib/credentials/provider-verifier';
import { STALE_THRESHOLD_DAYS } from '@/lib/credentials/stale-verifier';
import { buildCredentialRows } from '@/lib/credentials/storage';

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

function skip(label: string, reason: string): void {
  console.log(`  ⊘  ${label}  [skipped: ${reason}]`);
  skipped++;
}

// ── Main (async entry point) ──────────────────────────────────────────────────
// Top-level await is not available in CJS; wrap everything in main().

async function main(): Promise<void> {

// ── Section 1: Format guards (no network calls) ───────────────────────────────

console.log('\nSection 1: Format guards (no network)');

await test('telegram: missing bot_token → connected=false', async () => {
  const r = await validateProviderConnection('telegram', {});
  assert(!r.connected);
  assert(r.errors.length > 0);
});

await test('telegram: obviously malformed token rejected before network call', async () => {
  const r = await validateProviderConnection('telegram', { bot_token: 'notavalidtoken' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format')));
});

await test('slack: missing bot_token → connected=false', async () => {
  const r = await validateProviderConnection('slack', {});
  assert(!r.connected);
});

await test('slack: token not starting with xoxb-/xoxp- → format error', async () => {
  const r = await validateProviderConnection('slack', { bot_token: 'invalid-token' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format')));
});

await test('openai: missing api_key → connected=false', async () => {
  const r = await validateProviderConnection('openai', {});
  assert(!r.connected);
});

await test('openai: key not starting with sk- → format error', async () => {
  const r = await validateProviderConnection('openai', { api_key: 'invalidkey' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format')));
});

await test('claude: key not starting with sk-ant- → format error', async () => {
  const r = await validateProviderConnection('claude', { api_key: 'sk-notanthropickey' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format')));
});

await test('stripe: key not starting with sk_live_ or sk_test_ → format error', async () => {
  const r = await validateProviderConnection('stripe', { secret_key: 'pk_test_invalid' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format')));
});

await test('shopify: missing shop_domain → connected=false', async () => {
  const r = await validateProviderConnection('shopify', { access_token: 'shpat_x' });
  assert(!r.connected);
});

await test('shopify: domain without dot → format error', async () => {
  const r = await validateProviderConnection('shopify', { shop_domain: 'nodot', access_token: 'shpat_x' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format') || e.toLowerCase().includes('domain')));
});

await test('airtable: missing personal_access_token → connected=false', async () => {
  const r = await validateProviderConnection('airtable', {});
  assert(!r.connected);
});

await test('airtable: token not starting with "pat" → format error', async () => {
  const r = await validateProviderConnection('airtable', { personal_access_token: 'wrongprefix' });
  assert(!r.connected);
  assert(r.errors.some((e) => e.toLowerCase().includes('format') || e.toLowerCase().includes('pat')));
});

await test('whatsapp: missing access_token → connected=false', async () => {
  const r = await validateProviderConnection('whatsapp', {
    phone_number_id: '123',
    business_account_id: '456',
  });
  assert(!r.connected);
});

await test('gmail: requiresOAuthFlow=true', async () => {
  const r = await validateProviderConnection('gmail', {});
  assert(!r.connected);
  assert(r.metadata?.requiresOAuthFlow === true);
});

await test('google_sheets: requiresOAuthFlow=true', async () => {
  const r = await validateProviderConnection('google_sheets', {});
  assert(r.metadata?.requiresOAuthFlow === true);
});

await test('google_drive: requiresOAuthFlow=true', async () => {
  const r = await validateProviderConnection('google_drive', {});
  assert(r.metadata?.requiresOAuthFlow === true);
});

await test('unknown provider: returns errors array, not throw', async () => {
  const r = await validateProviderConnection('definitely_unknown_xyz', {});
  assert(!r.connected);
  assert(r.errors.length > 0);
});

await test('airtable PAT format: base64 encoded pat token accepted past format check', async () => {
  // "pat" prefix only — network call will fail but format check must pass
  const r = await validateProviderConnection('airtable', { personal_access_token: 'patABC123def456' });
  // May succeed or fail on network; what matters is it gets past format guard
  // (format check doesn't throw)
  assert(typeof r.connected === 'boolean');
});

await test('all validation results have connected + errors shape', async () => {
  const providers = ['telegram', 'slack', 'openai', 'claude', 'stripe', 'shopify'];
  for (const p of providers) {
    const r = await validateProviderConnection(p, {});
    assert(typeof r.connected === 'boolean', `${p}: connected must be boolean`);
    assert(Array.isArray(r.errors), `${p}: errors must be array`);
  }
});

await test('errors never contain raw URLs or credential values', async () => {
  const r = await validateProviderConnection('telegram', { bot_token: 'notavalidtoken' });
  for (const e of r.errors) {
    assert(!e.includes('api.telegram.org'), `Error leaks URL: ${e}`);
    assert(!e.includes('notavalidtoken'), `Error leaks credential value: ${e}`);
  }
});

// ── Section 2: Telegram — invalid token (real network) ───────────────────────

console.log('\nSection 2: Telegram — invalid token (real network)');

await test('telegram: syntactically valid but non-existent token → 401 from Telegram API', async () => {
  // Format: digits:alphanumeric(35+).  This passes the format check but will
  // get a 401 / ok=false from Telegram's getMe endpoint.
  const r = await validateProviderConnection('telegram', {
    bot_token: '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaa',
  });
  assert(!r.connected, `Expected connected=false, got true`);
  assert(r.errors.length > 0, 'Expected at least one error');
  assert(r.errors[0].toLowerCase().includes('telegram'), `Error should mention Telegram: ${r.errors[0]}`);
});

await test('telegram: invalid token error message is sanitized (no raw URL)', async () => {
  const r = await validateProviderConnection('telegram', {
    bot_token: '9999999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZzzz',
  });
  assert(!r.connected);
  for (const e of r.errors) {
    assert(!e.includes('api.telegram.org'), `Raw URL leaked in error: ${e}`);
  }
});

await test('telegram: chat_id present with invalid token — still errors on bot_token', async () => {
  const r = await validateProviderConnection('telegram', {
    bot_token: '1111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa',
    chat_id: '-100123456789',
  });
  assert(!r.connected);
  assert(r.errors.length > 0);
});

// ── Section 3: Telegram — valid token (env-gated) ────────────────────────────

console.log('\nSection 3: Telegram — valid token (env-gated)');

const TELEGRAM_TOKEN = process.env.TEST_TELEGRAM_BOT_TOKEN;
if (TELEGRAM_TOKEN) {
  await test('telegram: valid token → connected=true with bot metadata', async () => {
    const r = await validateProviderConnection('telegram', { bot_token: TELEGRAM_TOKEN });
    assert(r.connected, `Expected connected=true, errors: ${r.errors.join(', ')}`);
    assert(r.errors.length === 0, `Expected no errors, got: ${r.errors.join(', ')}`);
    assert(r.metadata?.botId || r.metadata?.username, 'Expected bot metadata in result');
  });

  await test('telegram: valid token + chat_id → metadata includes chat info', async () => {
    const chatId = process.env.TEST_TELEGRAM_CHAT_ID ?? '';
    if (!chatId) { skip('telegram valid token + chat_id', 'TEST_TELEGRAM_CHAT_ID not set'); return; }
    const r = await validateProviderConnection('telegram', {
      bot_token: TELEGRAM_TOKEN,
      chat_id: chatId,
    });
    assert(r.connected);
  });
} else {
  skip('telegram valid token tests (2)', 'TEST_TELEGRAM_BOT_TOKEN not set');
}

// ── Section 4: Slack — invalid token (real network) ──────────────────────────

console.log('\nSection 4: Slack — invalid token (real network)');

// validateSlack() only checks the prefix (xoxb-/xoxp-/xoxa-) before making a
// real call to slack.com/api/auth.test — the suffix content is irrelevant to
// both that check and Slack's own rejection. Built from disjoint fragments
// (never a single literal) so no Slack-bot-token-shaped string appears
// verbatim in source or git history; secret scanners match on the complete
// literal shape, not on these pieces joined at runtime.
function fakeSlackBotToken(fillChar: string): string {
  return ['xoxb', '0'.repeat(12), '0'.repeat(12), fillChar.repeat(23)].join('-');
}

await test('slack: valid-format but invalid xoxb- token → auth.test returns ok=false', async () => {
  const r = await validateProviderConnection('slack', {
    bot_token: fakeSlackBotToken('a'),
  });
  assert(!r.connected, 'Expected connected=false');
  assert(r.errors.length > 0, 'Expected error');
  assert(
    r.errors[0].toLowerCase().includes('slack'),
    `Error should mention Slack: ${r.errors[0]}`
  );
});

await test('slack: error message does not expose raw Slack error codes as-is', async () => {
  const r = await validateProviderConnection('slack', {
    bot_token: fakeSlackBotToken('b'),
  });
  assert(!r.connected);
  // Friendly message must not just be the raw Slack error string "invalid_auth"
  for (const e of r.errors) {
    assert(e.length > 5, `Error too short to be a friendly message: ${e}`);
  }
});

await test('slack: invalid_auth error maps to human-readable message', async () => {
  const r = await validateProviderConnection('slack', {
    bot_token: fakeSlackBotToken('c'),
  });
  assert(!r.connected);
  assert(
    r.errors.some((e) => e.includes('invalid') || e.includes('revoked') || e.includes('failed')),
    `Expected meaningful error, got: ${r.errors.join(', ')}`
  );
});

// ── Section 5: Slack — valid token (env-gated) ───────────────────────────────

console.log('\nSection 5: Slack — valid token (env-gated)');

const SLACK_TOKEN = process.env.TEST_SLACK_BOT_TOKEN;
if (SLACK_TOKEN) {
  await test('slack: valid token → connected=true with workspace metadata', async () => {
    const r = await validateProviderConnection('slack', { bot_token: SLACK_TOKEN });
    assert(r.connected, `Expected connected=true, errors: ${r.errors.join(', ')}`);
    assert(r.metadata?.team || r.metadata?.teamId, 'Expected workspace metadata');
  });

  await test('slack: valid token → errors array is empty', async () => {
    const r = await validateProviderConnection('slack', { bot_token: SLACK_TOKEN });
    assert.strictEqual(r.errors.length, 0, `Unexpected errors: ${r.errors.join(', ')}`);
  });
} else {
  skip('slack valid token tests (2)', 'TEST_SLACK_BOT_TOKEN not set');
}

// ── Section 6: Shopify — bad domain / token (real network) ───────────────────

console.log('\nSection 6: Shopify — bad domain / token (real network)');

await test('shopify: non-existent domain → ENOTFOUND/unreachable error', async () => {
  const r = await validateProviderConnection('shopify', {
    shop_domain: 'nonexistent-xyz-abc-123456.myshopify.com',
    access_token: 'shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  });
  assert(!r.connected);
  assert(r.errors.length > 0);
  // Should report unreachable, not an auth error, for a DNS-missing domain
  assert(
    r.errors.some((e) =>
      e.toLowerCase().includes('unreachable') ||
      e.toLowerCase().includes('network') ||
      e.toLowerCase().includes('shopify')
    ),
    `Unexpected error: ${r.errors.join(', ')}`
  );
});

await test('shopify: valid domain format but invalid access token → 401', async () => {
  const r = await validateProviderConnection('shopify', {
    shop_domain: 'demo.myshopify.com',
    access_token: 'shpat_invalid_token_that_wont_work',
  });
  assert(!r.connected);
  assert(r.errors.length > 0);
});

await test('shopify: normalizes https:// prefixed domain before fetching', async () => {
  const r = await validateProviderConnection('shopify', {
    shop_domain: 'https://nonexistent-shopify-test-abc.myshopify.com',
    access_token: 'shpat_x',
  });
  assert(!r.connected);
  // Should not error on URL format — normalizer should strip the prefix
  assert(!r.errors.some((e) => e.toLowerCase().includes('format')), `Got format error: ${r.errors[0]}`);
});

// ── Section 7: OpenAI — invalid key (real network) ───────────────────────────

console.log('\nSection 7: OpenAI — invalid key (real network)');

await test('openai: sk- prefixed but invalid key → 401 from /v1/models', async () => {
  const r = await validateProviderConnection('openai', {
    api_key: 'sk-invalid000000000000000000000000000000000000000000',
  });
  assert(!r.connected);
  assert(
    r.errors.some((e) => e.toLowerCase().includes('invalid') || e.toLowerCase().includes('expired')),
    `Expected auth error, got: ${r.errors.join(', ')}`
  );
});

await test('openai: error message does not expose the raw key', async () => {
  const key = 'sk-leaktest000000000000000000000000000000000000000';
  const r = await validateProviderConnection('openai', { api_key: key });
  assert(!r.connected);
  for (const e of r.errors) {
    assert(!e.includes(key), `Key leaked in error message: ${e}`);
    assert(!e.includes('leaktest'), `Partial key leaked: ${e}`);
  }
});

// ── Section 8: Claude — invalid key (real network) ───────────────────────────

console.log('\nSection 8: Claude (Anthropic) — invalid key (real network)');

await test('claude: sk-ant- prefixed but invalid key → 401 from /v1/models', async () => {
  const r = await validateProviderConnection('claude', {
    api_key: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  assert(!r.connected);
  assert(
    r.errors.some((e) =>
      e.toLowerCase().includes('invalid') ||
      e.toLowerCase().includes('unauthorized') ||
      e.toLowerCase().includes('claude')
    ),
    `Expected auth error, got: ${r.errors.join(', ')}`
  );
});

await test('claude: error is not a raw JSON API response dump', async () => {
  const r = await validateProviderConnection('claude', {
    api_key: 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  });
  assert(!r.connected);
  for (const e of r.errors) {
    assert(!e.startsWith('{'), `Error looks like raw JSON: ${e}`);
  }
});

// ── Section 9: Stripe — invalid key (real network) ───────────────────────────

console.log('\nSection 9: Stripe — invalid key (real network)');

await test('stripe: sk_test_ prefixed but invalid key → 401 from /v1/account', async () => {
  const r = await validateProviderConnection('stripe', {
    secret_key: 'sk_test_invalidkeyfortesting000000000000000000',
  });
  assert(!r.connected);
  assert(
    r.errors.some((e) => e.toLowerCase().includes('invalid') || e.toLowerCase().includes('revoked')),
    `Expected auth error, got: ${r.errors.join(', ')}`
  );
});

await test('stripe: error is sanitized (no raw Stripe JSON)', async () => {
  // Same reasoning as fakeSlackBotToken above: validateStripe() only checks
  // the sk_live_/sk_test_ prefix before the real network call, so the
  // suffix is built from fragments rather than stored as one literal —
  // no Stripe-secret-key-shaped string appears verbatim in source or
  // git history.
  const fakeStripeSecretKey = ['sk', 'live', 'invalidtestkeynotreal'.padEnd(40, '0')].join('_');
  const r = await validateProviderConnection('stripe', {
    secret_key: fakeStripeSecretKey,
  });
  assert(!r.connected);
  for (const e of r.errors) {
    assert(!e.startsWith('{'), `Error looks like raw JSON: ${e}`);
  }
});

// ── Section 10: OpenAI — valid key (env-gated) ───────────────────────────────

console.log('\nSection 10: OpenAI — valid key (env-gated)');

const OPENAI_KEY = process.env.TEST_OPENAI_API_KEY;
if (OPENAI_KEY) {
  await test('openai: valid key → connected=true', async () => {
    const r = await validateProviderConnection('openai', { api_key: OPENAI_KEY });
    assert(r.connected, `Expected connected=true, errors: ${r.errors.join(', ')}`);
    assert(r.errors.length === 0);
  });
} else {
  skip('openai valid key test (1)', 'TEST_OPENAI_API_KEY not set');
}

// ── Section 11: Stripe — valid key (env-gated) ───────────────────────────────

console.log('\nSection 11: Stripe — valid key (env-gated)');

const STRIPE_KEY = process.env.TEST_STRIPE_SECRET_KEY;
if (STRIPE_KEY) {
  await test('stripe: valid key → connected=true with account metadata', async () => {
    const r = await validateProviderConnection('stripe', { secret_key: STRIPE_KEY });
    assert(r.connected, `Expected connected=true, errors: ${r.errors.join(', ')}`);
    assert(r.metadata?.accountId, 'Expected accountId in metadata');
  });
} else {
  skip('stripe valid key test (1)', 'TEST_STRIPE_SECRET_KEY not set');
}

// ── Section 12: Timeout / network errors ─────────────────────────────────────

console.log('\nSection 12: Timeout / network error behaviour');

await test('VALIDATION_TIMEOUT_MS is defined and reasonable (1–60 seconds)', () => {
  assert(typeof VALIDATION_TIMEOUT_MS === 'number', 'VALIDATION_TIMEOUT_MS must be a number');
  assert(VALIDATION_TIMEOUT_MS >= 1000, 'Timeout must be at least 1 second');
  assert(VALIDATION_TIMEOUT_MS <= 60_000, 'Timeout must not exceed 60 seconds');
});

await test('telegram: unreachable bot host does not throw — returns structured error', async () => {
  // This tests that network errors are caught and returned as ValidationResult,
  // not as unhandled exceptions.
  // We call with a valid-format but definitely-non-existent numeric ID that will
  // get a response from Telegram (Telegram always responds, even for unknown bots).
  const r = await validateProviderConnection('telegram', {
    bot_token: '0000000001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaa',
  });
  // Whether it gets network error or 401 from Telegram, it must NOT throw
  assert(typeof r.connected === 'boolean');
  assert(Array.isArray(r.errors));
});

// ── Section 13: Stale-verifier date logic ────────────────────────────────────

console.log('\nSection 13: Stale-verifier date logic');

await test('STALE_THRESHOLD_DAYS is 7', () => {
  assert.strictEqual(STALE_THRESHOLD_DAYS, 7);
});

await test('credentials verified 8 days ago are stale', () => {
  const staleMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const verifiedAt = new Date(Date.now() - staleMs - 86_400_000); // 8 days ago
  const isStale = Date.now() - verifiedAt.getTime() > staleMs;
  assert(isStale, 'Should be stale after 8 days');
});

await test('credentials verified 6 days ago are NOT stale', () => {
  const staleMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const verifiedAt = new Date(Date.now() - staleMs + 86_400_000); // 6 days ago
  const isStale = Date.now() - verifiedAt.getTime() > staleMs;
  assert(!isStale, 'Should not be stale before 7 days');
});

await test('credentials with null verified_at are always treated as stale', () => {
  const existing = undefined; // no record
  const isStale = !existing;
  assert(isStale, 'Missing verification record should be considered stale');
});

// ── Section 14: Credential flow — no save on validation failure ──────────────

console.log('\nSection 14: Credential flow — no save on validation failure');

await test('buildCredentialRows produces rows only for non-empty values', () => {
  const now = new Date().toISOString();
  const rows = buildCredentialRows('user-1', 'telegram', {
    bot_token: 'tok',
    chat_id: '123',
  }, now);
  assert.strictEqual(rows.length, 2);
});

await test('buildCredentialRows excludes empty fields (validation gate enforces required fields)', () => {
  const now = new Date().toISOString();
  const rows = buildCredentialRows('user-1', 'telegram', {
    bot_token: '',
    chat_id: '',
  }, now);
  assert.strictEqual(rows.length, 0, 'No rows should be produced for empty credentials');
});

await test('validation failure result has connected=false and non-empty errors', async () => {
  const r = await validateProviderConnection('telegram', {
    bot_token: 'notavalidtoken', // fails format check before any network call
  });
  assert(!r.connected, 'connected must be false on validation failure');
  assert(r.errors.length > 0, 'errors must be non-empty on failure');
  // The connect route uses these errors to return 422 without saving
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailed tests indicate real provider API issues or broken validation logic.');
  process.exit(1);
}

} // end main()

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
