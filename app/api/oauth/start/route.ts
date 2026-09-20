import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { getOAuthProviderConfig, readOAuthClientCredentials } from '@/lib/credentials/oauth-providers';
import { buildOAuthState, isAllowedOAuthReturnTo } from '@/lib/credentials/oauth-state';

/**
 * POST /api/oauth/start
 * Body: { provider: string }
 *
 * Initiates the OAuth 2.0 authorization code flow.
 * Returns { redirectUrl } — the caller navigates window.location.href to it.
 *
 * Auth: Authorization: Bearer <token> header (preferred) or mf_access_token cookie.
 * The user JWT is NEVER forwarded to the OAuth provider and never appears in any URL.
 */
export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  // getUserFromRequest reads Authorization: Bearer header, then mf_access_token cookie.
  // No JWT is passed via query string.
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Body parsing ─────────────────────────────────────────────────────────────
  let body: { provider?: unknown; returnTo?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; returnTo?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Phase 9.9.7B -- which page to send the user back to after the OAuth
  // round trip (Builder vs Settings). Only ever taken from a fixed allow-list
  // (never an arbitrary caller-supplied path) and embedded in the signed
  // state so it can't be tampered with in transit.
  const returnTo = isAllowedOAuthReturnTo(body.returnTo) ? body.returnTo : undefined;

  // ── Provider validation ──────────────────────────────────────────────────────
  const rawProvider = String(body.provider ?? '');
  const provider = normalizeProvider(rawProvider);

  if (!provider) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }

  const config = getOAuthProviderConfig(provider);
  if (!config) {
    return NextResponse.json(
      { error: `OAuth is not supported for provider: ${provider}` },
      { status: 400 }
    );
  }

  // ── Check env vars are configured ────────────────────────────────────────────
  // Incident 9.9.17K -- reads via the same whitespace-trimming helper used
  // for the actual token requests, so a whitespace-only or newline-padded
  // env value (a copy/paste artifact) fails this check the same way it
  // would fail Google, instead of passing here and failing later.
  const { clientId } = readOAuthClientCredentials(config);
  if (!clientId) {
    return NextResponse.json(
      { error: 'OAuth is not configured for this provider' },
      { status: 503 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: 'APP_URL is not configured' }, { status: 503 });
  }

  // ── Build OAuth URL ───────────────────────────────────────────────────────────
  const redirectUri = `${appUrl}/api/oauth/callback`;
  const state = buildOAuthState(user.id, provider, returnTo);

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    ...(config.extraAuthParams ?? {}),
  });

  const redirectUrl = `${config.authUrl}?${authParams.toString()}`;
  return NextResponse.json({ redirectUrl });
}
