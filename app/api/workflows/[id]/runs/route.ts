import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

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

  if (workflowError) return NextResponse.json({ error: workflowError.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const { data: runs, error: runsError } = await db
    .from('workflow_runs')
    .select('id, status, logs, previews, final_output, error_message, created_at')
    .eq('workflow_id', params.id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (runsError) return NextResponse.json({ error: runsError.message }, { status: 500 });

  return NextResponse.json({ success: true, runs: runs ?? [] });
}
