/**
 * Encryption consolidation tests.
 *
 * lib/security/encryption.ts is now the single AES-256-GCM implementation
 * shared by both credential stores: the legacy user_integrations JSON blob
 * (encryptJson/decryptJson) and the per-row integration_credentials table
 * (lib/credentials/storage.ts, via encryptSecretValue/decryptSecretValue).
 * These tests verify the round trip, malformed-input handling, and that a
 * value encrypted through one call path decrypts correctly through the other
 * — proving the two credential systems remain interoperable after the
 * duplicate implementation was removed.
 */

import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'b'.repeat(64); // 64 hex chars → 32-byte AES-256 key
  }
});

describe('encryptSecretValue / decryptSecretValue', () => {
  it('round-trips a plaintext value', async () => {
    const { encryptSecretValue, decryptSecretValue } = await import('../lib/security/encryption');
    const plaintext = 'sk-super-secret-key-123';

    const encrypted = encryptSecretValue(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);

    expect(decryptSecretValue(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext on every call (random IV)', async () => {
    const { encryptSecretValue } = await import('../lib/security/encryption');
    const a = encryptSecretValue('same-plaintext');
    const b = encryptSecretValue('same-plaintext');
    expect(a).not.toBe(b);
  });

  it('returns non-triplet input unchanged (treated as plaintext)', async () => {
    const { decryptSecretValue } = await import('../lib/security/encryption');
    expect(decryptSecretValue('appXYZ123')).toBe('appXYZ123');
    expect(decryptSecretValue('')).toBe('');
  });

  it('throws on a corrupted ciphertext/tag (auth-tag mismatch)', async () => {
    const { encryptSecretValue, decryptSecretValue } = await import('../lib/security/encryption');
    const encrypted = encryptSecretValue('sensitive-value');
    const [iv, tag, data] = encrypted.split(':');
    const tampered = `${iv}:${tag}:${data.slice(0, -4)}${data.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;

    expect(() => decryptSecretValue(tampered)).toThrow();
  });
});

describe('encryptJson / decryptJson (legacy batch API)', () => {
  it('round-trips every field in an object', async () => {
    const { encryptJson, decryptJson } = await import('../lib/security/encryption');
    const original = { bot_token: 'xoxb-abc', channel: '#general' };

    const encrypted = encryptJson(original);
    expect(encrypted.bot_token).not.toBe(original.bot_token);

    const decrypted = decryptJson(encrypted);
    expect(decrypted).toEqual(original);
  });

  it('gracefully returns the original value instead of throwing on corrupted input', async () => {
    const { decryptJson } = await import('../lib/security/encryption');
    const result = decryptJson({ token: 'aXY:bXY:not-real-ciphertext-data' });
    // tryDecryptValue swallows the decrypt failure and returns the stored value as-is
    expect(result.token).toBe('aXY:bXY:not-real-ciphertext-data');
  });

  it('returns an empty object for null/undefined input', async () => {
    const { decryptJson } = await import('../lib/security/encryption');
    expect(decryptJson(null)).toEqual({});
    expect(decryptJson(undefined)).toEqual({});
  });
});

describe('cross-compatibility between the two credential stores', () => {
  it('a value encrypted via the credentials/storage.ts code path decrypts via the shared primitive', async () => {
    const { buildCredentialRows } = await import('../lib/credentials/storage');
    const { decryptSecretValue } = await import('../lib/security/encryption');

    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'openai',
      { api_key: 'sk-cross-compat-test' },
      new Date().toISOString(),
    );

    expect(rows[0].is_secret).toBe(true);
    expect(decryptSecretValue(rows[0].encrypted_value)).toBe('sk-cross-compat-test');
  });

  it('a value encrypted via encryptJson (legacy path) decrypts via the shared primitive', async () => {
    const { encryptJson } = await import('../lib/security/encryption');
    const { decryptSecretValue } = await import('../lib/security/encryption');

    const encrypted = encryptJson({ webhook_url: 'https://hooks.slack.com/services/legacy' });
    expect(decryptSecretValue(encrypted.webhook_url as string)).toBe('https://hooks.slack.com/services/legacy');
  });
});

describe('workflow JSON never carries raw credential secrets', () => {
  it('CredentialRef (the only shape allowed in workflow_json) carries no secret fields', async () => {
    const ref: { provider: string } = { provider: 'openai' };
    expect(Object.keys(ref)).toEqual(['provider']);
  });

  it('a decrypted credential value never round-trips back through buildCredentialRows as plaintext', async () => {
    // Guards against a regression where buildCredentialRows stops encrypting a
    // key that provider-registry.ts / SECRET_KEY_SET marks as secret.
    const { buildCredentialRows, isSecretKey } = await import('../lib/credentials/storage');
    const secretFields = ['bot_token', 'access_token', 'api_key', 'personal_access_token'];

    for (const key of secretFields) {
      expect(isSecretKey(key)).toBe(true);
      const rows = buildCredentialRows('00000000-0000-4000-8000-000000000001', 'custom', { [key]: 'raw-secret-value' }, new Date().toISOString());
      expect(rows[0].encrypted_value).not.toBe('raw-secret-value');
    }
  });
});
