import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { verifyProviderConnection } from '@/lib/credentials/storage';
import {
  getProviderDisplayName,
  getRequiredCredentials,
} from '@/lib/credentials/provider-registry';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = normalizeProvider(req.nextUrl.searchParams.get('provider') ?? '');
  if (!provider) {
    return NextResponse.json({ error: 'provider query param required' }, { status: 400 });
  }

  const status = await verifyProviderConnection(user.id, provider).catch(() => ({
    connected: false,
    missing: getRequiredCredentials(provider).map((f) => f.key),
  }));

  const requiredFields = getRequiredCredentials(provider);

  return NextResponse.json({
    provider,
    displayName: getProviderDisplayName(provider),
    connected: status.connected,
    missing: status.missing,
    requiredFields: requiredFields.map((f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      source: f.source,
      description: f.description,
      required: f.required,
    })),
  });
}
