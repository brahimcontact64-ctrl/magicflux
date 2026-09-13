import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/reviews
 *
 * Lists the authenticated user's own pending human-review items (Phase
 * 9.9.2's Pending Reviews panel). Owner-scoped: every query is filtered by
 * the authenticated user's id, never a client-supplied one -- a request
 * for someone else's reviews simply returns none, it never errors in a way
 * that would reveal whether other users' reviews exist.
 *
 * ?status=pending|approved|rejected|decided|all (default: pending)
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const statusParam = req.nextUrl.searchParams.get('status') ?? 'pending';

  let query = db
    .from('workflow_review_items')
    .select('id, workflow_id, execution_id, node_id, node_name, status, allowed_outcomes, decision_outcome, instruction, review_context, reviewed_at, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (statusParam !== 'all') {
    query = query.eq('status', statusParam) as typeof query;
  }

  const { data, error } = await query;

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }

  return NextResponse.json({ items: data ?? [] });
}
