import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

type Ctx = { params: { id: string } };

/**
 * GET /api/workflows/[id]/executions
 * Returns latest 20 executions for this workflow (owned by the authenticated user).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  const { data: executions, error } = await db
    .from('workflow_executions_v2')
    .select(
      'id, status, mode, current_node_id, error_message, retry_count, next_run_at, started_at, completed_at, created_at'
    )
    .eq('workflow_id', params.id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const normalized = (executions ?? []).map((exec) => ({
    ...exec,
    display_status: exec.mode === 'test' && exec.status === 'success' ? 'simulated_success' : exec.status,
  }));

  return NextResponse.json({ executions: normalized });
}
