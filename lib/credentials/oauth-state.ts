/**
 * OAuth CSRF state token: generation and verification.
 *
 * Format: base64url(JSON payload) + '.' + HMAC-SHA256(key, b64)
 *
 * Properties:
 * - Unforgeable without INTEGRATIONS_ENCRYPTION_KEY
 * - Carries userId + provider through the OAuth redirect without server-side session storage
 * - Replay-protected via iat + STATE_MAX_AGE_SECONDS window
 * - Constant-time signature comparison prevents timing attacks
 */

import crypto from 'node:crypto';

export const STATE_MAX_AGE_SECONDS = 600; // 10 minutes

export type OAuthStatePayload = {
  userId: string;
  provider: string;
  nonce: string;
  iat: number; // unix seconds
};

export type StateVerificationResult =
  | { valid: true; payload: OAuthStatePayload }
  | { valid: false; reason: string };

function getHmacKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required for OAuth state signing');
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Builds a signed state token embedding userId + provider.
 * Each call produces a unique token due to the random nonce.
 */
export function buildOAuthState(userId: string, provider: string): string {
  const payload: OAuthStatePayload = {
    userId,
    provider,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Math.floor(Date.now() / 1000),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getHmacKey()).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

/**
 * Verifies a state token. Returns the payload if valid, or an error reason.
 *
 * @param state - the raw state string from the OAuth callback query param
 * @param nowSeconds - override current time (for tests); defaults to Date.now()/1000
 */
export function verifyOAuthState(
  state: string,
  nowSeconds?: number
): StateVerificationResult {
  if (!state || typeof state !== 'string') {
    return { valid: false, reason: 'malformed_state' };
  }

  const dot = state.lastIndexOf('.');
  if (dot < 0) return { valid: false, reason: 'malformed_state' };

  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  let expected: string;
  try {
    expected = crypto.createHmac('sha256', getHmacKey()).update(b64).digest('hex');
  } catch {
    return { valid: false, reason: 'hmac_error' };
  }

  // Reject obviously wrong-length signatures immediately
  if (sig.length !== expected.length) return { valid: false, reason: 'invalid_signature' };

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(sig.padEnd(expected.length, '0'), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return { valid: false, reason: 'invalid_signature' };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return { valid: false, reason: 'invalid_signature' };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  if (!payload.userId || !payload.provider || !payload.nonce || typeof payload.iat !== 'number') {
    return { valid: false, reason: 'incomplete_payload' };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - payload.iat;
  if (age < 0) return { valid: false, reason: 'future_timestamp' };
  // Treat age === STATE_MAX_AGE_SECONDS as expired: a 600-second-old token is stale.
  if (age >= STATE_MAX_AGE_SECONDS) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}
