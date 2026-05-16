import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { ExecutionManager } from '@/runtime/execution-manager';

/**
 * POST /api/workflows/executions/resume
 *
 * Resumes all (or a specific) waiting execution where next_run_at <= now.
 * For manual testing, or to be called by a cron job.
 *
 * Body (optional):
 *   { executionId: string }  — resume a specific execution
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const executionManager = new ExecutionManager();
  const body = await req.json().catch(() => ({})) as { executionId?: string };

  let query = db
    .from('workflow_executions_v2')
    .select('id, workflow_id, user_id, current_node_id, input_data, retry_count, max_retries, mode')
    .eq('status', 'waiting')
    .eq('user_id', user.id)
    .lte('next_run_at', new Date().toISOString());

  if (body.executionId) {
    query = query.eq('id', body.executionId) as typeof query;
  }

  const { data: executions, error } = await query.limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!executions || executions.length === 0) {
    return NextResponse.json({ resumed: 0, message: 'No waiting executions ready to resume' });
  }

  // Load workflow JSONs
  const workflowIds = Array.from(new Set(executions.map((e) => e.workflow_id)));
  const { data: workflows } = await db
    .from('workflows')
    .select('id, workflow_json')
    .in('id', workflowIds);

  const workflowMap = new Map<string, unknown>(
    (workflows ?? []).map((w) => [w.id, w.workflow_json])
  );

  const results = await Promise.allSettled(
    executions.map(async (exec) => {
      const workflowJson = workflowMap.get(exec.workflow_id);
      if (!workflowJson) return Promise.resolve({ id: exec.id, error: 'Workflow not found' });

      return executionManager.resumeExecution({
        executionId: exec.id,
        userId: exec.user_id,
        workflowJson,
        workflowId: exec.workflow_id,
        mode: (exec.mode ?? 'live') as 'test' | 'live',
        inputData: (exec.input_data ?? {}) as Record<string, unknown>,
        retryCount: exec.retry_count ?? 0,
        maxRetries: exec.max_retries ?? 3,
      });
    })
  );

  const resumed = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  return NextResponse.json({ resumed, failed, total: executions.length });
}
