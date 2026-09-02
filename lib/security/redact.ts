/**
 * Phase 9.4.1 — the one authoritative deep-object redaction utility.
 *
 * Every place execution data, HTTP headers, credentials, or raw errors
 * might reach a log line, a persisted execution record, or an API
 * response should route through redact() (or isSensitiveKey() for a
 * single-field check) rather than inventing ad-hoc masking.
 *
 * Key matching is exact/normalized (lowercased, hyphens/underscores/
 * spaces stripped), not substring — "tokenized_words" or "broken_link"
 * are never touched just because they contain "token"/"oken". The base
 * list below is deliberately small and explicit; it is extended at
 * runtime with every provider credential field this codebase has
 * actually registered as secret (lib/credentials/provider-registry.ts's
 * getRegisteredSecretFieldKeys()), so a new integration's secret field is
 * protected automatically rather than requiring a second list to update.
 */

import { getRegisteredSecretFieldKeys } from '@/lib/credentials/provider-registry';

export const REDACTED = '[REDACTED]';

const BASE_SENSITIVE_KEYS = [
  // Explicitly required (Phase 9.4.1 Step B)
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'apiKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'password',
  'secret',
  'token',
  // Common, unambiguous extensions of the same categories
  'passwd',
  'pwd',
  'private_key',
  'privateKey',
  'session_token',
  'sessionToken',
  'id_token',
  'idToken',
  'bearer_token',
  'bearerToken',
  'webhook_secret',
  'webhookSecret',
  'signing_secret',
  'signingSecret',
  'api_secret',
  'apiSecret',
  'client_id_secret',
  'service_role_key',
  'serviceRoleKey',
  'smtp_password',
  'smtpPassword',
  'smtp_pass',
  'x-api-key',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

let cachedSensitiveKeySet: Set<string> | null = null;

function getSensitiveKeySet(): Set<string> {
  if (cachedSensitiveKeySet) return cachedSensitiveKeySet;
  const set = new Set(BASE_SENSITIVE_KEYS.map(normalizeKey));
  try {
    for (const key of getRegisteredSecretFieldKeys()) set.add(normalizeKey(key));
  } catch {
    // Registry unreachable in this context (e.g. an unusual bundling edge
    // case) -- the base list above still protects the required minimum.
  }
  cachedSensitiveKeySet = set;
  return set;
}

/** Exact/normalized check: is this key name one we always treat as a secret value? */
export function isSensitiveKey(key: string): boolean {
  return getSensitiveKeySet().has(normalizeKey(key));
}

const DEFAULT_MAX_DEPTH = 12;

/**
 * Deep-redacts sensitive keys anywhere in a value's shape. Never mutates
 * the input -- always returns a new structure. Handles arrays, nested
 * objects, circular references (replaced with '[CIRCULAR]'), and excess
 * depth (replaced with '[MAX_DEPTH]') without throwing. Header objects
 * work regardless of key capitalization since matching is
 * case-normalized; pass `Object.fromEntries(headers.entries())` for a
 * Fetch API Headers instance first (this function only walks plain
 * objects/arrays, not exotic iterables).
 *
 * A key that matches the sensitive set has its value replaced with
 * REDACTED ('[REDACTED]') -- except null/undefined, which are preserved
 * as-is so the shape honestly reflects "this secret was never set" rather
 * than implying a secret exists. Non-sensitive keys are recursed into, so
 * object shape (including harmless sibling fields next to a secret) is
 * preserved rather than nuking whole containers.
 */
export function redact<T>(value: T, options?: { maxDepth?: number }): T {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();

  function walk(input: unknown, depth: number): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input !== 'object') return input;
    if (input instanceof Date) return input;

    if (seen.has(input as object)) return '[CIRCULAR]';
    if (depth > maxDepth) return '[MAX_DEPTH]';

    if (Array.isArray(input)) {
      seen.add(input);
      return input.map((item) => walk(item, depth + 1));
    }

    seen.add(input as object);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = val === null || val === undefined ? val : REDACTED;
      } else {
        out[key] = walk(val, depth + 1);
      }
    }
    return out;
  }

  try {
    return walk(value, 0) as T;
  } catch {
    // redact() must never be the reason a log line or an error handler
    // itself throws -- fail to a safe, unambiguous marker instead.
    return '[REDACTION_FAILED]' as unknown as T;
  }
}

/**
 * Sanitizes free-text (a raw error message, a provider's plain-text
 * response body excerpt) that redact()'s key-based matching cannot help
 * with -- there's no object shape to inspect keys on. Strips whole URLs
 * (which can carry an embedded token/password in the query string or
 * userinfo component) and any `key=value`/`key: value`-shaped credential
 * pattern, then truncates. This is deliberately conservative (it will
 * over-strip some harmless text) rather than trying to precisely detect
 * every possible secret shape in prose -- consolidated here from what was
 * previously a private, local copy of the same logic in
 * lib/integration-verifier.ts, so provider-error text sanitization has
 * one implementation, not several that could drift.
 */
export function redactText(message: string, maxLength = 180): string {
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
    .replace(/\b(token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth)\s*[:=]\s*[^\s&,;]+/gi, '$1=[REDACTED]')
    .slice(0, maxLength);
}
