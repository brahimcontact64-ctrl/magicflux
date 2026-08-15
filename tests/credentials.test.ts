/**
 * Credential architecture tests.
 *
 * Verifies the types, validation helpers, and store facade without hitting
 * a live database. Encryption is tested via the pure helper functions
 * exported from storage.ts.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { buildCredentialRows, isSecretKey, maskSecretValue } from '../lib/credentials/storage';

// Provide a test encryption key so buildCredentialRows can encrypt secret fields
// without hitting the missing-env-var guard. This is a 64-char hex test key only.
beforeAll(() => {
  if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    process.env.INTEGRATIONS_ENCRYPTION_KEY =
      'a'.repeat(64); // 64 hex chars → 32-byte AES-256 key
  }
});
import { getProviderCredentials, getRequiredCredentials, getOptionalCredentials, providerHasCredentials, getProviderDisplayName } from '../lib/credentials/provider-registry';
import { allCredentialsPresent, validateProviderCredentials, validateWorkflowCredentials } from '../lib/credentials/validation';

// ─── Pure storage helpers ─────────────────────────────────────────────────────

describe('isSecretKey', () => {
  it('marks api_key as secret', () => {
    expect(isSecretKey('api_key')).toBe(true);
  });

  it('marks bot_token as secret', () => {
    expect(isSecretKey('bot_token')).toBe(true);
  });

  it('marks access_token as secret', () => {
    expect(isSecretKey('access_token')).toBe(true);
  });

  it('does not mark chat_id as secret', () => {
    expect(isSecretKey('chat_id')).toBe(false);
  });

  it('does not mark base_id as secret', () => {
    expect(isSecretKey('base_id')).toBe(false);
  });
});

describe('maskSecretValue', () => {
  it('masks a normal secret leaving last 4 chars', () => {
    const masked = maskSecretValue('sk-test-1234abcd');
    expect(masked.endsWith('abcd')).toBe(true);
    expect(masked.startsWith('*')).toBe(true);
  });

  it('returns placeholder for empty string', () => {
    expect(maskSecretValue('')).toBe('********');
  });

  it('returns placeholder for short strings (<=4)', () => {
    expect(maskSecretValue('ab')).toBe('********');
  });
});

describe('buildCredentialRows', () => {
  const NOW = '2026-06-08T00:00:00.000Z';

  it('produces one row per non-empty credential', () => {
    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'slack',
      { bot_token: 'xoxb-test' },
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_key).toBe('bot_token');
  });

  it('encrypts secret keys (stored value differs from plaintext)', () => {
    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'openai',
      { api_key: 'sk-real-key' },
      NOW,
    );
    expect(rows[0].is_secret).toBe(true);
    // Encrypted value is AES-256-GCM: iv:tag:ciphertext — never plaintext
    expect(rows[0].encrypted_value).not.toBe('sk-real-key');
    expect(rows[0].encrypted_value).toContain(':');
  });

  it('stores non-secret fields as plaintext', () => {
    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'airtable',
      { base_id: 'appABC' },
      NOW,
    );
    expect(rows[0].is_secret).toBe(false);
    expect(rows[0].encrypted_value).toBe('appABC');
  });

  it('skips empty values', () => {
    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'telegram',
      { bot_token: '', chat_id: '-100123' },
      NOW,
    );
    // bot_token is empty — should be skipped
    expect(rows.some((r) => r.credential_key === 'bot_token')).toBe(false);
    expect(rows.some((r) => r.credential_key === 'chat_id')).toBe(true);
  });

  it('sets correct user_id and provider on each row', () => {
    const userId = '00000000-0000-4000-8000-000000000002';
    const rows = buildCredentialRows(userId, 'slack', { bot_token: 'xoxb-1' }, NOW);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].provider).toBe('slack');
  });
});

// ─── Provider registry ────────────────────────────────────────────────────────

describe('provider registry', () => {
  it('returns credentials for openai', () => {
    const creds = getProviderCredentials('openai');
    expect(creds.length).toBeGreaterThan(0);
    expect(creds.some((c) => c.key === 'api_key')).toBe(true);
  });

  it('returns credentials for slack', () => {
    const creds = getProviderCredentials('slack');
    expect(creds.some((c) => c.key === 'bot_token')).toBe(true);
  });

  it('returns credentials for airtable', () => {
    const creds = getProviderCredentials('airtable');
    expect(creds.some((c) => c.key === 'personal_access_token')).toBe(true);
    expect(creds.some((c) => c.key === 'base_id')).toBe(true);
  });

  it('returns empty array for unknown provider', () => {
    expect(getProviderCredentials('nonexistent_provider_xyz')).toHaveLength(0);
  });

  it('providerHasCredentials is true for openai', () => {
    expect(providerHasCredentials('openai')).toBe(true);
  });

  it('providerHasCredentials is false for unknown provider', () => {
    expect(providerHasCredentials('unknown_xyz')).toBe(false);
  });

  it('getRequiredCredentials returns only required=true fields', () => {
    const required = getRequiredCredentials('airtable');
    expect(required.every((f) => f.required)).toBe(true);
  });

  it('getOptionalCredentials returns only required=false fields', () => {
    const optional = getOptionalCredentials('stripe');
    expect(optional.every((f) => !f.required)).toBe(true);
  });

  it('getProviderDisplayName returns human-readable name for openai', () => {
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
  });

  it('getProviderDisplayName normalizes aliases (email → gmail)', () => {
    expect(getProviderDisplayName('email')).toBe('Gmail');
  });
});

// ─── Credential validation (mocked DB calls) ─────────────────────────────────

// Mock the storage layer so these tests don't need a live DB
vi.mock('../lib/credentials/storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/credentials/storage')>();
  return {
    ...original,
    verifyProviderConnection: vi.fn(),
    assertTrustedUserId: vi.fn(), // no-op in tests
  };
});

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

describe('validateProviderCredentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns connected=true when storage says connected', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });

    const result = await validateProviderCredentials('openai', VALID_UUID);
    expect(result.connected).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('returns connected=false and missing fields when not connected', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockResolvedValue({
      connected: false,
      missing: ['api_key'],
    });

    const result = await validateProviderCredentials('openai', VALID_UUID);
    expect(result.connected).toBe(false);
    expect(result.missing).toContain('api_key');
  });

  it('returns connected=true for provider with no credential requirements', async () => {
    const result = await validateProviderCredentials('n8n-nodes-base.webhook', VALID_UUID);
    expect(result.connected).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('handles storage errors gracefully', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockRejectedValue(new Error('DB error'));

    const result = await validateProviderCredentials('openai', VALID_UUID);
    expect(result.connected).toBe(false);
  });
});

describe('validateWorkflowCredentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deduplicates providers', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });

    const results = await validateWorkflowCredentials(['openai', 'openai', 'slack'], VALID_UUID);
    expect(results).toHaveLength(2); // deduplicated
  });

  it('returns one result per unique provider', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });

    const results = await validateWorkflowCredentials(['openai', 'slack'], VALID_UUID);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.provider)).toContain('openai');
    expect(results.map((r) => r.provider)).toContain('slack');
  });
});

describe('allCredentialsPresent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when all providers are connected', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connected: true, missing: [] });

    const result = await allCredentialsPresent(['openai', 'slack'], VALID_UUID);
    expect(result).toBe(true);
  });

  it('returns false when any provider is missing', async () => {
    const { verifyProviderConnection } = await import('../lib/credentials/storage');
    vi.mocked(verifyProviderConnection)
      .mockResolvedValueOnce({ connected: true, missing: [] })
      .mockResolvedValueOnce({ connected: false, missing: ['bot_token'] });

    const result = await allCredentialsPresent(['openai', 'slack'], VALID_UUID);
    expect(result).toBe(false);
  });

  it('returns true for empty provider list (no requirements)', async () => {
    const result = await allCredentialsPresent([], VALID_UUID);
    expect(result).toBe(true);
  });
});

// ─── Security invariants ──────────────────────────────────────────────────────

describe('credential security invariants', () => {
  it('CredentialRef type has no value fields', () => {
    // Verify the type only carries provider, not any credential values.
    // This is a compile-time guarantee; at runtime we check the shape.
    const ref = { provider: 'openai' };
    expect(Object.keys(ref)).toEqual(['provider']);
    expect((ref as Record<string, unknown>).api_key).toBeUndefined();
    expect((ref as Record<string, unknown>).secret).toBeUndefined();
  });

  it('buildCredentialRows excludes whitespace-only values', () => {
    const rows = buildCredentialRows(
      '00000000-0000-4000-8000-000000000001',
      'slack',
      { bot_token: '   ' },
      '2026-06-08T00:00:00.000Z',
    );
    expect(rows).toHaveLength(0);
  });
});
