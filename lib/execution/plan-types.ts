/**
 * Types for the workflow compiler and mock execution engine.
 * Distinct from types.ts which contains execution-history UI types.
 */

// ─── Node representation used by the compiler / engine ───────────────────────

export interface PlanNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

// ─── Compiler output ──────────────────────────────────────────────────────────

export interface PlanStep {
  stepIndex: number;
  node: PlanNode;
  /** Names of immediate predecessor nodes (must complete before this step runs). */
  dependsOn: string[];
}

export interface WorkflowExecutionPlan {
  steps: PlanStep[];
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Node names that are part of a detected cycle. */
  cycleNodeNames: string[];
  /** Node names with no connections and non-trigger type (isolated/unreferenced). */
  orphanNodeNames: string[];
}

// ─── Execution context ────────────────────────────────────────────────────────

export interface MockExecutionContext {
  workflowId?: string;
  /** Accumulated results keyed by node name. */
  nodeResults: Map<string, MockExecutionResult>;
  /** Shared variable store for inter-node data passing. */
  variables: Record<string, unknown>;
}

export function createMockContext(workflowId?: string): MockExecutionContext {
  return { workflowId, nodeResults: new Map(), variables: {} };
}

// ─── Mock execution result ───────────────────────────────────────────────────

export type MockNodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface MockExecutionResult {
  nodeId: string;
  nodeName: string;
  status: MockNodeStatus;
  output: Record<string, unknown>;
  error?: string;
  durationMs: number;
  /** Condition nodes set this: true = true branch, false = false branch. */
  conditionResult?: boolean;
}

// ─── Handler contract ─────────────────────────────────────────────────────────

export type MockNodeHandler = (
  node: PlanNode,
  context: MockExecutionContext,
) => Promise<MockExecutionResult>;

export type MockHandlerMap = Record<string, MockNodeHandler>;
