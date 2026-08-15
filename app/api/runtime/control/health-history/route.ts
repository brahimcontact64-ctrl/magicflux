import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';

type WindowKey = '24h' | '7d' | '30d';

const WINDOW_MS: Record<WindowKey, number> = {
  '24h':       24 * 60 * 60 * 1000,
  '7d':   7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// GET — health score snapshot history for trend charts.
//
// Query params:
//   ?window=24h|7d|30d   — time window (default: 24h)
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const sp = req.nextUrl.searchParams;

  const rawWindow = sp.get('window') ?? '24h';
  const window: WindowKey = rawWindow in WINDOW_MS ? (rawWindow as WindowKey) : '24h';
  const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();

  const { data, error } = await db
    .from('runtime_health_score_snapshots')
    .select('id, overall_score, components, signals, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })
    .limit(500);

  if (error) return NextResponse.json({ error: 'Query failed' }, { status: 500 });

  return NextResponse.json({
    snapshots: data ?? [],
    window,
  });
}
