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
