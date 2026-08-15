import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import {
  analyzeCompaction,
  markEventsCompactable,
  markEventsArchivable,
} from '@/lib/runtime/compaction';

type Ctx = { params: { executionId: string } };

// GET — analyse an execution's event stream for compaction opportunities.
//
// Optional query parameters:
//   ?archive_after_days=<n>  — treat events older than n days as archival candidates (default: 30)
//
// Response fields:
//   replayCostEstimate   — events that must be replayed from scratch (or snapshot)
//   compactableRanges    — event ranges covered by existing snapshots
//   archivalRanges       — old event ranges eligible for cold storage
//   snapshotRecommended  — true when replay cost is high and snapshot is stale
//   alreadyCompactable   — events already marked compactable
//   alreadyArchivable    — events already marked archivable
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp             = req.nextUrl.searchParams;
  const archiveDaysRaw = sp.get('archive_after_days');
  const archiveAfterDays = archiveDaysRaw !== null && !isNaN(parseInt(archiveDaysRaw, 10))
    ? Math.max(1, parseInt(archiveDaysRaw, 10))
    : undefined;

  const report = await analyzeCompaction({
    executionId,
    userId: user.id,
    archiveAfterDays,
  });

  return NextResponse.json({ ...report });
}

// POST — mark events as compactable or archivable.
//
// Body variants:
//   { action: 'mark_compactable'; upToSequence: number }
//   { action: 'mark_archivable';  beforeTs: string }
//
// These operations are safe and non-destructive: they only set boolean flags.
// Actual deletion or archival must be performed by a separate offline process.
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_executions');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action } = body as { action?: string };

  if (action === 'mark_compactable') {
    const { upToSequence } = body as { upToSequence?: unknown };
    const seq = typeof upToSequence === 'number' ? upToSequence : parseInt(String(upToSequence ?? ''), 10);
    if (isNaN(seq) || seq < 1) {
      return NextResponse.json({ error: 'upToSequence must be a positive integer' }, { status: 400 });
    }
    const result = await markEventsCompactable({ executionId, userId: user.id, upToSequence: seq });
    return NextResponse.json({ executionId, action, ...result });
  }

  if (action === 'mark_archivable') {
    const { beforeTs } = body as { beforeTs?: unknown };
    if (typeof beforeTs !== 'string' || isNaN(new Date(beforeTs).getTime())) {
      return NextResponse.json({ error: 'beforeTs must be a valid ISO timestamp string' }, { status: 400 });
    }
    const result = await markEventsArchivable({ executionId, userId: user.id, beforeTs });
    return NextResponse.json({ executionId, action, ...result });
  }

  return NextResponse.json({ error: "action must be 'mark_compactable' or 'mark_archivable'" }, { status: 400 });
}
