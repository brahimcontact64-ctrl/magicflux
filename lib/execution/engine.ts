/**
 * Mock execution engine.
 *
 * Executes each step of a WorkflowExecutionPlan in topological order using
 * mock handlers. No real APIs are called — all results are simulated.
 *
 * This is intentionally a pure abstraction layer; swapping in real handlers
 * only requires replacing HANDLER_MAP entries.
 */

import type {
  WorkflowExecutionPlan,
  MockExecutionContext,
  MockExecutionResult,
  PlanNode,
} from './plan-types';
import { HANDLER_MAP } from './handlers/index';

// ─── Fallback generic handler ─────────────────────────────────────────────────

async function genericHandler(node: PlanNode): Promise<MockExecutionResult> {
  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output:   { mock: true, type: node.type, message: 'Executed by generic mock handler' },
    durationMs: 0,
  };
}

// ─── Single-node execution ────────────────────────────────────────────────────

export async function executeMockNode(
  node: PlanNode,
  context: MockExecutionContext,
): Promise<MockExecutionResult> {
  const handler = HANDLER_MAP[node.type] ?? genericHandler;
  try {
    return await handler(node, context);
  } catch (err) {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     err instanceof Error ? err.message : String(err),
      durationMs: 0,
    };
  }
}

// ─── Full plan execution ──────────────────────────────────────────────────────

export interface WorkflowExecutionSummary {
  stepResults: MockExecutionResult[];
  success: boolean;
  totalDurationMs: number;
  failedNodeNames: string[];
}

export async function executeMockWorkflow(
  plan: WorkflowExecutionPlan,
  context: MockExecutionContext,
): Promise<WorkflowExecutionSummary> {
  if (!plan.valid) {
    return {
      stepResults:     [],
      success:         false,
      totalDurationMs: 0,
      failedNodeNames: [],
    };
  }

  const stepResults: MockExecutionResult[] = [];
  const wallStart = Date.now();

  for (const step of plan.steps) {
    const result = await executeMockNode(step.node, context);
    context.nodeResults.set(step.node.name, result);

    // Store node output in shared variables for downstream template resolution.
    context.variables[step.node.name] = result.output;

    stepResults.push(result);

    // Stop on error so dependent nodes are not executed against bad data.
    if (result.status === 'error') break;
  }

  const failedNodeNames = stepResults
    .filter((r) => r.status === 'error')
    .map((r) => r.nodeName);

  return {
    stepResults,
    success:         failedNodeNames.length === 0,
    totalDurationMs: Date.now() - wallStart,
    failedNodeNames,
  };
}
