import "server-only";

import {
  activateWorkflow as n8nActivate,
  deactivateWorkflow as n8nDeactivate,
  createWorkflow,
  getWorkflowStatus,
  listExecutions,
  runTestExecution,
  getN8nErrorDetails,
  type N8nConfig,
} from '@/lib/ai-engine/n8n-deployer';
import { withExponentialBackoff } from '@/lib/agent/recovery';
import { createServiceClient } from '@/lib/supabase-server';
import { DeploymentManager } from '@/lib/deployment/deployment-manager';
import { emitRuntimeEvent } from './events';
import type { RuntimeQueuePayload, RuntimeQueueName } from './queue';
import { endSpan, startSpan } from './tracing';
import { incrementWorkerJobs } from './worker-registry';
import {
  claimExecutionOwnership,
  releaseExecutionOwnership,
  renewExecutionOwnership,
} from '@/runtime/hardening-layer';
import { canUseRuntimeRedis, getRedisConnection } from './redis';

const QUEUE_NAMES: RuntimeQueueName[] = [
  'planner_queue',
  'deploy_queue',
  'execution_queue',
  'retry_queue',
  'monitoring_queue',
  'recovery_queue',
  'notification_queue',
  'ai_task_queue',
];

function canStartWorkers(): boolean {
  if (!canUseRuntimeRedis()) return false;
  if (process.env.NEXT_PHASE === 'phase-production-build') return false;
  return true;
}

function getN8nConfig(): N8nConfig {
  return {
    apiUrl: process.env.N8N_API_URL ?? 'http://localhost:5678',
    apiKey: process.env.N8N_API_KEY ?? '',
  };
}

const deploymentManager = new DeploymentManager();

type RuntimeJob<T> = {
  data: T;
  id: string | number | undefined;
  attemptsStarted: number;
  attemptsMade: number;
  queueName: string;
  name: string;
  opts?: { attempts?: number };
};

type RuntimeWorker = {
  on: (event: 'error', handler: (error: Error) => void) => void;
  close: () => Promise<void>;
};

type WorkflowPayloadData = { nodes: object[]; connections: object };

function readWorkflowData(args: Record<string, unknown>): WorkflowPayloadData {
  try {
    const parsed = JSON.parse(String(args.workflow_json ?? '{}')) as {
      nodes?: object[];
      connections?: object;
    };
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      connections: parsed.connections ?? {},
    };
  } catch {
    return { nodes: [], connections: {} };
  }
}

function deploymentAttemptId(jobId: string): string {
  return `queue-${jobId}`;
}

async function upsertDeploymentAttempt(params: {
  userId: string | null;
  workflowId: string | undefined;
  jobId: string;
  status: 'deploying' | 'active' | 'failed';
  workflowData: WorkflowPayloadData;
  n8nWorkflowId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.userId || !params.workflowId) return;

  const db = createServiceClient();
  const deploymentId = deploymentAttemptId(params.jobId);

  const { data: existing } = await db
    .from('deployment_versions')
    .select('id, metadata')
    .eq('user_id', params.userId)
    .eq('workflow_id', params.workflowId)
    .eq('deployment_id', deploymentId)
    .limit(1)
    .maybeSingle();

  if (!existing) {
    if (params.status === 'active') {
      await deploymentManager.recordDeployment(
        params.userId,
        params.workflowId,
        deploymentId,
        params.workflowData,
        {
          n8nWorkflowId: params.n8nWorkflowId,
          metadata: {
            source: 'runtime_worker',
            job_id: params.jobId,
            ...(params.metadata ?? {}),
          },
        }
      );
      return;
    }

    const { data: latest } = await db
      .from('deployment_versions')
      .select('version')
      .eq('user_id', params.userId)
      .eq('workflow_id', params.workflowId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = Number(latest?.version ?? 0) + 1;

    const { error: insertError } = await db.from('deployment_versions').insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      version: nextVersion,
      deployment_id: deploymentId,
      n8n_workflow_id: params.n8nWorkflowId ?? null,
      status: params.status,
      deployed_at: new Date().toISOString(),
      workflow_data: params.workflowData,
      metadata: {
        source: 'runtime_worker',
        job_id: params.jobId,
        ...(params.metadata ?? {}),
      },
    });

    if (insertError) {
      // Fallback to an active deployment row so persistence gates are still met.
      const created = await deploymentManager.recordDeployment(
        params.userId,
        params.workflowId,
        deploymentId,
        params.workflowData,
        {
          n8nWorkflowId: params.n8nWorkflowId,
          metadata: {
            source: 'runtime_worker',
            job_id: params.jobId,
            fallback_from_status: params.status,
            persistence_error: insertError.message,
            ...(params.metadata ?? {}),
          },
        }
      );

      await db
        .from('deployment_versions')
        .update({ status: params.status })
        .eq('id', created.id);
    }

    return;
  }

  const mergedMetadata = {
    ...((existing.metadata ?? {}) as Record<string, unknown>),
    ...(params.metadata ?? {}),
  };

  const { error: updateError } = await db
    .from('deployment_versions')
    .update({
      status: params.status,
      n8n_workflow_id: params.n8nWorkflowId ?? null,
      workflow_data: params.workflowData,
      metadata: mergedMetadata,
      deployed_at: new Date().toISOString(),
    })
    .eq('id', existing.id);

  if (updateError) {
    await db
      .from('deployment_versions')
      .update({
        metadata: {
          ...mergedMetadata,
          persistence_error: updateError.message,
        },
      })
      .eq('id', existing.id);
  }
}

async function insertDeploymentFailureTimeline(params: {
  userId: string | null;
  sessionId: string;
  workflowId?: string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  await db.from('timeline_events').insert({
    user_id: params.userId,
    session_id: params.sessionId,
    workflow_id: params.workflowId ?? null,
    event_type: 'runtime_failure',
    title: params.title,
    description: params.description,
    status: 'error',
    metadata: params.metadata,
    created_at: new Date().toISOString(),
  });
}

async function updateQueueJob(params: {
  userId: string | null;
  jobId: string;
  status: 'active' | 'waiting' | 'completed' | 'failed';
  attempts?: number;
  result?: Record<string, unknown>;
  errorMessage?: string;
}) {
  if (!params.userId) return;

  const db = createServiceClient();
  await db
    .from('runtime_queue_jobs')
    .update({
      status: params.status,
      attempts: params.attempts ?? 0,
      result: params.result ?? null,
      error_message: params.errorMessage ?? null,
      started_at: params.status === 'active' ? new Date().toISOString() : undefined,
      completed_at: params.status === 'completed' || params.status === 'failed' ? new Date().toISOString() : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', params.jobId)
    .eq('user_id', params.userId);
}

async function claimQueueJobLease(params: {
  userId: string | null;
  jobId: string;
  workerId: string;
  ownerToken: string;
  leaseSeconds: number;
}): Promise<boolean> {
  if (!params.userId) return true;
  const db = createServiceClient();
  const now = new Date();

  const { data: current } = await db
    .from('runtime_queue_jobs')
    .select('owner_worker_id, lease_expires_at')
    .eq('job_id', params.jobId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  const leaseExpiresAt = current?.lease_expires_at ? new Date(String(current.lease_expires_at)) : null;
  if (current?.owner_worker_id && current.owner_worker_id !== params.workerId && leaseExpiresAt && leaseExpiresAt > now) {
    return false;
  }

  const { error } = await db
    .from('runtime_queue_jobs')
    .update({
      owner_worker_id: params.workerId,
      owner_token: params.ownerToken,
      lease_expires_at: new Date(now.getTime() + params.leaseSeconds * 1000).toISOString(),
      heartbeat_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('job_id', params.jobId)
    .eq('user_id', params.userId);

  return !error;
}

async function renewQueueJobLease(params: {
  userId: string | null;
  jobId: string;
  workerId: string;
  ownerToken: string;
  leaseSeconds: number;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  const now = new Date();
  await db
    .from('runtime_queue_jobs')
    .update({
      lease_expires_at: new Date(now.getTime() + params.leaseSeconds * 1000).toISOString(),
      heartbeat_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('job_id', params.jobId)
    .eq('user_id', params.userId)
    .eq('owner_worker_id', params.workerId)
    .eq('owner_token', params.ownerToken);
}

async function releaseQueueJobLease(params: {
  userId: string | null;
  jobId: string;
  workerId: string;
  ownerToken: string;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  await db
    .from('runtime_queue_jobs')
    .update({
      owner_worker_id: null,
      owner_token: null,
      lease_expires_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', params.jobId)
    .eq('user_id', params.userId)
    .eq('owner_worker_id', params.workerId)
    .eq('owner_token', params.ownerToken);
}

async function recordQueueDeadLetter(params: {
  userId: string | null;
  queueName: string;
  taskType: string;
  jobId: string;
  payload: RuntimeQueuePayload;
  errorMessage: string;
  stackTrace?: string;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  await db.from('runtime_queue_dead_letters').insert({
    user_id: params.userId,
    queue_name: params.queueName,
    task_type: params.taskType,
    job_id: params.jobId,
    trace_id: params.payload.traceId ?? null,
    span_id: params.payload.spanId ?? null,
    correlation_id: params.payload.correlationId,
    session_id: params.payload.sessionId,
    workflow_id: params.payload.workflowId ?? null,
    execution_id: params.payload.executionId,
    payload: params.payload.args,
    context: {
      toolName: params.payload.toolName,
      queue: params.queueName,
    },
    stack_trace: params.stackTrace ?? null,
    error_message: params.errorMessage,
    failed_at: new Date().toISOString(),
    replay_status: 'pending',
  });
}

async function processRuntimeJob(job: RuntimeJob<RuntimeQueuePayload>): Promise<Record<string, unknown>> {
  const payload = job.data;
  const n8n = getN8nConfig();
  await updateQueueJob({
    userId: payload.userId,
    jobId: String(job.id),
    status: 'active',
    attempts: job.attemptsStarted,
  });

  const toolName = payload.toolName;
  const args = payload.args;
  const workerSpanId = await startSpan({
    userId: payload.userId,
    traceId: payload.traceId ?? `trace-worker-${payload.executionId}`,
    parentSpanId: payload.parentSpanId ?? payload.spanId,
    spanId: payload.spanId,
    name: `worker:${toolName}`,
    kind: 'worker',
    agentId: 'runtime-worker',
    queueName: job.queueName,
    jobId: String(job.id),
    sessionId: payload.sessionId,
    workflowId: payload.workflowId,
    executionId: payload.executionId,
    attributes: { task: job.name },
  });

  try {

  if (toolName === 'deploy_workflow_to_n8n') {
    const workflowName = String(args.workflow_name ?? 'MagicFlux Workflow');
    const workflowData = readWorkflowData(args);
    const workflowId = payload.workflowId ?? (args.workflow_id ? String(args.workflow_id) : undefined);

    await upsertDeploymentAttempt({
      userId: payload.userId,
      workflowId,
      jobId: String(job.id),
      status: 'deploying',
      workflowData,
      metadata: {
        workflow_name: workflowName,
        queue_name: job.queueName,
      },
    });

    const deployAttempt = await withExponentialBackoff(
      async () => createWorkflow(n8n, {
        name: workflowName,
        nodes: workflowData.nodes,
        connections: workflowData.connections,
        settings: { executionOrder: 'v1' },
        active: false,
      }),
      { retries: 2, baseDelayMs: 800, maxDelayMs: 5000 }
    );

    if (!deployAttempt.value || deployAttempt.value.status === 'error') {
      const details = getN8nErrorDetails({
        message: deployAttempt.error ?? deployAttempt.value?.error ?? 'Deploy failed',
      });
      const errorCode = deployAttempt.value?.errorCode ?? details.code;
      const diagnostics = {
        ...(deployAttempt.value?.diagnostics ?? {}),
        retry_error: deployAttempt.error ?? null,
      };

      await upsertDeploymentAttempt({
        userId: payload.userId,
        workflowId,
        jobId: String(job.id),
        status: 'failed',
        workflowData,
        metadata: {
          workflow_name: workflowName,
          error_code: errorCode,
          error_message: deployAttempt.value?.error ?? deployAttempt.error ?? 'Deploy failed',
          diagnostics,
        },
      });

      await emitRuntimeEvent({
        eventType: 'deployment.failed',
        userId: payload.userId,
        sessionId: payload.sessionId,
        workflowId,
        executionId: payload.executionId,
        agentId: 'deploy',
        correlationId: payload.correlationId,
        traceId: payload.traceId,
        spanId: workerSpanId,
        parentSpanId: payload.parentSpanId ?? payload.spanId,
        severity: 'error',
        payload: {
          workflowName,
          error_code: errorCode,
          error: deployAttempt.value?.error ?? deployAttempt.error ?? 'Deploy failed',
          diagnostics,
        },
      });

      await insertDeploymentFailureTimeline({
        userId: payload.userId,
        sessionId: payload.sessionId,
        workflowId,
        title: 'Deployment failed',
        description: deployAttempt.value?.error ?? deployAttempt.error ?? 'Deploy failed',
        metadata: {
          queue_name: job.queueName,
          job_id: String(job.id),
          workflow_name: workflowName,
          error_code: errorCode,
          diagnostics,
        },
      });

      throw new Error(`${errorCode}: ${deployAttempt.value?.error ?? deployAttempt.error ?? 'Deploy failed'}`);
    }

    await upsertDeploymentAttempt({
      userId: payload.userId,
      workflowId,
      jobId: String(job.id),
      status: 'active',
      workflowData,
      n8nWorkflowId: deployAttempt.value.workflowId,
      metadata: {
        workflow_name: workflowName,
        workflow_url: deployAttempt.value.workflowUrl,
      },
    });

    await emitRuntimeEvent({
      eventType: 'workflow.deployed',
      userId: payload.userId,
      sessionId: payload.sessionId,
      workflowId: deployAttempt.value.workflowId,
      executionId: payload.executionId,
      agentId: 'deploy',
      correlationId: payload.correlationId,
      traceId: payload.traceId,
      spanId: workerSpanId,
      parentSpanId: payload.parentSpanId ?? payload.spanId,
      payload: {
        workflowName,
        workflowUrl: deployAttempt.value.workflowUrl,
      },
    });

    await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'success' });

    return {
      workflow_id: deployAttempt.value.workflowId,
      workflow_url: deployAttempt.value.workflowUrl,
      status: deployAttempt.value.status,
    };
  }

  if (toolName === 'activate_workflow') {
    const workflowId = String(args.workflow_id ?? '');

    const isProductionActivate = payload.policyMode === 'production';

    if (isProductionActivate) {
      const preActivationStatus = await getWorkflowStatus(n8n, workflowId);
      if (!preActivationStatus?.id) {
        throw new Error('Health gate failed before activation: workflow not reachable.');
      }
    }

    await n8nActivate(n8n, workflowId);

    if (isProductionActivate) {
      try {
        const postActivationStatus = await getWorkflowStatus(n8n, workflowId);
        if (!postActivationStatus.active) {
          await n8nDeactivate(n8n, workflowId);
          throw new Error('Health gate failed after activation: workflow is not active.');
        }
      } catch (error) {
        await n8nDeactivate(n8n, workflowId).catch(() => undefined);
        throw error;
      }
    }

    await emitRuntimeEvent({
      eventType: 'workflow.activated',
      userId: payload.userId,
      sessionId: payload.sessionId,
      workflowId,
      executionId: payload.executionId,
      agentId: 'deploy',
      correlationId: payload.correlationId,
      traceId: payload.traceId,
      spanId: workerSpanId,
      parentSpanId: payload.parentSpanId ?? payload.spanId,
      payload: { active: true },
    });

    await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'success' });

    return { workflow_id: workflowId, active: true };
  }

  if (toolName === 'test_workflow') {
    const workflowId = String(args.workflow_id ?? '');
    const result = await runTestExecution(
      n8n,
      workflowId,
      args.trigger_node ? String(args.trigger_node) : undefined
    );

    await emitRuntimeEvent({
      eventType: result.status === 'success' ? 'execution.completed' : 'execution.failed',
      userId: payload.userId,
      sessionId: payload.sessionId,
      workflowId,
      executionId: payload.executionId,
      agentId: 'monitoring',
      correlationId: payload.correlationId,
      traceId: payload.traceId,
      spanId: workerSpanId,
      parentSpanId: payload.parentSpanId ?? payload.spanId,
      severity: result.status === 'success' ? 'info' : 'error',
      payload: {
        execution_id: result.executionId,
        status: result.status,
        message: result.message,
      },
    });

    await endSpan({
      userId: payload.userId,
      spanId: workerSpanId,
      status: result.status === 'success' ? 'success' : 'error',
      errorMessage: result.status === 'success' ? undefined : result.message,
    });

    return {
      execution_id: result.executionId,
      status: result.status,
      message: result.message,
      node_statuses: result.nodeStatuses,
    };
  }

  if (toolName === 'get_workflow_status') {
    const workflowId = String(args.workflow_id ?? '');
    const status = await getWorkflowStatus(n8n, workflowId);
    await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'success' });
    return {
      workflow_id: status.id,
      active: status.active,
      updated_at: status.updatedAt,
    };
  }

  if (toolName === 'get_execution_logs') {
    const workflowId = String(args.workflow_id ?? '');
    const limit = typeof args.limit === 'number' ? args.limit : 5;
    const executions = await listExecutions(n8n, workflowId, limit);
    await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'success' });
    return {
      executions,
    };
  }

  await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'success' });
  return {
    skipped: true,
    reason: `No deterministic worker action for ${toolName}`,
  };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endSpan({ userId: payload.userId, spanId: workerSpanId, status: 'error', errorMessage: message });
    throw error;
  }
}

export async function startRuntimeWorkers(
  workerId?: string,
  options?: { explicitStart?: boolean }
): Promise<RuntimeWorker[]> {
  if (!options?.explicitStart && process.env.RUNTIME_WORKER_ENABLED !== 'true') {
    return [];
  }

  if (!canStartWorkers()) return [];

  const redis = await getRedisConnection({ key: 'runtime-worker:main' });
  if (!redis) return [];

  if (typeof window !== 'undefined') return [];

  const bullmq = await import("bullmq");
  const BullWorker = bullmq.Worker as new (
    queueName: string,
    processor: (job: RuntimeJob<RuntimeQueuePayload>) => Promise<Record<string, unknown>>,
    options: {
      connection: unknown;
      concurrency: number;
    }
  ) => RuntimeWorker;

  return QUEUE_NAMES.map((queueName) => {
    const worker = new BullWorker(
      queueName,
      async (job) => {
        const effectiveWorkerId = workerId ?? `worker-${process.pid}`;
        const ownerToken = `${effectiveWorkerId}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        const queueLeaseClaimed = await claimQueueJobLease({
          userId: job.data.userId,
          jobId: String(job.id),
          workerId: effectiveWorkerId,
          ownerToken,
          leaseSeconds: 45,
        });

        if (!queueLeaseClaimed) {
          throw new Error('Queue job lease already held by another worker');
        }

        const ownership = job.data.userId
          ? await claimExecutionOwnership({
              executionId: job.data.executionId,
              workflowId: job.data.workflowId ?? 'unknown',
              userId: job.data.userId,
              queueJobId: String(job.id),
              workerId: effectiveWorkerId,
              leaseSeconds: 45,
            })
          : { claimed: true as const, ownerToken: undefined };

        if (!ownership.claimed) {
          await releaseQueueJobLease({
            userId: job.data.userId,
            jobId: String(job.id),
            workerId: effectiveWorkerId,
            ownerToken,
          });
          throw new Error('Execution ownership lease already held by another worker');
        }

        const renewTimer = setInterval(() => {
          void renewQueueJobLease({
            userId: job.data.userId,
            jobId: String(job.id),
            workerId: effectiveWorkerId,
            ownerToken,
            leaseSeconds: 45,
          });

          if (job.data.userId && ownership.ownerToken) {
            void renewExecutionOwnership({
              executionId: job.data.executionId,
              userId: job.data.userId,
              workerId: effectiveWorkerId,
              ownerToken: ownership.ownerToken,
              leaseSeconds: 45,
            });
          }
        }, 15_000);

        try {
          const result = await processRuntimeJob(job);
          await updateQueueJob({
            userId: job.data.userId,
            jobId: String(job.id),
            status: 'completed',
            attempts: job.attemptsStarted,
            result,
          });

          if (workerId) {
            await incrementWorkerJobs(workerId);
          }

          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          const maxAttempts = Number(job.opts?.attempts ?? 1);
          const willRetry = job.attemptsMade + 1 < maxAttempts;

          await updateQueueJob({
            userId: job.data.userId,
            jobId: String(job.id),
            status: willRetry ? 'waiting' : 'failed',
            attempts: job.attemptsStarted,
            errorMessage: message,
          });

          if (!willRetry) {
            await recordQueueDeadLetter({
              userId: job.data.userId,
              queueName,
              taskType: String(job.name),
              jobId: String(job.id),
              payload: job.data,
              errorMessage: message,
              stackTrace: stack,
            });
          }

          await emitRuntimeEvent({
            eventType: willRetry ? 'retry.started' : 'execution.failed',
            userId: job.data.userId,
            sessionId: job.data.sessionId,
            workflowId: job.data.workflowId,
            executionId: job.data.executionId,
            agentId: 'recovery',
            correlationId: job.data.correlationId,
            traceId: job.data.traceId,
            spanId: job.data.spanId,
            parentSpanId: job.data.parentSpanId,
            severity: willRetry ? 'warning' : 'error',
            payload: {
              queue: queueName,
              job_id: String(job.id),
              will_retry: willRetry,
              attempts_made: job.attemptsMade + 1,
              max_attempts: maxAttempts,
              error: message,
            },
          });

          throw err;
        } finally {
          clearInterval(renewTimer);
          await releaseQueueJobLease({
            userId: job.data.userId,
            jobId: String(job.id),
            workerId: effectiveWorkerId,
            ownerToken,
          });

          if (job.data.userId && ownership.ownerToken) {
            await releaseExecutionOwnership({
              executionId: job.data.executionId,
              userId: job.data.userId,
              workerId: effectiveWorkerId,
              ownerToken: ownership.ownerToken,
              state: 'released',
            });
          }
        }
      },
      {
        connection: redis,
        concurrency: queueName === 'deploy_queue' ? 2 : 5,
      }
    );

    worker.on('error', (error: Error) => {
      const message = error.message ?? String(error);
      if (message.includes('ECONNRESET') || message.includes('ECONNABORTED') || message.includes('ECONNREFUSED')) {
        console.warn(`[runtime-worker:${queueName}] ${message}`);
        return;
      }
      console.error(`[runtime-worker:${queueName}] ${message}`);
    });

    return worker;
  });
}

export async function recoverStuckQueueJobs(params?: {
  staleMinutes?: number;
  limit?: number;
}): Promise<number> {
  const db = createServiceClient();
  const staleMinutes = params?.staleMinutes ?? 10;
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

  const { data } = await db
    .from('runtime_queue_jobs')
    .select('id, user_id, queue_name, task_type, job_id, payload, execution_id, session_id, workflow_id, trace_id, span_id, correlation_id')
    .eq('status', 'active')
    .lt('heartbeat_at', cutoff)
    .limit(params?.limit ?? 100);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  for (const row of rows) {
    await db
      .from('runtime_queue_jobs')
      .update({
        status: 'failed',
        error_message: 'Recovered stuck job after stale heartbeat',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id as string);

    await db.from('runtime_queue_dead_letters').insert({
      user_id: row.user_id ?? null,
      queue_name: row.queue_name,
      task_type: row.task_type,
      job_id: row.job_id,
      trace_id: row.trace_id ?? null,
      span_id: row.span_id ?? null,
      correlation_id: row.correlation_id ?? null,
      session_id: row.session_id ?? null,
      workflow_id: row.workflow_id ?? null,
      execution_id: row.execution_id ?? null,
      payload: row.payload ?? {},
      context: {
        repair_suggestion: 'Investigate upstream provider timeouts or worker process crash before replay.',
        recovered_by: 'stuck_job_recovery',
      },
      error_message: 'Recovered stuck job after stale heartbeat',
      failed_at: new Date().toISOString(),
      replay_status: 'pending',
    });
  }

  return rows.length;
}
