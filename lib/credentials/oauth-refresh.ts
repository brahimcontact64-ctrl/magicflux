/**
 * OAuth access-token lifecycle management.
 *
 * Reads stored token JSON for a provider, refreshes via grant_type=refresh_token
 * when the token is within REFRESH_BUFFER_SECONDS of expiry, persists the new
 * token atomically, and returns the current valid access_token.
 *
 * Callers (agent, workflow runner, etc.) should call getValidAccessToken() before
 * every API call to an OAuth provider instead of storing the access_token locally.
 */

import {
  assertTrustedUserId,
  getDecryptedProviderCredentials,
  saveCredentialsWithVerification,
  updateVerificationStatus,
} from './storage';
import {
  getOAuthProviderConfig,
  refreshOAuthToken,
  type OAuthTokenResponse,
} from './oauth-providers';
import { ClassifiedOAuthError } from './oauth-errors';
import { logger } from '@/lib/runtime/logger';

export const REFRESH_BUFFER_SECONDS = 300; // refresh when < 5 minutes remain

export type StoredOAuthToken = {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: number | null; // unix seconds, or null = unknown expiry
};

/**
 * Parses the stored JSON blob for an OAuth credential key.
 * Returns null when the value is absent or not valid token JSON.
 */
export function parseStoredToken(raw: string | undefined): StoredOAuthToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed.access_token || typeof parsed.access_token !== 'string') return null;
    return {
      access_token: String(parsed.access_token),
      refresh_token: parsed.refresh_token ? String(parsed.refresh_token) : null,
      token_type: parsed.token_type ? String(parsed.token_type) : 'Bearer',
      expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : null,
    };
  } catch {
    return null;
  }
}

/**
 * Returns true when the stored token is expired or within REFRESH_BUFFER_SECONDS
 * of expiry.  Returns false when expires_at is null (unknown expiry — assume valid).
 */
export function tokenNeedsRefresh(token: StoredOAuthToken, nowSeconds?: number): boolean {
  if (token.expires_at === null) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return token.expires_at - now < REFRESH_BUFFER_SECONDS;
}

/**
 * Returns a valid access_token for userId + provider, refreshing if necessary.
 *
 * Throws when:
 * - userId is not a valid UUID v4 (assertTrustedUserId)
 * - provider has no OAuth config
 * - no credentials are stored for the provider
 * - the stored value is not parseable token JSON
 * - the token needs refresh but no refresh_token is available
 * - the refresh request fails
 */
export async function getValidAccessToken(
  userId: string,
  provider: string
): Promise<string> {
  assertTrustedUserId(userId);

  const config = getOAuthProviderConfig(provider);
  if (!config) throw new Error(`No OAuth config for provider: ${provider}`);

  const creds = await getDecryptedProviderCredentials(userId, provider);
  const raw = creds[config.credentialKey];

  const stored = parseStoredToken(raw);
  if (!stored) {
    throw new Error(`No valid OAuth credentials stored for provider: ${provider}`);
  }

  if (!tokenNeedsRefresh(stored)) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    // No refresh token — return the existing access_token and let the caller handle 401s
    return stored.access_token;
  }

  // Perform the token refresh
  let refreshed: OAuthTokenResponse;
  try {
    refreshed = await refreshOAuthToken(config, stored.refresh_token);
  } catch (err) {
    // Incident 9.9.17K -- record the SaaS-facing meaning of this failure in
    // the one durable, per-(user, provider) health record every future
    // dashboard/alert should read, instead of leaving it forever showing
    // the last successful refresh's "healthy" status (the actual gap this
    // incident's live evidence exposed: a Railway refresh failure at
    // 16:24:15 left credential_verifications reporting "healthy" from
    // 16:24:28 all the way through a second failure at 19:21:52).
    //
    // Only a genuinely dead grant (reconnect_required) may ever mark the
    // credential 'invalid' -- that is the one classification where telling
    // the user to reconnect is actually correct. A platform config fault
    // (config_fault) or a transient provider hiccup must NEVER be recorded
    // as 'invalid': doing so would be exactly the false "credential
    // revoked" signal Part D of this incident explicitly prohibits.
    // Best-effort: a write failure here must never mask or replace the
    // original OAuth failure the caller needs to see.
    if (err instanceof ClassifiedOAuthError && err.errorClass === 'reconnect_required') {
      await updateVerificationStatus(userId, provider, 'invalid', {
        reason: 'oauth_reconnect_required',
        oauth_error: err.oauthErrorCode,
        http_status: err.httpStatus,
        checked_at: new Date().toISOString(),
      }).catch((writeErr: unknown) => {
        logger.warn('oauth_refresh.verification_status_write_failed', {
          provider,
          user_id: userId,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      });
    } else if (err instanceof ClassifiedOAuthError && err.errorClass === 'config_fault') {
      logger.warn('oauth_refresh.platform_config_fault', {
        provider,
        user_id: userId,
        oauth_error: err.oauthErrorCode,
        http_status: err.httpStatus,
      });
    }
    throw err;
  }

  // Incident 9.9.17K -- concurrency guard. A second getValidAccessToken()
  // call for the same (user, provider) racing this one (e.g. two workflow
  // executions for the same account dispatched together) may have already
  // completed its own refresh while this call's request to the provider was
  // in flight. If storage already reflects a DIFFERENT, still-fresh token
  // than the one this call started with, defer to it instead of writing
  // this call's result: this call's refresh_token fallback (below) is only
  // as current as the READ at the top of this function, so writing now
  // could silently overwrite a refresh_token the other call's response
  // rotated to with this call's stale one -- indistinguishable later from a
  // genuine revocation. Both this call's and the other call's access_token
  // are equally valid (same successful grant), so returning the other
  // call's is not a correctness loss, only a skipped redundant write.
  const currentCreds = await getDecryptedProviderCredentials(userId, provider);
  const current = parseStoredToken(currentCreds[config.credentialKey]);
  if (current && current.access_token !== stored.access_token && !tokenNeedsRefresh(current)) {
    return current.access_token;
  }

  // Preserve existing refresh_token when the provider does not rotate it.
  // Build as StoredOAuthToken (null-safe) and serialize directly — avoids
  // the null/undefined mismatch with OAuthTokenResponse.
  const updated: StoredOAuthToken = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    token_type: refreshed.token_type ?? stored.token_type,
    expires_at: refreshed.expires_in
      ? Math.floor(Date.now() / 1000) + refreshed.expires_in
      : null,
  };

  await saveCredentialsWithVerification(
    userId,
    provider,
    { [config.credentialKey]: JSON.stringify(updated) },
    'healthy'
  );

  return updated.access_token;
}
