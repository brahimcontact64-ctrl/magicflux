import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import {
  getSlaReport,
  upsertSlaTarget,
  type SlaTargetType,
} from '@/lib/runtime/sla-engine';

// GET — SLA report: targets, recent violations, compliance.
//
// Query params:
//   ?window=<hours>   — violation window in hours, default 24
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp          = req.nextUrl.searchParams;
  const windowHours = parseInt(sp.get('window') ?? '24', 10);
  const safeWindow  = Math.min(720, Math.max(1, isNaN(windowHours) ? 24 : windowHours));

  const report = await getSlaReport(safeWindow);

  return NextResponse.json({ ...report, generatedAt: new Date().toISOString() });
}

// POST — upsert an SLA target.
//
// Body: { targetType, thresholdMs, warningPct?, description? }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_executions');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { targetType, thresholdMs, warningPct, description } = body as Record<string, unknown>;

  const validTypes: SlaTargetType[] = [
    'execution_duration', 'worker_availability', 'queue_latency', 'command_ack_time',
  ];

  if (typeof targetType !== 'string' || !validTypes.includes(targetType as SlaTargetType)) {
    return NextResponse.json(
      { error: `targetType must be one of: ${validTypes.join(', ')}` },
      { status: 400 }
    );
  }

  if (typeof thresholdMs !== 'number' || thresholdMs <= 0) {
    return NextResponse.json({ error: 'thresholdMs must be a positive number' }, { status: 400 });
  }

  const target = await upsertSlaTarget({
    targetType:  targetType as SlaTargetType,
    thresholdMs: thresholdMs as number,
    warningPct:  typeof warningPct === 'number' ? warningPct : undefined,
    description: typeof description === 'string' ? description : undefined,
  });

  return NextResponse.json({ target });
}
