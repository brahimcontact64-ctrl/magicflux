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
import { isConditionalNodeType } from '@/lib/workflow-runtime/node-capabilities';
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
  renewNodeMutex,
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
  userId?: string | null;
  workflowId?: string;
}) {
  return {
    mode: params.mode,
    integrations: params.integrations,
    sampleData: params.inputData,
    userId: params.userId,
    workflowId: params.workflowId,
    // Phase 9.9.2 -- filled in once the real executionId is known (see the
    // initializeExecution() call below); a brand-new execution doesn't have
    // one yet at the point this object is constructed.
    executionId: undefined as string | undefined,
    deploymentVersionId: undefined as string | null | undefined,
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
      userId: opts.userId,
      workflowId: opts.workflowId,
    });

    const initResult = await this.state.initializeExecution({
      executionId: opts.executionId,
      workflowId: opts.workflowId,
      userId: opts.userId,
      mode: opts.mode,
      inputData: opts.inputData,
      maxRetries,
      deploymentVersionId: opts.deploymentVersionId,
    });
    const executionId = initResult.executionId;

    // Phase 9.9.6 -- the cumulative active-compute deadline
    // (MAX_EXECUTION_DURATION_MS) is measured from the execution's true,
    // durable original started_at (never reset on resume, see
    // initializeExecution() above) -- EXCEPT when this invocation is
    // resuming immediately after a genuine durable wait (Human Review or
    // a Wait node's scheduled delay), in which case that wait time must
    // not count against active-compute budget at all, so the baseline
    // resets to "now" for this segment only. An ordinary node-failure
    // retry resume does NOT reset it, so a repeated-failure retry storm
    // (e.g. an SMTP connection that keeps timing out) is still correctly
    // bounded across resumes instead of each invocation individually
    // appearing to be well within budget.
    const executionStartedAt = opts.resumedFromDurableWait
      ? Date.now()
      : new Date(initResult.startedAt).getTime();

    handlerContext.executionId = executionId;
    handlerContext.deploymentVersionId = opts.deploymentVersionId ?? null;

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

    // Fan-in guard: a node reachable from more than one upstream edge (e.g. two
    // parallel branches that both feed into the same downstream node) must not
    // be queued twice — this engine has no join/merge semantics that wait for
    // every predecessor, so a duplicate queue entry means a duplicate execution
    // (duplicate side effects: two emails, two Slack messages, ...). Tracks
    // names currently pending in `queue`; does not prevent a node that already
    // ran from being queued again later (e.g. a cyclic/loop-back edge).
    const pendingInQueue = new Set(queue.map((item) => item.nodeName));

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
      pendingInQueue.delete(next.nodeName);

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
        pendingInQueue.add(next.nodeName);
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

      // Phase 9.9.6 -- Part D fix: the node mutex's 30s lease was never
      // renewed while the handler was actually running, unlike the
      // execution-level lock above (acquireExecutionLock/renewExecutionLock,
      // renewed every 15s for its 45s lease). A single side-effect
      // network operation exceeding 30s (the observed Gmail/SMTP hang did,
      // by design in Part A it should no longer even be possible, but this
      // must hold regardless of any one handler's own timeout behavior)
      // let the lease expire WHILE this worker was still genuinely
      // executing the node -- opening a window for a second worker to
      // acquire the "free" mutex and dispatch the SAME Email/Slack/
      // Airtable side effect concurrently. Renewing on the same cadence
      // as the execution lock keeps this worker's ownership continuously
      // valid for exactly as long as it is actually running the node, and
      // stops immediately (finally) whether the handler resolves or throws.
      const nodeMutexRenewTimer = setInterval(() => {
        void renewNodeMutex({ executionId, nodeId, ownerId, leaseSeconds: 30 });
      }, 10_000);

      let runResult: Awaited<ReturnType<NodeRunner['run']>>;
      try {
        runResult = await this.nodeRunner.run({
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
      } finally {
        clearInterval(nodeMutexRenewTimer);
        await releaseNodeMutex({
          executionId,
          nodeId,
          ownerId,
        });
      }

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
        // Phase 9.9.6 -- Part C fix: this branch used to apply its OWN,
        // SECOND retry-with-backoff budget (`nextRetry <= maxRetries`,
        // scheduling an execution-level 'waiting' resume) on top of
        // NodeRunner.run()'s own internal bounded retry loop, which has
        // ALREADY retried this exact node up to `maxRetries` times (see
        // node-runner.ts) before ever returning status:'failed' here. The
        // two loops shared the same nominal `maxRetries` value but were
        // completely unaware of each other, so a single node failure
        // could consume maxRetries+1 SQUARED total attempts across
        // "generations" -- each generation resetting retry_count and (via
        // the initializeExecution() bug fixed above) started_at, which is
        // exactly why a Gmail/SMTP node stuck in this pattern kept
        // retrying indefinitely without the execution deadline ever
        // tripping. There is now exactly ONE authoritative retry budget
        // per node failure -- NodeRunner's own -- so once it returns
        // 'failed' the execution goes straight to terminal. A genuinely
        // ambiguous side effect (runResult.nonRetryable, e.g. an SMTP
        // send whose connection dropped during/after DATA) is included in
        // this same terminal path -- it must never be retried at all, at
        // any layer.
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
        // Phase 9.9.2 -- previously defaulted to now()+60s whenever a
        // handler didn't supply nextRunAt. That fallback was dead code
        // until now (wait.ts, the only prior 'waiting' producer, always
        // supplies a real computed Date) -- but a NEW handler that
        // deliberately omits it (human-review.ts: waiting on a human
        // decision, not a timer) would otherwise get silently enrolled
        // into lib/runtime/retry-dispatcher.ts's due-execution scan once
        // that invented time passed, auto-resuming with no real decision
        // ever made. No fallback: an explicit nextRunAt means "resume via
        // timer when due"; none at all means "wait indefinitely for an
        // explicit resume call" -- next_run_at stays NULL, which
        // retry-dispatcher's `.lte(next_run_at, now)` never matches.
        const nextRunAt = runResult.nextRunAt ?? null;
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'waiting',
          currentNodeId,
          outputData: finalOutput,
          retryCount,
          nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
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
          nextRunAt: nextRunAt ?? undefined,
          simulated: opts.mode === 'test',
          message: opts.mode === 'test' ? 'Simulated only. No real API was called.' : undefined,
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      const outputPorts = edgeMap.get(nodeName) ?? [];
      const outputData = asRecord(runResult.outputData);
      const conditionBranch = typeof outputData._conditionBranch === 'number' ? outputData._conditionBranch : null;

      // Phase 9.9.3.1 -- defensive invariant, generation validation
      // (lib/agent/branch-connection-guard.ts) is the primary prevention
      // layer, but a workflow could in principle reach this runtime via
      // another path (a future import feature, a hand-edited row, a
      // generation-guard regression). A node that never decided a branch
      // (conditionBranch === null) but is wired with more than one
      // output-port array is exactly the Phase 9.9.4 defect shape: the
      // "fire every port" fallback below is only correct for a genuine
      // single-port fan-out. Fail closed rather than silently running every
      // port for a node that was never supposed to have more than one.
      if (conditionBranch === null && outputPorts.length > 1 && !isConditionalNodeType(String(node.type ?? ''))) {
        const error = `RUNTIME_NON_BRANCHING_PORT_INTEGRITY: node "${nodeName}" (${String(node.type ?? 'unknown')}) never decided a branch but is wired with ${outputPorts.length} output ports.`;
        await this.state.setExecutionState({
          executionId,
          userId: opts.userId,
          state: 'failed',
          currentNodeId,
          outputData: finalOutput,
          errorMessage: error,
          retryCount,
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
          error,
          simulated: opts.mode === 'test',
          warnings: [],
          previews: handlerContext.previews,
        };
      }

      const enqueueTarget = (target: string) => {
        if (pendingInQueue.has(target)) return; // fan-in guard — see pendingInQueue declaration above
        pendingInQueue.add(target);
        queue.push({ nodeName: target, input: runResult.outputData });
      };

      // Phase 9.9.0 -- branch semantics fix. A node that produced a
      // _conditionBranch (any IF/condition/switch-style node -- see
      // node-handlers/condition.ts) has DECIDED which single output port
      // fires. The previous fallback ("if that exact port array is
      // missing, fire every port instead") was meant only for ordinary
      // unconditional nodes with no branch decision at all -- but it
      // silently applied to a real branch decision too whenever the
      // generated connections object omitted main[1] entirely (as opposed
      // to an explicit empty array), making the false branch fire the same
      // targets as the true branch. Confirmed live in production: a
      // Hot/Warm/Cold/Uncertain IF node whose connections only populated
      // main[0] executed identical downstream nodes for every
      // classification, regardless of the branch actually taken.
      //
      // Correct semantics: once a node has decided a branch, ONLY that
      // branch's targets ever run -- a missing/absent port for the taken
      // branch means zero downstream targets, never "run everything
      // instead." The "fire every port" fan-out is reserved exclusively
      // for ordinary nodes that never decided a branch at all
      // (conditionBranch === null).
      if (conditionBranch !== null) {
        const targets = outputPorts[conditionBranch] ?? [];
        for (const target of targets) {
          enqueueTarget(target);
        }
      } else {
        for (const port of outputPorts) {
          for (const target of port) {
            enqueueTarget(target);
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
      // Phase 9.9.14 -- best-effort correction for an unhandled exception
      // that skipped every normal return path above (see
      // RuntimeStateStore.forceFailIfStillRunning's own doc comment for the
      // full root-cause). A no-op on every clean exit.
      await this.state.forceFailIfStillRunning(
        executionId,
        opts.userId,
        'Execution crashed with an unhandled error before it could reach a terminal state -- recovery_required.'
      );
      await releaseExecutionLock({
        executionId,
        userId: opts.userId,
        ownerId,
        status: lockStatus,
      });
    }
  }
}
