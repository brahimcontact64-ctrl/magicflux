import { NextRequest, NextResponse } from 'next/server';

import { approveAction } from '@/lib/agent/safety';
import { createCorrelationId, emitRuntimeEvent } from '@/lib/runtime/events';
import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    sessionId?: string;
    actionKey?: string;
    decision?: 'approve' | 'reject';
  };

  const sessionId = String(body.sessionId ?? '').trim();
  const actionKey = String(body.actionKey ?? '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';

  if (!sessionId || !actionKey) {
    return NextResponse.json({ error: 'sessionId and actionKey are required' }, { status: 400 });
  }

  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Authentication required for approvals' }, { status: 401 });
  }

  const ok = await approveAction({
    userId,
    sessionId,
    actionKey,
    approve: decision === 'approve',
  });

  if (!ok) {
    return NextResponse.json({ error: 'Approval update failed' }, { status: 500 });
  }

  const db = createServiceClient();
  const { data } = await db
    .from('agent_action_approvals')
    .select('action_key, action_type, reason, status, approved_at')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .eq('action_key', actionKey)
    .limit(1)
    .maybeSingle();

  await emitRuntimeEvent({
    eventType: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
    userId,
    sessionId,
    workflowId: null,
    agentId: 'planner',
    correlationId: createCorrelationId(sessionId),
    payload: {
      actionKey,
      actionType: data?.action_type ?? null,
      status: data?.status ?? null,
    },
    severity: decision === 'approve' ? 'info' : 'warning',
  });

  return NextResponse.json({
    success: true,
    approval: data ?? null,
  });
}
