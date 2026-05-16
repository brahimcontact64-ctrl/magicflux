import type { EngineNode, NodeHandlerContext, NodeHandlerResult, NodeHandler } from '../types';
import { webhookHandler } from './webhook';
import { codeHandler } from './code';
import { emailHandler } from './email';
import { slackHandler } from './slack';
import { airtableHandler } from './airtable';
import { waitHandler } from './wait';
import { conditionHandler } from './condition';
import { shopifyHandler } from './shopify';

function getNodeTypeKey(node: EngineNode): string {
  return String(node.type ?? '').toLowerCase();
}

function pickHandler(node: EngineNode): NodeHandler {
  const type = getNodeTypeKey(node);

  if (type.includes('webhook') || type.includes('trigger') || type.includes('manualtrigger')) {
    return webhookHandler;
  }
  if (type.includes('code') || type.includes('function')) {
    return codeHandler;
  }
  if (type.includes('email') || type.includes('smtp') || type.includes('gmail') || type.includes('sendgrid') || type.includes('resend')) {
    return emailHandler;
  }
  if (type.includes('slack')) {
    return slackHandler;
  }
  if (type.includes('airtable')) {
    return airtableHandler;
  }
  if (type.includes('wait') || type.includes('pause') || type.includes('delay')) {
    return waitHandler;
  }
  if (type.includes('if') || type.includes('condition') || type.includes('switch') || type.includes('filter')) {
    return conditionHandler;
  }
  if (type.includes('shopify')) {
    return shopifyHandler;
  }

  // Unknown nodes are only tolerated in test mode. Live mode must not fake success.
  return async (_node: EngineNode, inputData: unknown, ctx: NodeHandlerContext): Promise<NodeHandlerResult> => {
    const nodeType = String(_node.type ?? 'unknown');
    if (ctx.mode === 'live') {
      return {
        status: 'failed',
        outputData: null,
        logs: [`Unsupported node type '${nodeType}' in live mode.`],
        error: `UNSUPPORTED_NODE_TYPE:${nodeType}`,
      };
    }

    return {
      status: 'simulated_success',
      outputData: inputData,
      logs: [`SIMULATED — no real API executed (unsupported node '${nodeType}').`],
    };
  };
}

export async function dispatchNode(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const handler = pickHandler(node);
  return handler(node, inputData, context);
}

export {
  webhookHandler,
  codeHandler,
  emailHandler,
  slackHandler,
  airtableHandler,
  waitHandler,
  conditionHandler,
  shopifyHandler,
};
