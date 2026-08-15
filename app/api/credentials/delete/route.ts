import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { deleteProviderCredentials } from '@/lib/credentials/storage';
import { normalizeProvider } from '@/lib/agent/provider-allowlist';
import { assertCredentialOwnership } from '@/lib/security/ownership';

export async function DELETE(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = normalizeProvider(req.nextUrl.searchParams.get('provider') ?? '');
  if (!provider) {
    return NextResponse.json({ error: 'provider query param required' }, { status: 400 });
  }

  try {
    await assertCredentialOwnership(user.id, provider);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    await deleteProviderCredentials(user.id, provider);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete credentials' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, provider });
}
