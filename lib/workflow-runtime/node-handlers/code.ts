// SECURITY: Code node JavaScript execution is permanently disabled.
//
// Node.js vm.runInNewContext() is NOT a security boundary (Node.js docs are
// explicit on this). Any regex deny-list can be bypassed — confirmed exploit:
//
//   this.constructor.constructor('return this')()['process']['env']
//
// This single payload escapes the sandbox and reads process.env without
// matching any pattern in the former DENIED_CODE_PATTERNS list.
//
// Fix: user-supplied JavaScript is NEVER executed server-side.
//   - live mode  → hard failure, status CODE_NODES_DISABLED_LIVE_MODE
//   - test mode  → simulated_success, inputData returned unchanged
//
// If real transformation logic is needed in future, it must run in a
// fully isolated sub-process (e.g. Worker thread with env: {}) where
// process.env of the host process is not inherited.

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

export async function codeHandler(
  _node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  if (context.mode === 'live') {
    return {
      status: 'failed',
      outputData: null,
      logs: ['Code nodes are disabled in live mode for security reasons.'],
      error: 'CODE_NODES_DISABLED_LIVE_MODE',
    };
  }

  // Test / simulation mode: pass input through unchanged.
  // User JS is not evaluated under any circumstances.
  return {
    status: 'simulated_success',
    outputData: inputData,
    logs: ['Code node simulated — user JavaScript is not executed server-side.'],
  };
}
