import { NextRequest, NextResponse } from 'next/server';

import { getSessionTimeline } from '@/lib/agent/observability';
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

  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const timeline = await getSessionTimeline(userId, sessionId);

  const safeTimeline = timeline.map((entry) => {
    const eventType = String(entry.event_type ?? 'event');
    const actionName = entry.action_name ? String(entry.action_name) : null;
    const status = String(entry.status ?? 'info');
    const detail = entry.detail ? String(entry.detail) : null;
    const createdAt = entry.created_at ? String(entry.created_at) : null;

    const title = actionName
      ? `${actionName.replace(/_/g, ' ')} ${status === 'error' ? 'failed' : status === 'success' ? 'completed' : status}`
      : eventType.replace(/_/g, ' ');

    return {
      title,
      description: detail,
      status,
      timestamp: createdAt,
      category: eventType,
    };
  });

  return NextResponse.json({ success: true, timeline: safeTimeline });
}
