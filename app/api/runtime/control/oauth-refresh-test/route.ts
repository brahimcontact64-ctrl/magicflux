import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { getOAuthProviderConfig } from '@/lib/credentials/oauth-providers';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { getValidAccessToken, parseStoredToken, tokenNeedsRefresh } from '@/lib/credentials/oauth-refresh';
import { ClassifiedOAuthError } from '@/lib/credentials/oauth-errors';
import { computeOAuthClientFingerprint, fingerprintSecret } from '@/lib/credentials/oauth-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * POST — Incident 9.9.17M. A controlled, one-shot trigger of the EXACT
 * canonical getValidAccessToken()/refreshOAuthToken() path this incident
 * has been investigating, invoked from Vercel's own runtime under the
 * caller's own authenticated session -- so a Vercel-side refresh attempt
 * can be observed directly instead of inferred from historical timestamps.
 *
 * Deliberately narrow: the provider is hard-coded to 'gmail' (any other
 * value is rejected), it only ever operates on the CALLER's own credential
 * (never an arbitrary userId), and the response contains nothing but
 * sanitized outcome/classification + one-way fingerprints -- never a
 * token, secret, or unsanitized provider payload.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const provider = (body as { provider?: unknown } | null)?.provider;
  if (provider !== 'gmail') {
    return NextResponse.json({ error: 'This diagnostic action only supports provider "gmail"' }, { status: 400 });
  }

  const config = getOAuthProviderConfig('gmail');
  if (!config) {
    return NextResponse.json({ error: 'gmail has no OAuth configuration' }, { status: 500 });
  }

  const credsBefore = await getDecryptedProviderCredentials(user.id, 'gmail').catch(() => ({}) as Record<string, string>);
  const before = parseStoredToken(credsBefore[config.credentialKey]);
  const preCheck = {
    hadStoredToken: Boolean(before),
    wasAlreadyExpiredOrDueForRefresh: before ? tokenNeedsRefresh(before) : null,
    // If there's no stored token at all, or it's not due, this call will
    // short-circuit and never reach Google -- reported so the result is
    // never misread as a live network outcome when it wasn't one.
    attemptedNetworkCall: Boolean(before?.refresh_token) && tokenNeedsRefresh(before!),
  };

  try {
    await getValidAccessToken(user.id, 'gmail');

    const credsAfter = await getDecryptedProviderCredentials(user.id, 'gmail').catch(() => ({}) as Record<string, string>);
    const after = parseStoredToken(credsAfter[config.credentialKey]);

    return NextResponse.json({
      provider: 'gmail',
      preCheck,
      outcome: preCheck.attemptedNetworkCall ? 'refresh_succeeded' : 'no_refresh_needed',
      clientFingerprint: computeOAuthClientFingerprint('gmail'),
      refreshTokenFingerprintBefore: fingerprintSecret(before?.refresh_token ?? null),
      refreshTokenFingerprintAfter: fingerprintSecret(after?.refresh_token ?? null),
      refreshTokenRotated:
        before && after ? fingerprintSecret(before.refresh_token) !== fingerprintSecret(after.refresh_token) : null,
    });
  } catch (err) {
    if (err instanceof ClassifiedOAuthError) {
      return NextResponse.json({
        provider: 'gmail',
        preCheck,
        outcome: err.errorClass, // 'config_fault' | 'reconnect_required' | 'transient' | 'unknown'
        httpStatus: err.httpStatus,
        oauthErrorCode: err.oauthErrorCode,
        sanitizedDescription: err.oauthErrorDescription,
        clientFingerprint: computeOAuthClientFingerprint('gmail'),
        refreshTokenFingerprint: fingerprintSecret(before?.refresh_token ?? null),
      });
    }
    return NextResponse.json({
      provider: 'gmail',
      preCheck,
      outcome: 'error',
      sanitizedDescription: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
