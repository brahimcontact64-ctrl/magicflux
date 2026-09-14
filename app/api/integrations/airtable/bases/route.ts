import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { getConnectedAirtableToken } from '@/lib/user-integrations';
import { listAirtableBases } from '@/lib/airtable/schema';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/integrations/airtable/bases
 *
 * Server-side schema discovery (Phase 9.9.3, unified with Settings in Phase
 * 9.9.4B): fetches the caller's OWN connected Airtable Personal Access
 * Token via the same canonical lookup Settings/runtime use, and calls
 * Airtable's real Metadata API for the bases it can access. The token
 * itself never reaches the browser -- only base id/name/permission metadata
 * does.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getConnectedAirtableToken(user.id);
  if (!token) return NextResponse.json({ error: 'Airtable is not connected for this account.' }, { status: 409 });

  try {
    const bases = await listAirtableBases(token);
    return NextResponse.json({ bases });
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }
}
