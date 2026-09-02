/**
 * Phase 9.4.1 — user-safe error taxonomy.
 *
 * Converts any raw error (Postgres/PostgREST, Redis/queue, fetch/network,
 * provider HTTP failure, validation, auth) into a small, fixed set of
 * product-level categories. The user only ever sees `message` from the
 * fixed SAFE_MESSAGES table below -- never a raw `error.message`, stack
 * trace, SQL, PostgREST code, Redis error text, hostname, file path, env
 * var name, or internal handler/class name. Callers that need to log or
 * display something richer for operators use `diagnostics`, which is
 * itself built from redact() and a small set of known-safe fields
 * (provider HTTP status, a Postgres SQLSTATE/PGRST code, retryability) --
 * never the raw message text.
 */

import { redact, redactText } from './redact';

export type SafeErrorCode =
  | 'connection_required'
  | 'authentication_expired'
  | 'invalid_configuration'
  | 'unsupported_action'
  | 'service_unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'permission_denied'
  | 'not_found'
  | 'validation_failed'
  | 'workflow_failed'
  | 'temporary_system_problem'
  | 'unknown';

const SAFE_MESSAGES: Record<SafeErrorCode, string> = {
  connection_required: 'This step needs a connected integration. Connect it and try again.',
  authentication_expired: 'Your connection to this service has expired. Reconnect and try again.',
  invalid_configuration: 'This workflow step is not configured correctly.',
  unsupported_action: 'This action is not currently supported.',
  service_unavailable: 'The external service is temporarily unavailable. Please try again shortly.',
  timeout: 'The request took too long and timed out.',
  rate_limited: 'Too many requests right now. Please try again in a moment.',
  permission_denied: "You don't have permission to do this.",
  not_found: 'The requested item could not be found.',
  validation_failed: 'Some of the provided information is invalid.',
  workflow_failed: 'This workflow step failed to complete.',
  temporary_system_problem: 'A temporary system problem occurred. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

const HTTP_STATUS_FOR_CODE: Record<SafeErrorCode, number> = {
  connection_required: 409,
  authentication_expired: 401,
  invalid_configuration: 422,
  unsupported_action: 400,
  service_unavailable: 502,
  timeout: 504,
  rate_limited: 429,
  permission_denied: 403,
  not_found: 404,
  validation_failed: 400,
  workflow_failed: 422,
  temporary_system_problem: 503,
  unknown: 500,
};

const RETRYABLE_CODES = new Set<SafeErrorCode>([
  'service_unavailable',
  'timeout',
  'rate_limited',
  'temporary_system_problem',
]);

export type SafeError = {
  code: SafeErrorCode;
  message: string;
  retryable: boolean;
  httpStatus: number;
};

export type SafeErrorDiagnostics = {
  executionId?: string;
  correlationId?: string;
  /** A Postgres SQLSTATE (5 chars) or PostgREST PGRSTxxx code, if that's what this was. Never SQL text. */
  internalCode?: string;
  /** The provider's/upstream's own HTTP status code, if this came from an external call. */
  providerStatus?: number;
  /** redact()-passed extra context, safe to log/show to operators. */
  context?: unknown;
};

export type ClassifiedError = SafeError & { diagnostics: SafeErrorDiagnostics };

export function makeSafeError(code: SafeErrorCode, overrideMessage?: string): SafeError {
  return {
    code,
    message: overrideMessage ?? SAFE_MESSAGES[code],
    retryable: RETRYABLE_CODES.has(code),
    httpStatus: HTTP_STATUS_FOR_CODE[code],
  };
}

const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Classifies a raw error into a SafeError the client/UI may see, plus a
 * sanitized diagnostics object for internal logs. Never includes the raw
 * `err.message`/`err.stack` in the returned SafeError; a truncated,
 * redact()-passed excerpt of the message may appear in `diagnostics`
 * only, for operator-facing sanitized richer detail (Step G).
 */
export function classifyError(
  err: unknown,
  ctx?: { executionId?: string; correlationId?: string },
): ClassifiedError {
  const errObj = err as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown } | null;
  const rawMessage = typeof errObj?.message === 'string' ? errObj.message : String(err ?? 'Unknown error');
  const rawCode = typeof errObj?.code === 'string' ? errObj.code : undefined;
  const status = typeof errObj?.status === 'number' ? errObj.status
    : typeof errObj?.statusCode === 'number' ? errObj.statusCode
    : undefined;

  let code: SafeErrorCode = 'unknown';

  if (rawCode && (POSTGRES_SQLSTATE.test(rawCode) || rawCode.startsWith('PGRST'))) {
    code = 'temporary_system_problem';
  } else if (status === 401) {
    code = 'authentication_expired';
  } else if (status === 403) {
    code = 'permission_denied';
  } else if (status === 404) {
    code = 'not_found';
  } else if (status === 429) {
    code = 'rate_limited';
  } else if (typeof status === 'number' && status >= 500) {
    code = 'service_unavailable';
  } else if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(rawMessage)) {
    code = 'service_unavailable';
  } else if (/timed?\s?out|ETIMEDOUT|AbortError/i.test(rawMessage) || errObj?.name === 'AbortError') {
    code = 'timeout';
  } else if (/rate.?limit/i.test(rawMessage)) {
    code = 'rate_limited';
  } else if (/unauthoriz|invalid.?(api.?key|token|credential)/i.test(rawMessage)) {
    code = 'authentication_expired';
  } else if (/forbidden|permission/i.test(rawMessage)) {
    code = 'permission_denied';
  } else if (/not found/i.test(rawMessage)) {
    code = 'not_found';
  } else if (/validation|invalid (input|parameter|configuration)/i.test(rawMessage)) {
    code = 'validation_failed';
  }

  const safe = makeSafeError(code);

  return {
    ...safe,
    diagnostics: {
      executionId: ctx?.executionId,
      correlationId: ctx?.correlationId,
      internalCode: rawCode,
      providerStatus: status,
      // redactText() (not redact()) -- this is free text, not a keyed
      // object, so a structural key-based redactor cannot help; the raw
      // message might echo a secret back (e.g. a misconfigured provider
      // embedding a token in an error body) as plain text.
      context: { excerpt: redactText(rawMessage, 300) },
    },
  };
}
