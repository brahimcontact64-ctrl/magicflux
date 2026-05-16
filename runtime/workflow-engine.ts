import { createCorrelationId, emitRuntimeEvent } from '@/lib/runtime/events';
import { createTraceId } from '@/lib/runtime/tracing';
import type {
  ConnectionEntry,
  EngineNode,
  EngineResult,
  EngineWorkflow,
  ExecutionStep,
  RunExecutionOptions,
} from '@/lib/workflow-runtime/types';
import { getUserIntegrations, resolveWorkflowIntegrations } from '@/lib/user-integrations';
import { RuntimeStateStore } from './runtime-state';
import { NodeRunner } from './node-runner';
import {
  acquireExecutionLock,
  acquireNodeMutex,
  buildExecutionIdempotencyKey,
  findExecutionByIdempotencyKey,
  releaseExecutionLock,
  releaseNodeMutex,
  renewExecutionLock,
} from './hardening-layer';

type QueueItem = { nodeName: string; input: unknown };

const MAX_NODE_EXECUTIONS = 400;
const MAX_INPUT_BYTES = Number(process.env.RUNTIME_MAX_INPUT_BYTES ?? 1024 * 1024);
const MAX_EXECUTION_DURATION_MS = Number(process.env.RUNTIME_MAX_EXECUTION_DURATION_MS ?? 5 * 60 * 1000);

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function buildNodeMap(nodes: EngineNode[]): Map<string, EngineNode> {
  const map = new Map<string, EngineNode>();
  for (const node of nodes) {
    const key = String(node.name ?? node.id ?? '').trim();
    if (key) map.set(key, node);
  }
  return map;
}

function buildEdgeMap(connections: Record<string, { main?: ConnectionEntry[][] }>): Map<string, string[][]> {
  const map = new Map<string, string[][]>();
  for (const [source, connData] of Object.entries(connections)) {
    const ports = (connData.main ?? []).map((port) => (port ?? []).map((entry) => entry.node).filter(Boolean));
    map.set(source, ports);
  }
  return map;
}

function findStartNodes(nodes: EngineNode[], edgeMap: Map<string, string[][]>): string[] {
  const incoming = new Map<string, number>();
  for (const node of nodes) {
    const name = String(node.name ?? node.id ?? '').trim();
    if (name) incoming.set(name, 0);
  }

  for (const ports of edgeMap.values()) {
    for (const port of ports) {
      for (const target of port) {
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
      }
    }
  }

  const triggerNodes = nodes
    .filter((node) => {
      const type = String(node.type ?? '').toLowerCase();
      return type.includes('trigger') || type.includes('webhook') || type.includes('manualtrigger');
    })
    .map((node) => String(node.name ?? node.id ?? '').trim())
    .filter(Boolean);

  if (triggerNodes.length > 0) return triggerNodes;

  const roots = Array.from(incoming.entries())
    .filter(([, count]) => count === 0)
    .map(([name]) => name);

  if (roots.length > 0) return roots;

  const first = String(nodes[0]?.name ?? nodes[0]?.id ?? '').trim();
  return first ? [first] : [];
}

function buildHandlerContext(params: {
  mode: 'test' | 'live';
  integrations: Awaited<ReturnType<typeof getUserIntegrations>>;
  inputData: Record<string, unknown>;
}) {
  return {
    mode: params.mode,
    integrations: params.integrations,
    sampleData: params.inputData,
    previews: {
      emails: [] as Array<Record<string, unknown>>,
      slackMessages: [] as Array<Record<string, unknown>>,
      airtableRecords: [] as Array<Record<string, unknown>>,
    },
  };
}

export class WorkflowEngine {
  private readonly state = new RuntimeStateStore();
  private readonly nodeRunner = new NodeRunner(this.state);

  async execute(opts: RunExecutionOptions & { pendingQueue?: QueueItem[] }): Promise<EngineResult> {
    const executionStartedAt = Date.now();
    const workflow = (opts.workflowJson ?? {}) as EngineWorkflow;
    const nodes = workflow.nodes ?? [];
    const connections = workflow.connections ?? {};

    if (Buffer.byteLength(JSON.stringify(opts.inputData ?? {}), 'utf8') > MAX_INPUT_BYTES) {
      return {
        executionId: opts.executionId ?? 'no-execution',
        status: 'failed',
        currentNodeId: null,
        steps: [],
        finalOutput: null,
        error: `Input payload too large. Max allowed is ${MAX_INPUT_BYTES} bytes.`,
        simulated: opts.mode === 'test',
        message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
        warnings: ['Execution blocked by payload size policy.'],
        previews: {
          emails: [],
          slackMessages: [],
          airtableRecords: [],
        },
      };
    }

    if (nodes.length === 0) {
      return {
        executionId: opts.executionId ?? 'no-execution',
        status: 'failed',
        currentNodeId: null,
        steps: [],
        finalOutput: null,
        error: 'Workflow has no nodes',
        simulated: opts.mode === 'test',
        message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
        warnings: [],
        previews: {
          emails: [],
          slackMessages: [],
          airtableRecords: [],
        },
      };
    }

    const maxRetries = opts.maxRetries ?? 3;
    const retryCount = opts.retryCount ?? 0;
    const correlationId = createCorrelationId(opts.executionId ?? opts.workflowId);
    const traceId = createTraceId();
    const ownerId = opts.ownerId ?? `engine-${process.pid}`;
    const idempotencyKey = buildExecutionIdempotencyKey({
      workflowId: opts.workflowId,
      mode: opts.mode,
      inputData: opts.inputData,
      explicitKey: opts.idempotencyKey,
    });

    if (!opts.executionId) {
      const prior = await findExecutionByIdempotencyKey({
        userId: opts.userId,
        idempotencyKey,
      });

      if (prior && ['running', 'waiting', 'success', 'completed'].includes(prior.status)) {
        return {
          executionId: prior.executionId,
          status: prior.status === 'completed' ? 'success' : (prior.status as EngineResult['status']),
          currentNodeId: prior.currentNodeId,
          steps: [],
          finalOutput: prior.outputData,
          error: prior.errorMessage ?? undefined,
          nextRunAt: prior.nextRunAt ? new Date(prior.nextRunAt) : undefined,
          simulated: opts.mode === 'test',
          message: prior.status === 'waiting' ? 'Duplicate execution suppressed; original run is waiting.' : 'Duplicate execution suppressed.',
          warnings: ['Idempotency prevented duplicate execution.'],
          previews: {
            emails: [],
            slackMessages: [],
            airtableRecords: [],
          },
        };
      }
    }

    const integrations = opts.mode === 'live'
      ? Array.from((await resolveWorkflowIntegrations(opts.userId, opts.workflowId, opts.workflowJson)).resolved.values())
      : await getUserIntegrations(opts.userId, { connectedOnly: true });

    const handlerContext = buildHandlerContext({
      mode: opts.mode,
      integrations,
      inputData: opts.inputData,
    });

    const executionId = await this.state.initializeExecution({
      executionId: opts.executionId,
      workflowId: opts.workflowId,
      userId: opts.userId,
      mode: opts.mode,
      inputData: opts.inputData,
      maxRetries,
    });

    const lock = await acquireExecutionLock({
      executionId,
      userId: opts.userId,
      workflowId: opts.workflowId,
      ownerId,
      idempotencyKey,
      leaseSeconds: 45,
    });

    if (!lock.acquired) {
      return {
        executionId,
        status: 'waiting',
        currentNodeId: null,
        steps: [],
        finalOutput: opts.inputData,
        error: lock.reason ?? 'Execution lease already held by another worker',
        simulated: opts.mode === 'test',
        message: 'Execution is currently owned by another worker.',
        warnings: ['Distributed lock prevented race condition.'],
        previews: {
          emails: [],
          slackMessages: [],
          airtableRecords: [],
        },
      };
    }

    const lockRenewTimer = setInterval(() => {
      void renewExecutionLock({ executionId, userId: opts.userId, ownerId, leaseSeconds: 45 });
    }, 15_000);

    let lockStatus: 'waiting' | 'completed' | 'failed' | 'cancelled' = 'failed';

    try {

    await emitRuntimeEvent({
      eventType: 'execution.started',
      userId: opts.userId,
      workflowId: opts.workflowId,
      executionId,
      correlationId,
      traceId,
      severity: 'info',
      payload: { mode: opts.mode },
    });

    const nodeMap = buildNodeMap(nodes);
    const edgeMap = buildEdgeMap(connections as Record<string, { main?: ConnectionEntry[][] }>);

    const queue: QueueItem[] = opts.pendingQueue && opts.pendingQueue.length > 0
      ? [...opts.pendingQueue]
      : (opts.resumeFromNodeId ? [opts.resumeFromNodeId] : findStartNodes(nodes, edgeMap)).map((nodeName) => ({
          nodeName,
          input: opts.inputData,
        }));

    let snapshotVersion = (await this.state.getLatestSnapshot(executionId, opts.userId))?.snapshotVersion ?? 0;
    const persistCheckpoint = async (input: {
      checkpointType: 'node_completed' | 'waiting' | 'paused' | 'retrying' | 'cancelled' | 'failed' | 'completed';
      currentNodeId?: string | null;
      stateSnapshot: Record<string, unknown>;
      pendingQueue: Array<{ nodeName: string; input: unknown }>;
      metadata?: Record<string, unknown>;
    }) => {
      await this.state.writeCheckpoint({
        executionId,
        workflowId: opts.workflowId,
        userId: opts.userId,
        checkpointType: input.checkpointType,
        currentNodeId: input.currentNodeId,
        stateSnapshot: input.stateSnapshot,
        pendingQueue: input.pendingQueue,
      });

      snapshotVersion += 1;
      await this.state.writeSnapshot({
        executionId,
        workflowId: opts.workflowId,
        userId: opts.userId,
        snapshotType: input.checkpointType === 'completed' ? 'checkpoint' : input.checkpointType === 'failed' ? 'failover' : 'checkpoint',
        snapshotVersion,
        currentNodeId: input.currentNodeId,
        stateSnapshot: {
          ...input.stateSnapshot,
          inputData: opts.inputData,
        },
        pendingQueue: input.pendingQueue,
        metadata: input.metadata,
      });
    };

    for (const queuedItem of queue) {
      const node = nodeMap.get(queuedItem.nodeName);
      if (!node) continue;
      const nodeName = String(node.name ?? node.id ?? queuedItem.nodeName);
      const nodeId = String(node.id ?? nodeName);
      await this.state.persistNodeState({
        executionId,
        workflowId: opts.workflowId,
        userId: opts.userId,
        nodeId,
        nodeName,
        nodeType: String(node.type ?? 'unknown'),
        status: 'queued',
        attempt: retryCount + 1,
        inputData: queuedItem.input,
        logs: ['Node queued for execution.'],
      });
    }

    const steps: ExecutionStep[] = [];
    let currentNodeId: string | null = null;
    let finalOutput: unknown = opts.inputData;
    let totalExecutions = 0;

    while (queue.length > 0) {
      if (Date.now() - executionStartedAt > MAX_EXECUTION_DURATION_MS) {
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'failed',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: `Execution exceeded runtime budget of ${MAX_EXECUTION_DURATION_MS}ms`,
          retryCount,
        });

        await persistCheckpoint({
          checkpointType: 'failed',
          currentNodeId,
          stateSnapshot: { output: asRecord(finalOutput) },
          pendingQueue: queue,
          metadata: { reason: 'execution_timeout_budget' },
        });

        lockStatus = 'failed';
        return {
          executionId,
          status: 'failed',
          currentNodeId,
          steps,
          finalOutput,
          error: `Execution exceeded runtime budget of ${MAX_EXECUTION_DURATION_MS}ms`,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      totalExecutions += 1;
      if (totalExecutions > MAX_NODE_EXECUTIONS) {
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'failed',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: 'Execution halted due to max node execution limit',
          retryCount,
        });

        return {
          executionId,
          status: 'failed',
          currentNodeId,
          steps,
          finalOutput,
          error: 'Execution halted due to max node execution limit',
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      const control = await this.state.getExecutionControl(executionId, opts.userId);
      if (control.cancelRequested) {
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'cancelled',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: control.reason ?? 'Execution cancelled',
          retryCount,
        });

        await persistCheckpoint({
          checkpointType: 'cancelled',
          currentNodeId,
          stateSnapshot: { output: asRecord(finalOutput) },
          pendingQueue: queue,
        });

        lockStatus = 'cancelled';

        return {
          executionId,
          status: 'cancelled',
          currentNodeId,
          steps,
          finalOutput,
          error: control.reason ?? 'Execution cancelled',
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      if (control.pauseRequested && !control.resumeRequested) {
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'paused',
          currentNodeId,
          outputData: finalOutput,
          retryCount,
        });

        await persistCheckpoint({
          checkpointType: 'paused',
          currentNodeId,
          stateSnapshot: { output: asRecord(finalOutput) },
          pendingQueue: queue,
        });

        lockStatus = 'waiting';

        return {
          executionId,
          status: 'waiting',
          currentNodeId,
          steps,
          finalOutput,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : 'Execution paused',
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      const next = queue.shift();
      if (!next) continue;

      const node = nodeMap.get(next.nodeName);
      if (!node) continue;

      const nodeName = String(node.name ?? node.id ?? next.nodeName);
      const nodeId = String(node.id ?? nodeName);
      currentNodeId = nodeName;

      const nodeMutex = await acquireNodeMutex({
        executionId,
        workflowId: opts.workflowId,
        userId: opts.userId,
        nodeId,
        ownerId,
        leaseSeconds: 30,
      });

      if (!nodeMutex.acquired) {
        queue.push(next);
        if (totalExecutions > nodes.length * 3) {
          await this.state.setExecutionState({
            executionId,
            userId: opts.userId,
            state: 'failed',
            currentNodeId,
            outputData: finalOutput,
            errorMessage: 'Deadlock prevention triggered after repeated mutex contention',
            retryCount,
          });
          await persistCheckpoint({
            checkpointType: 'failed',
            currentNodeId,
            stateSnapshot: { output: asRecord(finalOutput) },
            pendingQueue: queue,
            metadata: { reason: 'deadlock_prevention' },
          });
          lockStatus = 'failed';
          return {
            executionId,
            status: 'failed',
            currentNodeId,
            steps,
            finalOutput,
            error: 'Deadlock prevention triggered after repeated mutex contention',
            simulated: opts.mode === 'test',
            message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
            warnings: [],
            previews: handlerContext.previews,
          };
        }
        continue;
      }

      await this.state.setExecutionState({
        executionId,
        userId: opts.userId,
        state: 'running',
        currentNodeId,
        retryCount,
      });

      const runResult = await this.nodeRunner.run({
        executionId,
        workflowId: opts.workflowId,
        userId: opts.userId,
        node,
        inputData: next.input,
        maxRetries,
        mode: opts.mode,
        handlerContext,
        correlationId,
        traceId,
      });

      await releaseNodeMutex({
        executionId,
        nodeId,
        ownerId,
      });

      const step: ExecutionStep = {
        nodeId,
        nodeName,
        nodeType: String(node.type ?? 'unknown'),
        status: runResult.status === 'cancelled' ? 'failed' : runResult.status,
        inputData: next.input,
        outputData: runResult.outputData,
        logs: runResult.logs,
        error: runResult.error,
        startedAt: new Date(),
        completedAt: new Date(),
        attempt: runResult.attempts,
      };
      steps.push(step);

      if (runResult.status === 'cancelled') {
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'cancelled',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: runResult.error ?? 'Execution cancelled',
          retryCount,
        });

        lockStatus = 'cancelled';
        return {
          executionId,
          status: 'cancelled',
          currentNodeId,
          steps,
          finalOutput,
          error: runResult.error,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      if (runResult.status === 'failed') {
        const nextRetry = retryCount + 1;
        if (nextRetry <= maxRetries) {
          const nextRunAt = new Date(Date.now() + Math.min(900_000, Math.max(1000, nextRetry * 3000)));
          await this.state.setExecutionState({
            executionId,
            userId: opts.userId,
            state: 'waiting',
            currentNodeId,
            outputData: finalOutput,
            errorMessage: runResult.error ?? 'Execution failed',
            retryCount: nextRetry,
            nextRunAt: nextRunAt.toISOString(),
          });

          await persistCheckpoint({
            checkpointType: 'retrying',
            currentNodeId,
            stateSnapshot: { output: asRecord(finalOutput) },
            pendingQueue: [{ nodeName: nodeName, input: next.input }, ...queue],
          });

          lockStatus = 'waiting';

          return {
            executionId,
            status: 'waiting',
            currentNodeId,
            steps,
            finalOutput,
            error: runResult.error,
            nextRunAt,
            simulated: opts.mode === 'test',
            message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
            warnings: [],
            previews: handlerContext.previews,
          };
        }

        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'failed',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: runResult.error ?? 'Execution failed',
          retryCount: maxRetries,
        });

        await persistCheckpoint({
          checkpointType: 'failed',
          currentNodeId,
          stateSnapshot: { output: asRecord(finalOutput) },
          pendingQueue: queue,
        });

        lockStatus = 'failed';

        return {
          executionId,
          status: 'failed',
          currentNodeId,
          steps,
          finalOutput,
          error: runResult.error,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      finalOutput = runResult.outputData;

      if (runResult.status === 'waiting') {
        const nextRunAt = runResult.nextRunAt ?? new Date(Date.now() + 60_000);
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'waiting',
          currentNodeId,
          outputData: finalOutput,
          retryCount,
          nextRunAt: nextRunAt.toISOString(),
        });

        await persistCheckpoint({
          checkpointType: 'waiting',
          currentNodeId,
          stateSnapshot: { output: asRecord(finalOutput) },
          pendingQueue: queue,
        });

        lockStatus = 'waiting';

        return {
          executionId,
          status: 'waiting',
          currentNodeId,
          steps,
          finalOutput,
          nextRunAt,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      const outputPorts = edgeMap.get(nodeName) ?? [];
      const outputData = asRecord(runResult.outputData);
      const conditionBranch = typeof outputData._conditionBranch === 'number' ? outputData._conditionBranch : null;

      if (conditionBranch !== null && outputPorts[conditionBranch]) {
        for (const target of outputPorts[conditionBranch]) {
          queue.push({ nodeName: target, input: runResult.outputData });
        }
      } else {
        for (const port of outputPorts) {
          for (const target of port) {
            queue.push({ nodeName: target, input: runResult.outputData });
          }
        }
      }

      await persistCheckpoint({
        checkpointType: 'node_completed',
        currentNodeId,
        stateSnapshot: { output: asRecord(finalOutput) },
        pendingQueue: queue,
      });
    }

    await this.state.setExecutionState({
      executionId,
      userId: opts.userId,
      state: 'completed',
      currentNodeId,
      outputData: finalOutput,
      retryCount,
    });

    await persistCheckpoint({
      checkpointType: 'completed',
      currentNodeId,
      stateSnapshot: { output: asRecord(finalOutput) },
      pendingQueue: [],
    });

    await emitRuntimeEvent({
      eventType: 'execution.completed',
      userId: opts.userId,
      workflowId: opts.workflowId,
      executionId,
      correlationId,
      traceId,
      severity: 'info',
      payload: { mode: opts.mode },
    });

    lockStatus = 'completed';
    return {
      executionId,
      status: opts.mode === 'test' ? 'simulated_success' : 'success',
      currentNodeId,
      steps,
      finalOutput,
      simulated: opts.mode === 'test',
      message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : 'Live execution completed.',
      warnings: [],
      previews: handlerContext.previews,
    };
    } finally {
      clearInterval(lockRenewTimer);
      await releaseExecutionLock({
        executionId,
        userId: opts.userId,
        ownerId,
        status: lockStatus,
      });
    }
  }
}
