import { dispatchNode } from '@/lib/workflow-runtime/node-handlers';
import type { EngineNode, NodeHandlerContext, NodeStatus } from '@/lib/workflow-runtime/types';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import { recordUsageEventSafe } from '@/lib/runtime/usage-metering';
import { claimSideEffect, recordSideEffectOutcome, isStaleInProgress, type SideEffectLedgerRow } from '@/lib/runtime/side-effect-ledger';
import {
  isLedgerProtectedSideEffect,
  deriveEffectType,
  extractProviderRef,
  buildDuplicateSuppressedOutputData,
} from '@/lib/workflow-runtime/node-handlers/side-effect-gate';
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
  /** Phase 9.9.11A -- propagated from the terminal NodeHandlerResult so callers (the side-effect ledger gate) can distinguish a network-ambiguous outcome from an ordinary, safely-retryable failure without string-matching the error message. Always false/absent for a genuine "retries exhausted" exit. */
  nonRetryable?: boolean;
  /** Phase 9.9.14 -- propagated alongside nonRetryable; see NodeHandlerResult's own doc comment. */
  failureClass?: 'indeterminate' | 'blocked_configuration';
};

function retryDelay(attempt: number): number {
  const schedule = [1000, 3000, 5000, 10000, 15000];
  return schedule[Math.min(schedule.length - 1, Math.max(0, attempt - 1))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a completed NodeRunResult to the ledger's own succeeded/failed/indeterminate vocabulary. 'cancelled' is treated as 'failed' (safe to retry later) since the cancel check always runs BEFORE any provider call within a given attempt -- cancellation can therefore never itself be the ambiguous case. */
function classifyRunResultForLedger(result: NodeRunResult): 'succeeded' | 'failed' | 'indeterminate' {
  if (result.status === 'success' || result.status === 'simulated_success' || result.status === 'skipped' || result.status === 'waiting') {
    return 'succeeded';
  }
  if (result.status === 'cancelled') return 'failed';
  // status === 'failed'
  if (!result.nonRetryable) return 'failed';
  // Phase 9.9.14 -- a definitive provider rejection (blocked_configuration)
  // PROVES nothing was created -- ledgering it 'failed' (reclaimable once
  // the operator fixes the credential) is correct; only a genuinely
  // ambiguous outcome (the default when failureClass is absent, e.g. a
  // network-level throw) may ever become 'indeterminate', since the
  // ledger's own CAS rules never allow reclaiming an indeterminate row.
  return result.failureClass === 'blocked_configuration' ? 'failed' : 'indeterminate';
}

export class NodeRunner {
  constructor(private readonly stateStore: RuntimeStateStore) {}

  /**
   * Phase 9.9.11A -- Part 4/5/7: the durable side-effect ledger gate. Wraps
   * the ENTIRE claimed attempt (which may itself contain multiple in-
   * process retries -- see runAttempts() below) as one ledger-tracked
   * unit: claimed once, BEFORE any provider call, recorded once, after the
   * attempt reaches a terminal outcome. This is what lets a crash-and-
   * recover (a fresh process re-running this exact node, whether via
   * Human Review resume or the retry dispatcher) see "this effect already
   * happened" and skip the provider entirely, or see "this is genuinely
   * unresolved" and refuse to guess -- neither of which the in-process
   * retry loop alone (Phase 9.9.11) could ever know across a process
   * boundary. Only gates the three currently-certified external-effect
   * node types (Airtable/Gmail/Slack) -- every other node type (AI
   * Classifier, Human Review, IF, webhook, ...) runs exactly as before,
   * completely unaffected.
   */
  async run(input: RunNodeInput): Promise<NodeRunResult> {
    if (!isLedgerProtectedSideEffect(input.node)) {
      return this.runAttempts(input);
    }

    const nodeId = String(input.node.id ?? input.node.name ?? 'node');
    const effectType = deriveEffectType(input.node);

    const claim = await claimSideEffect({
      userId: input.userId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      nodeId,
      effectType,
    });

    if (!claim.claimed) {
      return this.shortCircuitUnclaimed(input, claim.existing);
    }

    const result = await this.runAttempts(input);

    await recordSideEffectOutcome({
      executionId: input.executionId,
      nodeId,
      status: classifyRunResultForLedger(result),
      providerRef: result.status === 'success' || result.status === 'simulated_success' ? extractProviderRef(input.node, result.outputData) : undefined,
      error: result.error,
    });

    return result;
  }

  /**
   * The provider is NEVER called here -- either the effect is already
   * known-succeeded (duplicate_suppressed, Part 4/8) or the ledger holds a
   * state this attempt must not act past (indeterminate, or an
   * in_progress claim -- fresh/concurrent or stale/crashed, Part 4/6:
   * "recovery must NOT blindly assume either success or failure").
   */
  private async shortCircuitUnclaimed(input: RunNodeInput, existing: SideEffectLedgerRow): Promise<NodeRunResult> {
    const nodeName = String(input.node.name ?? input.node.id ?? 'node');
    const nodeId = String(input.node.id ?? nodeName);
    const nodeType = String(input.node.type ?? 'unknown');

    if (existing.status === 'succeeded') {
      const outputData = buildDuplicateSuppressedOutputData(input.inputData, existing.providerRef);
      const logs = [`${nodeName}: this effect already succeeded (duplicate_suppressed) -- not calling the provider again.`];
      await this.stateStore.persistNodeState({
        executionId: input.executionId, workflowId: input.workflowId, userId: input.userId,
        nodeId, nodeName, nodeType, status: 'success', attempt: 0, inputData: input.inputData, outputData, logs,
      });
      await emitRuntimeEvent({
        eventType: 'node.completed', userId: input.userId, workflowId: input.workflowId, executionId: input.executionId,
        correlationId: input.correlationId, traceId: input.traceId, severity: 'info',
        payload: { nodeId, nodeName, nodeType, attempt: 0, status: 'duplicate_suppressed' },
      });
      return { status: 'skipped', outputData, logs, attempts: 0 };
    }

    // indeterminate, or an in_progress claim (fresh-concurrent or stale-
    // crashed, per isStaleInProgress) -- MagicFlux cannot prove whether the
    // provider completed this action; automatic retry is stopped rather
    // than risk a possible duplicate. A stale in_progress row is left for
    // the separate reconcileStaleSideEffects() sweep, never speculatively
    // resolved here.
    const reason = existing.status === 'in_progress'
      ? (isStaleInProgress(existing)
          ? 'INDETERMINATE: a prior attempt for this effect appears to have crashed mid-flight -- MagicFlux cannot prove whether the provider completed this action. Automatic retry stopped to prevent a possible duplicate; this requires manual verification.'
          : 'A concurrent attempt for this exact effect is already in progress.')
      : 'INDETERMINATE: this effect was already left in an unresolved state -- MagicFlux cannot prove whether the provider completed this action. Automatic retry stopped to prevent a possible duplicate; this requires manual verification.';
    const logs = [`${nodeName}: ${reason}`];

    await this.stateStore.persistNodeState({
      executionId: input.executionId, workflowId: input.workflowId, userId: input.userId,
      nodeId, nodeName, nodeType, status: 'failed', attempt: 0, inputData: input.inputData, logs, errorMessage: reason,
    });
    await emitRuntimeEvent({
      eventType: 'node.failed', userId: input.userId, workflowId: input.workflowId, executionId: input.executionId,
      correlationId: input.correlationId, traceId: input.traceId, severity: 'error',
      payload: { nodeId, nodeName, nodeType, attempt: 0, error: reason },
    });

    return { status: 'failed', outputData: null, logs, error: reason, attempts: 0 };
  }

  private async runAttempts(input: RunNodeInput): Promise<NodeRunResult> {
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
      // Phase 9.9.6 -- Part E fix: a handler that marks its own failure
      // nonRetryable (e.g. emailHandler after an SMTP connection dropped
      // during/after the DATA command -- the receiving server may already
      // have accepted the message) must never be retried, at any layer,
      // regardless of how many attempts remain in this node's budget.
      // Retrying an externally ambiguous side effect risks duplicating it.
      const canRetry = !result.nonRetryable && attempt <= input.maxRetries;

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
          nonRetryable: result.nonRetryable,
          failureClass: result.failureClass,
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
