import "server-only";

import { createServiceClient } from '@/lib/supabase-server';
import { loadExecutionEvents, loadLatestSnapshot } from './event-store';

export type CompactionRange = {
  fromSequence: number;
  toSequence:   number;
  eventCount:   number;
  compactable:  boolean;
  reason:       string;
};

export type ArchivalRange = {
  fromSequence:  number;
  toSequence:    number;
  eventCount:    number;
  oldestEventAt: string;
  newestEventAt: string;
};

export type CompactionReport = {
  executionId:         string;
  totalEvents:         number;
  replayCostEstimate:  number;
  compactableRanges:   CompactionRange[];
  archivalRanges:      ArchivalRange[];
  snapshotRecommended: boolean;
  snapshotVersion:     number | null;
  alreadyCompactable:  number;
  alreadyArchivable:   number;
  details:             Record<string, unknown>;
};

/**
 * Analyses the event stream and returns compaction recommendations.
 *
 * This function is read-only — it never mutates data.
 * Call markEventsCompactable() or markEventsArchivable() to act on results.
 *
 * replayCostEstimate: events that must be replayed from the snapshot (or
 *   genesis) to reconstruct the current state.
 *
 * compactableRanges: events already covered by a snapshot that can be
 *   skipped during future replays.
 *
 * archivalRanges: events older than archiveAfterDays that are candidates
 *   for cold storage.
 *
 * snapshotRecommended: true when replayCostEstimate > 100 and the existing
 *   snapshot covers less than half the event stream.
 */
export async function analyzeCompaction(params: {
  executionId:     string;
  userId:          string;
  archiveAfterDays?: number;
}): Promise<CompactionReport> {
  const archiveDays   = params.archiveAfterDays ?? 30;
  const archiveCutoff = new Date(Date.now() - archiveDays * 86_400_000).toISOString();

  const [events, snapshot] = await Promise.all([
    loadExecutionEvents({ executionId: params.executionId, userId: params.userId }),
    loadLatestSnapshot({ executionId: params.executionId, userId: params.userId }),
  ]);

  if (events.length === 0) {
    return {
      executionId:         params.executionId,
      totalEvents:         0,
      replayCostEstimate:  0,
      compactableRanges:   [],
      archivalRanges:      [],
      snapshotRecommended: false,
      snapshotVersion:     null,
      alreadyCompactable:  0,
      alreadyArchivable:   0,
      details:             { archiveCutoff, snapshotSeq: 0, maxSeq: 0 },
    };
  }

  const snapshotSeq = snapshot?.snapshotVersion ?? 0;
  const maxSeq      = events[events.length - 1].sequenceNumber;

  // Events at or before the snapshot are compactable — state is captured.
  const compactableRanges: CompactionRange[] = [];
  if (snapshot && snapshotSeq > 0) {
    const pre = events.filter((e) => e.sequenceNumber <= snapshotSeq);
    if (pre.length > 0) {
      compactableRanges.push({
        fromSequence: events[0].sequenceNumber,
        toSequence:   snapshotSeq,
        eventCount:   pre.length,
        compactable:  true,
        reason:       `Events covered by snapshot v${snapshotSeq}`,
      });
    }
  }

  // Archival candidates: events created before the cutoff date.
  const archivalRanges: ArchivalRange[] = [];
  const archivable = events.filter((e) => e.createdAt < archiveCutoff);
  if (archivable.length > 0) {
    archivalRanges.push({
      fromSequence:  archivable[0].sequenceNumber,
      toSequence:    archivable[archivable.length - 1].sequenceNumber,
      eventCount:    archivable.length,
      oldestEventAt: archivable[0].createdAt,
      newestEventAt: archivable[archivable.length - 1].createdAt,
    });
  }

  // Count events already marked as compactable / archivable.
  // Uses mark functions' RPC path (SECURITY DEFINER) to bypass INSERT-only RLS.
  const db = createServiceClient();
  const [compactableRes, archivableRes] = await Promise.all([
    db
      .from('runtime_execution_events')
      .select('id', { count: 'exact', head: true })
      .eq('execution_id', params.executionId)
      .eq('user_id', params.userId)
      .filter('compactable', 'eq', 'true'),
    db
      .from('runtime_execution_events')
      .select('id', { count: 'exact', head: true })
      .eq('execution_id', params.executionId)
      .eq('user_id', params.userId)
      .filter('archivable', 'eq', 'true'),
  ]);
  const compactableCount = compactableRes.count ?? 0;
  const archivableCount  = archivableRes.count ?? 0;

  // Replay cost: events after the snapshot (or all events if no snapshot).
  const replayCostEstimate = snapshot
    ? events.filter((e) => e.sequenceNumber > snapshotSeq).length
    : events.length;

  // Recommend a snapshot when replay would be expensive and the snapshot is stale.
  const snapshotRecommended =
    replayCostEstimate > 100 && (snapshot === null || maxSeq - snapshotSeq > 50);

  return {
    executionId:         params.executionId,
    totalEvents:         events.length,
    replayCostEstimate,
    compactableRanges,
    archivalRanges,
    snapshotRecommended,
    snapshotVersion:     snapshot?.snapshotVersion ?? null,
    alreadyCompactable:  Number(compactableCount),
    alreadyArchivable:   Number(archivableCount),
    details:             { archiveCutoff, snapshotSeq, maxSeq },
  };
}

/**
 * Marks events up to and including `upToSequence` as compactable.
 * Calls the SECURITY DEFINER function to bypass INSERT-only RLS.
 * DOES NOT delete any data — only sets compactable = true.
 */
export async function markEventsCompactable(params: {
  executionId:  string;
  userId:       string;
  upToSequence: number;
}): Promise<{ markedCount: number }> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('mark_execution_events_compactable', {
    p_execution_id:   params.executionId,
    p_user_id:        params.userId,
    p_up_to_sequence: params.upToSequence,
  });

  if (error) return { markedCount: 0 };
  return { markedCount: Number(data ?? 0) };
}

/**
 * Marks events created before `beforeTs` as archivable.
 * Calls the SECURITY DEFINER function to bypass INSERT-only RLS.
 * DOES NOT delete any data — only sets archivable = true.
 */
export async function markEventsArchivable(params: {
  executionId: string;
  userId:      string;
  beforeTs:    string;
}): Promise<{ markedCount: number }> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('mark_execution_events_archivable', {
    p_execution_id: params.executionId,
    p_user_id:      params.userId,
    p_before_ts:    params.beforeTs,
  });

  if (error) return { markedCount: 0 };
  return { markedCount: Number(data ?? 0) };
}
