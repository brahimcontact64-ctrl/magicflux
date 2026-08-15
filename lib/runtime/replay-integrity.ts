import "server-only";

import { createHash } from 'node:crypto';
import type { ExecutionEvent } from './event-store';
import { loadExecutionEvents, loadLatestSnapshot } from './event-store';

export type SequenceGap = {
  afterSequence:  number;
  beforeSequence: number;
  missingCount:   number;
};

export type FencingViolation = {
  sequenceNumber: number;
  eventType:      string;
  previousToken:  number;
  currentToken:   number;
  violationType:  'non_monotonic' | 'split_brain_stale_token';
};

export type ReplayIntegrityReport = {
  executionId:                string;
  totalEvents:                number;
  checksum:                   string;
  sequenceGaps:               SequenceGap[];
  fencingViolations:          FencingViolation[];
  snapshotCompatible:         boolean;
  snapshotVersion:            number | null;
  deterministicReplayVerdict: 'clean' | 'gaps_detected' | 'fencing_violations' | 'snapshot_mismatch' | 'no_events';
  details:                    Record<string, unknown>;
};

/**
 * Computes a deterministic SHA-256 checksum over the event stream.
 *
 * Each event contributes the line: `<seq>:<type>:<payload_json>\n`
 * This checksum is stable across workers and replay runs — if the same
 * ordered events are fed in, the same hex digest is always produced.
 */
export function computeEventStreamChecksum(events: ExecutionEvent[]): string {
  if (events.length === 0) return '';
  const hash = createHash('sha256');
  for (const event of events) {
    hash.update(`${event.sequenceNumber}:${event.eventType}:${JSON.stringify(event.payload)}\n`);
  }
  return hash.digest('hex');
}

/**
 * Detects gaps in the monotonic sequence number stream.
 * Events must already be sorted ascending by sequenceNumber.
 * A gap means one or more events were either never written or were deleted
 * (both are violations of the append-only invariant).
 */
export function detectSequenceGaps(events: ExecutionEvent[]): SequenceGap[] {
  const gaps: SequenceGap[] = [];
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].sequenceNumber;
    const curr = sorted[i].sequenceNumber;
    if (curr - prev > 1) {
      gaps.push({
        afterSequence:  prev,
        beforeSequence: curr,
        missingCount:   curr - prev - 1,
      });
    }
  }
  return gaps;
}

/**
 * Validates that fencing tokens are monotonically non-decreasing across
 * ownership_claimed / ownership_renewed events.
 *
 * Also validates split_brain_prevented events: the stale token MUST be
 * strictly less than the authoritative token; otherwise a split-brain
 * scenario was mis-recorded.
 */
export function validateFencingConsistency(events: ExecutionEvent[]): FencingViolation[] {
  const violations: FencingViolation[] = [];
  let maxFencingToken = 0;

  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  for (const event of sorted) {
    if (event.eventType === 'ownership_claimed' || event.eventType === 'ownership_renewed') {
      const token = event.fencingToken ?? Number(event.payload.fencing_token ?? 0);
      if (token < maxFencingToken) {
        violations.push({
          sequenceNumber: event.sequenceNumber,
          eventType:      event.eventType,
          previousToken:  maxFencingToken,
          currentToken:   token,
          violationType:  'non_monotonic',
        });
      } else {
        maxFencingToken = token;
      }
    }
    if (event.eventType === 'split_brain_prevented' || event.eventType === 'ownership_fenced') {
      const staleToken = Number(event.payload.stale_fencing_token ?? 0);
      const authToken  = Number(event.payload.authoritative_fencing_token ?? event.fencingToken ?? 0);
      if (staleToken >= authToken) {
        violations.push({
          sequenceNumber: event.sequenceNumber,
          eventType:      event.eventType,
          previousToken:  authToken,
          currentToken:   staleToken,
          violationType:  'split_brain_stale_token',
        });
      }
    }
  }
  return violations;
}

/**
 * Runs a full deterministic replay integrity check on an execution.
 *
 * Checks performed:
 *  1. Sequence continuity (no gaps)
 *  2. Fencing token monotonicity + split-brain consistency
 *  3. Snapshot version compatibility (snapshot.snapshotVersion ≤ max event seq)
 *  4. Optional: checksum comparison against a known-good value
 *
 * The deterministicReplayVerdict summarises the outcome:
 *  - 'clean'              — all checks passed
 *  - 'no_events'          — event stream is empty (nothing to check)
 *  - 'gaps_detected'      — one or more sequence gaps found
 *  - 'fencing_violations' — fencing token invariant broken
 *  - 'snapshot_mismatch'  — snapshot version > max event or checksum mismatch
 */
export async function verifyReplayIntegrity(params: {
  executionId:       string;
  userId:            string;
  expectedChecksum?: string;
}): Promise<ReplayIntegrityReport> {
  const [events, snapshot] = await Promise.all([
    loadExecutionEvents({ executionId: params.executionId, userId: params.userId }),
    loadLatestSnapshot({ executionId: params.executionId, userId: params.userId }),
  ]);

  if (events.length === 0) {
    return {
      executionId:                params.executionId,
      totalEvents:                0,
      checksum:                   '',
      sequenceGaps:               [],
      fencingViolations:          [],
      snapshotCompatible:         true,
      snapshotVersion:            snapshot?.snapshotVersion ?? null,
      deterministicReplayVerdict: 'no_events',
      details:                    {},
    };
  }

  const checksum           = computeEventStreamChecksum(events);
  const sequenceGaps       = detectSequenceGaps(events);
  const fencingViolations  = validateFencingConsistency(events);

  const maxSeq = events[events.length - 1].sequenceNumber;
  let snapshotCompatible = true;
  if (snapshot) {
    // Snapshot version must not exceed the max event sequence in the stream
    snapshotCompatible = snapshot.snapshotVersion <= maxSeq;
  }

  const checksumMismatch =
    params.expectedChecksum !== undefined && params.expectedChecksum !== checksum;

  let deterministicReplayVerdict = 'clean' as ReplayIntegrityReport['deterministicReplayVerdict'];
  if (sequenceGaps.length > 0) {
    deterministicReplayVerdict = 'gaps_detected';
  } else if (fencingViolations.length > 0) {
    deterministicReplayVerdict = 'fencing_violations';
  } else if (!snapshotCompatible || checksumMismatch) {
    deterministicReplayVerdict = 'snapshot_mismatch';
  }

  return {
    executionId:                params.executionId,
    totalEvents:                events.length,
    checksum,
    sequenceGaps,
    fencingViolations,
    snapshotCompatible,
    snapshotVersion:            snapshot?.snapshotVersion ?? null,
    deterministicReplayVerdict,
    details: {
      checksumMismatch,
      expectedChecksum: params.expectedChecksum ?? null,
      firstSequence:    events[0].sequenceNumber,
      lastSequence:     maxSeq,
    },
  };
}
