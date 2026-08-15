import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import {
  getAllConnectedProviders,
  getVerificationStatus,
  verifyProviderConnection,
  type VerificationStatus,
} from '@/lib/credentials/storage';
import { STALE_THRESHOLD_DAYS } from '@/lib/credentials/stale-verifier';
import { getProviderDisplayName } from '@/lib/credentials/provider-registry';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';

export type CredentialHealthRecord = {
  provider: string;
  displayName: string;
  connected: boolean;
  lastVerifiedAt: string | null;
  status: VerificationStatus;
  isStale: boolean;
};

const STALE_MS = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

function computeIsStale(verifiedAt: string | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - new Date(verifiedAt).getTime() > STALE_MS;
}

/**
 * GET /api/credentials/health[?provider=x]
 *
 * Returns health status for all providers the authenticated user has
 * credential rows for.  An optional ?provider= query param scopes the
 * response to a single provider.
 *
 * Response:
 *   { providers: CredentialHealthRecord[] }
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Optional single-provider filter
  const rawProvider = req.nextUrl.searchParams.get('provider');
  const singleProvider = rawProvider ? normalizeProvider(rawProvider) : null;

  let providers: string[];
  try {
    const all = await getAllConnectedProviders(user.id);
    providers = singleProvider ? all.filter((p) => p === singleProvider) : all;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read credentials' },
      { status: 500 }
    );
  }

  if (providers.length === 0) {
    return NextResponse.json({ providers: [] });
  }

  const records: CredentialHealthRecord[] = await Promise.all(
    providers.map(async (provider) => {
      const [connectionStatus, verification] = await Promise.all([
        verifyProviderConnection(user.id, provider).catch(() => ({
          connected: false,
          missing: [] as string[],
        })),
        getVerificationStatus(user.id, provider).catch(() => ({
          provider,
          verifiedAt: null,
          status: 'unknown' as VerificationStatus,
        })),
      ]);

      return {
        provider,
        displayName: getProviderDisplayName(provider),
        connected: connectionStatus.connected,
        lastVerifiedAt: verification.verifiedAt,
        status: verification.status,
        isStale: computeIsStale(verification.verifiedAt),
      };
    })
  );

  return NextResponse.json({ providers: records });
}
