import { createServiceClient } from '@/lib/supabase-server';
import type { EngineResult, RunExecutionOptions } from '@/lib/workflow-runtime/types';
import { WorkflowEngine } from './workflow-engine';
import { RuntimeStateStore } from './runtime-state';

export class ExecutionManager {
  private readonly engine = new WorkflowEngine();
  private readonly stateStore = new RuntimeStateStore();
  private readonly db = createServiceClient();

  async startExecution(opts: RunExecutionOptions): Promise<EngineResult> {
    return this.engine.execute(opts);
  }

  async resumeExecution(params: {
    executionId: string;
    userId: string;
    workflowJson: unknown;
    workflowId: string;
    mode: 'test' | 'live';
    inputData: Record<string, unknown>;
    retryCount?: number;
    maxRetries?: number;
  }): Promise<EngineResult> {
    const checkpoint = await this.stateStore.getLatestCheckpoint(params.executionId, params.userId);

    await this.stateStore.setExecutionControl({
      executionId: params.executionId,
      userId: params.userId,
      pauseRequested: false,
      cancelRequested: false,
      resumeRequested: true,
      reason: 'Resume requested',
    });

    // Phase 9.9.3.2 -- resume data-integrity fix. When a node parks with
    // status:'waiting' (e.g. magicflux-nodes.humanReview, wait.ts), its
    // pendingQueue at that moment is whatever was left AFTER it was
    // dequeued -- for the common case of a single parked node with nothing
    // else in flight, that is an EMPTY array. The engine's own fallback for
    // an empty pendingQueue (runtime/workflow-engine.ts) re-seeds the queue
    // from `resumeFromNodeId` using the CALLER's `inputData` -- but every
    // caller of resumeExecution() (lib/runtime/review-resume.ts, the manual
    // resume route) passes inputData:{} here, since they have no reason to
    // reconstruct the node's actual prior input themselves. The result:
    // the parked node was re-invoked with an empty object instead of the
    // real data it originally received (its own AI classification,
    // confidence, and every other upstream field), silently discarding it
    // for every downstream node -- not merely a stale value, a lost one.
    // The correct source of truth already exists: persistCheckpoint()
    // always snapshots `{ output: <the parked node's own input> }` into
    // stateSnapshot at the moment it went to 'waiting'
    // (runtime/workflow-engine.ts). Use that here whenever there is no
    // already-queued input to fall back on, instead of the caller's opaque
    // inputData placeholder.
    const checkpointOutput = checkpoint?.stateSnapshot?.output;
    const pendingQueue = checkpoint?.pendingQueue && checkpoint.pendingQueue.length > 0
      ? checkpoint.pendingQueue
      : checkpoint?.currentNodeId
        ? [{ nodeName: checkpoint.currentNodeId, input: checkpointOutput ?? params.inputData }]
        : undefined;

    return this.engine.execute({
      workflowJson: params.workflowJson,
      inputData: params.inputData,
      userId: params.userId,
      workflowId: params.workflowId,
      mode: params.mode,
      executionId: params.executionId,
      resumeFromNodeId: checkpoint?.currentNodeId ?? undefined,
      retryCount: params.retryCount ?? 0,
      maxRetries: params.maxRetries ?? 3,
      pendingQueue,
      // Phase 9.9.6 -- only a genuine durable wait (Human Review / a Wait
      // node's scheduled delay) resets the active-compute deadline
      // baseline for this segment; an ordinary node-failure retry
      // ('retrying') must keep accumulating against the execution's true
      // original start so a repeated-failure retry storm is still bounded.
      resumedFromDurableWait: checkpoint?.checkpointType === 'waiting',
    });
  }

  async requestPause(executionId: string, userId: string, reason?: string): Promise<void> {
    await this.stateStore.setExecutionControl({
      executionId,
      userId,
      pauseRequested: true,
      cancelRequested: false,
      resumeRequested: false,
      reason: reason ?? 'Paused by user',
    });

    await this.db
      .from('workflow_executions_v2')
      .update({ status: 'waiting', updated_at: new Date().toISOString() })
      .eq('id', executionId)
      .eq('user_id', userId);
  }

  async requestCancel(executionId: string, userId: string, reason?: string): Promise<void> {
    await this.stateStore.setExecutionControl({
      executionId,
      userId,
      pauseRequested: false,
      cancelRequested: true,
      resumeRequested: false,
      reason: reason ?? 'Cancelled by user',
    });

    await this.db
      .from('workflow_executions_v2')
      .update({ status: 'failed', error_message: reason ?? 'Cancelled by user', updated_at: new Date().toISOString() })
      .eq('id', executionId)
      .eq('user_id', userId);
  }

  async getExecution(executionId: string, userId: string): Promise<{
    id: string;
    workflow_id: string;
    mode: 'test' | 'live';
    input_data: Record<string, unknown>;
    retry_count: number;
    max_retries: number;
    deployment_version_id: string | null;
  } | null> {
    const { data } = await this.db
      .from('workflow_executions_v2')
      .select('id, workflow_id, mode, input_data, retry_count, max_retries, deployment_version_id')
      .eq('id', executionId)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      id: data.id,
      workflow_id: data.workflow_id,
      mode: (data.mode ?? 'live') as 'test' | 'live',
      input_data: (data.input_data ?? {}) as Record<string, unknown>,
      retry_count: Number(data.retry_count ?? 0),
      max_retries: Number(data.max_retries ?? 3),
      deployment_version_id: (data.deployment_version_id as string | null) ?? null,
    };
  }

  async rewindExecution(params: {
    executionId: string;
    userId: string;
    workflowJson: unknown;
    workflowId: string;
    mode: 'test' | 'live';
    toSnapshotVersion: number;
    reason?: string;
  }): Promise<EngineResult> {
    const target = await this.stateStore.getSnapshotByVersion(
      params.executionId,
      params.userId,
      params.toSnapshotVersion
    );

    if (!target) {
      throw new Error(`Snapshot version ${params.toSnapshotVersion} not found`);
    }

    const fromSnapshot = await this.stateStore.getLatestSnapshot(params.executionId, params.userId);
    await this.stateStore.recordRewind({
      executionId: params.executionId,
      workflowId: params.workflowId,
      userId: params.userId,
      fromSnapshotVersion: fromSnapshot?.snapshotVersion,
      toSnapshotVersion: params.toSnapshotVersion,
      reason: params.reason,
    });

    return this.engine.execute({
      executionId: params.executionId,
      workflowJson: params.workflowJson,
      workflowId: params.workflowId,
      userId: params.userId,
      mode: params.mode,
      inputData: (target.stateSnapshot.inputData as Record<string, unknown>)
        ?? (target.stateSnapshot.output as Record<string, unknown>)
        ?? {},
      resumeFromNodeId: target.currentNodeId ?? undefined,
      pendingQueue: target.pendingQueue,
    });
  }
}
