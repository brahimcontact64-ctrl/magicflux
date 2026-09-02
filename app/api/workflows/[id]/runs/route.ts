import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { redact } from '@/lib/security/redact';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const { data: runs, error: runsError } = await db
    .from('workflow_runs')
    .select('id, status, logs, previews, final_output, error_message, created_at')
    .eq('workflow_id', params.id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (runsError) {
    const safe = classifyError(runsError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  // Phase 9.4.1: read-time defense-in-depth, same as
  // /api/workflows/executions/[id]/steps -- protects historical rows
  // written before the /api/workflows/[id]/test route started sanitizing
  // on write, regardless of when this row was created.
  const safeRuns = (runs ?? []).map((run) => ({
    ...run,
    logs: redact(run.logs),
    previews: redact(run.previews),
    final_output: redact(run.final_output),
  }));

  return NextResponse.json({ success: true, runs: safeRuns });
}
