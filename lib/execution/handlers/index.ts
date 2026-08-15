import type { MockHandlerMap } from '../plan-types';

import { triggerHandler }   from './trigger';
import { emailHandler }     from './email';
import { slackHandler }     from './slack';
import { airtableHandler }  from './airtable';
import { httpHandler }      from './http';
import { delayHandler }     from './delay';
import { conditionHandler } from './condition';
import { openAiHandler }    from './openai';
import { codeHandler }      from './code';

/**
 * Maps n8n-style node type strings → mock handler functions.
 * Any type not listed here falls back to the generic handler in the engine.
 */
export const HANDLER_MAP: MockHandlerMap = {
  // Triggers (all share the trigger handler)
  'n8n-nodes-base.webhook':         triggerHandler,
  'n8n-nodes-base.scheduleTrigger': triggerHandler,
  'n8n-nodes-base.shopifyTrigger':  triggerHandler,
  'n8n-nodes-base.gmailTrigger':    triggerHandler,
  // Messaging
  'n8n-nodes-base.emailSend':       emailHandler,
  'n8n-nodes-base.slack':           slackHandler,
  // Storage
  'n8n-nodes-base.airtable':        airtableHandler,
  'n8n-nodes-base.googleDrive':     airtableHandler, // reuse similar shape
  // Control
  'n8n-nodes-base.if':              conditionHandler,
  'n8n-nodes-base.wait':            delayHandler,
  // AI / Code
  'n8n-nodes-base.openAi':          openAiHandler,
  'n8n-nodes-base.code':            codeHandler,
  // HTTP
  'n8n-nodes-base.httpRequest':     httpHandler,
};
