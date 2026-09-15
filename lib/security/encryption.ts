import crypto from 'node:crypto';

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required for encryption');
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Phase 9.9.5C — thrown when a value that is unambiguously in MagicFlux's
 * own encrypted envelope format (see isEncryptedEnvelope() below) fails
 * authenticated decryption -- wrong key, corrupted ciphertext, or a
 * tampered auth tag. Deliberately generic: never carries the ciphertext,
 * key material, IV, tag, or any credential field, so it is always safe to
 * surface in a log line or a generic error response.
 *
 * Root cause this exists to fix: decryptJson()/decryptIntegrationCredentials()
 * previously caught exactly this failure and silently returned the RAW,
 * STILL-ENCRYPTED ciphertext string as if it were the decrypted plaintext
 * credential -- which a caller (e.g. the Airtable/Slack/Email node
 * handlers) would then send to the external provider's Authorization
 * header verbatim. A provider correctly rejects that as invalid
 * authentication, but the local failure that caused it was silently
 * swallowed instead of surfacing anywhere -- looking, from every log and
 * every runtime signal, exactly like "the credential is fine, the provider
 * just doesn't like it." This error type makes that failure loud and
 * local instead.
 */
export class CredentialDecryptionError extends Error {
  constructor(message = 'Credential decryption failed') {
    super(message);
    this.name = 'CredentialDecryptionError';
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Phase 9.9.5C — canonical recognition of MagicFlux's own AES-256-GCM
 * envelope format, replacing the previous `value.split(':').length === 3`
 * heuristic. That heuristic could not distinguish a genuine encrypted
 * envelope from ordinary legacy plaintext that merely happens to contain
 * exactly two colons (a URL with a port and a path segment, a timestamp-ish
 * string, etc.) -- requirement to never mistake arbitrary plaintext
 * containing ':' for encrypted data. encryptSecretValue() always produces
 * a 12-byte IV (crypto.randomBytes(12), the standard GCM nonce size) and a
 * 16-byte auth tag (cipher.getAuthTag() for aes-256-gcm is always 128
 * bits) -- checking both exact decoded byte lengths, not just the
 * colon-separated shape, is what the real encrypted envelope guarantees
 * and coincidental plaintext essentially never does.
 */
export function isEncryptedEnvelope(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) return false;
  if (!BASE64_RE.test(ivB64) || !BASE64_RE.test(tagB64) || !BASE64_RE.test(dataB64)) return false;
  try {
    if (Buffer.from(ivB64, 'base64').length !== 12) return false;
    if (Buffer.from(tagB64, 'base64').length !== 16) return false;
    return true;
  } catch {
    return false;
  }
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

/**
 * Phase 9.9.5C — fail-closed by construction. A value that is NOT
 * recognized as MagicFlux's own encrypted envelope (per isEncryptedEnvelope())
 * is genuine legacy plaintext (or truly unknown data this function has no
 * business touching) and is returned as-is, unchanged -- this is the ONLY
 * backward-compatibility path, and it is now based on the actual canonical
 * envelope shape rather than a coincidental colon count.
 *
 * A value that IS recognized as an encrypted envelope MUST decrypt
 * successfully -- AES-256-GCM is an authenticated cipher, so a wrong key
 * or corrupted ciphertext/tag cannot produce a plausible-but-wrong
 * plaintext; the auth-tag check inside decipher.final() cryptographically
 * fails and throws. This function lets that throw propagate as a
 * CredentialDecryptionError instead of ever returning the ciphertext
 * itself as if it were the secret.
 */
export function decryptSecretValue(stored: string): string {
  if (!isEncryptedEnvelope(stored)) return stored; // genuine legacy plaintext — returned as-is
  const [ivB64, tagB64, dataB64] = stored.split(':');
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Never rethrow the raw crypto error message -- Node's OpenSSL bindings
    // don't embed key/ciphertext in it, but normalizing here guarantees it
    // regardless of runtime/OpenSSL version, satisfying "never reveal
    // ciphertext, key material, IVs, tags" even in the error path itself.
    throw new CredentialDecryptionError();
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

/**
 * Phase 9.9.5C — fail-closed: throws CredentialDecryptionError if ANY field
 * that is recognized as an encrypted envelope fails to decrypt, instead of
 * the previous behavior of silently returning that field's raw ciphertext
 * as if it were the plaintext value. Genuine legacy plaintext fields (not
 * recognized as an encrypted envelope) are returned unchanged, exactly as
 * before -- this only changes behavior for values that ARE encrypted and
 * fail to decrypt, which was never a safe-to-ignore case to begin with.
 */
export function decryptJson(data: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v != null ? decryptSecretValue(String(v)) : '';
  }
  return out;
}

export const decryptIntegrationCredentials = decryptJson;
