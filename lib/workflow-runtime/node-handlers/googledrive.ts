// Google Drive handler — stub.
//
// Google Drive OAuth integration is not yet implemented on the credential
// injection side (byProvider.google_drive = undefined in integrations.ts).
// This handler entry exists so HANDLER_NODE_ALLOWLIST stays consistent with
// PROVIDER_NODE_ALLOWLIST. When the credential side is implemented, replace
// the live-mode stub with a real drive API call.

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

export async function googleDriveHandler(
  _node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  if (context.mode === 'live') {
    return {
      status: 'failed',
      outputData: null,
      logs: ['Google Drive integration is not yet implemented.'],
      error: 'GOOGLE_DRIVE_NOT_IMPLEMENTED',
    };
  }

  return {
    status: 'simulated_success',
    outputData: inputData,
    logs: ['Google Drive node simulated.'],
  };
}
