import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { loadLatestSnapshot, loadExecutionEvents, saveExecutionSnapshot } from '@/lib/runtime/event-store';
import { replayFromEvents, replayFromSnapshot } from '@/lib/runtime/replay-engine';

type Ctx = { params: { executionId: string } };

// GET — return the latest snapshot; if none exists and ?create=true, replay events and create one.
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp = req.nextUrl.searchParams;
  const createIfMissing = sp.get('create') === 'true';

  const snapshot = await loadLatestSnapshot({ executionId, userId: user.id });

  if (snapshot) {
    return NextResponse.json({ executionId, snapshot });
  }

  if (!createIfMissing) {
    return NextResponse.json({ executionId, snapshot: null });
  }

  // Replay all events and create a snapshot from the current state.
  const events = await loadExecutionEvents({ executionId, userId: user.id });
  if (events.length === 0) {
    return NextResponse.json({ executionId, snapshot: null });
  }

  const state = replayFromEvents(events);
  const workflowId = state.workflowId ?? events[0]?.workflowId ?? '';

  const saved = await saveExecutionSnapshot({
    executionId,
    workflowId,
    userId: user.id,
    snapshotType: 'checkpoint',
    stateSnapshot: {
      status: state.status,
      worker_id: state.workerId,
      owner_token: state.ownerToken,
      fencing_token: state.fencingToken,
      side_effects: state.sideEffects,
      ownership_history: state.ownershipHistory,
      split_brain_events: state.splitBrainEvents,
      created_at: state.createdAt,
      completed_at: state.completedAt,
      error_message: state.errorMessage,
    },
    metadata: {
      replayed_event_count: state.replayedEventCount,
      last_sequence: state.lastSequence,
      created_by: 'snapshot_api',
    },
  });

  const newSnapshot = saved ? await loadLatestSnapshot({ executionId, userId: user.id }) : null;

  return NextResponse.json({
    executionId,
    snapshot: newSnapshot,
    created: saved !== null,
    snapshotVersion: saved?.snapshotVersion ?? null,
    replayedEventCount: state.replayedEventCount,
  });
}

// POST — force-create a new snapshot from the current replayed state.
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const [snapshot, events] = await Promise.all([
    loadLatestSnapshot({ executionId, userId: user.id }),
    loadExecutionEvents({ executionId, userId: user.id }),
  ]);

  if (events.length === 0) {
    return NextResponse.json({ error: 'No events found for execution' }, { status: 404 });
  }

  const eventsForReplay = snapshot
    ? events.filter((e) => e.sequenceNumber > snapshot.snapshotVersion)
    : events;

  const state = snapshot ? replayFromSnapshot(snapshot, eventsForReplay) : replayFromEvents(events);
  const workflowId = state.workflowId ?? events[0]?.workflowId ?? '';

  const saved = await saveExecutionSnapshot({
    executionId,
    workflowId,
    userId: user.id,
    snapshotType: 'manual',
    stateSnapshot: {
      status: state.status,
      worker_id: state.workerId,
      owner_token: state.ownerToken,
      fencing_token: state.fencingToken,
      side_effects: state.sideEffects,
      ownership_history: state.ownershipHistory,
      split_brain_events: state.splitBrainEvents,
      created_at: state.createdAt,
      completed_at: state.completedAt,
      error_message: state.errorMessage,
    },
    metadata: {
      replayed_event_count: state.replayedEventCount,
      last_sequence: state.lastSequence,
      created_by: 'snapshot_api_post',
    },
  });

  if (!saved) {
    return NextResponse.json({ error: 'Failed to save snapshot' }, { status: 500 });
  }

  return NextResponse.json({
    executionId,
    snapshotVersion: saved.snapshotVersion,
    replayedEventCount: state.replayedEventCount,
    lastSequence: state.lastSequence,
  });
}
