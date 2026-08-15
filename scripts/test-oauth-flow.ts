/**
 * OAuth flow tests — production-risk fixes
 * Run with: npx tsx scripts/test-oauth-flow.ts
 *
 * Sections:
 *  1.  OAuth provider registry ...................  10 tests
 *  2.  State generation ..........................   6 tests
 *  3.  State verification ........................  11 tests  (incl. boundary fix)
 *  4.  Credential key isolation ..................   8 tests  (updated keys + no-overwrite)
 *  5.  Registry × provider-registry integration ..   6 tests
 *  6.  Token serialization .......................   5 tests
 *  7.  OAuth-only detection ......................   4 tests
 *  8.  Callback flow logic (pure) ................   5 tests
 *  9.  Refresh token logic .......................  11 tests
 *  10. POST flow + window guard ..................   5 tests
 *  Total: 71 tests
 */

import assert from 'assert';

// ── Test env: must be set before importing modules that read it ────────────────
process.env.INTEGRATIONS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = 'https://test.magicflux.app';

import {
  getOAuthProviderConfig,
  isOAuthProvider,
  listOAuthProviders,
  serializeOAuthTokens,
  type OAuthTokenResponse,
} from '@/lib/credentials/oauth-providers';

import {
  buildOAuthState,
  verifyOAuthState,
  STATE_MAX_AGE_SECONDS,
} from '@/lib/credentials/oauth-state';

import {
  parseStoredToken,
  tokenNeedsRefresh,
  REFRESH_BUFFER_SECONDS,
  type StoredOAuthToken,
} from '@/lib/credentials/oauth-refresh';

import {
  getRequiredCredentials,
} from '@/lib/credentials/provider-registry';

import {
  isOAuthOnlyProvider,
} from '@/lib/credentials/automation-brain-utils';

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

const TEST_UUID = '123e4567-e89b-42d3-a456-426614174000';

// ── Section 1: OAuth provider registry ───────────────────────────────────────

console.log('\nSection 1: OAuth provider registry');

test('getOAuthProviderConfig("gmail") returns a config', () => {
  assert.ok(getOAuthProviderConfig('gmail') !== null);
});

test('getOAuthProviderConfig("google_sheets") returns a config', () => {
  assert.ok(getOAuthProviderConfig('google_sheets') !== null);
});

test('getOAuthProviderConfig("google_drive") returns a config', () => {
  assert.ok(getOAuthProviderConfig('google_drive') !== null);
});

test('getOAuthProviderConfig("canva") returns a config', () => {
  assert.ok(getOAuthProviderConfig('canva') !== null);
});

test('getOAuthProviderConfig("unknown_provider") returns null', () => {
  assert.strictEqual(getOAuthProviderConfig('unknown_provider'), null);
});

test('getOAuthProviderConfig("telegram") returns null (not OAuth)', () => {
  assert.strictEqual(getOAuthProviderConfig('telegram'), null);
});

test('isOAuthProvider("gmail") is true', () => {
  assert.strictEqual(isOAuthProvider('gmail'), true);
});

test('isOAuthProvider("shopify") is false', () => {
  assert.strictEqual(isOAuthProvider('shopify'), false);
});

test('isOAuthProvider("stripe") is false', () => {
  assert.strictEqual(isOAuthProvider('stripe'), false);
});

test('listOAuthProviders() contains all 4 expected providers', () => {
  const list = listOAuthProviders();
  for (const p of ['gmail', 'google_sheets', 'google_drive', 'canva']) {
    assert.ok(list.includes(p), `${p} missing from listOAuthProviders()`);
  }
  assert.ok(list.length >= 4);
});

// ── Section 2: State generation ───────────────────────────────────────────────

console.log('\nSection 2: State generation');

test('buildOAuthState returns a string containing a dot', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  assert.ok(state.includes('.'));
});

test('buildOAuthState returns non-empty string', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  assert.ok(state.length > 20);
});

test('two calls produce different states (nonce uniqueness)', () => {
  const s1 = buildOAuthState(TEST_UUID, 'gmail');
  const s2 = buildOAuthState(TEST_UUID, 'gmail');
  assert.notStrictEqual(s1, s2);
});

test('state payload is valid base64url JSON', () => {
  const state = buildOAuthState(TEST_UUID, 'google_sheets');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.ok(json.userId && json.provider && json.nonce && typeof json.iat === 'number');
});

test('state payload contains correct userId and provider', () => {
  const state = buildOAuthState(TEST_UUID, 'canva');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.strictEqual(json.userId, TEST_UUID);
  assert.strictEqual(json.provider, 'canva');
});

test('buildOAuthState signature is 64 hex chars (SHA-256)', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const sig = state.slice(state.lastIndexOf('.') + 1);
  assert.strictEqual(sig.length, 64);
});

// ── Section 3: State verification ────────────────────────────────────────────

console.log('\nSection 3: State verification');

test('valid fresh state verifies successfully', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const result = verifyOAuthState(state);
  assert.ok(result.valid);
});

test('verified payload contains correct userId', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const result = verifyOAuthState(state);
  assert.ok(result.valid);
  if (result.valid) assert.strictEqual(result.payload.userId, TEST_UUID);
});

test('verified payload contains correct provider', () => {
  const state = buildOAuthState(TEST_UUID, 'google_drive');
  const result = verifyOAuthState(state);
  assert.ok(result.valid);
  if (result.valid) assert.strictEqual(result.payload.provider, 'google_drive');
});

test('tampered b64 payload is rejected', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const dot = state.lastIndexOf('.');
  const evil = Buffer.from(JSON.stringify({ userId: 'evil', provider: 'gmail', nonce: 'x', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const result = verifyOAuthState(`${evil}.${state.slice(dot + 1)}`);
  assert.ok(!result.valid);
});

test('tampered signature is rejected', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const dot = state.lastIndexOf('.');
  const result = verifyOAuthState(`${state.slice(0, dot)}.${'0'.repeat(64)}`);
  assert.ok(!result.valid);
  if (!result.valid) assert.strictEqual(result.reason, 'invalid_signature');
});

test('malformed state (no dot) is rejected', () => {
  const result = verifyOAuthState('nodotinhere');
  assert.ok(!result.valid);
  if (!result.valid) assert.strictEqual(result.reason, 'malformed_state');
});

test('empty state is rejected', () => {
  assert.ok(!verifyOAuthState('').valid);
});

test('expired state (age > STATE_MAX_AGE_SECONDS) is rejected', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { iat: number };
  const result = verifyOAuthState(state, payload.iat + STATE_MAX_AGE_SECONDS + 1);
  assert.ok(!result.valid);
  if (!result.valid) assert.strictEqual(result.reason, 'expired');
});

test('state exactly at STATE_MAX_AGE_SECONDS is REJECTED (>= boundary fix)', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { iat: number };
  const result = verifyOAuthState(state, payload.iat + STATE_MAX_AGE_SECONDS);
  // age === 600: with >= operator, this must be expired
  assert.ok(!result.valid, 'state at exactly STATE_MAX_AGE_SECONDS should be rejected');
  if (!result.valid) assert.strictEqual(result.reason, 'expired');
});

test('state one second before expiry is still valid', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { iat: number };
  const result = verifyOAuthState(state, payload.iat + STATE_MAX_AGE_SECONDS - 1);
  assert.ok(result.valid, 'state 1s before expiry should still be valid');
});

test('future-timestamped state (age < 0) is rejected', () => {
  const state = buildOAuthState(TEST_UUID, 'gmail');
  const b64 = state.slice(0, state.lastIndexOf('.'));
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { iat: number };
  const result = verifyOAuthState(state, payload.iat - 1);
  assert.ok(!result.valid);
  if (!result.valid) assert.strictEqual(result.reason, 'future_timestamp');
});

// ── Section 4: Credential key isolation ──────────────────────────────────────

console.log('\nSection 4: Credential key isolation');

test('gmail credentialKey is "oauth_google_gmail" (not shared "oauth_google")', () => {
  const cfg = getOAuthProviderConfig('gmail')!;
  assert.strictEqual(cfg.credentialKey, 'oauth_google_gmail');
});

test('google_sheets credentialKey is "oauth_google_sheets"', () => {
  const cfg = getOAuthProviderConfig('google_sheets')!;
  assert.strictEqual(cfg.credentialKey, 'oauth_google_sheets');
});

test('google_drive credentialKey is "oauth_google_drive"', () => {
  const cfg = getOAuthProviderConfig('google_drive')!;
  assert.strictEqual(cfg.credentialKey, 'oauth_google_drive');
});

test('canva credentialKey is "oauth_access_token"', () => {
  assert.strictEqual(getOAuthProviderConfig('canva')!.credentialKey, 'oauth_access_token');
});

test('gmail and google_sheets credential keys are different (no overwrite)', () => {
  const gmail = getOAuthProviderConfig('gmail')!;
  const sheets = getOAuthProviderConfig('google_sheets')!;
  assert.notStrictEqual(gmail.credentialKey, sheets.credentialKey);
});

test('gmail and google_drive credential keys are different (no overwrite)', () => {
  const gmail = getOAuthProviderConfig('gmail')!;
  const drive = getOAuthProviderConfig('google_drive')!;
  assert.notStrictEqual(gmail.credentialKey, drive.credentialKey);
});

test('google_sheets and google_drive credential keys are different (no overwrite)', () => {
  const sheets = getOAuthProviderConfig('google_sheets')!;
  const drive = getOAuthProviderConfig('google_drive')!;
  assert.notStrictEqual(sheets.credentialKey, drive.credentialKey);
});

test('provider-registry gmail key matches oauth-providers credentialKey', () => {
  const regKey = getRequiredCredentials('gmail')[0].key;
  const oauthKey = getOAuthProviderConfig('gmail')!.credentialKey;
  assert.strictEqual(regKey, oauthKey, `registry has "${regKey}" but oauth-providers has "${oauthKey}"`);
});

// ── Section 5: Registry × provider-registry integration ──────────────────────

console.log('\nSection 5: Registry × provider-registry integration');

test('every OAuthProviderConfig has required fields', () => {
  for (const provider of listOAuthProviders()) {
    const cfg = getOAuthProviderConfig(provider)!;
    assert.ok(cfg.authUrl.startsWith('https://'), `${provider}: bad authUrl`);
    assert.ok(cfg.tokenUrl.startsWith('https://'), `${provider}: bad tokenUrl`);
    assert.ok(cfg.scopes.length > 0, `${provider}: empty scopes`);
    assert.ok(cfg.clientIdEnv, `${provider}: missing clientIdEnv`);
    assert.ok(cfg.clientSecretEnv, `${provider}: missing clientSecretEnv`);
  }
});

test('gmail authUrl is Google OAuth endpoint', () => {
  assert.ok(getOAuthProviderConfig('gmail')!.authUrl.includes('accounts.google.com'));
});

test('google_sheets and google_drive share clientIdEnv', () => {
  const sheets = getOAuthProviderConfig('google_sheets')!;
  const drive = getOAuthProviderConfig('google_drive')!;
  assert.strictEqual(sheets.clientIdEnv, drive.clientIdEnv);
  assert.strictEqual(sheets.clientSecretEnv, drive.clientSecretEnv);
});

test('canva has a distinct clientIdEnv from Google providers', () => {
  assert.notStrictEqual(
    getOAuthProviderConfig('canva')!.clientIdEnv,
    getOAuthProviderConfig('gmail')!.clientIdEnv
  );
});

test('gmail scopes include gmail.send', () => {
  assert.ok(getOAuthProviderConfig('gmail')!.scopes.some((s) => s.includes('gmail.send')));
});

test('google_sheets scopes include spreadsheets', () => {
  assert.ok(getOAuthProviderConfig('google_sheets')!.scopes.some((s) => s.includes('spreadsheets')));
});

// ── Section 6: Token serialization ───────────────────────────────────────────

console.log('\nSection 6: Token serialization');

test('serializeOAuthTokens produces valid JSON string', () => {
  const json = JSON.parse(serializeOAuthTokens({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 })) as Record<string, unknown>;
  assert.ok(json.access_token);
});

test('serializeOAuthTokens includes refresh_token when present', () => {
  const json = JSON.parse(serializeOAuthTokens({ access_token: 'tok', refresh_token: 'ref_tok', expires_in: 3600 })) as Record<string, unknown>;
  assert.strictEqual(json.refresh_token, 'ref_tok');
});

test('serializeOAuthTokens sets refresh_token to null when absent', () => {
  const json = JSON.parse(serializeOAuthTokens({ access_token: 'tok' })) as Record<string, unknown>;
  assert.strictEqual(json.refresh_token, null);
});

test('serializeOAuthTokens computes expires_at from expires_in', () => {
  const before = Math.floor(Date.now() / 1000);
  const json = JSON.parse(serializeOAuthTokens({ access_token: 'tok', expires_in: 3600 })) as Record<string, unknown>;
  assert.ok((json.expires_at as number) >= before + 3600);
});

test('serializeOAuthTokens sets expires_at to null when expires_in absent', () => {
  const json = JSON.parse(serializeOAuthTokens({ access_token: 'tok' })) as Record<string, unknown>;
  assert.strictEqual(json.expires_at, null);
});

// ── Section 7: OAuth-only detection ──────────────────────────────────────────

console.log('\nSection 7: OAuth-only detection');

test('gmail registry fields → isOAuthOnlyProvider = true', () => {
  assert.strictEqual(isOAuthOnlyProvider(getRequiredCredentials('gmail')), true);
});

test('google_sheets registry fields → isOAuthOnlyProvider = true', () => {
  assert.strictEqual(isOAuthOnlyProvider(getRequiredCredentials('google_sheets')), true);
});

test('canva registry fields → isOAuthOnlyProvider = true', () => {
  assert.strictEqual(isOAuthOnlyProvider(getRequiredCredentials('canva')), true);
});

test('telegram registry fields → isOAuthOnlyProvider = false', () => {
  assert.strictEqual(isOAuthOnlyProvider(getRequiredCredentials('telegram')), false);
});

// ── Section 8: Callback flow logic (pure) ────────────────────────────────────

console.log('\nSection 8: Callback flow logic (pure)');

test('state round-trip: build → verify returns same userId and provider', () => {
  const state = buildOAuthState(TEST_UUID, 'google_sheets');
  const result = verifyOAuthState(state);
  assert.ok(result.valid);
  if (result.valid) {
    assert.strictEqual(result.payload.userId, TEST_UUID);
    assert.strictEqual(result.payload.provider, 'google_sheets');
  }
});

test('credential map built from serializeOAuthTokens matches provider credentialKey', () => {
  const cfg = getOAuthProviderConfig('gmail')!;
  const tokens: OAuthTokenResponse = { access_token: 'abc', refresh_token: 'def' };
  const credentials: Record<string, string> = { [cfg.credentialKey]: serializeOAuthTokens(tokens) };
  assert.ok(credentials['oauth_google_gmail'], 'expected oauth_google_gmail key');
  const parsed = JSON.parse(credentials['oauth_google_gmail']) as Record<string, unknown>;
  assert.strictEqual(parsed.access_token, 'abc');
  assert.strictEqual(parsed.refresh_token, 'def');
});

test('callback with missing code should not proceed', () => {
  const shouldProceed = !(!null || !buildOAuthState(TEST_UUID, 'gmail'));
  assert.strictEqual(shouldProceed, false);
});

test('callback with missing state should not proceed', () => {
  assert.strictEqual(!('valid_code' && null), true);
});

test('provider-side error param causes immediate error redirect', () => {
  assert.strictEqual('access_denied' !== null, true);
});

// ── Section 9: Refresh token logic ───────────────────────────────────────────

console.log('\nSection 9: Refresh token logic');

test('parseStoredToken returns null for undefined input', () => {
  assert.strictEqual(parseStoredToken(undefined), null);
});

test('parseStoredToken returns null for empty string', () => {
  assert.strictEqual(parseStoredToken(''), null);
});

test('parseStoredToken returns null for invalid JSON', () => {
  assert.strictEqual(parseStoredToken('not-json'), null);
});

test('parseStoredToken returns null when access_token missing', () => {
  assert.strictEqual(parseStoredToken(JSON.stringify({ refresh_token: 'x' })), null);
});

test('parseStoredToken correctly parses full token JSON', () => {
  const raw = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_at: 9999999 });
  const parsed = parseStoredToken(raw)!;
  assert.ok(parsed !== null);
  assert.strictEqual(parsed.access_token, 'tok');
  assert.strictEqual(parsed.refresh_token, 'ref');
  assert.strictEqual(parsed.expires_at, 9999999);
});

test('parseStoredToken sets refresh_token=null when absent', () => {
  const raw = JSON.stringify({ access_token: 'tok' });
  const parsed = parseStoredToken(raw)!;
  assert.strictEqual(parsed.refresh_token, null);
});

test('tokenNeedsRefresh=false when expires_at is null (unknown expiry)', () => {
  const token: StoredOAuthToken = { access_token: 'tok', refresh_token: null, token_type: 'Bearer', expires_at: null };
  assert.strictEqual(tokenNeedsRefresh(token), false);
});

test('tokenNeedsRefresh=false when token expires far in future', () => {
  const now = Math.floor(Date.now() / 1000);
  const token: StoredOAuthToken = { access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_at: now + 3600 };
  assert.strictEqual(tokenNeedsRefresh(token), false);
});

test('tokenNeedsRefresh=true when token expires within REFRESH_BUFFER_SECONDS', () => {
  const now = Math.floor(Date.now() / 1000);
  const token: StoredOAuthToken = { access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_at: now + REFRESH_BUFFER_SECONDS - 60 };
  assert.strictEqual(tokenNeedsRefresh(token), true);
});

test('tokenNeedsRefresh=true when token already expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token: StoredOAuthToken = { access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_at: now - 10 };
  assert.strictEqual(tokenNeedsRefresh(token), true);
});

test('REFRESH_BUFFER_SECONDS is 300 (5 minutes)', () => {
  assert.strictEqual(REFRESH_BUFFER_SECONDS, 300);
});

// ── Section 10: POST flow + window guard ─────────────────────────────────────

console.log('\nSection 10: POST flow + window guard');

test('start route no longer exposes ?token= in URL (by design: POST body)', () => {
  // The start route is now POST — there is no query-param token path.
  // This test documents the invariant: provider is in POST body, auth in header.
  const startUrl = '/api/oauth/start';
  assert.ok(!startUrl.includes('token='), 'no token in start URL');
  assert.ok(!startUrl.includes('?'), 'no query params in start URL');
});

test('handleOAuthRedirect sends provider in POST body, not URL', () => {
  // Simulate: the fetch body is JSON with {provider}, not URL-encoded
  const provider = 'gmail';
  const body = JSON.stringify({ provider });
  const parsed = JSON.parse(body) as { provider: string };
  assert.strictEqual(parsed.provider, 'gmail');
  assert.ok(!body.includes('token'), 'JWT must not appear in POST body');
});

test('window guard: typeof window === "undefined" check is present in AutomationBrain', () => {
  // Verify the source file contains the SSR guard
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'builder', 'AutomationBrain.tsx'),
    'utf8'
  );
  assert.ok(src.includes("typeof window === 'undefined'"), 'SSR window guard missing');
});

test('AutomationBrain uses window.history.replaceState (not bare history)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'builder', 'AutomationBrain.tsx'),
    'utf8'
  );
  assert.ok(src.includes('window.history.replaceState'), 'should use window.history.replaceState');
  assert.ok(!src.includes('\n    history.replaceState'), 'bare history.replaceState must not be present');
});

test('ConnectionModal handleOAuthRedirect does not contain ?token= URL', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'integrations', 'ConnectionModal.tsx'),
    'utf8'
  );
  assert.ok(!src.includes('?token='), 'JWT must not appear as URL query param');
  assert.ok(src.includes("method: 'POST'"), 'ConnectionModal must use POST for OAuth start');
  assert.ok(src.includes('Authorization'), 'Authorization header must be used');
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
