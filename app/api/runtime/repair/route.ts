import { NextRequest, NextResponse } from 'next/server';

import { RuntimeRepairEngine } from '@/recovery/runtime-repair';
import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as {
    workflowId?: string;
    sessionId?: string;
    errorMessage?: string;
  } | null;

  const workflowId = String(body?.workflowId ?? '');
  const sessionId = String(body?.sessionId ?? '');
  const errorMessage = String(body?.errorMessage ?? '');

  if (!workflowId || !sessionId || !errorMessage) {
    return NextResponse.json(
      { error: 'workflowId, sessionId and errorMessage are required' },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const { data: workflow } = await db
    .from('workflows')
    .select('workflow_json')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const repair = new RuntimeRepairEngine();
  const result = await repair.attemptRepair({
    userId,
    workflowId,
    sessionId,
    errorMessage,
    workflowJson: (workflow.workflow_json ?? {}) as Record<string, unknown>,
  });

  return NextResponse.json({ success: true, result });
}
