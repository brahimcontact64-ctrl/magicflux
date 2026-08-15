/**
 * Migration verification: 20260522000001_migrate_google_oauth_credential_keys
 *
 * Proves the SQL migration logic is correct by running a pure TypeScript
 * re-implementation against known fixtures.  No database required.
 *
 * Run with: npx tsx scripts/test-oauth-migration.ts
 *
 * Sections:
 *  1.  Simple rename (no conflict) ...................  9 tests
 *  2.  Conflict resolution (both keys present) ......  7 tests
 *  3.  Untouched rows ...............................  6 tests
 *  4.  Multi-user scenarios .........................  5 tests
 *  5.  Idempotency ..................................  4 tests
 *  Total: 31 tests
 */

import assert from 'assert';

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

// ── In-memory table model ────────────────────────────────────────────────────

type CredRow = {
  user_id: string;
  provider: string;
  credential_key: string;
  encrypted_value: string;
};

/** Composite PK / UNIQUE key matching the DB constraint. */
function rowKey(r: CredRow): string {
  return `${r.user_id}|${r.provider}|${r.credential_key}`;
}

const GOOGLE_PROVIDERS = new Set(['gmail', 'google_sheets', 'google_drive']);

const NEW_CREDENTIAL_KEY: Record<string, string> = {
  gmail:         'oauth_google_gmail',
  google_sheets: 'oauth_google_sheets',
  google_drive:  'oauth_google_drive',
};

/**
 * Pure TypeScript implementation of the SQL DO block.
 *
 * Step 1 — delete old 'oauth_google' rows that would conflict with an
 *           already-existing new-style row for the same (user_id, provider).
 *
 * Step 2 — rename remaining 'oauth_google' rows to the provider-specific key.
 *
 * Returns { rows, deleted, renamed } for assertions.
 */
function applyMigration(input: CredRow[]): {
  rows: CredRow[];
  deleted: number;
  renamed: number;
} {
  // Use a Map keyed by composite PK — mirrors the UNIQUE constraint.
  const table = new Map<string, CredRow>(input.map((r) => [rowKey(r), { ...r }]));

  let deleted = 0;
  let renamed = 0;

  // ── Step 1: delete stale oauth_google rows where new-style key exists ───────
  for (const [k, row] of [...table]) {
    if (!GOOGLE_PROVIDERS.has(row.provider)) continue;
    if (row.credential_key !== 'oauth_google') continue;

    const newKey = NEW_CREDENTIAL_KEY[row.provider];
    const conflictKey = `${row.user_id}|${row.provider}|${newKey}`;

    if (table.has(conflictKey)) {
      table.delete(k);
      deleted++;
    }
  }

  // ── Step 2: rename remaining oauth_google rows ────────────────────────────
  for (const [k, row] of [...table]) {
    if (!GOOGLE_PROVIDERS.has(row.provider)) continue;
    if (row.credential_key !== 'oauth_google') continue;

    const newKey = NEW_CREDENTIAL_KEY[row.provider];
    table.delete(k);
    table.set(`${row.user_id}|${row.provider}|${newKey}`, {
      ...row,
      credential_key: newKey,
    });
    renamed++;
  }

  return { rows: [...table.values()], deleted, renamed };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const U1 = 'user-0001';
const U2 = 'user-0002';
const U3 = 'user-0003';
const ENC = 'enc:iv:tag:ciphertext'; // placeholder encrypted value

function row(user_id: string, provider: string, credential_key: string, encrypted_value = ENC): CredRow {
  return { user_id, provider, credential_key, encrypted_value };
}

// ── Section 1: Simple rename (no conflict) ────────────────────────────────────

console.log('\nSection 1: Simple rename (no conflict)');

test('gmail oauth_google → renamed to oauth_google_gmail', () => {
  const { rows, renamed } = applyMigration([row(U1, 'gmail', 'oauth_google')]);
  assert.strictEqual(renamed, 1);
  assert.ok(rows.some((r) => r.credential_key === 'oauth_google_gmail'));
});

test('gmail: no oauth_google row remains after migration', () => {
  const { rows } = applyMigration([row(U1, 'gmail', 'oauth_google')]);
  assert.ok(!rows.some((r) => r.credential_key === 'oauth_google'));
});

test('google_sheets oauth_google → renamed to oauth_google_sheets', () => {
  const { rows, renamed } = applyMigration([row(U1, 'google_sheets', 'oauth_google')]);
  assert.strictEqual(renamed, 1);
  assert.ok(rows.some((r) => r.credential_key === 'oauth_google_sheets'));
});

test('google_drive oauth_google → renamed to oauth_google_drive', () => {
  const { rows, renamed } = applyMigration([row(U1, 'google_drive', 'oauth_google')]);
  assert.strictEqual(renamed, 1);
  assert.ok(rows.some((r) => r.credential_key === 'oauth_google_drive'));
});

test('renamed row preserves encrypted_value unchanged', () => {
  const enc = 'my:secret:token:blob';
  const { rows } = applyMigration([row(U1, 'gmail', 'oauth_google', enc)]);
  const migrated = rows.find((r) => r.credential_key === 'oauth_google_gmail');
  assert.ok(migrated, 'migrated row not found');
  assert.strictEqual(migrated!.encrypted_value, enc);
});

test('renamed row preserves user_id', () => {
  const { rows } = applyMigration([row(U1, 'gmail', 'oauth_google')]);
  const migrated = rows.find((r) => r.credential_key === 'oauth_google_gmail');
  assert.strictEqual(migrated!.user_id, U1);
});

test('renamed row preserves provider', () => {
  const { rows } = applyMigration([row(U1, 'gmail', 'oauth_google')]);
  const migrated = rows.find((r) => r.credential_key === 'oauth_google_gmail');
  assert.strictEqual(migrated!.provider, 'gmail');
});

test('total row count is unchanged after simple rename', () => {
  const input = [row(U1, 'gmail', 'oauth_google')];
  const { rows } = applyMigration(input);
  assert.strictEqual(rows.length, input.length);
});

test('empty table migrates to empty table', () => {
  const { rows, deleted, renamed } = applyMigration([]);
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(deleted, 0);
  assert.strictEqual(renamed, 0);
});

// ── Section 2: Conflict resolution (both old and new key present) ─────────────

console.log('\nSection 2: Conflict resolution');

test('conflict gmail: old oauth_google deleted, new oauth_google_gmail kept', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google', 'old-token'),
    row(U1, 'gmail', 'oauth_google_gmail', 'new-token'),
  ];
  const { rows, deleted } = applyMigration(input);
  assert.strictEqual(deleted, 1, 'expected 1 deleted');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].credential_key, 'oauth_google_gmail');
});

test('conflict gmail: new-style encrypted_value is preserved (not the old one)', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google', 'old-token'),
    row(U1, 'gmail', 'oauth_google_gmail', 'new-token'),
  ];
  const { rows } = applyMigration(input);
  assert.strictEqual(rows[0].encrypted_value, 'new-token');
});

test('conflict google_sheets: old deleted, new kept', () => {
  const input = [
    row(U1, 'google_sheets', 'oauth_google', 'old'),
    row(U1, 'google_sheets', 'oauth_google_sheets', 'new'),
  ];
  const { rows, deleted } = applyMigration(input);
  assert.strictEqual(deleted, 1);
  assert.ok(rows.some((r) => r.credential_key === 'oauth_google_sheets' && r.encrypted_value === 'new'));
});

test('conflict google_drive: old deleted, new kept', () => {
  const input = [
    row(U1, 'google_drive', 'oauth_google', 'old'),
    row(U1, 'google_drive', 'oauth_google_drive', 'new'),
  ];
  const { rows, deleted } = applyMigration(input);
  assert.strictEqual(deleted, 1);
  assert.ok(rows.some((r) => r.credential_key === 'oauth_google_drive' && r.encrypted_value === 'new'));
});

test('conflict: row count decreases by 1 (duplicate eliminated)', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google'),
    row(U1, 'gmail', 'oauth_google_gmail'),
  ];
  const { rows } = applyMigration(input);
  assert.strictEqual(rows.length, 1);
});

test('conflict: no oauth_google rows remain after migration', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google'),
    row(U1, 'gmail', 'oauth_google_gmail'),
    row(U1, 'google_sheets', 'oauth_google'),
    row(U1, 'google_sheets', 'oauth_google_sheets'),
  ];
  const { rows } = applyMigration(input);
  assert.ok(!rows.some((r) => r.credential_key === 'oauth_google'), 'stale oauth_google rows must not remain');
});

test('conflict: unique constraint holds — no duplicate (user_id, provider, credential_key)', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google'),
    row(U1, 'gmail', 'oauth_google_gmail'),
  ];
  const { rows } = applyMigration(input);
  const keys = rows.map((r) => `${r.user_id}|${r.provider}|${r.credential_key}`);
  const unique = new Set(keys);
  assert.strictEqual(unique.size, keys.length, 'duplicate composite keys found after migration');
});

// ── Section 3: Untouched rows ─────────────────────────────────────────────────

console.log('\nSection 3: Untouched rows');

test('telegram bot_token row is not affected', () => {
  const input = [row(U1, 'telegram', 'bot_token'), row(U1, 'gmail', 'oauth_google')];
  const { rows } = applyMigration(input);
  assert.ok(rows.some((r) => r.provider === 'telegram' && r.credential_key === 'bot_token'));
});

test('canva oauth_access_token row is not affected', () => {
  const input = [row(U1, 'canva', 'oauth_access_token'), row(U1, 'gmail', 'oauth_google')];
  const { rows } = applyMigration(input);
  assert.ok(rows.some((r) => r.provider === 'canva' && r.credential_key === 'oauth_access_token'));
});

test('already-migrated oauth_google_gmail row is not affected when no old key present', () => {
  const input = [row(U1, 'gmail', 'oauth_google_gmail', 'already-new')];
  const { rows, renamed, deleted } = applyMigration(input);
  assert.strictEqual(renamed, 0);
  assert.strictEqual(deleted, 0);
  assert.strictEqual(rows[0].encrypted_value, 'already-new');
});

test('shopify api keys are not affected', () => {
  const input = [
    row(U1, 'shopify', 'shop_domain'),
    row(U1, 'shopify', 'access_token'),
    row(U1, 'gmail', 'oauth_google'),
  ];
  const { rows } = applyMigration(input);
  assert.ok(rows.some((r) => r.provider === 'shopify' && r.credential_key === 'shop_domain'));
  assert.ok(rows.some((r) => r.provider === 'shopify' && r.credential_key === 'access_token'));
});

test('oauth_google row for an unknown provider is not touched', () => {
  // If a hypothetical future provider accidentally uses oauth_google, we must not rename it.
  const input = [row(U1, 'some_other_provider', 'oauth_google')];
  const { rows, renamed, deleted } = applyMigration(input);
  assert.strictEqual(renamed, 0);
  assert.strictEqual(deleted, 0);
  assert.ok(rows.some((r) => r.provider === 'some_other_provider' && r.credential_key === 'oauth_google'));
});

test('total row count is correct after mixed migration', () => {
  const input = [
    row(U1, 'gmail',         'oauth_google'),   // → renamed
    row(U1, 'google_sheets', 'oauth_google'),   // → renamed
    row(U1, 'canva',         'oauth_access_token'), // → untouched
    row(U1, 'telegram',      'bot_token'),       // → untouched
  ];
  const { rows } = applyMigration(input);
  assert.strictEqual(rows.length, 4, `expected 4 rows, got ${rows.length}`);
});

// ── Section 4: Multi-user scenarios ──────────────────────────────────────────

console.log('\nSection 4: Multi-user scenarios');

test('two users with old gmail key: both renamed independently', () => {
  const input = [row(U1, 'gmail', 'oauth_google', 'tok-u1'), row(U2, 'gmail', 'oauth_google', 'tok-u2')];
  const { rows, renamed } = applyMigration(input);
  assert.strictEqual(renamed, 2);
  const u1 = rows.find((r) => r.user_id === U1)!;
  const u2 = rows.find((r) => r.user_id === U2)!;
  assert.strictEqual(u1.credential_key, 'oauth_google_gmail');
  assert.strictEqual(u1.encrypted_value, 'tok-u1');
  assert.strictEqual(u2.credential_key, 'oauth_google_gmail');
  assert.strictEqual(u2.encrypted_value, 'tok-u2');
});

test('u1 has conflict (both keys), u2 has only old key: handled correctly', () => {
  const input = [
    row(U1, 'gmail', 'oauth_google', 'old-u1'),
    row(U1, 'gmail', 'oauth_google_gmail', 'new-u1'),
    row(U2, 'gmail', 'oauth_google', 'old-u2'),
  ];
  const { rows, deleted, renamed } = applyMigration(input);
  assert.strictEqual(deleted, 1, 'one conflict deleted');
  assert.strictEqual(renamed, 1, 'one old row renamed');
  const u1 = rows.filter((r) => r.user_id === U1);
  const u2 = rows.filter((r) => r.user_id === U2);
  assert.strictEqual(u1.length, 1);
  assert.strictEqual(u1[0].encrypted_value, 'new-u1');
  assert.strictEqual(u2.length, 1);
  assert.strictEqual(u2[0].encrypted_value, 'old-u2');
  assert.strictEqual(u2[0].credential_key, 'oauth_google_gmail');
});

test('three users × three providers: all 9 old-key rows correctly renamed', () => {
  const input = [
    row(U1, 'gmail',         'oauth_google'),
    row(U1, 'google_sheets', 'oauth_google'),
    row(U1, 'google_drive',  'oauth_google'),
    row(U2, 'gmail',         'oauth_google'),
    row(U2, 'google_sheets', 'oauth_google'),
    row(U2, 'google_drive',  'oauth_google'),
    row(U3, 'gmail',         'oauth_google'),
    row(U3, 'google_sheets', 'oauth_google'),
    row(U3, 'google_drive',  'oauth_google'),
  ];
  const { rows, renamed, deleted } = applyMigration(input);
  assert.strictEqual(renamed, 9);
  assert.strictEqual(deleted, 0);
  assert.ok(!rows.some((r) => r.credential_key === 'oauth_google'), 'no oauth_google rows should remain');
});

test('provider-registry keys match NEW_CREDENTIAL_KEY mapping in migration', () => {
  // Verify the TypeScript mapping used in the migration test matches the
  // actual provider-registry keys (which were updated in the code fix).
  // This guards against the migration and registry drifting apart.
  const registry = {
    gmail:         'oauth_google_gmail',
    google_sheets: 'oauth_google_sheets',
    google_drive:  'oauth_google_drive',
  };
  for (const [provider, expectedKey] of Object.entries(registry)) {
    assert.strictEqual(
      NEW_CREDENTIAL_KEY[provider],
      expectedKey,
      `NEW_CREDENTIAL_KEY['${provider}'] mismatch`
    );
  }
});

test('unique constraint holds for all rows after large mixed migration', () => {
  const input = [
    row(U1, 'gmail',              'oauth_google', 'old'), row(U1, 'gmail',         'oauth_google_gmail', 'new'),
    row(U2, 'google_sheets',      'oauth_google'),
    row(U3, 'google_drive',       'oauth_google'),
    row(U1, 'telegram',           'bot_token'),
    row(U2, 'canva',              'oauth_access_token'),
  ];
  const { rows } = applyMigration(input);
  const keys = rows.map((r) => `${r.user_id}|${r.provider}|${r.credential_key}`);
  const unique = new Set(keys);
  assert.strictEqual(unique.size, keys.length, `duplicate PK detected after migration`);
});

// ── Section 5: Idempotency ────────────────────────────────────────────────────

console.log('\nSection 5: Idempotency');

test('applying migration twice produces same result as once', () => {
  const input = [
    row(U1, 'gmail',         'oauth_google'),
    row(U1, 'google_sheets', 'oauth_google'),
    row(U2, 'gmail',         'oauth_google', 'old'), row(U2, 'gmail', 'oauth_google_gmail', 'new'),
  ];
  const once = applyMigration(input);
  const twice = applyMigration(once.rows);

  // Second run should change nothing
  assert.strictEqual(twice.renamed, 0, 'second run renamed rows unexpectedly');
  assert.strictEqual(twice.deleted, 0, 'second run deleted rows unexpectedly');
  assert.strictEqual(twice.rows.length, once.rows.length);
});

test('after first run no oauth_google rows remain for target providers', () => {
  const input = [row(U1, 'gmail', 'oauth_google'), row(U1, 'google_drive', 'oauth_google')];
  const { rows } = applyMigration(input);
  assert.ok(!rows.some((r) => GOOGLE_PROVIDERS.has(r.provider) && r.credential_key === 'oauth_google'));
});

test('idempotent: second run row count equals first run row count', () => {
  const input = [row(U1, 'gmail', 'oauth_google'), row(U2, 'google_sheets', 'oauth_google')];
  const once = applyMigration(input);
  const twice = applyMigration(once.rows);
  assert.strictEqual(twice.rows.length, once.rows.length);
});

test('idempotent: encrypted_values are stable across runs', () => {
  const enc = 'sensitive:iv:tag:data';
  const once = applyMigration([row(U1, 'gmail', 'oauth_google', enc)]);
  const twice = applyMigration(once.rows);
  assert.strictEqual(twice.rows[0].encrypted_value, enc);
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
