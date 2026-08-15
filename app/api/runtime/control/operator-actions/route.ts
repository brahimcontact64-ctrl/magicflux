import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';

// GET — paginated operator audit log with search and filter support.
//
// Query params:
//   ?search=<text>        — ilike filter on action_type
//   ?action_type=<t>      — exact action_type filter (ignored when search is present)
//   ?from=<ISO>           — created_at >= from
//   ?to=<ISO>             — created_at <= to
//   ?page=<n>             — 1-indexed page number (default 1)
//   ?page_size=<n>        — results per page (default 50, max 200)
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_audit') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const search      = sp.get('search');
  const actionType  = sp.get('action_type');
  const from        = sp.get('from');
  const to          = sp.get('to');
  const pageRaw     = parseInt(sp.get('page')      ?? '1',  10);
  const pageSizeRaw = parseInt(sp.get('page_size') ?? '50', 10);
  const page        = Math.max(1, isNaN(pageRaw)     ? 1  : pageRaw);
  const pageSize    = Math.min(200, Math.max(1, isNaN(pageSizeRaw) ? 50 : pageSizeRaw));
  const offset      = (page - 1) * pageSize;

  let q = db
    .from('runtime_operator_actions')
    .select(
      'id, action_type, operator_id, execution_id, worker_id, incident_id, workflow_id, ' +
      'payload, result, created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (!isAdmin) q = q.eq('operator_id', user.id);

  if (search) {
    q = q.ilike('action_type', `%${search}%`);
  } else if (actionType) {
    q = q.eq('action_type', actionType);
  }

  if (from && !isNaN(new Date(from).getTime())) q = q.gte('created_at', from);
  if (to   && !isNaN(new Date(to).getTime()))   q = q.lte('created_at', to);

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 });

  return NextResponse.json({
    actions:  data ?? [],
    count:    (data ?? []).length,
    total:    count ?? 0,
    page,
    pageSize,
  });
}
