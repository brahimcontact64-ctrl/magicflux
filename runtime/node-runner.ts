import { dispatchNode } from '@/lib/workflow-runtime/node-handlers';
import type { EngineNode, NodeHandlerContext, NodeStatus } from '@/lib/workflow-runtime/types';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import { recordUsageEventSafe } from '@/lib/runtime/usage-metering';
import { RuntimeStateStore } from './runtime-state';

type RunNodeInput = {
  executionId: string;
  workflowId: string;
  userId: string;
  node: EngineNode;
  inputData: unknown;
  maxRetries: number;
  mode: 'test' | 'live';
  handlerContext: NodeHandlerContext;
  correlationId: string;
  traceId?: string;
};

export type NodeRunResult = {
  status: NodeStatus | 'cancelled';
  outputData: unknown;
  logs: string[];
  error?: string;
  nextRunAt?: Date;
  attempts: number;
};

function retryDelay(attempt: number): number {
  const schedule = [1000, 3000, 5000, 10000, 15000];
  return schedule[Math.min(schedule.length - 1, Math.max(0, attempt - 1))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NodeRunner {
  constructor(private readonly stateStore: RuntimeStateStore) {}

  async run(input: RunNodeInput): Promise<NodeRunResult> {
    const nodeName = String(input.node.name ?? input.node.id ?? 'node');
    const nodeId = String(input.node.id ?? nodeName);
    const nodeType = String(input.node.type ?? 'unknown');

    let attempt = 0;
    while (attempt <= input.maxRetries) {
      attempt += 1;

      const control = await this.stateStore.getExecutionControl(input.executionId, input.userId);
      if (control.cancelRequested) {
        await this.stateStore.persistNodeState({
          executionId: input.executionId,
          workflowId: input.workflowId,
          userId: input.userId,
          nodeId,
          nodeName,
          nodeType,
          status: 'cancelled',
          attempt,
          inputData: input.inputData,
          logs: ['Execution cancelled before node run.'],
          errorMessage: control.reason ?? 'Cancelled by user',
        });

        return {
          status: 'cancelled',
          outputData: input.inputData,
          logs: ['Execution cancelled by user.'],
          error: control.reason ?? 'Cancelled by user',
          attempts: attempt,
        };
      }

      await this.stateStore.persistNodeState({
        executionId: input.executionId,
        workflowId: input.workflowId,
        userId: input.userId,
        nodeId,
        nodeName,
        nodeType,
        status: 'running',
        attempt,
        inputData: input.inputData,
        logs: [`Running ${nodeName} (attempt ${attempt}/${input.maxRetries + 1})`],
      });

      await emitRuntimeEvent({
        eventType: 'node.started',
        userId: input.userId,
        workflowId: input.workflowId,
        executionId: input.executionId,
        correlationId: input.correlationId,
        traceId: input.traceId,
        severity: 'info',
        payload: { nodeId, nodeName, nodeType, attempt },
      });

      const result = await dispatchNode(input.node, input.inputData, input.handlerContext);
      const terminalStatus = result.status === 'simulated_success' ? 'success' : result.status;

      // Usage metering — fire-and-forget, never blocks or fails node execution.
      // Only recorded for live mode: test/simulated runs make no real calls and
      // must not be billed as if they did.
      if (input.mode === 'live') {
        recordUsageEventSafe({
          userId: input.userId,
          workflowId: input.workflowId,
          executionId: input.executionId,
          nodeId,
          eventType: 'node_executed',
          metadata: { nodeType, attempt, status: terminalStatus },
          idempotencyKey: `${input.executionId}:${nodeId}:${attempt}:node_executed`,
        });

        const outputRecord = (result.outputData ?? null) as Record<string, unknown> | null;
        const usage = outputRecord?.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
          recordUsageEventSafe({
            userId: input.userId,
            workflowId: input.workflowId,
            executionId: input.executionId,
            nodeId,
            eventType: 'ai_tokens',
            quantity: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            metadata: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0, nodeType, attempt },
            idempotencyKey: `${input.executionId}:${nodeId}:${attempt}:ai_tokens`,
          });
        }

        if (nodeType.toLowerCase().includes('httprequest')) {
          recordUsageEventSafe({
            userId: input.userId,
            workflowId: input.workflowId,
            executionId: input.executionId,
            nodeId,
            eventType: 'http_request',
            metadata: { nodeType, attempt, status: outputRecord?.status ?? null },
            idempotencyKey: `${input.executionId}:${nodeId}:${attempt}:http_request`,
          });
        }
      }

      if (terminalStatus === 'success' || terminalStatus === 'skipped' || terminalStatus === 'waiting') {
        await this.stateStore.persistNodeState({
          executionId: input.executionId,
          workflowId: input.workflowId,
          userId: input.userId,
          nodeId,
          nodeName,
          nodeType,
          status: terminalStatus === 'success' || terminalStatus === 'skipped' || terminalStatus === 'waiting' ? 'success' : 'failed',
          attempt,
          inputData: input.inputData,
          outputData: result.outputData,
          logs: result.logs,
          errorMessage: result.error,
        });

        await emitRuntimeEvent({
          eventType: terminalStatus === 'waiting' ? 'execution.checkpointed' : 'node.completed',
          userId: input.userId,
          workflowId: input.workflowId,
          executionId: input.executionId,
          correlationId: input.correlationId,
          traceId: input.traceId,
          severity: 'info',
          payload: { nodeId, nodeName, nodeType, attempt, status: terminalStatus },
        });

        return {
          status: result.status,
          outputData: result.outputData,
          logs: result.logs,
          error: result.error,
          nextRunAt: result.nextRunAt,
          attempts: attempt,
        };
      }

      const error = result.error ?? 'Node execution failed';
      const canRetry = attempt <= input.maxRetries;

      await this.stateStore.persistNodeState({
        executionId: input.executionId,
        workflowId: input.workflowId,
        userId: input.userId,
        nodeId,
        nodeName,
        nodeType,
        status: canRetry ? 'retrying' : 'failed',
        attempt,
        inputData: input.inputData,
        outputData: result.outputData,
        logs: [...result.logs, canRetry ? 'Retrying node after failure.' : 'Node failed permanently.'],
        errorMessage: error,
      });

      await emitRuntimeEvent({
        eventType: canRetry ? 'retry.started' : 'node.failed',
        userId: input.userId,
        workflowId: input.workflowId,
        executionId: input.executionId,
        correlationId: input.correlationId,
        traceId: input.traceId,
        severity: canRetry ? 'warning' : 'error',
        payload: { nodeId, nodeName, nodeType, attempt, error },
      });

      if (!canRetry) {
        return {
          status: 'failed',
          outputData: result.outputData,
          logs: result.logs,
          error,
          attempts: attempt,
        };
      }

      await sleep(retryDelay(attempt));
    }

    return {
      status: 'failed',
      outputData: input.inputData,
      logs: ['Node retries exhausted.'],
      error: 'Node retries exhausted',
      attempts: input.maxRetries + 1,
    };
  }
}
