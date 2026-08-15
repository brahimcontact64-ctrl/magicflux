import "server-only";

import { createServiceClient } from '@/lib/supabase-server';
import { scheduleCommand } from './command-bus';

/**
 * RuntimeClock — wall mode vs. deterministic replay mode.
 *
 * In wall mode:   returns real Date.now() / new Date().toISOString().
 * In replay mode: replays timestamps from an injected event log in order,
 *                 so that the same event stream always produces the same
 *                 wall-clock observations regardless of when replay runs.
 *
 * NEVER call Date.now() or new Date() directly in replay-sensitive code.
 * Instead, obtain a RuntimeClock from the execution context and call .now().
 */
export class RuntimeClock {
  private readonly _wallMode: boolean;
  private readonly _replayTimestamps: string[];
  private _replayIndex: number;

  private constructor(wallMode: boolean, replayTimestamps: string[] = []) {
    this._wallMode = wallMode;
    this._replayTimestamps = replayTimestamps;
    this._replayIndex = 0;
  }

  /** Returns a clock that reads real wall-clock time. */
  static wall(): RuntimeClock {
    return new RuntimeClock(true);
  }

  /**
   * Returns a deterministic replay clock seeded with the ISO timestamps
   * extracted from an ordered event stream.
   * Each call to .now() advances to the next timestamp in sequence.
   * When exhausted, the last known timestamp is returned to prevent drift.
   */
  static fromEventTimestamps(timestamps: string[]): RuntimeClock {
    return new RuntimeClock(false, [...timestamps]);
  }

  isReplay(): boolean {
    return !this._wallMode;
  }

  /** Returns the current timestamp as an ISO string. */
  now(): string {
    if (this._wallMode) {
      return new Date().toISOString();
    }
    if (this._replayIndex < this._replayTimestamps.length) {
      return this._replayTimestamps[this._replayIndex++];
    }
    // Exhausted replay buffer — return the last known timestamp rather than
    // letting wall-clock time leak into a deterministic replay path.
    const last = this._replayTimestamps[this._replayTimestamps.length - 1];
    return last ?? new Date().toISOString();
  }

  /** Returns the current timestamp as milliseconds since epoch. */
  nowMs(): number {
    return new Date(this.now()).getTime();
  }
}

/**
 * LogicalClock — a monotonically incrementing counter tied to the execution's
 * event sequence. Reconstructible from max(sequence_number) of the event log.
 *
 * Safe for replay: given the same starting sequence and the same sequence of
 * tick() calls, always produces the same stream of logical timestamps.
 */
export class LogicalClock {
  private _counter: number;

  private constructor(initialValue: number) {
    this._counter = initialValue;
  }

  /**
   * Initialises a logical clock from the last known sequence number.
   * Subsequent tick() calls produce values > lastSequence.
   */
  static fromSequence(lastSequence: number): LogicalClock {
    return new LogicalClock(lastSequence);
  }

  /** Increments the counter and returns the new value. */
  tick(): number {
    return ++this._counter;
  }

  /** Returns the current value without incrementing. */
  peek(): number {
    return this._counter;
  }

  /**
   * Advances the counter to `to` if `to` is greater than the current value.
   * Use this when replaying events to catch up to the observed max sequence.
   */
  advance(to: number): void {
    if (to > this._counter) {
      this._counter = to;
    }
  }
}

export type VirtualTimer = {
  id: string;
  executionId: string;
  commandType: string;
  scheduledFor: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

/**
 * Persists a virtual timer as a scheduled command in the durable command bus.
 *
 * Timers MUST NOT rely on in-memory setTimeout alone: a process crash or
 * worker restart would lose all pending in-memory timers. Persisting in the
 * command bus (via `scheduled_for`) ensures timers survive crashes, failover,
 * replay, and split-brain fencing.
 */
export async function scheduleVirtualTimer(params: {
  executionId: string;
  workflowId: string;
  userId: string;
  commandType: string;
  scheduledFor: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
}): Promise<{ commandId: string; sequenceNumber: number } | null> {
  return scheduleCommand({
    executionId:   params.executionId,
    workflowId:    params.workflowId,
    userId:        params.userId,
    commandType:   params.commandType,
    scheduledFor:  params.scheduledFor,
    payload:       params.payload ?? {},
    metadata:      { ...(params.metadata ?? {}), timer: true },
    causationId:   params.causationId ?? null,
    correlationId: params.correlationId ?? null,
  });
}

/**
 * Loads all pending virtual timers for an execution that are due to fire
 * at or before `asOf` (defaults to now).
 *
 * Only returns commands whose metadata includes `timer: true` — i.e. those
 * originally created via scheduleVirtualTimer().
 */
export async function loadPendingTimers(params: {
  executionId: string;
  userId: string;
  asOf?: string;
}): Promise<VirtualTimer[]> {
  const db = createServiceClient();
  const cutoff = params.asOf ?? new Date().toISOString();

  const { data } = await db
    .from('runtime_execution_commands')
    .select('id, execution_id, command_type, scheduled_for, payload, metadata')
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('status', 'pending')
    .not('scheduled_for', 'is', null)
    .lte('scheduled_for', cutoff)
    .order('scheduled_for', { ascending: true })
    .limit(100);

  return (data ?? [])
    .map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        id:           String(row.id),
        executionId:  String(row.execution_id),
        commandType:  String(row.command_type),
        scheduledFor: String(row.scheduled_for),
        payload:      (row.payload as Record<string, unknown>) ?? {},
        metadata:     (row.metadata as Record<string, unknown>) ?? {},
      };
    })
    .filter((t) => t.metadata.timer === true);
}
