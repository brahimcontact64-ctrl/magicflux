import { NextRequest, NextResponse } from 'next/server';

import { getObservabilitySummary } from '@/lib/agent/observability';
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

  const summary = await getObservabilitySummary(userId);
  return NextResponse.json({ success: true, summary });
}
