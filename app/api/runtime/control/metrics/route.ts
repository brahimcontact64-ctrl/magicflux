import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import {
  recordRuntimeMetricsSnapshot,
  queryMetricSeries,
  listAvailableMetrics,
  type MetricWindow,
} from '@/lib/runtime/metrics-engine';

const VALID_WINDOWS: MetricWindow[] = ['5m', '15m', '1h', '24h', '7d', '30d'];

// GET — query metric time-series or trigger a snapshot.
//
// Query params:
//   ?metric=<name>          — required for time-series query
//   ?window=5m|15m|1h|24h|7d|30d — time window, default 1h
//   ?from=<iso>             — range start (overrides window)
//   ?to=<iso>               — range end (default: now)
//   ?list=true              — list available metric names (last 24h)
//   ?snapshot=true          — record a fresh snapshot and return it
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;

  if (sp.get('list') === 'true') {
    const names = await listAvailableMetrics();
    return NextResponse.json({ metrics: names, count: names.length });
  }

  if (sp.get('snapshot') === 'true') {
    if (!perms.includes('admin_runtime')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const snapshot = await recordRuntimeMetricsSnapshot();
    return NextResponse.json({ snapshot, generatedAt: new Date().toISOString() });
  }

  const metricName = sp.get('metric');
  if (!metricName) {
    return NextResponse.json(
      { error: "metric query param required, or use ?list=true or ?snapshot=true" },
      { status: 400 }
    );
  }

  const windowRaw = sp.get('window') ?? '1h';
  const window: MetricWindow = VALID_WINDOWS.includes(windowRaw as MetricWindow)
    ? (windowRaw as MetricWindow)
    : '1h';

  const from  = sp.get('from') ?? undefined;
  const to    = sp.get('to')   ?? undefined;
  const limit = parseInt(sp.get('limit') ?? '500', 10);

  const series = await queryMetricSeries({ metricName, window, from, to, limit });

  return NextResponse.json({ series, generatedAt: new Date().toISOString() });
}
