/**
 * Phase 9.9.8B -- explicit workflow-persistence identity states.
 *
 * Root cause this exists to fix: the Builder's Airtable configuration panel
 * previously inferred "still saving" purely from `!workflowId`, with no way
 * to distinguish "a save is genuinely in flight" from "a save was attempted
 * and failed" from "nothing has been generated yet" -- so a lost/failed
 * persistence left the panel showing a generic "still saving" message
 * forever, indistinguishable from a real bug. This is the single, pure,
 * testable rule every workflow-identity-aware Builder surface should use
 * instead of re-deriving its own heuristic.
 */
export type WorkflowIdentityStatus = 'no_workflow' | 'saving' | 'persisted' | 'persistence_failed';

export function computeWorkflowIdentityStatus(params: {
  /** True once a workflow has actually been generated in this Builder session (a result exists to save). */
  hasResult: boolean;
  /** The exact persisted row id for this exact result, or null if none yet/lost. */
  workflowId: string | null;
  /** The save attempt's own lifecycle state -- 'idle' before any attempt, 'saving' while in flight. */
  saveState: 'idle' | 'saving' | 'saved' | 'failed';
}): WorkflowIdentityStatus {
  if (!params.hasResult) return 'no_workflow';
  if (params.workflowId) return 'persisted';
  if (params.saveState === 'failed') return 'persistence_failed';
  return 'saving';
}
