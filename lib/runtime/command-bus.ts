import "server-only";

import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { logger } from './logger';

// All valid command types for the durable command bus.
export type CommandType =
  | 'deploy_workflow'
  | 'activate_workflow'
  | 'deactivate_workflow'
  | 'test_workflow'
  | 'run_workflow'
  | 'cancel_execution'
  | 'pause_execution'
  | 'resume_execution'
  | 'retry_node'
  | 'quarantine_node'
  | 'isolate_execution'
  | 'recover_orphan'
  | 'renew_lease'
  | 'release_ownership'
  | 'scheduled_timer'
  | 'compact_events'
  | 'archive_events';

export type ExecutionCommand = {
  id: string;
  executionId: string;
  workflowId: string | null;
  userId: string | null;
  commandType: CommandType | string;
  commandVersion: number;
  sequenceNumber: number;
  causationId: string | null;
  correlationId: string | null;
  parentCommandId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: 'pending' | 'processing' | 'acknowledged' | 'failed' | 'dead_letter';
  retryCount: number;
  scheduledFor: string | null;
  processingStartedAt: string | null;
  acknowledgedAt: string | null;
  workerId: string | null;
  createdAt: string;
};

export type AppendCommandInput = {
  executionId: string;
  workflowId?: string | null;
  userId: string | null;
  commandType: CommandType | string;
  commandVersion?: number;
  causationId?: string | null;
  correlationId?: string | null;
  parentCommandId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  scheduledFor?: string | null;
};

export type WorkflowVersionPin = {
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
};

// Returns the user_id that owns the execution in workflow_executions_v2.
// Returns null when the execution does not exist in that table (system-initiated
// executions that predate the v2 schema) — callers treat null as "unknown owner".
export async function getExecutionOwnerUserId(executionId: string): Promise<string | null> {
  if (!executionId) return null;
  const db = createServiceClient();
  const { data } = await db
    .from('workflow_executions_v2')
    .select('user_id')
    .eq('id', executionId)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return row.user_id != null ? String(row.user_id) : null;
}

function mapCommandRow(r: Record<string, unknown>): ExecutionCommand {
  return {
    id:                   String(r.id),
    executionId:          String(r.execution_id),
    workflowId:           r.workflow_id != null ? String(r.workflow_id) : null,
    userId:               r.user_id != null ? String(r.user_id) : null,
    commandType:          String(r.command_type) as CommandType,
    commandVersion:       Number(r.command_version ?? 1),
    sequenceNumber:       Number(r.sequence_number),
    causationId:          r.causation_id != null ? String(r.causation_id) : null,
    correlationId:        r.correlation_id != null ? String(r.correlation_id) : null,
    parentCommandId:      r.parent_command_id != null ? String(r.parent_command_id) : null,
    payload:              (r.payload as Record<string, unknown>) ?? {},
    metadata:             (r.metadata as Record<string, unknown>) ?? {},
    status:               String(r.status) as ExecutionCommand['status'],
    retryCount:           Number(r.retry_count ?? 0),
    scheduledFor:         r.scheduled_for != null ? String(r.scheduled_for) : null,
    processingStartedAt:  r.processing_started_at != null ? String(r.processing_started_at) : null,
    acknowledgedAt:       r.acknowledged_at != null ? String(r.acknowledged_at) : null,
    workerId:             r.worker_id != null ? String(r.worker_id) : null,
    createdAt:            String(r.created_at),
  };
}

// Appends a single command to the execution command bus.
// Returns null when userId is absent or the DB call fails.
// Deduplication and monotonic sequence_number are guaranteed by
// append_execution_command() using pg_advisory_xact_lock('cmd:'+execution_id).
export async function appendCommand(
  input: AppendCommandInput
): Promise<{ commandId: string; sequenceNumber: number } | null> {
  if (!input.userId) return null;

  // Ownership guard: if the execution is registered in workflow_executions_v2,
  // the caller's userId must match the execution owner.
  // Null ownerUserId means the execution is not yet in v2 (system boot commands) — allow.
  const ownerUserId = await getExecutionOwnerUserId(input.executionId);
  if (ownerUserId !== null && ownerUserId !== input.userId) {
    logger.warn('cross_tenant_command_rejected', {
      execution_id: input.executionId,
      caller_user_id: input.userId,
      execution_owner_id: ownerUserId,
      command_type: String(input.commandType),
    });
    return null;
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc('append_execution_command', {
    p_execution_id:      input.executionId,
    p_workflow_id:       input.workflowId ?? null,
    p_user_id:           input.userId,
    p_command_type:      input.commandType,
    p_command_version:   input.commandVersion ?? 1,
    p_causation_id:      input.causationId ?? null,
    p_correlation_id:    input.correlationId ?? null,
    p_parent_command_id: input.parentCommandId ?? null,
    p_payload:           input.payload ?? {},
    p_metadata:          input.metadata ?? {},
    p_scheduled_for:     input.scheduledFor ?? null,
  });

  if (error || !data) return null;
  const row = Array.isArray(data) ? data[0] : (data as Record<string, unknown> | null);
  if (!row) return null;
  return {
    commandId:      String(row.command_id ?? ''),
    sequenceNumber: Number(row.sequence_number ?? 0),
  };
}

// Alias for appendCommand — use when initiating a new command from outside the execution.
export const dispatchCommand = appendCommand;

// Claims up to `limit` pending commands for processing by `workerId`.
// Uses SKIP LOCKED — concurrent workers will each claim a disjoint set of commands.
export async function fetchPendingCommands(params: {
  workerId: string;
  limit?: number;
}): Promise<ExecutionCommand[]> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('fetch_pending_execution_commands', {
    p_worker_id: params.workerId,
    p_limit:     params.limit ?? 10,
  });

  if (error || !data) return [];
  const rows = Array.isArray(data) ? data : [data];
  return rows.map((r) => mapCommandRow(r as unknown as Record<string, unknown>));
}

// Acknowledges a processing command. Returns true if the row was updated.
export async function acknowledgeCommand(params: {
  commandId: string;
  workerId: string;
}): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('ack_execution_command', {
    p_command_id: params.commandId,
    p_worker_id:  params.workerId,
  });

  if (error) return false;
  return data === true;
}

// Moves a single command to dead_letter and records it in the dispatch log.
export async function deadLetterCommand(params: {
  commandId: string;
  executionId: string;
  userId: string | null;
  workerId?: string | null;
  reason: string;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();

  let dlq = db
    .from('runtime_execution_commands')
    .update({ status: 'dead_letter', worker_id: params.workerId ?? null })
    .eq('id', params.commandId);
  // Scope to user_id so one tenant cannot dead-letter another tenant's command.
  if (params.userId) dlq = dlq.eq('user_id', params.userId);
  await dlq;

  await db.from('runtime_command_dispatch_log').insert({
    command_id:     params.commandId,
    execution_id:   params.executionId,
    user_id:        params.userId,
    worker_id:      params.workerId ?? null,
    dispatch_type: 'dead_lettered',
    attempt_number: 1,
    payload:        { reason: params.reason },
    created_at:     new Date().toISOString(),
  });
}

// Moves ALL pending/processing commands for an execution to dead_letter.
// Used when an execution is aborted irrecoverably (e.g. OwnershipAbortSignal).
export async function deadLetterExecutionCommands(params: {
  executionId: string;
  userId: string | null;
  workerId?: string | null;
  reason: string;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();

  const { data } = await db
    .from('runtime_execution_commands')
    .select('id')
    .eq('execution_id', params.executionId)
    .in('status', ['pending', 'processing']);

  const commands = (data ?? []) as Array<{ id: string }>;
  await Promise.all(
    commands.map((cmd) =>
      deadLetterCommand({
        commandId:   cmd.id,
        executionId: params.executionId,
        userId:      params.userId,
        workerId:    params.workerId,
        reason:      params.reason,
      }).catch(() => undefined)
    )
  );
}

const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

function computeRetryDelay(retryCount: number): number {
  const delay = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

// Re-queues a failed command with exponential backoff.
// After MAX_RETRY_COUNT attempts, moves it to dead_letter instead.
export async function retryCommand(params: {
  commandId: string;
  executionId: string;
  userId: string | null;
  workerId?: string | null;
  currentRetryCount: number;
  reason?: string;
}): Promise<{ queued: boolean; deadLettered: boolean }> {
  if (!params.userId) return { queued: false, deadLettered: false };
  const db = createServiceClient();

  if (params.currentRetryCount >= MAX_RETRY_COUNT) {
    await deadLetterCommand({
      commandId:   params.commandId,
      executionId: params.executionId,
      userId:      params.userId,
      workerId:    params.workerId,
      reason:      params.reason ?? `Max retries (${MAX_RETRY_COUNT}) exceeded`,
    });
    return { queued: false, deadLettered: true };
  }

  const delayMs = computeRetryDelay(params.currentRetryCount);
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();

  let q = db
    .from('runtime_execution_commands')
    .update({
      status:               'pending',
      retry_count:          params.currentRetryCount + 1,
      scheduled_for:        scheduledFor,
      worker_id:            null,
      processing_started_at: null,
    })
    .eq('id', params.commandId);
  // Scope to user_id so one tenant cannot re-queue another tenant's command.
  if (params.userId) q = q.eq('user_id', params.userId);
  const { error } = await q;

  if (!error) {
    await db.from('runtime_command_dispatch_log').insert({
      command_id:     params.commandId,
      execution_id:   params.executionId,
      user_id:        params.userId,
      worker_id:      params.workerId ?? null,
      dispatch_type:  'retried',
      attempt_number: params.currentRetryCount + 1,
      payload:        { scheduled_for: scheduledFor, reason: params.reason ?? null },
      created_at:     new Date().toISOString(),
    });
  }

  return { queued: !error, deadLettered: false };
}

// Appends a command scheduled to fire at a specific future time.
// Timers created via scheduleVirtualTimer() in deterministic-clock.ts call this.
export async function scheduleCommand(params: {
  executionId: string;
  workflowId?: string | null;
  userId: string | null;
  commandType: CommandType | string;
  scheduledFor: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  causationId?: string | null;
  correlationId?: string | null;
}): Promise<{ commandId: string; sequenceNumber: number } | null> {
  return appendCommand({
    executionId:   params.executionId,
    workflowId:    params.workflowId,
    userId:        params.userId,
    commandType:   params.commandType,
    scheduledFor:  params.scheduledFor,
    payload:       params.payload,
    metadata:      params.metadata,
    causationId:   params.causationId,
    correlationId: params.correlationId,
  });
}

// Pins a workflow definition at a specific version by computing SHA-256 of
// the serialized {nodes, connections} object. Idempotent: if the same hash
// was already pinned, returns the existing version without inserting a duplicate.
export async function pinWorkflowVersion(params: {
  workflowId: string;
  userId: string | null;
  nodes: object[];
  connections: object;
  plannerSnapshot?: Record<string, unknown> | null;
  integrationSnapshot?: Record<string, unknown> | null;
}): Promise<WorkflowVersionPin | null> {
  if (!params.userId || !params.workflowId) return null;

  const canonical = JSON.stringify({ nodes: params.nodes, connections: params.connections });
  const hash = createHash('sha256').update(canonical).digest('hex');

  const db = createServiceClient();

  // Idempotency: same hash → return existing record without inserting
  const { data: existing } = await db
    .from('runtime_workflow_versions')
    .select('workflow_id, workflow_version, workflow_hash')
    .eq('workflow_id', params.workflowId)
    .eq('workflow_hash', hash)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const row = existing as unknown as Record<string, unknown>;
    return {
      workflowId:      String(row.workflow_id),
      workflowVersion: Number(row.workflow_version),
      workflowHash:    String(row.workflow_hash),
    };
  }

  // Atomically assign the next version number
  const { data: latest } = await db
    .from('runtime_workflow_versions')
    .select('workflow_version')
    .eq('workflow_id', params.workflowId)
    .order('workflow_version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = Number((latest as Record<string, unknown> | null)?.workflow_version ?? 0) + 1;

  const { error } = await db.from('runtime_workflow_versions').insert({
    workflow_id:          params.workflowId,
    workflow_version:     nextVersion,
    workflow_hash:        hash,
    workflow_snapshot:    { nodes: params.nodes, connections: params.connections },
    planner_snapshot:     params.plannerSnapshot ?? null,
    integration_snapshot: params.integrationSnapshot ?? null,
    created_by:           params.userId,
    created_at:           new Date().toISOString(),
  });

  if (error) return null;
  return { workflowId: params.workflowId, workflowVersion: nextVersion, workflowHash: hash };
}
