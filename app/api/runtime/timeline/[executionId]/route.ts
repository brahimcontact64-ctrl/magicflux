import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { loadExecutionEvents } from '@/lib/runtime/event-store';

type Ctx = { params: { executionId: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp = req.nextUrl.searchParams;
  const fromSeqRaw = sp.get('from_seq');
  const toSeqRaw = sp.get('to_seq');
  const fromTs = sp.get('from_ts');
  const toTs = sp.get('to_ts');
  const limitRaw = sp.get('limit');
  const filterType = sp.get('type');

  const limit = limitRaw ? Math.min(2000, Math.max(1, parseInt(limitRaw, 10))) : 500;

  const events = await loadExecutionEvents({
    executionId,
    userId: user.id,
    fromSequence: fromSeqRaw !== null && !isNaN(parseInt(fromSeqRaw, 10)) ? parseInt(fromSeqRaw, 10) : undefined,
    toSequence: toSeqRaw !== null && !isNaN(parseInt(toSeqRaw, 10)) ? parseInt(toSeqRaw, 10) : undefined,
    limit,
  });

  let filtered = events;

  if (fromTs !== null) {
    const cutoff = new Date(fromTs).getTime();
    filtered = filtered.filter((e) => new Date(e.createdAt).getTime() >= cutoff);
  }
  if (toTs !== null) {
    const cutoff = new Date(toTs).getTime();
    filtered = filtered.filter((e) => new Date(e.createdAt).getTime() <= cutoff);
  }
  if (filterType) {
    const types = filterType.split(',').map((t) => t.trim()).filter(Boolean);
    if (types.length > 0) {
      filtered = filtered.filter((e) => types.includes(e.eventType));
    }
  }

  // Annotate causality chains
  const eventIndex = new Map(events.map((e) => [e.id, e]));
  const timeline = filtered.map((event) => ({
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    workerId: event.workerId,
    fencingToken: event.fencingToken,
    causationId: event.causationId,
    correlationId: event.correlationId,
    parentEventId: event.parentEventId,
    payload: event.payload,
    createdAt: event.createdAt,
    causedBy: event.causationId ? eventIndex.get(event.causationId)?.eventType ?? null : null,
  }));

  return NextResponse.json({
    executionId,
    totalEvents: events.length,
    filteredCount: filtered.length,
    timeline,
  });
}
