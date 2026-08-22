/**
 * Runtime execution entrypoint.
 *
 * Backward-compatible wrapper that now delegates to the Phase 9 runtime
 * execution manager for checkpointing, pause/resume, cancellation, and
 * persisted node-state transitions.
 */

import { ExecutionManager } from '@/runtime/execution-manager';
import type { EngineResult, RunExecutionOptions } from './types';

const executionManager = new ExecutionManager();

export async function runWorkflowExecution(opts: RunExecutionOptions): Promise<EngineResult> {
  return executionManager.startExecution(opts);
}

/**
 * Resumes an existing execution from its last persisted checkpoint —
 * fetches the checkpoint itself (currentNodeId, pendingQueue) via
 * ExecutionManager.resumeExecution(), unlike runWorkflowExecution() above
 * which always starts fresh from the workflow's trigger node(s). Used by
 * the manual pause/resume control route and, since Phase 8.8, the retry
 * dispatcher's queue-driven resume path — both must resolve workflowJson
 * respecting the execution's frozen deployment_version_id before calling
 * this, exactly as runWorkflowExecution()'s callers already do.
 */
export async function resumeWorkflowExecution(opts: {
  executionId: string;
  userId: string;
  workflowId: string;
  workflowJson: unknown;
  mode: 'test' | 'live';
  inputData: Record<string, unknown>;
  retryCount?: number;
  maxRetries?: number;
}): Promise<EngineResult> {
  return executionManager.resumeExecution(opts);
}

export async function runWorkflow(
  workflow: unknown,
  input: Record<string, unknown>,
  options: Omit<RunExecutionOptions, 'workflowJson' | 'inputData'>
): Promise<EngineResult> {
  return runWorkflowExecution({
    ...options,
    workflowJson: workflow,
    inputData: input,
  });
}
