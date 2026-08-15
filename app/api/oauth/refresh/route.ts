import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { getOAuthProviderConfig } from '@/lib/credentials/oauth-providers';
import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';
import { assertCredentialOwnership } from '@/lib/security/ownership';

/**
 * POST /api/oauth/refresh
 * Body: { provider: string }
 *
 * Returns a valid access_token for the requesting user + provider.
 * Transparently refreshes via grant_type=refresh_token when the stored token
 * is within 5 minutes of expiry.
 *
 * Auth: Authorization: Bearer <token> header or mf_access_token cookie.
 */
export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Body ─────────────────────────────────────────────────────────────────────
  let body: { provider?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

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

  try {
    await assertCredentialOwnership(user.id, provider);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── Refresh / return token ────────────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(user.id, provider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve access token';
    // Log without revealing the token value
    console.error(`[oauth/refresh] provider=${provider} user=${user.id.slice(0, 8)}…: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 422 });
  }

  return NextResponse.json({ access_token: accessToken });
}
