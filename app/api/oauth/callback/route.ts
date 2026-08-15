import { NextRequest, NextResponse } from 'next/server';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { getOAuthProviderConfig, exchangeOAuthCode, serializeOAuthTokens } from '@/lib/credentials/oauth-providers';
import { verifyOAuthState } from '@/lib/credentials/oauth-state';
import { assertTrustedUserId, saveCredentialsWithVerification } from '@/lib/credentials/storage';

/**
 * GET /api/oauth/callback?code=<code>&state=<state>
 *               or  ?error=<error>&state=<state>  (provider-side denial)
 *
 * Completes the OAuth 2.0 authorization code flow:
 *   1. Verifies the HMAC-signed state (CSRF + replay protection)
 *   2. Exchanges the authorization code for access + refresh tokens
 *   3. Saves credentials atomically via saveCredentialsWithVerification()
 *   4. Redirects to /builder?oauth=success&provider=<p>  or ?oauth=error&reason=<r>
 *
 * The userId embedded in the state is NEVER sourced from query params —
 * it is always extracted from the server-signed state token.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const builderBase = `${appUrl}/builder`;

  function errorRedirect(reason: string): NextResponse {
    return NextResponse.redirect(`${builderBase}?oauth=error&reason=${encodeURIComponent(reason)}`);
  }

  // ── Provider-side denial (user clicked "Cancel" on OAuth consent screen) ──────
  const errorParam = searchParams.get('error');
  if (errorParam) {
    return errorRedirect(errorParam);
  }

  // ── Required params ────────────────────────────────────────────────────────────
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');

  if (!code || !stateParam) {
    return errorRedirect('missing_params');
  }

  // ── State verification (CSRF + replay protection) ─────────────────────────────
  const stateResult = verifyOAuthState(stateParam);
  if (!stateResult.valid) {
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
    await saveCredentialsWithVerification(userId, provider, credentials, 'healthy');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth/callback] saveCredentialsWithVerification failed for provider=${provider}: ${msg}`);
    return errorRedirect('save_failed');
  }

  // ── Success redirect ───────────────────────────────────────────────────────────
  return NextResponse.redirect(
    `${builderBase}?oauth=success&provider=${encodeURIComponent(provider)}`
  );
}
