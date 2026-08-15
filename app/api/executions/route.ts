import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import type { ExecutionRecord, PaginatedExecutions } from '@/lib/execution/types';

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/executions
 *
 * Query params:
 *   ?workflow_id=<uuid>
 *   ?status=running|success|failed|waiting|paused|cancelled
 *   ?mode=test|live
 *   ?from=<ISO>            – started_at >=
 *   ?to=<ISO>              – started_at <=
 *   ?search=<text>         – workflow name ilike
 *   ?page=<n>              – 1-indexed (default 1)
 *   ?page_size=<n>         – default 20, max 100
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const workflowId = sp.get('workflow_id');
  const status     = sp.get('status');
  const mode       = sp.get('mode');
  const from       = sp.get('from');
  const to         = sp.get('to');
  const search     = sp.get('search');
  const pageRaw    = parseInt(sp.get('page')      ?? '1',  10);
  const sizeRaw    = parseInt(sp.get('page_size') ?? '20', 10);
  const page       = Math.max(1, isNaN(pageRaw) ? 1 : pageRaw);
  const pageSize   = Math.min(MAX_PAGE_SIZE, Math.max(1, isNaN(sizeRaw) ? PAGE_SIZE : sizeRaw));
  const offset     = (page - 1) * pageSize;

  // Use the summary view — it already has step_count, failed_step_count, duration_ms
  let query = db
    .from('v_execution_summaries')
    .select(
      'id, workflow_id, workflow_name, status, mode, started_at, completed_at, ' +
      'duration_ms, step_count, failed_step_count, error_message, retry_count',
      { count: 'exact' }
    )
    .eq('user_id', user.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + pageSize - 1);

  if (workflowId) query = query.eq('workflow_id', workflowId);
  if (status)     query = query.eq('status', status);
  if (mode)       query = query.eq('mode', mode);
  if (from && !isNaN(new Date(from).getTime())) query = query.gte('started_at', from);
  if (to   && !isNaN(new Date(to).getTime()))   query = query.lte('started_at', to);
  if (search)     query = query.ilike('workflow_name', `%${search}%`);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to load executions' }, { status: 500 });
  }

  type Row = Record<string, unknown>;
  const executions: ExecutionRecord[] = ((data ?? []) as unknown as Row[]).map(r => ({
    id:                 String(r.id),
    workflow_id:        String(r.workflow_id ?? ''),
    workflow_name:      String(r.workflow_name ?? 'Unknown'),
    status:             r.status as ExecutionRecord['status'],
    mode:               (r.mode ?? 'live') as ExecutionRecord['mode'],
    started_at:         (r.started_at as string) ?? null,
    completed_at:       (r.completed_at as string) ?? null,
    duration_ms:        r.duration_ms != null ? Number(r.duration_ms) : null,
    step_count:         Number(r.step_count ?? 0),
    failed_step_count:  Number(r.failed_step_count ?? 0),
    error_message:      (r.error_message as string) ?? null,
    retry_count:        Number(r.retry_count ?? 0),
  }));

  const total = count ?? 0;
  const response: PaginatedExecutions = {
    executions,
    total,
    page,
    page_size: pageSize,
    has_next:  offset + pageSize < total,
  };

  return NextResponse.json(response);
}
