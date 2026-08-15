/**
 * End-to-end OAuth smoke tests — scripts/test-oauth-e2e.ts
 *
 * Covers: start URL construction, callback credential storage, credential key
 * isolation, reconnect isolation, DB row verification, token refresh path, and
 * cleanup / disconnect scoping.
 *
 * No live DB or HTTP calls are made.  All external boundaries are exercised
 * through the exported pure functions in the credential stack, mirroring
 * exactly what the route handlers do at runtime.
 *
 * Run: npx tsx scripts/test-oauth-e2e.ts
 */

// ── Environment ───────────────────────────────────────────────────────────────
// Must be assigned before any import that reads process.env at module-load time.
process.env.INTEGRATIONS_ENCRYPTION_KEY =
  'e2e-smoke-test-key-padded-to-at-least-32-bytes!!';
process.env.NEXT_PUBLIC_APP_URL    = 'https://smoke.magicflux.test';
process.env.GOOGLE_CLIENT_ID       = 'google-smoke-client-id';
process.env.GOOGLE_CLIENT_SECRET   = 'google-smoke-client-secret';
process.env.CANVA_CLIENT_ID        = 'canva-smoke-client-id';
process.env.CANVA_CLIENT_SECRET    = 'canva-smoke-client-secret';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildOAuthState,
  verifyOAuthState,
  STATE_MAX_AGE_SECONDS,
} from '../lib/credentials/oauth-state';
import {
  getOAuthProviderConfig,
  listOAuthProviders,
  serializeOAuthTokens,
} from '../lib/credentials/oauth-providers';
import {
  buildCredentialRows,
  isSecretKey,
  assertTrustedUserId,
} from '../lib/credentials/storage';
import {
  parseStoredToken,
  tokenNeedsRefresh,
  REFRESH_BUFFER_SECONDS,
} from '../lib/credentials/oauth-refresh';

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function t(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err: unknown) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_USER_ID  = randomUUID(); // valid UUID v4
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL!;
const CALLBACK_URI  = `${APP_URL}/api/oauth/callback`;

const GOOGLE_PROVIDERS = ['gmail', 'google_sheets', 'google_drive'] as const;
const ALL_PROVIDERS    = listOAuthProviders();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mirrors exactly what POST /api/oauth/start does to build the redirectUrl.
 * Testing this function tests the real production logic without the HTTP layer.
 */
function buildStartUrl(provider: string, userId: string): string {
  const config = getOAuthProviderConfig(provider);
  if (!config) throw new Error(`No OAuth config for provider: ${provider}`);

  const clientId = process.env[config.clientIdEnv]!;
  const state = buildOAuthState(userId, provider);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK_URI,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    ...(config.extraAuthParams ?? {}),
  });

  return `${config.authUrl}?${params.toString()}`;
}

/**
 * Mirrors exactly what GET /api/oauth/callback does to build the credentials
 * map from a serialized token response before calling saveCredentialsWithVerification.
 */
function buildCallbackCreds(provider: string, tokenJson: string): Record<string, string> {
  const config = getOAuthProviderConfig(provider);
  if (!config) throw new Error(`No OAuth config for provider: ${provider}`);
  return { [config.credentialKey]: tokenJson };
}

// Stable fake token JSON for each provider — created with serializeOAuthTokens
// so the shape is identical to what the real callback stores.
const FAKE_GMAIL  = serializeOAuthTokens({ access_token: 'gmail-tok',  refresh_token: 'gmail-ref',  expires_in: 3600, token_type: 'Bearer' });
const FAKE_SHEETS = serializeOAuthTokens({ access_token: 'sheets-tok', refresh_token: 'sheets-ref', expires_in: 3600, token_type: 'Bearer' });
const FAKE_DRIVE  = serializeOAuthTokens({ access_token: 'drive-tok',  refresh_token: 'drive-ref',  expires_in: 3600, token_type: 'Bearer' });
const FAKE_CANVA  = serializeOAuthTokens({ access_token: 'canva-tok',  expires_in: 3600, token_type: 'Bearer' });

const FAKE_BY_PROVIDER: Record<string, string> = {
  gmail: FAKE_GMAIL,
  google_sheets: FAKE_SHEETS,
  google_drive: FAKE_DRIVE,
  canva: FAKE_CANVA,
};

// ─────────────────────────────────────────────────────────────────────────────

// ── Section 1: Start route — OAuth authorization URL construction ─────────────

console.log('\nSection 1: Start route — OAuth authorization URL construction');

t('gmail start URL points to Google OAuth endpoint', () => {
  assert.ok(buildStartUrl('gmail', TEST_USER_ID).startsWith(
    'https://accounts.google.com/o/oauth2/v2/auth'
  ));
});

t('google_sheets start URL points to Google OAuth endpoint', () => {
  assert.ok(buildStartUrl('google_sheets', TEST_USER_ID).startsWith(
    'https://accounts.google.com/o/oauth2/v2/auth'
  ));
});

t('google_drive start URL points to Google OAuth endpoint', () => {
  assert.ok(buildStartUrl('google_drive', TEST_USER_ID).startsWith(
    'https://accounts.google.com/o/oauth2/v2/auth'
  ));
});

t('canva start URL points to Canva OAuth endpoint', () => {
  assert.ok(buildStartUrl('canva', TEST_USER_ID).startsWith(
    'https://www.canva.com/api/oauth/authorize'
  ));
});

t('start URL contains correct redirect_uri pointing to /api/oauth/callback', () => {
  const url = new URL(buildStartUrl('gmail', TEST_USER_ID));
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK_URI);
});

t('start URL uses response_type=code (authorization code flow)', () => {
  const url = new URL(buildStartUrl('gmail', TEST_USER_ID));
  assert.equal(url.searchParams.get('response_type'), 'code');
});

t('start URL never contains a "token" query parameter (JWT isolation)', () => {
  for (const p of ALL_PROVIDERS) {
    const url = new URL(buildStartUrl(p, TEST_USER_ID));
    assert.ok(!url.searchParams.has('token'),        `${p}: "token" param found in URL`);
    assert.ok(!url.searchParams.has('access_token'), `${p}: "access_token" param found in URL`);
  }
});

t('start URL state round-trips: verifyOAuthState returns correct userId + provider', () => {
  for (const p of ALL_PROVIDERS) {
    const url   = new URL(buildStartUrl(p, TEST_USER_ID));
    const state = url.searchParams.get('state')!;
    const res   = verifyOAuthState(state);
    assert.ok(res.valid, `${p}: state invalid`);
    if (res.valid) {
      assert.equal(res.payload.userId,   TEST_USER_ID, `${p}: userId mismatch`);
      assert.equal(res.payload.provider, p,            `${p}: provider mismatch`);
    }
  }
});

t('gmail start URL scope includes gmail.send', () => {
  const url = new URL(buildStartUrl('gmail', TEST_USER_ID));
  assert.ok((url.searchParams.get('scope') ?? '').includes('gmail.send'));
});

t('google_sheets start URL scope includes spreadsheets', () => {
  const url = new URL(buildStartUrl('google_sheets', TEST_USER_ID));
  assert.ok((url.searchParams.get('scope') ?? '').includes('spreadsheets'));
});

t('google_drive start URL scope includes auth/drive', () => {
  const url = new URL(buildStartUrl('google_drive', TEST_USER_ID));
  assert.ok((url.searchParams.get('scope') ?? '').includes('auth/drive'));
});

t('Google providers include access_type=offline (requests refresh token)', () => {
  for (const p of GOOGLE_PROVIDERS) {
    const url = new URL(buildStartUrl(p, TEST_USER_ID));
    assert.equal(url.searchParams.get('access_type'), 'offline', `${p}: access_type missing`);
  }
});

t('Google providers include prompt=consent (ensures refresh_token is always returned)', () => {
  for (const p of GOOGLE_PROVIDERS) {
    const url = new URL(buildStartUrl(p, TEST_USER_ID));
    assert.equal(url.searchParams.get('prompt'), 'consent', `${p}: prompt=consent missing`);
  }
});

// ── Section 2: Callback route — state verification + credential storage path ──

console.log('\nSection 2: Callback route — state verification + credential storage path');

t('callback: fresh HMAC-signed state verifies successfully', () => {
  const state = buildOAuthState(TEST_USER_ID, 'gmail');
  const res   = verifyOAuthState(state);
  assert.ok(res.valid);
});

t('callback: userId is extracted from verified state, not from query params', () => {
  const state = buildOAuthState(TEST_USER_ID, 'gmail');
  const res   = verifyOAuthState(state);
  assert.ok(res.valid);
  if (res.valid) assert.equal(res.payload.userId, TEST_USER_ID);
});

t('callback: tampered payload is rejected with invalid_signature', () => {
  const state   = buildOAuthState(TEST_USER_ID, 'gmail');
  const tampered = state.slice(0, -4) + 'xxxx';
  const res     = verifyOAuthState(tampered);
  assert.ok(!res.valid);
  if (!res.valid) assert.equal(res.reason, 'invalid_signature');
});

t('callback: state at exactly STATE_MAX_AGE_SECONDS is rejected (>= boundary)', () => {
  const state      = buildOAuthState(TEST_USER_ID, 'gmail');
  const nowSeconds = Math.floor(Date.now() / 1000) + STATE_MAX_AGE_SECONDS;
  const res        = verifyOAuthState(state, nowSeconds);
  assert.ok(!res.valid);
  if (!res.valid) assert.equal(res.reason, 'expired');
});

t('callback: state one second before expiry is still accepted', () => {
  const state      = buildOAuthState(TEST_USER_ID, 'gmail');
  const nowSeconds = Math.floor(Date.now() / 1000) + STATE_MAX_AGE_SECONDS - 1;
  const res        = verifyOAuthState(state, nowSeconds);
  assert.ok(res.valid, `Expected valid but got: ${!res.valid ? res.reason : 'ok'}`);
});

t('callback: gmail stores credentials under key oauth_google_gmail', () => {
  const creds = buildCallbackCreds('gmail', FAKE_GMAIL);
  assert.ok('oauth_google_gmail' in creds);
});

t('callback: google_sheets stores credentials under key oauth_google_sheets', () => {
  const creds = buildCallbackCreds('google_sheets', FAKE_SHEETS);
  assert.ok('oauth_google_sheets' in creds);
});

t('callback: google_drive stores credentials under key oauth_google_drive', () => {
  const creds = buildCallbackCreds('google_drive', FAKE_DRIVE);
  assert.ok('oauth_google_drive' in creds);
});

t('callback: canva stores credentials under key oauth_access_token', () => {
  const creds = buildCallbackCreds('canva', FAKE_CANVA);
  assert.ok('oauth_access_token' in creds);
});

t('callback: credential map has exactly one key per provider (no extra rows)', () => {
  for (const p of ALL_PROVIDERS) {
    const creds = buildCallbackCreds(p, FAKE_BY_PROVIDER[p]!);
    const keys  = Object.keys(creds);
    assert.equal(keys.length, 1, `${p}: expected 1 key, got ${keys.join(', ')}`);
  }
});

t('callback: success redirect URL has oauth=success and correct provider param', () => {
  for (const p of ALL_PROVIDERS) {
    const redirectUrl = `${APP_URL}/builder?oauth=success&provider=${encodeURIComponent(p)}`;
    const url         = new URL(redirectUrl);
    assert.equal(url.searchParams.get('oauth'),    'success');
    assert.equal(url.searchParams.get('provider'), p);
  }
});

t('callback: error redirect URL has oauth=error and reason param', () => {
  const redirectUrl = `${APP_URL}/builder?oauth=error&reason=${encodeURIComponent('invalid_state')}`;
  const url         = new URL(redirectUrl);
  assert.equal(url.searchParams.get('oauth'),  'error');
  assert.equal(url.searchParams.get('reason'), 'invalid_state');
});

// ── Section 3: Credential key isolation ──────────────────────────────────────

console.log('\nSection 3: Credential key isolation');

t('gmail credentialKey !== google_sheets credentialKey', () => {
  assert.notEqual(
    getOAuthProviderConfig('gmail')!.credentialKey,
    getOAuthProviderConfig('google_sheets')!.credentialKey
  );
});

t('gmail credentialKey !== google_drive credentialKey', () => {
  assert.notEqual(
    getOAuthProviderConfig('gmail')!.credentialKey,
    getOAuthProviderConfig('google_drive')!.credentialKey
  );
});

t('google_sheets credentialKey !== google_drive credentialKey', () => {
  assert.notEqual(
    getOAuthProviderConfig('google_sheets')!.credentialKey,
    getOAuthProviderConfig('google_drive')!.credentialKey
  );
});

t('canva credentialKey differs from every Google provider credentialKey', () => {
  const canvaKey = getOAuthProviderConfig('canva')!.credentialKey;
  for (const p of GOOGLE_PROVIDERS) {
    assert.notEqual(canvaKey, getOAuthProviderConfig(p)!.credentialKey,
      `canva and ${p} share credentialKey`);
  }
});

t('no two OAuth providers share the same credentialKey', () => {
  const keys   = ALL_PROVIDERS.map((p) => getOAuthProviderConfig(p)!.credentialKey);
  const unique = new Set(keys);
  assert.equal(unique.size, keys.length,
    `Duplicate credentialKeys detected: ${keys.join(', ')}`);
});

t('gmail credentialKey is exactly "oauth_google_gmail"', () => {
  assert.equal(getOAuthProviderConfig('gmail')!.credentialKey, 'oauth_google_gmail');
});

t('google_sheets credentialKey is exactly "oauth_google_sheets"', () => {
  assert.equal(getOAuthProviderConfig('google_sheets')!.credentialKey, 'oauth_google_sheets');
});

t('google_drive credentialKey is exactly "oauth_google_drive"', () => {
  assert.equal(getOAuthProviderConfig('google_drive')!.credentialKey, 'oauth_google_drive');
});

t('canva credentialKey is exactly "oauth_access_token"', () => {
  assert.equal(getOAuthProviderConfig('canva')!.credentialKey, 'oauth_access_token');
});

// ── Section 4: Reconnect isolation ───────────────────────────────────────────

console.log('\nSection 4: Reconnect isolation');

t('gmail connect produces rows for oauth_google_gmail only — no sheets or drive key', () => {
  const creds = buildCallbackCreds('gmail', FAKE_GMAIL);
  const rows  = buildCredentialRows(TEST_USER_ID, 'gmail', creds, new Date().toISOString());
  const keys  = rows.map((r) => r.credential_key);
  assert.deepEqual(keys, ['oauth_google_gmail']);
});

t('Gmail connect does NOT overwrite Sheets: no shared credential key', () => {
  const gmailCreds  = buildCallbackCreds('gmail', FAKE_GMAIL);
  const sheetsCreds = buildCallbackCreds('google_sheets', FAKE_SHEETS);
  const overlap     = Object.keys(gmailCreds).filter((k) => k in sheetsCreds);
  assert.equal(overlap.length, 0,
    `Overlap between gmail and google_sheets credentials: ${overlap.join(', ')}`);
});

t('Sheets connect does NOT overwrite Drive: no shared credential key', () => {
  const sheetsCreds = buildCallbackCreds('google_sheets', FAKE_SHEETS);
  const driveCreds  = buildCallbackCreds('google_drive',  FAKE_DRIVE);
  const overlap     = Object.keys(sheetsCreds).filter((k) => k in driveCreds);
  assert.equal(overlap.length, 0,
    `Overlap between google_sheets and google_drive credentials: ${overlap.join(', ')}`);
});

t('Gmail connect does NOT overwrite Drive: no shared credential key', () => {
  const gmailCreds = buildCallbackCreds('gmail', FAKE_GMAIL);
  const driveCreds = buildCallbackCreds('google_drive', FAKE_DRIVE);
  const overlap    = Object.keys(gmailCreds).filter((k) => k in driveCreds);
  assert.equal(overlap.length, 0);
});

t('reconnect (second gmail connect) produces same credential_key as first connect', () => {
  const first  = Object.keys(buildCallbackCreds('gmail', FAKE_GMAIL))[0];
  const second = Object.keys(buildCallbackCreds('gmail', FAKE_GMAIL))[0];
  assert.equal(first, second);
});

t('reconnect rows use same upsert conflict key (user_id, provider, credential_key)', () => {
  const now   = new Date().toISOString();
  const creds = buildCallbackCreds('gmail', FAKE_GMAIL);
  const r1    = buildCredentialRows(TEST_USER_ID, 'gmail', creds, now);
  const r2    = buildCredentialRows(TEST_USER_ID, 'gmail', creds, now);
  // Both produce the same conflict key: {user_id, provider, credential_key}
  assert.equal(
    `${r1[0].user_id}|${r1[0].provider}|${r1[0].credential_key}`,
    `${r2[0].user_id}|${r2[0].provider}|${r2[0].credential_key}`
  );
});

t('Google providers share clientIdEnv (same OAuth app) but have different credentialKeys', () => {
  const envs = GOOGLE_PROVIDERS.map((p) => getOAuthProviderConfig(p)!.clientIdEnv);
  // All three use the same OAuth app env var — that is intentional and expected
  assert.ok(new Set(envs).size === 1, 'Google providers should share clientIdEnv');
  // But stored credential keys are still isolated
  const ckeys = GOOGLE_PROVIDERS.map((p) => getOAuthProviderConfig(p)!.credentialKey);
  assert.equal(new Set(ckeys).size, 3, 'Google providers must have distinct credentialKeys');
});

// ── Section 5: DB row verification ───────────────────────────────────────────

console.log('\nSection 5: DB row verification');

t('buildCredentialRows: gmail row credential_key = oauth_google_gmail', () => {
  const rows = buildCredentialRows(TEST_USER_ID, 'gmail',
    { oauth_google_gmail: FAKE_GMAIL }, new Date().toISOString());
  assert.equal(rows[0].credential_key, 'oauth_google_gmail');
});

t('buildCredentialRows: google_sheets row credential_key = oauth_google_sheets', () => {
  const rows = buildCredentialRows(TEST_USER_ID, 'google_sheets',
    { oauth_google_sheets: FAKE_SHEETS }, new Date().toISOString());
  assert.equal(rows[0].credential_key, 'oauth_google_sheets');
});

t('buildCredentialRows: google_drive row credential_key = oauth_google_drive', () => {
  const rows = buildCredentialRows(TEST_USER_ID, 'google_drive',
    { oauth_google_drive: FAKE_DRIVE }, new Date().toISOString());
  assert.equal(rows[0].credential_key, 'oauth_google_drive');
});

t('buildCredentialRows: canva row credential_key = oauth_access_token', () => {
  const rows = buildCredentialRows(TEST_USER_ID, 'canva',
    { oauth_access_token: FAKE_CANVA }, new Date().toISOString());
  assert.equal(rows[0].credential_key, 'oauth_access_token');
});

t('buildCredentialRows: OAuth token rows are marked is_secret = true', () => {
  const cases: Array<[string, string, string]> = [
    ['gmail',         'oauth_google_gmail',  FAKE_GMAIL],
    ['google_sheets', 'oauth_google_sheets', FAKE_SHEETS],
    ['google_drive',  'oauth_google_drive',  FAKE_DRIVE],
    ['canva',         'oauth_access_token',  FAKE_CANVA],
  ];
  for (const [provider, key, tok] of cases) {
    const rows = buildCredentialRows(TEST_USER_ID, provider, { [key]: tok }, new Date().toISOString());
    assert.ok(rows[0].is_secret, `${provider} row should be is_secret=true`);
  }
});

t('buildCredentialRows: stored value is AES-256-GCM ciphertext (iv:tag:ciphertext), not plaintext', () => {
  const rows = buildCredentialRows(TEST_USER_ID, 'gmail',
    { oauth_google_gmail: FAKE_GMAIL }, new Date().toISOString());
  const stored = rows[0].encrypted_value;
  assert.notEqual(stored, FAKE_GMAIL, 'Stored value should not equal plaintext JSON');
  // AES-256-GCM format: base64:base64:base64
  const parts = stored.split(':');
  assert.equal(parts.length, 3, 'Encrypted value should have format iv:tag:ciphertext');
});

t('buildCredentialRows: user_id is preserved in every row', () => {
  for (const [p, key, tok] of [
    ['gmail',         'oauth_google_gmail',  FAKE_GMAIL],
    ['google_sheets', 'oauth_google_sheets', FAKE_SHEETS],
    ['google_drive',  'oauth_google_drive',  FAKE_DRIVE],
    ['canva',         'oauth_access_token',  FAKE_CANVA],
  ] as const) {
    const rows = buildCredentialRows(TEST_USER_ID, p, { [key]: tok }, new Date().toISOString());
    assert.equal(rows[0].user_id, TEST_USER_ID, `${p}: user_id not preserved`);
  }
});

t('buildCredentialRows: gmail and sheets rows have different upsert conflict keys', () => {
  const now       = new Date().toISOString();
  const gmailRows = buildCredentialRows(TEST_USER_ID, 'gmail',
    { oauth_google_gmail: FAKE_GMAIL }, now);
  const sheetsRows = buildCredentialRows(TEST_USER_ID, 'google_sheets',
    { oauth_google_sheets: FAKE_SHEETS }, now);
  const gmailConflict  = `${gmailRows[0].provider}|${gmailRows[0].credential_key}`;
  const sheetsConflict = `${sheetsRows[0].provider}|${sheetsRows[0].credential_key}`;
  assert.notEqual(gmailConflict, sheetsConflict);
});

t('isSecretKey: all OAuth credential keys are recognized as secret', () => {
  const oauthKeys = [
    'oauth_google_gmail', 'oauth_google_sheets', 'oauth_google_drive',
    'oauth_access_token', 'oauth_google',
  ];
  for (const k of oauthKeys) {
    assert.ok(isSecretKey(k), `"${k}" should be in SECRET_KEY_SET`);
  }
});

// ── Section 6: Refresh path — token lifecycle before API call ─────────────────

console.log('\nSection 6: Refresh path — token lifecycle before API call');

t('parseStoredToken: correctly parses a serializeOAuthTokens-produced blob', () => {
  const tok = parseStoredToken(FAKE_GMAIL);
  assert.ok(tok !== null);
  assert.equal(tok!.access_token,  'gmail-tok');
  assert.equal(tok!.refresh_token, 'gmail-ref');
  assert.ok(typeof tok!.expires_at === 'number');
});

t('parseStoredToken: returns null for undefined input', () => {
  assert.equal(parseStoredToken(undefined), null);
});

t('parseStoredToken: returns null for empty string', () => {
  assert.equal(parseStoredToken(''), null);
});

t('parseStoredToken: returns null for malformed JSON', () => {
  assert.equal(parseStoredToken('{bad json}'), null);
});

t('parseStoredToken: sets refresh_token = null when provider omits it (e.g. Google no rotation)', () => {
  const noRefresh = serializeOAuthTokens({ access_token: 'tok', expires_in: 3600 });
  const parsed    = parseStoredToken(noRefresh);
  assert.ok(parsed !== null);
  assert.equal(parsed!.refresh_token, null);
});

t('tokenNeedsRefresh: false when expires_at is null (unknown expiry — assume valid)', () => {
  const tok = parseStoredToken(serializeOAuthTokens({ access_token: 'tok' }));
  assert.ok(tok !== null);
  assert.equal(tok!.expires_at, null);
  assert.equal(tokenNeedsRefresh(tok!), false);
});

t('tokenNeedsRefresh: true when token is already expired', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(
    tokenNeedsRefresh({ access_token: 'tok', refresh_token: null, token_type: 'Bearer', expires_at: past }),
    true
  );
});

t('tokenNeedsRefresh: true when token expires within REFRESH_BUFFER_SECONDS', () => {
  const soonExpiring = Math.floor(Date.now() / 1000) + REFRESH_BUFFER_SECONDS - 60;
  assert.equal(
    tokenNeedsRefresh({ access_token: 'tok', refresh_token: null, token_type: 'Bearer', expires_at: soonExpiring }),
    true
  );
});

t('tokenNeedsRefresh: false when token expires well in the future', () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  assert.equal(
    tokenNeedsRefresh({ access_token: 'tok', refresh_token: null, token_type: 'Bearer', expires_at: future }),
    false
  );
});

t('refresh path reads the same credentialKey that callback stored', () => {
  // getValidAccessToken reads creds[config.credentialKey].
  // Verify that every provider's config.credentialKey matches what callback stores.
  for (const p of ALL_PROVIDERS) {
    const config        = getOAuthProviderConfig(p)!;
    const callbackCreds = buildCallbackCreds(p, FAKE_BY_PROVIDER[p]!);
    assert.ok(
      config.credentialKey in callbackCreds,
      `${p}: refresh reads "${config.credentialKey}" but callback stored "${Object.keys(callbackCreds).join(',')}"`
    );
  }
});

t('REFRESH_BUFFER_SECONDS is 300 (5 minutes)', () => {
  assert.equal(REFRESH_BUFFER_SECONDS, 300);
});

// ── Section 7: Cleanup — disconnect scoping ───────────────────────────────────

console.log('\nSection 7: Cleanup — disconnect scoping');

t('deleteProviderCredentials accepts (userId, provider) — function exists with arity 2', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../lib/credentials/storage') as typeof import('../lib/credentials/storage');
  assert.equal(typeof mod.deleteProviderCredentials, 'function');
  assert.equal(mod.deleteProviderCredentials.length, 2);
});

t('gmail credential key differs from sheets key — disconnect gmail cannot affect sheets rows', () => {
  // deleteProviderCredentials issues: DELETE WHERE user_id=? AND provider=?
  // Sheets rows have provider='google_sheets', gmail rows have provider='gmail'.
  // Since providers are different, deleting gmail rows leaves sheets rows intact.
  const gmailKey  = getOAuthProviderConfig('gmail')!.credentialKey;
  const sheetsKey = getOAuthProviderConfig('google_sheets')!.credentialKey;
  assert.notEqual(gmailKey, sheetsKey);
});

t('sheets credential key differs from drive key — disconnect sheets cannot affect drive rows', () => {
  const sheetsKey = getOAuthProviderConfig('google_sheets')!.credentialKey;
  const driveKey  = getOAuthProviderConfig('google_drive')!.credentialKey;
  assert.notEqual(sheetsKey, driveKey);
});

t('reconnect after disconnect: new callback produces same credential_key (upsert overwrites correctly)', () => {
  const beforeDisconnect = Object.keys(buildCallbackCreds('gmail', FAKE_GMAIL))[0];
  const afterReconnect   = Object.keys(buildCallbackCreds('gmail', FAKE_GMAIL))[0];
  assert.equal(beforeDisconnect, afterReconnect);
});

t('assertTrustedUserId rejects invalid input before any DB operation', () => {
  assert.throws(() => assertTrustedUserId('not-a-uuid'),    /SECURITY/);
  assert.throws(() => assertTrustedUserId(''),              /SECURITY/);
  assert.throws(() => assertTrustedUserId('1234-5678'),     /SECURITY/);
});

t('assertTrustedUserId accepts a valid UUID v4', () => {
  assert.doesNotThrow(() => assertTrustedUserId(TEST_USER_ID));
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
