import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { saveCredentialsWithVerification } from '@/lib/credentials/storage';
import {
  getProviderDisplayName,
  providerHasCredentials,
  getRequiredCredentials,
} from '@/lib/credentials/provider-registry';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { validateProviderConnection } from '@/lib/credentials/provider-verifier';

export async function POST(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { provider?: unknown; credentials?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; credentials?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const provider = normalizeProvider(String(body.provider ?? ''));
  if (!provider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  if (!providerHasCredentials(provider)) {
    return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const raw = (body.credentials ?? {}) as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    const v = String(val ?? '').trim();
    if (v) sanitized[key] = v;
  }

  if (Object.keys(sanitized).length === 0) {
    return NextResponse.json({ error: 'No credential values provided' }, { status: 400 });
  }

  // Verify all required fields are present before hitting the provider API
  const requiredKeys = getRequiredCredentials(provider).map((f) => f.key);
  const missingRequired = requiredKeys.filter(
    (k) => !Object.prototype.hasOwnProperty.call(sanitized, k)
  );
  if (missingRequired.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missingRequired.join(', ')}` },
      { status: 400 }
    );
  }

  // ── Real API validation ──────────────────────────────────────────────────────
  // Credentials are NOT saved until validation passes.
  let validation: Awaited<ReturnType<typeof validateProviderConnection>>;
  try {
    validation = await validateProviderConnection(provider, sanitized);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Validation error' },
      { status: 500 }
    );
  }

  // OAuth providers cannot be verified with an API key — save as-is.
  const requiresOAuthFlow = validation.metadata?.requiresOAuthFlow === true;

  if (!requiresOAuthFlow && !validation.connected) {
    return NextResponse.json(
      { success: false, provider, errors: validation.errors },
      { status: 422 }
    );
  }

  // ── Atomic persist: credentials + verification record in one transaction ─────
  // saveCredentialsWithVerification() calls the save_credentials_with_verification()
  // Postgres function which writes both tables in a single BEGIN/COMMIT block.
  // Any failure rolls back both writes — no partial state is possible.
  const verificationStatus = requiresOAuthFlow ? 'unknown' : 'healthy';
  try {
    await saveCredentialsWithVerification(
      user.id,
      provider,
      sanitized,
      verificationStatus,
      validation.metadata
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save credentials' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    provider,
    displayName: getProviderDisplayName(provider),
    connected: !requiresOAuthFlow,
    requiresOAuthFlow,
    metadata: requiresOAuthFlow ? undefined : validation.metadata,
  });
}
