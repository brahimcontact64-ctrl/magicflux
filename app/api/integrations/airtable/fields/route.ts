import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { getConnectedAirtableToken } from '@/lib/user-integrations';
import { getAirtableTableFields } from '@/lib/airtable/schema';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/integrations/airtable/fields?baseId=appXXX&tableId=tblXXX
 *
 * Server-side schema discovery: real fields (name/id/type) for one table,
 * using the caller's own connected token (Phase 9.9.4B: the same canonical
 * lookup Settings/runtime use).
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const baseId = req.nextUrl.searchParams.get('baseId');
  const tableId = req.nextUrl.searchParams.get('tableId');
  if (!baseId || !tableId) return NextResponse.json({ error: 'baseId and tableId query parameters are required' }, { status: 400 });

  const token = await getConnectedAirtableToken(user.id);
  if (!token) return NextResponse.json({ error: 'Airtable is not connected for this account.' }, { status: 409 });

  try {
    const fields = await getAirtableTableFields(token, baseId, tableId);
    if (fields === null) return NextResponse.json({ error: `Table "${tableId}" was not found in base "${baseId}".` }, { status: 404 });
    return NextResponse.json({ fields });
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }
}
