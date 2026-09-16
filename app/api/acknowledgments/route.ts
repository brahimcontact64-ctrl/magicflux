import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/acknowledgments
 *
 * Lists the authenticated user's own SLA acknowledgment items (Part L --
 * the minimal dashboard visibility this capability needs: which items are
 * awaiting acknowledgment, their deadline, and which have already
 * breached). Mirrors app/api/reviews/route.ts's exact OWNER-ONLY shape
 * (Phase 9.9.2A) -- every query filtered by the authenticated caller's own
 * id, never a client-supplied one, no cross-tenant view.
 *
 * Deliberately never selects acknowledgment_token_hash (Part D/K -- no
 * secret/token material is ever exposed, even to the row's own owner).
 *
 * ?status=pending|acknowledged|timed_out|all (default: pending -- awaiting
 * acknowledgment, the actionable dashboard view).
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const statusParam = req.nextUrl.searchParams.get('status') ?? 'pending';

  let query = db
    .from('workflow_acknowledgments')
    .select('id, workflow_id, execution_id, node_id, node_name, status, deadline_at, escalation_level, acknowledged_by, acknowledged_at, late_acknowledged_by, late_acknowledged_at, created_at')
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
