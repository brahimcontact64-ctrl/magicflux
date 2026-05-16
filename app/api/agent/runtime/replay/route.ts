import { NextRequest, NextResponse } from 'next/server';

import { replayDeadLetterJob, replayExecution, replayFromStep } from '@/lib/runtime/replay';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

type ReplayBody = {
  type?: 'execution' | 'step' | 'dlq';
  id?: string;
  reason?: string;
};

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as ReplayBody;
  const replayType = body.type;
  const id = String(body.id ?? '').trim();
  const reason = String(body.reason ?? '').trim() || undefined;

  if (!replayType || !id) {
    return NextResponse.json({ error: 'type and id are required' }, { status: 400 });
  }

  try {
    if (replayType === 'execution') {
      const replay = await replayExecution({ userId, executionId: id, reason });
      return NextResponse.json({ success: true, replayType, replay });
    }

    if (replayType === 'step') {
      const replay = await replayFromStep({ userId, stepId: id, reason });
      return NextResponse.json({ success: true, replayType, replay });
    }

    if (replayType === 'dlq') {
      const replay = await replayDeadLetterJob({ userId, dlqId: id, reason });
      return NextResponse.json({ success: true, replayType, replay });
    }

    return NextResponse.json({ error: 'Unsupported replay type' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Replay failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
