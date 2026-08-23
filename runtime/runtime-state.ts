import { createServiceClient } from '@/lib/supabase-server';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import { recordUsageEvent } from '@/lib/runtime/usage-metering';
import { logger } from '@/lib/runtime/logger';

/**
 * Thrown by persistNodeState() when either the runtime_node_states upsert
 * or the workflow_execution_steps insert fails. Distinguishes a genuine
 * node-state persistence failure from other errors a caller might need to
 * handle differently (e.g. distributed-lock or provider errors).
 */
export class RuntimeNodeStatePersistenceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RuntimeNodeStatePersistenceError';
  }
}

export type RuntimeNodeStatus = 'queued' | 'running' | 'success' | 'failed' | 'retrying' | 'cancelled';
export type RuntimeExecutionState = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type RuntimeNodeStateInput = {
  executionId: string;
  workflowId: string;
  userId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: RuntimeNodeStatus;
  attempt: number;
  inputData?: unknown;
  outputData?: unknown;
  logs?: string[];
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
};

export type RuntimeCheckpointInput = {
  executionId: string;
  workflowId: string;
  userId: string;
  checkpointType: 'node_completed' | 'waiting' | 'paused' | 'retrying' | 'cancelled' | 'failed' | 'completed';
  currentNodeId?: string | null;
  stateSnapshot: Record<string, unknown>;
  pendingQueue: Array<{ nodeName: string; input: unknown }>;
};

export type RuntimeSnapshotInput = {
  executionId: string;
  workflowId: string;
  userId: string;
  snapshotType: 'checkpoint' | 'rewind_point' | 'failover' | 'manual';
  snapshotVersion: number;
  currentNodeId?: string | null;
  stateSnapshot: Record<string, unknown>;
  pendingQueue: Array<{ nodeName: string; input: unknown }>;
  metadata?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class RuntimeStateStore {
  private db = createServiceClient();

  async initializeExecution(params: {
    executionId?: string;
    workflowId: string;
    userId: string;
    mode: 'test' | 'live';
    inputData: Record<string, unknown>;
    maxRetries: number;
    /** deployment_versions.id this execution is pinned to, if the workflow is activated. */
    deploymentVersionId?: string | null;
  }): Promise<string> {
    if (params.executionId) {
      await this.db
        .from('workflow_executions_v2')
        .update({
          status: 'running',
          input_data: params.inputData,
          max_retries: params.maxRetries,
          started_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq('id', params.executionId)
        .eq('user_id', params.userId);

      return params.executionId;
    }

    const { data } = await this.db
      .from('workflow_executions_v2')
      .insert({
        workflow_id: params.workflowId,
        user_id: params.userId,
        status: 'running',
        mode: params.mode,
        input_data: params.inputData,
        retry_count: 0,
        max_retries: params.maxRetries,
        deployment_version_id: params.deploymentVersionId ?? null,
        started_at: nowIso(),
      })
      .select('id')
      .maybeSingle();

    const executionId = data?.id ?? crypto.randomUUID();

    // Only the fresh-insert branch reaches here — the async production
    // dispatch path (lib/runtime/execution-dispatch.ts) creates its own row
    // up front and records execution_started itself, then calls this with an
    // existing executionId (the branch above), so this never double-counts.
    recordUsageEvent({
      userId: params.userId,
      workflowId: params.workflowId,
      executionId,
      eventType: 'execution_started',
      idempotencyKey: `${executionId}:execution_started`,
    }).catch(() => undefined);

    return executionId;
  }

  async setExecutionState(params: {
    executionId: string;
    userId: string;
    state: RuntimeExecutionState;
    currentNodeId?: string | null;
    outputData?: unknown;
    errorMessage?: string | null;
    retryCount?: number;
    nextRunAt?: string | null;
  }): Promise<void> {
    const patch: Record<string, unknown> = {
      status: params.state === 'completed' ? 'success' : params.state,
      current_node_id: params.currentNodeId ?? null,
      output_data: params.outputData ?? null,
      error_message: params.errorMessage ?? null,
      retry_count: params.retryCount,
      next_run_at: params.nextRunAt ?? null,
      updated_at: nowIso(),
    };

    if (params.state === 'completed' || params.state === 'failed' || params.state === 'cancelled') {
      patch.completed_at = nowIso();
    }

    try {
      const { data: updated } = await this.db
        .from('workflow_executions_v2')
        .update(patch)
        .eq('id', params.executionId)
        .eq('user_id', params.userId)
        .select('workflow_id, started_at')
        .maybeSingle();

      if ((params.state === 'completed' || params.state === 'failed') && updated?.workflow_id) {
        const startedAtMs = updated.started_at ? new Date(String(updated.started_at)).getTime() : Date.now();
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        recordUsageEvent({
          userId: params.userId,
          workflowId: String(updated.workflow_id),
          executionId: params.executionId,
          eventType: params.state === 'failed' ? 'execution_failed' : 'execution_completed',
          quantity: 1,
          metadata: { duration_ms: durationMs },
          idempotencyKey: `${params.executionId}:${params.state === 'failed' ? 'execution_failed' : 'execution_completed'}`,
        }).catch(() => undefined);
      }
    } catch {
      if (params.state === 'paused' || params.state === 'cancelled') {
        await this.db
          .from('workflow_executions_v2')
          .update({
            status: params.state === 'cancelled' ? 'failed' : 'waiting',
            error_message: params.state === 'cancelled' ? 'Execution cancelled by user' : null,
            current_node_id: params.currentNodeId ?? null,
            updated_at: nowIso(),
          })
          .eq('id', params.executionId)
          .eq('user_id', params.userId);
      }
    }
  }

  async persistNodeState(input: RuntimeNodeStateInput): Promise<void> {
    const startedAt = input.startedAt ?? nowIso();
    const completedAt = input.completedAt ?? (input.status === 'running' || input.status === 'queued' || input.status === 'retrying' ? null : nowIso());

    const { error: nodeStateError } = await this.db.from('runtime_node_states').upsert({
      execution_id: input.executionId,
      workflow_id: input.workflowId,
      user_id: input.userId,
      node_id: input.nodeId,
      node_name: input.nodeName,
      node_type: input.nodeType,
      status: input.status,
      attempt: input.attempt,
      input_data: input.inputData ?? null,
      output_data: input.outputData ?? null,
      logs: input.logs ?? [],
      error_message: input.errorMessage ?? null,
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: nowIso(),
    }, { onConflict: 'execution_id,node_id,user_id' });

    if (nodeStateError) {
      logger.error('runtime_node_states.persist_failed', {
        execution_id: input.executionId,
        workflow_id: input.workflowId,
        user_id: input.userId,
        node_id: input.nodeId,
        status: input.status,
        attempt: input.attempt,
        error: nodeStateError.message,
        code: nodeStateError.code,
      });
      throw new RuntimeNodeStatePersistenceError(
        `Failed to persist runtime_node_states for execution ${input.executionId}, node ${input.nodeId}: ${nodeStateError.message}`,
        nodeStateError,
      );
    }

    const { error: stepError } = await this.db.from('workflow_execution_steps').insert({
      execution_id: input.executionId,
      workflow_id: input.workflowId,
      user_id: input.userId,
      node_id: input.nodeId,
      node_name: input.nodeName,
      node_type: input.nodeType,
      status: input.status,
      input_data: input.inputData ?? null,
      output_data: input.outputData ?? null,
      logs: input.logs ?? [],
      error_message: input.errorMessage ?? null,
      attempt: input.attempt,
      started_at: startedAt,
      completed_at: completedAt,
    });

    if (stepError) {
      logger.error('workflow_execution_steps.persist_failed', {
        execution_id: input.executionId,
        workflow_id: input.workflowId,
        user_id: input.userId,
        node_id: input.nodeId,
        status: input.status,
        attempt: input.attempt,
        error: stepError.message,
        code: stepError.code,
      });
      throw new RuntimeNodeStatePersistenceError(
        `Failed to persist workflow_execution_steps for execution ${input.executionId}, node ${input.nodeId}: ${stepError.message}`,
        stepError,
      );
    }
  }

  async writeCheckpoint(input: RuntimeCheckpointInput): Promise<void> {
    await this.db.from('runtime_execution_checkpoints').insert({
      execution_id: input.executionId,
      workflow_id: input.workflowId,
      user_id: input.userId,
      checkpoint_type: input.checkpointType,
      current_node_id: input.currentNodeId ?? null,
      state_snapshot: input.stateSnapshot,
      pending_queue: input.pendingQueue,
      created_at: nowIso(),
    });
  }

  async writeSnapshot(input: RuntimeSnapshotInput): Promise<void> {
    await this.db.from('runtime_execution_snapshots').upsert({
      execution_id: input.executionId,
      workflow_id: input.workflowId,
      user_id: input.userId,
      snapshot_type: input.snapshotType,
      snapshot_version: input.snapshotVersion,
      current_node_id: input.currentNodeId ?? null,
      state_snapshot: input.stateSnapshot,
      pending_queue: input.pendingQueue,
      metadata: input.metadata ?? {},
      created_at: nowIso(),
    }, { onConflict: 'execution_id,snapshot_version,user_id' });
  }

  async getLatestSnapshot(executionId: string, userId: string): Promise<{
    snapshotVersion: number;
    currentNodeId: string | null;
    pendingQueue: Array<{ nodeName: string; input: unknown }>;
    stateSnapshot: Record<string, unknown>;
  } | null> {
    const { data } = await this.db
      .from('runtime_execution_snapshots')
      .select('snapshot_version, current_node_id, pending_queue, state_snapshot')
      .eq('execution_id', executionId)
      .eq('user_id', userId)
      .order('snapshot_version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      snapshotVersion: Number(data.snapshot_version ?? 0),
      currentNodeId: (data.current_node_id as string | null) ?? null,
      pendingQueue: Array.isArray(data.pending_queue) ? (data.pending_queue as Array<{ nodeName: string; input: unknown }>) : [],
      stateSnapshot: (data.state_snapshot ?? {}) as Record<string, unknown>,
    };
  }

  async getSnapshotByVersion(executionId: string, userId: string, snapshotVersion: number): Promise<{
    snapshotVersion: number;
    currentNodeId: string | null;
    pendingQueue: Array<{ nodeName: string; input: unknown }>;
    stateSnapshot: Record<string, unknown>;
  } | null> {
    const { data } = await this.db
      .from('runtime_execution_snapshots')
      .select('snapshot_version, current_node_id, pending_queue, state_snapshot')
      .eq('execution_id', executionId)
      .eq('user_id', userId)
      .eq('snapshot_version', snapshotVersion)
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      snapshotVersion: Number(data.snapshot_version ?? 0),
      currentNodeId: (data.current_node_id as string | null) ?? null,
      pendingQueue: Array.isArray(data.pending_queue) ? (data.pending_queue as Array<{ nodeName: string; input: unknown }>) : [],
      stateSnapshot: (data.state_snapshot ?? {}) as Record<string, unknown>,
    };
  }

  async recordRewind(params: {
    executionId: string;
    workflowId: string;
    userId: string;
    fromSnapshotVersion?: number;
    toSnapshotVersion: number;
    reason?: string;
  }): Promise<void> {
    await this.db.from('runtime_execution_rewinds').insert({
      execution_id: params.executionId,
      workflow_id: params.workflowId,
      user_id: params.userId,
      from_snapshot_version: params.fromSnapshotVersion ?? null,
      to_snapshot_version: params.toSnapshotVersion,
      reason: params.reason ?? null,
      requested_by: 'user',
      applied: true,
      applied_at: nowIso(),
      metadata: {},
      created_at: nowIso(),
    });
  }

  async getLatestCheckpoint(executionId: string, userId: string): Promise<{
    currentNodeId: string | null;
    pendingQueue: Array<{ nodeName: string; input: unknown }>;
    stateSnapshot: Record<string, unknown>;
  } | null> {
    const { data } = await this.db
      .from('runtime_execution_checkpoints')
      .select('current_node_id, pending_queue, state_snapshot')
      .eq('execution_id', executionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      currentNodeId: data.current_node_id ?? null,
      pendingQueue: Array.isArray(data.pending_queue) ? (data.pending_queue as Array<{ nodeName: string; input: unknown }>) : [],
      stateSnapshot: (data.state_snapshot ?? {}) as Record<string, unknown>,
    };
  }

  async setExecutionControl(params: {
    executionId: string;
    userId: string;
    pauseRequested?: boolean;
    cancelRequested?: boolean;
    resumeRequested?: boolean;
    reason?: string;
  }): Promise<void> {
    await this.db.from('runtime_execution_controls').upsert({
      execution_id: params.executionId,
      user_id: params.userId,
      pause_requested: params.pauseRequested ?? false,
      cancel_requested: params.cancelRequested ?? false,
      resume_requested: params.resumeRequested ?? false,
      reason: params.reason ?? null,
      updated_at: nowIso(),
    }, { onConflict: 'execution_id,user_id' });

    if (params.pauseRequested) {
      await emitRuntimeEvent({
        eventType: 'execution.paused',
        userId: params.userId,
        executionId: params.executionId,
        severity: 'warning',
        payload: { reason: params.reason ?? 'Pause requested' },
      });
    }

    if (params.cancelRequested) {
      await emitRuntimeEvent({
        eventType: 'execution.cancelled',
        userId: params.userId,
        executionId: params.executionId,
        severity: 'warning',
        payload: { reason: params.reason ?? 'Cancellation requested' },
      });
    }
  }

  async getExecutionControl(executionId: string, userId: string): Promise<{
    pauseRequested: boolean;
    cancelRequested: boolean;
    resumeRequested: boolean;
    reason: string | null;
  }> {
    const { data } = await this.db
      .from('runtime_execution_controls')
      .select('pause_requested, cancel_requested, resume_requested, reason')
      .eq('execution_id', executionId)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    return {
      pauseRequested: Boolean(data?.pause_requested),
      cancelRequested: Boolean(data?.cancel_requested),
      resumeRequested: Boolean(data?.resume_requested),
      reason: (data?.reason as string | null) ?? null,
    };
  }

  async appendTimeline(params: {
    userId: string;
    sessionId: string;
    workflowId: string;
    eventType:
      | 'workflow_generated'
      | 'node_created'
      | 'graph_mutated'
      | 'deployment_started'
      | 'deployment_completed'
      | 'retry_attempt'
      | 'runtime_failure'
      | 'failure_recovered'
      | 'rollback_executed'
      | 'execution_started'
      | 'execution_completed';
    title: string;
    description?: string;
    status?: 'info' | 'success' | 'warning' | 'error';
    metadata?: Record<string, unknown>;
    internalEventId?: string;
  }): Promise<void> {
    await this.db.from('timeline_events').insert({
      user_id: params.userId,
      session_id: params.sessionId,
      workflow_id: params.workflowId,
      event_type: params.eventType,
      title: params.title,
      description: params.description ?? null,
      status: params.status ?? 'info',
      metadata: params.metadata ?? {},
      internal_event_id: params.internalEventId ?? null,
      created_at: nowIso(),
    });
  }
}
