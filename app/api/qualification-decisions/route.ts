import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

/**
 * GET /api/qualification-decisions?workflow_id=<uuid>&outcome=<status|all>
 *
 * Phase 9.9.15 -- Part J: the lead list backing the single-lead inspector.
 * Owner-scoped, paginated with a hard cap. Deliberately returns only the
 * fields the list view needs (never positive_signals/negative_signals/
 * contradictions/ai_reason -- those are for the detail view only, keeping
 * this list cheap and free of anything resembling a raw payload dump).
 */
const MAX_ROWS = 200;

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = req.nextUrl.searchParams.get('workflow_id');
  if (!workflowId) return NextResponse.json({ error: 'workflow_id query parameter is required' }, { status: 400 });

  const outcomeFilter = req.nextUrl.searchParams.get('outcome');

  const db = createServiceClient();
  let query = db
    .from('workflow_qualification_decisions')
    .select('id, execution_id, created_at, ai_classification, ai_confidence, human_review_occurred, human_classification, final_classification, overridden, outcome_status, outcome_revenue, outcome_currency')
    .eq('user_id', user.id)
    .eq('workflow_id', workflowId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (outcomeFilter === 'open') {
    query = query.or('outcome_status.is.null,outcome_status.eq.contacted');
  } else if (outcomeFilter && outcomeFilter !== 'all') {
    query = query.eq('outcome_status', outcomeFilter);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load qualification decisions' }, { status: 500 });

  return NextResponse.json({ decisions: data ?? [], count: (data ?? []).length });
}
