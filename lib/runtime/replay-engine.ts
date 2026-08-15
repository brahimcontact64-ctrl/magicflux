// Pure deterministic state machine for execution replay.
// Given the same ordered event stream, always produces the same state.
// NO database calls, NO external mutations — safe to call during debugging.

import type { ExecutionEvent, ExecutionSnapshot } from './event-store';

export type SideEffectRecord = {
  eventId: string;
  operation: string;
  status: 'requested' | 'completed' | 'failed';
  timestamp: string;
  sequenceNumber: number;
};

export type OwnershipRecord = {
  workerId: string;
  ownerToken: string;
  fencingToken: number;
  claimedAt: string;
  releasedAt: string | null;
};

export type SplitBrainRecord = {
  staleWorkerId: string;
  authoritativeFencingToken: number;
  timestamp: string;
  sequenceNumber: number;
};

export type ExecutionReplayState = {
  executionId: string;
  status: 'unknown' | 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  workflowId: string | null;
  workerId: string | null;
  ownerToken: string | null;
  fencingToken: number;
  sideEffects: SideEffectRecord[];
  ownershipHistory: OwnershipRecord[];
  splitBrainEvents: SplitBrainRecord[];
  lastSequence: number;
  createdAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  replayedEventCount: number;
};

function initialState(executionId: string): ExecutionReplayState {
  return {
    executionId,
    status: 'unknown',
    workflowId: null,
    workerId: null,
    ownerToken: null,
    fencingToken: 0,
    sideEffects: [],
    ownershipHistory: [],
    splitBrainEvents: [],
    lastSequence: 0,
    createdAt: null,
    completedAt: null,
    errorMessage: null,
    replayedEventCount: 0,
  };
}

function applyEvent(state: ExecutionReplayState, event: ExecutionEvent): ExecutionReplayState {
  const next: ExecutionReplayState = {
    ...state,
    lastSequence: event.sequenceNumber,
    replayedEventCount: state.replayedEventCount + 1,
  };

  switch (event.eventType) {
    case 'execution_created':
      return {
        ...next,
        status: 'created',
        workflowId: next.workflowId ?? (event.payload.workflow_id != null ? String(event.payload.workflow_id) : null),
        createdAt: event.createdAt,
      };

    case 'execution_started':
      return { ...next, status: 'running' };

    case 'execution_paused':
      return { ...next, status: 'paused' };

    case 'execution_resumed':
      return { ...next, status: 'running' };

    case 'execution_completed':
      return { ...next, status: 'completed', completedAt: event.createdAt };

    case 'execution_failed':
      return {
        ...next,
        status: 'failed',
        completedAt: event.createdAt,
        errorMessage: event.payload.error != null ? String(event.payload.error) : state.errorMessage,
      };

    case 'execution_cancelled':
      return { ...next, status: 'cancelled', completedAt: event.createdAt };

    case 'ownership_claimed': {
      const workerId = event.payload.worker_id != null ? String(event.payload.worker_id) : event.workerId;
      const ownerToken = event.payload.owner_token != null ? String(event.payload.owner_token) : null;
      const fencingToken = event.fencingToken ?? Number(event.payload.fencing_token ?? 0);
      const newRecord: OwnershipRecord = {
        workerId: workerId ?? '',
        ownerToken: ownerToken ?? '',
        fencingToken,
        claimedAt: event.createdAt,
        releasedAt: null,
      };
      return {
        ...next,
        workerId,
        ownerToken,
        fencingToken,
        status: next.status === 'unknown' ? 'running' : next.status,
        ownershipHistory: [...next.ownershipHistory, newRecord],
      };
    }

    case 'ownership_renewed':
      return { ...next, fencingToken: event.fencingToken ?? next.fencingToken };

    case 'ownership_replaced':
    case 'ownership_expired': {
      const updatedHistory = next.ownershipHistory.map((h, i) =>
        i === next.ownershipHistory.length - 1 && h.releasedAt === null
          ? { ...h, releasedAt: event.createdAt }
          : h
      );
      return { ...next, ownershipHistory: updatedHistory };
    }

    case 'ownership_fenced':
    case 'split_brain_prevented': {
      const splitRecord: SplitBrainRecord = {
        staleWorkerId: event.workerId ?? String(event.payload.stale_worker_id ?? ''),
        authoritativeFencingToken: Number(
          event.payload.authoritative_fencing_token ?? event.fencingToken ?? 0
        ),
        timestamp: event.createdAt,
        sequenceNumber: event.sequenceNumber,
      };
      return { ...next, splitBrainEvents: [...next.splitBrainEvents, splitRecord] };
    }

    case 'side_effect_requested': {
      const record: SideEffectRecord = {
        eventId: event.id,
        operation: String(event.payload.operation ?? ''),
        status: 'requested',
        timestamp: event.createdAt,
        sequenceNumber: event.sequenceNumber,
      };
      return { ...next, sideEffects: [...next.sideEffects, record] };
    }

    case 'side_effect_completed': {
      const updated = updateSideEffectStatus(next.sideEffects, event, 'completed');
      return { ...next, sideEffects: updated };
    }

    case 'side_effect_failed': {
      const updated = updateSideEffectStatus(next.sideEffects, event, 'failed');
      return { ...next, sideEffects: updated };
    }

    case 'execution_isolated':
      return { ...next, status: 'failed', errorMessage: 'Execution isolated by healing system' };

    case 'orphan_recovered':
      return { ...next, status: 'running' };

    default:
      return next;
  }
}

// Resolves the matching 'requested' side-effect by causationId first,
// then falls back to last-matching operation name.
function updateSideEffectStatus(
  effects: SideEffectRecord[],
  event: ExecutionEvent,
  newStatus: 'completed' | 'failed'
): SideEffectRecord[] {
  const causingId = event.causationId;
  if (causingId) {
    const idx = effects.findIndex((e) => e.eventId === causingId);
    if (idx >= 0) {
      const result = [...effects];
      result[idx] = { ...result[idx], status: newStatus };
      return result;
    }
  }
  // Fallback: update the last 'requested' entry with the same operation name.
  const op = String(event.payload.operation ?? '');
  let lastIdx = -1;
  for (let i = effects.length - 1; i >= 0; i--) {
    if (effects[i].operation === op && effects[i].status === 'requested') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx >= 0) {
    const result = [...effects];
    result[lastIdx] = { ...result[lastIdx], status: newStatus };
    return result;
  }
  return effects;
}

// Replays a sequence of events from scratch.
// Events MUST be pre-sorted by sequence_number ascending.
export function replayFromEvents(events: ExecutionEvent[]): ExecutionReplayState {
  if (events.length === 0) {
    return initialState('');
  }
  let state = initialState(events[0].executionId);
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

// Hydrates state from a snapshot and applies the remaining events on top.
// Use this for fast replay of long-running executions.
export function replayFromSnapshot(
  snapshot: ExecutionSnapshot,
  eventsAfterSnapshot: ExecutionEvent[]
): ExecutionReplayState {
  const ss = snapshot.stateSnapshot;
  const base: ExecutionReplayState = {
    executionId: snapshot.executionId,
    status: (ss.status as ExecutionReplayState['status']) ?? 'running',
    workflowId: snapshot.workflowId,
    workerId: ss.worker_id != null ? String(ss.worker_id) : null,
    ownerToken: ss.owner_token != null ? String(ss.owner_token) : null,
    fencingToken: Number(ss.fencing_token ?? 0),
    sideEffects: (ss.side_effects as SideEffectRecord[]) ?? [],
    ownershipHistory: (ss.ownership_history as OwnershipRecord[]) ?? [],
    splitBrainEvents: (ss.split_brain_events as SplitBrainRecord[]) ?? [],
    lastSequence: snapshot.snapshotVersion,
    createdAt: ss.created_at != null ? String(ss.created_at) : snapshot.createdAt,
    completedAt: ss.completed_at != null ? String(ss.completed_at) : null,
    errorMessage: ss.error_message != null ? String(ss.error_message) : null,
    replayedEventCount: 0,
  };

  let state = base;
  for (const event of eventsAfterSnapshot) {
    state = applyEvent(state, event);
  }
  return state;
}

// Filters events to only those at or before the given sequence number.
export function filterEventsUntilSequence(
  events: ExecutionEvent[],
  untilSequence: number
): ExecutionEvent[] {
  return events.filter((e) => e.sequenceNumber <= untilSequence);
}

// Filters events to only those at or before the given ISO timestamp.
export function filterEventsUntilTimestamp(
  events: ExecutionEvent[],
  untilTimestamp: string
): ExecutionEvent[] {
  const cutoff = new Date(untilTimestamp).getTime();
  return events.filter((e) => new Date(e.createdAt).getTime() <= cutoff);
}

// Returns a field-by-field diff between two replay states.
// Useful for time-travel debugging: what changed between sequence A and B?
export function diffReplayStates(
  before: ExecutionReplayState,
  after: ExecutionReplayState
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]) as Set<keyof ExecutionReplayState>;

  for (const key of keys) {
    const bStr = JSON.stringify(before[key]);
    const aStr = JSON.stringify(after[key]);
    if (bStr !== aStr) {
      diff[key] = { before: before[key], after: after[key] };
    }
  }
  return diff;
}
