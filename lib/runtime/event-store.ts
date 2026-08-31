import { createServiceClient } from '@/lib/supabase-server';

// Canonical execution event types for the append-only event store.
// These are DISTINCT from RuntimeEventType in events.ts (which is the broadcast bus).
export type ExecutionEventType =
  // Execution lifecycle
  | 'execution_created'
  | 'execution_started'
  | 'execution_paused'
  | 'execution_resumed'
  | 'execution_completed'
  | 'execution_failed'
  | 'execution_cancelled'
  // Node lifecycle
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_retried'
  | 'node_quarantined'
  // Ownership
  | 'ownership_claimed'
  | 'ownership_renewed'
  | 'ownership_replaced'
  | 'ownership_fenced'
  | 'ownership_expired'
  // Worker runtime
  | 'queue_drained'
  | 'worker_restarted'
  | 'execution_isolated'
  | 'orphan_recovered'
  | 'lease_renew_failed'
  | 'split_brain_prevented'
  // Side effect journaling (before/after each external mutation)
  | 'side_effect_requested'
  | 'side_effect_completed'
  | 'side_effect_failed'
  // Replay
  | 'replay_started'
  | 'replay_completed';

export type ExecutionEvent = {
  id: string;
  executionId: string;
  workflowId: string | null;
  userId: string;
  workerId: string | null;
  eventType: ExecutionEventType;
  eventVersion: number;
  sequenceNumber: number;
  causationId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  fencingToken: number | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AppendExecutionEventInput = {
  executionId: string;
  workflowId?: string | null;
  userId: string | null;
  workerId?: string | null;
  eventType: ExecutionEventType;
  eventVersion?: number;
  causationId?: string | null;
  correlationId?: string | null;
  parentEventId?: string | null;
  fencingToken?: number | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

// Appends a single event to the execution event log via the append_execution_event()
// RPC, which assigns a monotonically incrementing sequence_number under an advisory lock.
// Returns null when userId is absent or if the DB call fails — callers use .catch(() => null).
export async function appendExecutionEvent(
  input: AppendExecutionEventInput
): Promise<{ eventId: string; sequenceNumber: number } | null> {
  if (!input.userId) return null;

  const db = createServiceClient();
  const { data, error } = await db.rpc('append_execution_event', {
    p_execution_id:    input.executionId,
    p_workflow_id:     input.workflowId ?? null,
    p_user_id:         input.userId,
    p_worker_id:       input.workerId ?? null,
    p_event_type:      input.eventType,
    p_event_version:   input.eventVersion ?? 1,
    p_causation_id:    input.causationId ?? null,
    p_correlation_id:  input.correlationId ?? null,
    p_parent_event_id: input.parentEventId ?? null,
    p_fencing_token:   input.fencingToken ?? null,
    p_payload:         input.payload ?? {},
    p_metadata:        input.metadata ?? {},
  });

  if (error || !data) return null;

  const row = Array.isArray(data) ? data[0] : (data as Record<string, unknown> | null);
  if (!row) return null;

  return {
    eventId: String(row.event_id ?? ''),
    sequenceNumber: Number(row.sequence_number ?? 0),
  };
}

// Loads the ordered event stream for an execution, suitable for deterministic replay.
// Events are returned sorted by sequence_number ascending.
export async function loadExecutionEvents(params: {
  executionId: string;
  userId: string;
  fromSequence?: number;
  toSequence?: number;
  limit?: number;
}): Promise<ExecutionEvent[]> {
  const db = createServiceClient();
  let query = db
    .from('runtime_execution_events')
    .select(
      'id, execution_id, workflow_id, user_id, worker_id, event_type, event_version, ' +
      'sequence_number, causation_id, correlation_id, parent_event_id, fencing_token, ' +
      'payload, metadata, created_at'
    )
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .order('sequence_number', { ascending: true })
    .limit(params.limit ?? 2000);

  if (params.fromSequence !== undefined) {
    query = query.gte('sequence_number', params.fromSequence);
  }
  if (params.toSequence !== undefined) {
    query = query.lte('sequence_number', params.toSequence);
  }

  const { data } = await query;
  return (data ?? []).map((r) => mapRow(r as unknown as Record<string, unknown>));
}

function mapRow(r: Record<string, unknown>): ExecutionEvent {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    workflowId: r.workflow_id != null ? String(r.workflow_id) : null,
    userId: String(r.user_id),
    workerId: r.worker_id != null ? String(r.worker_id) : null,
    eventType: r.event_type as ExecutionEventType,
    eventVersion: Number(r.event_version ?? 1),
    sequenceNumber: Number(r.sequence_number),
    causationId: r.causation_id != null ? String(r.causation_id) : null,
    correlationId: r.correlation_id != null ? String(r.correlation_id) : null,
    parentEventId: r.parent_event_id != null ? String(r.parent_event_id) : null,
    fencingToken: r.fencing_token != null ? Number(r.fencing_token) : null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

export type ExecutionSnapshot = {
  id: string;
  executionId: string;
  workflowId: string;
  userId: string;
  snapshotType: string;
  snapshotVersion: number;
  currentNodeId: string | null;
  stateSnapshot: Record<string, unknown>;
  pendingQueue: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

// Loads the most recent snapshot for an execution, to be used as a replay base.
export async function loadLatestSnapshot(params: {
  executionId: string;
  userId: string;
}): Promise<ExecutionSnapshot | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_execution_snapshots')
    .select(
      'id, execution_id, workflow_id, user_id, snapshot_type, snapshot_version, ' +
      'current_node_id, state_snapshot, pending_queue, metadata, created_at'
    )
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .order('snapshot_version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const r = data as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    workflowId: String(r.workflow_id),
    userId: String(r.user_id),
    snapshotType: String(r.snapshot_type),
    snapshotVersion: Number(r.snapshot_version),
    currentNodeId: r.current_node_id != null ? String(r.current_node_id) : null,
    stateSnapshot: (r.state_snapshot as Record<string, unknown>) ?? {},
    pendingQueue: (r.pending_queue as unknown[]) ?? [],
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

// Saves a snapshot of the current execution state for faster future replay.
// Returns the assigned snapshot_version or null on failure.
export async function saveExecutionSnapshot(params: {
  executionId: string;
  workflowId: string;
  userId: string;
  snapshotType?: 'checkpoint' | 'rewind_point' | 'failover' | 'manual';
  currentNodeId?: string | null;
  stateSnapshot: Record<string, unknown>;
  pendingQueue?: unknown[];
  metadata?: Record<string, unknown>;
}): Promise<{ snapshotVersion: number } | null> {
  const db = createServiceClient();

  const { data: latest } = await db
    .from('runtime_execution_snapshots')
    .select('snapshot_version')
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .order('snapshot_version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = Number((latest as Record<string, unknown> | null)?.snapshot_version ?? 0) + 1;

  const { error } = await db.from('runtime_execution_snapshots').insert({
    execution_id:     params.executionId,
    workflow_id:      params.workflowId,
    user_id:          params.userId,
    snapshot_type:    params.snapshotType ?? 'checkpoint',
    snapshot_version: nextVersion,
    current_node_id:  params.currentNodeId ?? null,
    state_snapshot:   params.stateSnapshot,
    pending_queue:    params.pendingQueue ?? [],
    metadata:         params.metadata ?? {},
    created_at:       new Date().toISOString(),
  });

  if (error) return null;
  return { snapshotVersion: nextVersion };
}

// Returns the cached result if the key already exists, preventing duplicate side effects.
export async function checkIdempotencyKey(params: {
  idempotencyKey: string;
  userId: string;
}): Promise<{ exists: boolean; result: Record<string, unknown> | null }> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_idempotency_keys')
    .select('id, result')
    .eq('idempotency_key', params.idempotencyKey)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!data) return { exists: false, result: null };
  return {
    exists: true,
    result: ((data as Record<string, unknown>).result as Record<string, unknown>) ?? {},
  };
}

// Records a completed side-effect result under an idempotency key.
// Silently ignores conflicts (onConflict: ignoreDuplicates) — first writer wins.
export async function recordIdempotencyKey(params: {
  idempotencyKey: string;
  executionId: string;
  userId: string;
  operation: string;
  result: Record<string, unknown>;
}): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_idempotency_keys').upsert(
    {
      idempotency_key: params.idempotencyKey,
      execution_id:    params.executionId,
      user_id:         params.userId,
      operation:       params.operation,
      result:          params.result,
      created_at:      new Date().toISOString(),
    },
    { onConflict: 'idempotency_key,user_id', ignoreDuplicates: true }
  );
}
