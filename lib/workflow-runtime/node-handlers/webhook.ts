import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

export async function webhookHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];

  if (context.mode === 'test') {
    logs.push('Trigger: using provided sample data for test run.');
    return { status: 'simulated_success', outputData: context.sampleData, logs };
  }

  // In live mode, the webhook payload arrives as inputData
  logs.push('Trigger: using incoming webhook payload.');
  return { status: 'success', outputData: inputData ?? context.sampleData, logs };
}
