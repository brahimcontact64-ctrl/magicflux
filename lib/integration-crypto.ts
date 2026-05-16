import crypto from 'node:crypto';

type EncryptedPayload = {
  __enc: true;
  v: 1;
  iv: string;
  tag: string;
  data: string;
};

function getKey(): Buffer {
  const key = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? '';
  if (!key) {
    throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required for integration credential encryption');
  }

  // Accept 64-char hex key or any secret string (hashed to 32 bytes).
  if (/^[a-fA-F0-9]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }

  return crypto.createHash('sha256').update(key).digest();
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.__enc === true && v.v === 1 && typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.data === 'string';
}

export function encryptIntegrationCredentials(input: Record<string, unknown>): Record<string, unknown> {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(input), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    __enc: true,
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

export function decryptIntegrationCredentials(
  stored: Record<string, unknown> | null | undefined
): Record<string, string> {
  if (!stored) return {};

  if (!isEncryptedPayload(stored)) {
    // Backward compatibility for legacy plaintext rows.
    const plain = stored as Record<string, unknown>;
    return Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, String(v ?? '')]));
  }

  const key = getKey();
  const iv = Buffer.from(stored.iv, 'base64');
  const tag = Buffer.from(stored.tag, 'base64');
  const ciphertext = Buffer.from(stored.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;

  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
}
