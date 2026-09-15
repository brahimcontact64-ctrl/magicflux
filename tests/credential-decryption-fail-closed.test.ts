/**
 * Phase 9.9.5C — credential decryption fail-closed hardening.
 *
 * Root cause fixed: decryptJson()/decryptIntegrationCredentials()
 * (lib/security/encryption.ts) used to catch ANY authenticated AES-256-GCM
 * decryption failure -- wrong INTEGRATIONS_ENCRYPTION_KEY, corrupted
 * ciphertext, a tampered auth tag -- and silently return the RAW,
 * STILL-ENCRYPTED ciphertext string as if it were the plaintext credential.
 * A caller (the Airtable/Slack/Email node handlers, via
 * lib/user-integrations.ts's getUserIntegrations()) would then send that
 * ciphertext to the real provider's Authorization header, which the
 * provider correctly rejects -- but the actual local failure (a bad key or
 * corrupted data) was invisible everywhere, looking exactly like "the
 * credential itself is bad" instead of "this environment can't decrypt it."
 *
 * This proved to be the exact mechanism that could explain the real
 * production Airtable 401 investigated in Phase 9.9.5B: if the persistent
 * Railway worker's INTEGRATIONS_ENCRYPTION_KEY ever differs from the key
 * that encrypted a credential, decryption fails, and the OLD code would
 * silently hand the ciphertext to Airtable as a bearer token -- Airtable's
 * own documented behavior classifies exactly that (an unrecognized/
 * malformed token) as 401 AUTHENTICATION_REQUIRED, not 403.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const REAL_KEY = 'a'.repeat(64); // 64 hex chars -> valid 32-byte AES-256 key
const WRONG_KEY = 'f'.repeat(64); // a different, equally valid-shaped key

beforeEach(() => {
  vi.resetModules();
  process.env.INTEGRATIONS_ENCRYPTION_KEY = REAL_KEY;
});

describe('decryptSecretValue / decryptJson -- fail-closed on genuine encrypted envelopes', () => {
  it('correct key: decrypts back to the exact original plaintext credential', async () => {
    const { encryptSecretValue, decryptSecretValue } = await import('../lib/security/encryption');
    const plaintext = 'patABCDEF1234567890.veryrealtoken';
    const encrypted = encryptSecretValue(plaintext);
    expect(decryptSecretValue(encrypted)).toBe(plaintext);
  });

  it('wrong key on a genuinely encrypted value: throws a deterministic CredentialDecryptionError, never returns the ciphertext or garbage plaintext', async () => {
    const { encryptSecretValue } = await import('../lib/security/encryption');
    const encrypted = encryptSecretValue('sk-should-never-leak-anywhere');

    process.env.INTEGRATIONS_ENCRYPTION_KEY = WRONG_KEY;
    vi.resetModules();
    const { decryptSecretValue, CredentialDecryptionError } = await import('../lib/security/encryption');

    let thrown: unknown;
    try {
      decryptSecretValue(encrypted);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialDecryptionError);
    // The error itself must never carry the ciphertext, ivs, tags, or key.
    const message = (thrown as Error).message;
    expect(message).not.toContain(encrypted);
    for (const part of encrypted.split(':')) expect(message).not.toContain(part);
    expect(message).not.toContain(REAL_KEY);
    expect(message).not.toContain(WRONG_KEY);
  });

  it('corrupted ciphertext/tag on a genuine envelope: fails closed the same way as a wrong key', async () => {
    const { encryptSecretValue, decryptSecretValue, CredentialDecryptionError } = await import('../lib/security/encryption');
    const encrypted = encryptSecretValue('another-real-secret');
    const [iv, tag, data] = encrypted.split(':');
    const tampered = `${iv}:${tag}:${data.slice(0, -4)}${data.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;

    expect(() => decryptSecretValue(tampered)).toThrow(CredentialDecryptionError);
  });

  it('decryptJson (batch/legacy API) propagates the same fail-closed error for any field that fails', async () => {
    const { encryptJson } = await import('../lib/security/encryption');
    const encrypted = encryptJson({ personal_access_token: 'pat-real-value', base_id: 'appXYZ' });

    process.env.INTEGRATIONS_ENCRYPTION_KEY = WRONG_KEY;
    vi.resetModules();
    // Re-import CredentialDecryptionError from the SAME post-reset module
    // instance as decryptJson -- vi.resetModules() re-instantiates the
    // module, so a class reference captured before the reset would be a
    // different (non-matching) constructor for `instanceof` purposes.
    const { decryptJson, CredentialDecryptionError } = await import('../lib/security/encryption');

    expect(() => decryptJson(encrypted)).toThrow(CredentialDecryptionError);
  });

  it('legacy plaintext credential (never encrypted) remains fully supported -- no false-positive envelope detection', async () => {
    const { decryptJson, decryptIntegrationCredentials } = await import('../lib/security/encryption');
    // A real-shaped legacy plaintext value that happens to contain colons
    // (e.g. a webhook URL) must never be mistaken for an encrypted envelope.
    const legacy = { webhook_url: 'https://hooks.slack.com/services/T00/B00/xyz', smtp_port: '587' };
    expect(decryptJson(legacy)).toEqual(legacy);
    expect(decryptIntegrationCredentials(legacy)).toEqual(legacy);
  });

  it('isEncryptedEnvelope requires exact GCM IV (12 bytes) and tag (16 bytes) lengths, not just three colon-separated parts', async () => {
    const { isEncryptedEnvelope } = await import('../lib/security/encryption');
    // Three colon-separated, valid-base64 parts, but wrong byte lengths --
    // must not be misclassified as a real encrypted envelope.
    const fakeIv = Buffer.from('short').toString('base64'); // 5 bytes, not 12
    const fakeTag = Buffer.from('also-not-sixteen-bytes-long').toString('base64'); // wrong length
    const fakeData = Buffer.from('data').toString('base64');
    expect(isEncryptedEnvelope(`${fakeIv}:${fakeTag}:${fakeData}`)).toBe(false);

    const realIv = Buffer.alloc(12, 1).toString('base64');
    const realTag = Buffer.alloc(16, 2).toString('base64');
    expect(isEncryptedEnvelope(`${realIv}:${realTag}:${fakeData}`)).toBe(true);
  });
});

describe('no decrypted-failure ciphertext ever reaches an external provider handler', () => {
  const OWNER_ID = '00000000-0000-4000-8000-0000000000c1';

  function mockSupabaseWithCorruptedAirtableCredential() {
    // A row whose stored 'credentials' blob is a well-formed encrypted
    // envelope (right shape) that will fail to decrypt under whatever key
    // is active when getUserIntegrations() runs -- simulating exactly a
    // Railway/Vercel key mismatch, without ever needing a real wrong key
    // in this test (mockable independent of the outer beforeEach's key).
    const corruptedEnvelope = `${Buffer.alloc(12, 9).toString('base64')}:${Buffer.alloc(16, 9).toString('base64')}:${Buffer.from('garbage').toString('base64')}`;

    vi.doMock('@/lib/supabase-server', () => ({
      createServiceClient: () => ({
        from: (table: string) => {
          if (table === 'user_integrations') {
            return {
              select: () => ({
                eq: () => Promise.resolve({
                  data: [{
                    id: 'int-airtable-1',
                    provider: 'airtable',
                    name: null,
                    credentials: { personal_access_token: corruptedEnvelope },
                    status: 'connected',
                    last_verified_at: null,
                    created_at: '2026-01-01',
                  }],
                  error: null,
                }),
              }),
            };
          }
          throw new Error(`unexpected table in test mock: ${table}`);
        },
      }),
    }));
    vi.doMock('@/lib/credentials/storage', () => ({
      getAllConnectedProviders: async () => [],
      verifyProviderConnection: async () => ({ connected: false }),
      getDecryptedProviderCredentials: async () => ({}),
    }));
  }

  it('a credential that fails to decrypt is reclassified as invalid with EMPTY credentials, never surfaced as connected/usable', async () => {
    vi.resetModules();
    mockSupabaseWithCorruptedAirtableCredential();
    const { getUserIntegrations } = await import('../lib/user-integrations');

    const all = await getUserIntegrations(OWNER_ID, { connectedOnly: false });
    const airtable = all.find((i) => i.provider === 'airtable');
    expect(airtable?.status).toBe('invalid');
    expect(airtable?.credentials).toEqual({});
  });

  it('connectedOnly resolution (the exact path runtime/workflow-engine.ts uses) excludes the undecryptable credential entirely -- it can never reach a node handler', async () => {
    vi.resetModules();
    mockSupabaseWithCorruptedAirtableCredential();
    const { getUserIntegrations } = await import('../lib/user-integrations');

    const connected = await getUserIntegrations(OWNER_ID, { connectedOnly: true });
    expect(connected.find((i) => i.provider === 'airtable')).toBeUndefined();
  });

  it('airtableHandler never sends a request when its resolved integration has empty credentials (the fail-closed shape getUserIntegrations now produces)', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const node = { id: '1', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'appX', tableId: 'tblY', operation: 'create', fields: {} } };
    const context = {
      mode: 'live' as const,
      integrations: [{ provider: 'airtable' as const, credentials: {}, status: 'invalid' as const }],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await airtableHandler(node as never, {}, context as never);
    expect(result.status).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('slackHandler never sends a request when its resolved integration has empty credentials', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const node = { id: '1', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'hi' } };
    const context = {
      mode: 'live' as const,
      integrations: [{ provider: 'slack' as const, credentials: {}, status: 'invalid' as const }],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await slackHandler(node as never, {}, context as never);
    expect(result.status).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('emailHandler never sends a message when its resolved integration has empty credentials', async () => {
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node = { id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'hi', message: 'hi' } };
    const context = {
      mode: 'live' as const,
      integrations: [{ provider: 'gmail' as const, credentials: {}, status: 'invalid' as const }],
      sampleData: {},
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    };

    const result = await emailHandler(node as never, {}, context as never);
    expect(result.status).toBe('failed');
  });
});
