import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';

// GET — search traces or fetch a single trace with spans.
//
// Query params:
//   ?id=<traceId>           — fetch single trace + all spans
//   ?execution_id=<uuid>    — filter by execution
//   ?workflow_id=<uuid>     — filter by workflow
//   ?status=running|completed|failed|cancelled
//   ?limit=<n>              — default 50
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const sp    = req.nextUrl.searchParams;
  const db    = createServiceClient();
  const id    = sp.get('id');

  if (id) {
    let traceQ = db.from('runtime_traces').select('*').eq('trace_id', id);
    if (!isAdmin) traceQ = traceQ.eq('user_id', user.id);

    // Ownership confirmed before spans are queried.
    const traceRes = await traceQ.maybeSingle();
    if (!traceRes.data) {
      return NextResponse.json({ error: 'Trace not found' }, { status: 404 });
    }

    const spansRes = await db
      .from('runtime_spans')
      .select('*')
      .eq('trace_id', id)
      .order('started_at', { ascending: true })
      .limit(500);

    return NextResponse.json({
      trace: traceRes.data,
      spans: spansRes.data ?? [],
    });
  }

  const executionId = sp.get('execution_id');
  const workflowId  = sp.get('workflow_id');
  const status      = sp.get('status');
  const limitRaw    = parseInt(sp.get('limit') ?? '50', 10);
  const limit       = Math.min(500, Math.max(1, isNaN(limitRaw) ? 50 : limitRaw));

  let query = db
    .from('runtime_traces')
    .select('trace_id, user_id, session_id, workflow_id, execution_id, correlation_id, root_agent, status, started_at, completed_at, metadata')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (!isAdmin) query = query.eq('user_id', user.id);
  if (executionId) query = query.eq('execution_id', executionId);
  if (workflowId)  query = query.eq('workflow_id',  workflowId);
  if (status)      query = query.eq('status',        status);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch traces' }, { status: 500 });
  }

  return NextResponse.json({
    traces:      data ?? [],
    count:       (data ?? []).length,
    generatedAt: new Date().toISOString(),
  });
}
