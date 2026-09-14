import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { getConnectedAirtableToken } from '@/lib/user-integrations';
import { listAirtableTables } from '@/lib/airtable/schema';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/integrations/airtable/tables?baseId=appXXXXXXXXXXXXXX
 *
 * Server-side schema discovery: real tables (with their real fields) for
 * one base, using the caller's own connected token (Phase 9.9.4B: the same
 * canonical lookup Settings/runtime use). Never exposes the token.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const baseId = req.nextUrl.searchParams.get('baseId');
  if (!baseId) return NextResponse.json({ error: 'baseId query parameter is required' }, { status: 400 });

  const token = await getConnectedAirtableToken(user.id);
  if (!token) return NextResponse.json({ error: 'Airtable is not connected for this account.' }, { status: 409 });

  try {
    const tables = await listAirtableTables(token, baseId);
    return NextResponse.json({ tables });
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }
}
