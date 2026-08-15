import crypto from 'node:crypto';

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required for encryption');
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

// ─── Single-value primitives ───────────────────────────────────────────────────
// The one AES-256-GCM implementation shared by every credential store in this
// codebase (legacy user_integrations JSON blobs and the per-row
// integration_credentials table). Format: `iv:tag:ciphertext`, all base64.

export function encryptSecretValue(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Throws on malformed input or auth-tag mismatch — use when a decrypt failure must not be silently swallowed. */
export function decryptSecretValue(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) return stored; // plaintext or unknown format — return as-is
  const [ivB64, tagB64, dataB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Same as decryptSecretValue but never throws — returns the original value on any failure. */
function tryDecryptValue(stored: string): string {
  try {
    return decryptSecretValue(stored);
  } catch {
    return stored; // decryption failed — return original value unchanged
  }
}

// ─── Batch JSON helpers (legacy user_integrations credentials blob) ───────────

export function encryptJson(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v != null ? encryptSecretValue(String(v)) : v;
  }
  return out;
}

export function decryptJson(data: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v != null ? tryDecryptValue(String(v)) : '';
  }
  return out;
}

export const decryptIntegrationCredentials = decryptJson;
