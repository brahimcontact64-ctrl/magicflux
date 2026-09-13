import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { listAirtableBases } from '@/lib/airtable/schema';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/integrations/airtable/bases
 *
 * Server-side schema discovery (Phase 9.9.3): fetches the caller's OWN
 * decrypted Airtable Personal Access Token and calls Airtable's real
 * Metadata API for the bases it can access. The token itself never
 * reaches the browser -- only base id/name/permission metadata does.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const creds = await getDecryptedProviderCredentials(user.id, 'airtable');
  const token = creds.personal_access_token;
  if (!token) return NextResponse.json({ error: 'Airtable is not connected for this account.' }, { status: 409 });

  try {
    const bases = await listAirtableBases(token);
    return NextResponse.json({ bases });
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }
}
