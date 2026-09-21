import { NextRequest, NextResponse } from 'next/server';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { getOAuthProviderConfig, exchangeOAuthCode, serializeOAuthTokens } from '@/lib/credentials/oauth-providers';
import { isAllowedOAuthReturnTo, verifyOAuthState } from '@/lib/credentials/oauth-state';
import { assertTrustedUserId, saveCredentialsWithVerification } from '@/lib/credentials/storage';
import { computeOAuthClientFingerprint, fingerprintSecret, getRuntimeIdentity } from '@/lib/credentials/oauth-fingerprint';

/**
 * GET /api/oauth/callback?code=<code>&state=<state>
 *               or  ?error=<error>&state=<state>  (provider-side denial)
 *
 * Completes the OAuth 2.0 authorization code flow:
 *   1. Verifies the HMAC-signed state (CSRF + replay protection)
 *   2. Exchanges the authorization code for access + refresh tokens
 *   3. Saves credentials atomically via saveCredentialsWithVerification()
 *   4. Redirects to <returnTo>?oauth=success&provider=<p>  or ?oauth=error&reason=<r>
 *      (returnTo defaults to /builder; Phase 9.9.7B lets Settings-initiated
 *      connections land back on /settings/integrations instead)
 *
 * The userId embedded in the state is NEVER sourced from query params —
 * it is always extracted from the server-signed state token. Same for
 * returnTo: only a value carried inside the signed state is ever used, so a
 * caller cannot redirect the browser anywhere by tampering with query params.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  // Best-effort: recover which page started this flow from the signed state,
  // even on an error path (e.g. the user clicked "Cancel" on Google's consent
  // screen), so Settings-initiated connections don't get bounced to Builder.
  // Falls back to /builder when the state is missing/invalid/unrecognized —
  // identical to this route's behavior before Phase 9.9.7B.
  const stateParam = searchParams.get('state');
  const stateResult = stateParam ? verifyOAuthState(stateParam) : null;
  const returnTo =
    stateResult?.valid && isAllowedOAuthReturnTo(stateResult.payload.returnTo)
      ? stateResult.payload.returnTo
      : '/builder';
  const returnBase = `${appUrl}${returnTo}`;

  function errorRedirect(reason: string): NextResponse {
    return NextResponse.redirect(`${returnBase}?oauth=error&reason=${encodeURIComponent(reason)}`);
  }

  // ── Provider-side denial (user clicked "Cancel" on OAuth consent screen) ──────
  const errorParam = searchParams.get('error');
  if (errorParam) {
    return errorRedirect(errorParam);
  }

  // ── Required params ────────────────────────────────────────────────────────────
  const code = searchParams.get('code');

  if (!code || !stateParam) {
    return errorRedirect('missing_params');
  }

  // ── State verification (CSRF + replay protection) ─────────────────────────────
  if (!stateResult || !stateResult.valid) {
    return errorRedirect('invalid_state');
  }

  const { userId, provider: rawProvider } = stateResult.payload;

  // Validate the userId extracted from state — guards against edge-case state tampering
  // that somehow passed HMAC (defense in depth).
  try {
    assertTrustedUserId(userId);
  } catch {
    return errorRedirect('unauthorized');
  }

  // ── Provider lookup ────────────────────────────────────────────────────────────
  const provider = normalizeProvider(rawProvider);
  if (!provider) {
    return errorRedirect('invalid_provider');
  }

  const config = getOAuthProviderConfig(provider);
  if (!config) {
    return errorRedirect('unsupported_provider');
  }

  // ── Token exchange ─────────────────────────────────────────────────────────────
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const redirectUri = `${appBaseUrl}/api/oauth/callback`;

  let tokens: Awaited<ReturnType<typeof exchangeOAuthCode>>;
  try {
    tokens = await exchangeOAuthCode(config, code, redirectUri);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'token_exchange_failed';
    console.error(`[oauth/callback] token exchange failed for provider=${provider}: ${reason}`);
    return errorRedirect('token_exchange_failed');
  }

  // ── Credential storage ─────────────────────────────────────────────────────────
  // Tokens are serialized as a JSON blob under the provider's credential key.
  // saveCredentialsWithVerification() atomically writes integration_credentials +
  // credential_verifications in one Postgres transaction (no partial state).
  const credentials: Record<string, string> = {
    [config.credentialKey]: serializeOAuthTokens(tokens),
  };

  try {
    // Incident 9.9.17L -- tags this write as a genuine user-initiated
    // reconnect (the authorization_code grant, only reachable via a real
    // Google consent-screen round trip), distinct from an automatic
    // background refresh's 'automatic_refresh' tag
    // (lib/credentials/oauth-refresh.ts) -- so a future investigation can
    // tell, from credential_verifications.metadata alone, whether the last
    // write to this credential was a reconnect or a silent refresh, and
    // whether the refresh_token identity changed as a result.
    await saveCredentialsWithVerification(userId, provider, credentials, 'healthy', {
      source: 'oauth_callback_connect',
      runtime: getRuntimeIdentity(),
      client_fingerprint: computeOAuthClientFingerprint(provider),
      refresh_token_fingerprint: fingerprintSecret(tokens.refresh_token ?? null),
      connected_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth/callback] saveCredentialsWithVerification failed for provider=${provider}: ${msg}`);
    return errorRedirect('save_failed');
  }

  // ── Success redirect ───────────────────────────────────────────────────────────
  return NextResponse.redirect(
    `${returnBase}?oauth=success&provider=${encodeURIComponent(provider)}`
  );
}
