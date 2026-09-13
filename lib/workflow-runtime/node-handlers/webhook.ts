import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

// Phase 9.8.7 -- this handler is a generic passthrough shared by every
// trigger type (manual, webhook, schedule all route here via the generic
// 'trigger'/'webhook' substring match in node-handlers/index.ts's
// pickHandler() -- none of them need real per-type logic beyond "start the
// flow with this input data"). The live-mode log line used to unconditionally
// say "using incoming webhook payload" regardless of actual trigger type,
// which was confusing (and, on a Manual Trigger, flatly wrong) in the
// execution timeline -- purely cosmetic, outputData was identical either
// way, but worth being honest about what actually happened.
function liveTriggerLogLine(nodeType: string): string {
  const lc = nodeType.toLowerCase();
  if (lc.includes('manualtrigger')) return 'Trigger: manual run started.';
  if (lc.includes('scheduletrigger') || lc.includes('cron')) return 'Trigger: schedule fired.';
  return 'Trigger: using incoming webhook payload.';
}

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

  // In live mode, the webhook payload (or manual/schedule sample data) arrives as inputData.
  logs.push(liveTriggerLogLine(String(node.type ?? '')));
  return { status: 'success', outputData: inputData ?? context.sampleData, logs };
}
