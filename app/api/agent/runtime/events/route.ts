import { NextRequest, NextResponse } from 'next/server';

import { replayRuntimeEvents } from '@/lib/runtime/events';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim() || undefined;
  const correlationId = req.nextUrl.searchParams.get('correlationId')?.trim() || undefined;
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;

  const events = await replayRuntimeEvents({
    userId,
    sessionId,
    correlationId,
    limit,
  });

  return NextResponse.json({ success: true, events });
}
