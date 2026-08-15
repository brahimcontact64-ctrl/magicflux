import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { loadExecutionEvents, loadLatestSnapshot } from '@/lib/runtime/event-store';
import {
  replayFromEvents,
  replayFromSnapshot,
  filterEventsUntilSequence,
  filterEventsUntilTimestamp,
  diffReplayStates,
} from '@/lib/runtime/replay-engine';

type Ctx = { params: { executionId: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp = req.nextUrl.searchParams;
  const untilSeqRaw = sp.get('until_seq');
  const untilTs = sp.get('until_ts');
  const diffFromRaw = sp.get('diff_from');
  const diffToRaw = sp.get('diff_to');
  const useSnapshot = sp.get('snapshot') !== 'false';

  const startMs = Date.now();

  const [snapshot, allEvents] = await Promise.all([
    useSnapshot ? loadLatestSnapshot({ executionId, userId: user.id }) : Promise.resolve(null),
    loadExecutionEvents({ executionId, userId: user.id }),
  ]);

  const loadMs = Date.now() - startMs;

  // Time-travel: optionally filter events to a point in time / sequence
  let replayEvents = allEvents;
  if (untilSeqRaw !== null) {
    const untilSeq = parseInt(untilSeqRaw, 10);
    if (!isNaN(untilSeq)) replayEvents = filterEventsUntilSequence(allEvents, untilSeq);
  } else if (untilTs !== null) {
    replayEvents = filterEventsUntilTimestamp(allEvents, untilTs);
  }

  // Snapshot-accelerated replay vs full replay from genesis
  const eventsForReplay =
    snapshot && replayEvents.length > 0
      ? replayEvents.filter((e) => e.sequenceNumber > snapshot.snapshotVersion)
      : replayEvents;

  const replayStartMs = Date.now();
  const state =
    snapshot && eventsForReplay.length < replayEvents.length
      ? replayFromSnapshot(snapshot, eventsForReplay)
      : replayFromEvents(replayEvents);
  const replayMs = Date.now() - replayStartMs;

  // Optional diff between two sequence points
  let diff: Record<string, { before: unknown; after: unknown }> | null = null;
  if (diffFromRaw !== null && diffToRaw !== null) {
    const fromSeq = parseInt(diffFromRaw, 10);
    const toSeq = parseInt(diffToRaw, 10);
    if (!isNaN(fromSeq) && !isNaN(toSeq)) {
      const beforeState = replayFromEvents(filterEventsUntilSequence(allEvents, fromSeq));
      const afterState = replayFromEvents(filterEventsUntilSequence(allEvents, toSeq));
      diff = diffReplayStates(beforeState, afterState);
    }
  }

  return NextResponse.json({
    executionId,
    state,
    totalEvents: allEvents.length,
    replayedEvents: replayEvents.length,
    snapshotUsed: snapshot !== null && eventsForReplay.length < replayEvents.length,
    snapshotVersion: snapshot?.snapshotVersion ?? null,
    diff,
    metrics: {
      load_ms: loadMs,
      replay_ms: replayMs,
      replay_event_count: state.replayedEventCount,
    },
  });
}
