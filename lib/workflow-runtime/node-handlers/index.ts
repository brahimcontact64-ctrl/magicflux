import type { EngineNode, NodeHandlerContext, NodeHandlerResult, NodeHandler } from '../types';
import { webhookHandler } from './webhook';
import { codeHandler } from './code';
import { emailHandler } from './email';
import { slackHandler } from './slack';
import { airtableHandler } from './airtable';
import { waitHandler } from './wait';
import { conditionHandler } from './condition';
import { shopifyHandler } from './shopify';
import { googleDriveHandler } from './googledrive';
import { openaiHandler } from './openai';
import { httpHandler } from './http';

// Returns a ReadonlyMap backed by a Proxy that throws TypeError on any
// mutation attempt (set / delete / clear). Object.freeze() does not protect
// Map internal storage, so the Proxy is required for true runtime immutability.
function frozenMap<K, V>(entries: ReadonlyArray<readonly [K, V]>): ReadonlyMap<K, V> {
  const inner = new Map<K, V>(entries as [K, V][]);
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'set' || prop === 'delete' || prop === 'clear') {
        return () => { throw new TypeError(`Cannot mutate frozen allowlist (attempted: ${String(prop)})`); };
      }
      // Map internal methods (get, has, size, keys, …) use [[MapData]] which
      // lives on the real Map. Always bind to `target`, not the Proxy receiver.
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as ReadonlyMap<K, V>;
}

// Exact allowlist: only these lowercase node types are routed to credential-using handlers.
// Any type not present falls through to the safe generic routing below.
//
// Security contract: crafted types such as 'slackCustom', 'airtableProxy', or
// 'emailFakeHttp' are NOT in this map and therefore cannot reach a handler that
// makes real API calls with integration credentials.
//
// Must stay in sync with PROVIDER_NODE_ALLOWLIST in lib/integrations.ts.
// The allowlist-consistency.security.test.ts suite enforces this at test time.
export const HANDLER_NODE_ALLOWLIST: ReadonlyMap<string, NodeHandler> = frozenMap([
  // Shopify
  ['n8n-nodes-base.shopify',             shopifyHandler],
  ['n8n-nodes-base.shopifytrigger',      shopifyHandler],
  // Slack
  ['n8n-nodes-base.slack',               slackHandler],
  ['n8n-nodes-base.slacktrigger',        slackHandler],
  // Airtable
  ['n8n-nodes-base.airtable',            airtableHandler],
  ['n8n-nodes-base.airtabletrigger',     airtableHandler],
  // Email / Gmail / SMTP
  ['n8n-nodes-base.emailsend',           emailHandler],
  ['n8n-nodes-base.emailreadimap',       emailHandler],
  ['n8n-nodes-base.gmail',               emailHandler],
  ['n8n-nodes-base.gmailtrigger',        emailHandler],
  // Google Drive (stub — credential injection side not yet implemented)
  ['n8n-nodes-base.googledrive',         googleDriveHandler],
  ['n8n-nodes-base.googledrivetrigger',  googleDriveHandler],
  // OpenAI
  ['n8n-nodes-base.openai',             openaiHandler],
  // Generic/custom API-key credential (see PROVIDER_NODE_ALLOWLIST['custom'] in lib/integrations.ts)
  ['n8n-nodes-base.httprequest',        httpHandler],
] as const);

function getNodeTypeKey(node: EngineNode): string {
  return String(node.type ?? '').toLowerCase();
}

function pickHandler(node: EngineNode): NodeHandler {
  const type = getNodeTypeKey(node);

  // 1. Exact provider match — only allowlisted types reach credential-using handlers.
  const providerHandler = HANDLER_NODE_ALLOWLIST.get(type);
  if (providerHandler) return providerHandler;

  // 2. Safe generic routing — none of these handlers use integration credentials.
  if (type.includes('webhook') || type.includes('trigger') || type.includes('manualtrigger')) {
    return webhookHandler;
  }
  if (type.includes('code') || type.includes('function')) {
    return codeHandler;
  }
  if (type.includes('wait') || type.includes('pause') || type.includes('delay')) {
    return waitHandler;
  }
  if (type.includes('if') || type.includes('condition') || type.includes('switch') || type.includes('filter')) {
    return conditionHandler;
  }
  if (type.includes('httprequest')) {
    return httpHandler;
  }

  // 3. Unknown node type — simulated in test mode, fails in live mode.
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
  googleDriveHandler,
  openaiHandler,
  httpHandler,
};
