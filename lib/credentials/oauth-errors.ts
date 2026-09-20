/**
 * Incident 9.9.17K -- classification of OAuth token-endpoint rejections into
 * the three categories that actually require different SaaS behavior:
 *
 *   config_fault       -- the OAuth CLIENT (id/secret pair) itself is not
 *                         recognized/authorized by the provider. This is a
 *                         platform deployment defect (wrong/mismatched
 *                         client credentials on this runtime), never
 *                         something the end user caused or can fix by
 *                         reconnecting their Gmail account.
 *   reconnect_required -- the specific GRANT (refresh token) is dead:
 *                         revoked, expired past recovery, or issued for a
 *                         redirect/consent that no longer applies. Only this
 *                         category should ever tell a user to reconnect.
 *   transient          -- rate limiting, a 5xx, or a network-level failure
 *                         talking to the provider. Must never be treated as
 *                         "credential is bad" -- the same credential will
 *                         likely work on the next attempt.
 *
 * Before this incident, every one of these was collapsed into a single
 * generic "SETUP_REQUIRED:<provider>" three layers up the call stack
 * (lib/user-integrations.ts), which is what made a pure platform
 * configuration bug (Railway's OAuth client not matching the client that
 * issued the stored refresh token) look identical to "user needs to
 * reconnect Gmail" or "Google is down."
 */

export type OAuthErrorClass = 'config_fault' | 'reconnect_required' | 'transient' | 'unknown';

/**
 * Classifies a provider's RFC 6749 token-endpoint rejection.
 *
 * Google-specific codes handled explicitly (these are the ones observed or
 * plausible for this codebase's OAuth providers, all of which are Google
 * except Canva):
 *   - unauthorized_client / invalid_client -> config_fault
 *   - invalid_grant                        -> reconnect_required
 * Any HTTP status of 429 or >= 500 is treated as transient regardless of
 * the error code, since a provider outage can accompany any code (or none,
 * if the response was an HTML error page with no parseable body).
 */
export function classifyOAuthRejection(
  oauthErrorCode: string | null,
  httpStatus: number
): OAuthErrorClass {
  if (httpStatus === 429 || httpStatus >= 500) return 'transient';
  if (oauthErrorCode === 'unauthorized_client' || oauthErrorCode === 'invalid_client') {
    return 'config_fault';
  }
  if (oauthErrorCode === 'invalid_grant') return 'reconnect_required';
  return 'unknown';
}

export type ClassifiedOAuthErrorInit = {
  provider: string;
  errorClass: OAuthErrorClass;
  httpStatus: number | null;
  oauthErrorCode: string | null;
  oauthErrorDescription: string | null;
};

/**
 * Thrown by refreshOAuthToken()/exchangeOAuthCode() in place of a bare
 * Error, so callers up the stack (getValidAccessToken, resolveBridgedIntegration)
 * can react differently to a platform config fault vs. a genuine
 * reconnect-required state vs. a transient provider failure, without
 * re-parsing the message string. The message itself is unchanged from the
 * prior plain-Error format, so every existing log line and test assertion
 * that checks `.message` keeps working.
 *
 * Never carries token/secret material -- only the safe RFC 6749
 * error/error_description fields plus HTTP status, exactly like the
 * message it wraps.
 */
export class ClassifiedOAuthError extends Error {
  readonly provider: string;
  readonly errorClass: OAuthErrorClass;
  readonly httpStatus: number | null;
  readonly oauthErrorCode: string | null;
  readonly oauthErrorDescription: string | null;

  constructor(message: string, init: ClassifiedOAuthErrorInit) {
    super(message);
    this.name = 'ClassifiedOAuthError';
    this.provider = init.provider;
    this.errorClass = init.errorClass;
    this.httpStatus = init.httpStatus;
    this.oauthErrorCode = init.oauthErrorCode;
    this.oauthErrorDescription = init.oauthErrorDescription;
  }
}
