import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/reviews
 *
 * Lists the authenticated user's own human-review items (the Pending
 * Reviews panel). Authorization truth (Phase 9.9.2A): this is OWNER-ONLY
 * -- every query is filtered by the authenticated caller's own id, never a
 * client-supplied one. There is no cross-tenant admin/founder view; a
 * request only ever sees rows this exact user owns.
 *
 * `status` here is the resume LIFECYCLE (pending -> resume_pending ->
 * resumed), not the decision's own value -- decision_outcome carries
 * approve/reject/custom regardless of lifecycle stage. A resume_pending
 * row already has a final decision_outcome; it just hasn't been confirmed
 * to have taken effect on the execution yet (see lib/runtime/review-resume.ts).
 *
 * ?status=pending|resume_pending|resumed|all (default: pending -- awaiting
 * an actual human decision)
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
