/**
 * MagicFlux Autonomous Agent — Tool Definitions
 *
 * These are the OpenAI function-calling tool definitions.
 * The AI decides which tools to call, in which order, with which parameters.
 */

import type OpenAI from 'openai';

export type AgentTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Phase 9.8.6 -- single source of truth for generate_workflow_json's
 * `trigger` argument, shared with executor.ts's defense-in-depth validation
 * so the enum below and the runtime check can't drift apart. Every value
 * here maps to a trigger the native runtime actually supports end-to-end
 * (see lib/workflow-runtime/node-capabilities.ts) -- no inbox-watching or
 * other blocklisted trigger types.
 */
export const SUPPORTED_TRIGGER_TYPES = ['manual_trigger', 'webhook', 'schedule', 'new_order'] as const;
export type SupportedTriggerType = (typeof SUPPORTED_TRIGGER_TYPES)[number];

/** True only for a trigger value the native runtime actually supports end-to-end. Used by executor.ts as defense-in-depth against a model deviation from the schema's `enum`. */
export function isSupportedTriggerType(value: string): value is SupportedTriggerType {
  return (SUPPORTED_TRIGGER_TYPES as readonly string[]).includes(value);
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'generate_workflow_json',
      description:
        'Generate a production-ready n8n workflow JSON based on the automation requirements. ' +
        'Call this as soon as user intent is clear enough to start building. ' +
        'Returns workflow nodes, connections, and a human explanation of how it works. ' +
        'Many valid automations involve NO external platform at all -- they only branch on a ' +
        'condition and assign/derive a field (e.g. "mark as VIP", "classify as high priority", ' +
        '"set status to approved"). For those, omit platform entirely and set action to a plain ' +
        'internal transformation like set_field or classify_record -- do not invent a messaging, ' +
        'notification, or CRM step just because the request uses a verb like "mark"/"tag"/"notify ' +
        'the system"/"update".',
      parameters: {
        type: 'object',
        required: ['workflow_name', 'trigger', 'action', 'nodes_description'],
        properties: {
          workflow_name: {
            type: 'string',
            description: 'A clear name for the workflow, e.g. "Gmail AI Auto-Reply"',
          },
          trigger: {
            type: 'string',
            // Phase 9.8.6 -- constrained to exactly the trigger types the
            // native runtime actually supports end-to-end today (see
            // lib/workflow-runtime/node-capabilities.ts's BLOCKLIST --
            // n8n-nodes-base.gmailTrigger and similar inbox-watching
            // triggers are explicitly blocked as silent no-ops, so
            // "new_email"/"new_message"/"form_submit" were never real
            // options and are removed rather than left as invented,
            // non-functional examples). An enum (not free-form text)
            // because the previous open-ended description gave the model
            // no listed option for a one-time/immediate request, so it
            // improvised "webhook" or invented values like "new_message"
            // that the runtime cannot support the way the model intends.
            enum: [...SUPPORTED_TRIGGER_TYPES],
            description:
              'The trigger type. Use manual_trigger for a one-time/immediate "do this now" / ' +
              '"run this once" request with no recurring schedule and no external event to wait ' +
              'for -- never use webhook for these unless the user explicitly asked for an ' +
              'externally callable endpoint/webhook. Use webhook only when an external system ' +
              'should call this workflow. Use schedule for a recurring/time-based automation. Use ' +
              'new_order for a Shopify new-order trigger.',
          },
          action: {
            type: 'string',
            description:
              'The primary action. External-side-effect examples: auto_reply, send_slack_message, ' +
              'save_to_airtable, send_email, create_ticket, notify. Internal-only examples (no ' +
              'platform, no external side effect): set_field, classify_record, update_status, ' +
              'branch_and_set -- use one of these when the request is really about deriving or ' +
              'assigning a value based on a condition, not sending/posting/notifying anything ' +
              'externally.',
          },
          platform: {
            type: 'string',
            description:
              'Main external platform/integration, ONLY if one is genuinely involved: gmail, ' +
              'shopify, slack, airtable, instagram, whatsapp, telegram. Omit this field entirely ' +
              'for automations that only transform/branch data internally (no external system is ' +
              'contacted) -- never guess or default to a platform that was not actually requested.',
          },
          destination: {
            type: 'string',
            description:
              'Output destination if different from platform. Phase 9.8.7: if the user gave an ' +
              'exact recipient/address (an email address, a Slack channel, a phone number, etc.), ' +
              'put it here VERBATIM -- copy the literal text, never generalize it into a category ' +
              '("their email address") or invent a placeholder ("recipient@example.com").',
          },
          ai_provider: {
            type: 'string',
            description: 'AI provider to use for generation: openai, claude, groq, gemini',
          },
          schedule: {
            type: 'string',
            description:
              'Phase 9.8.8: ONLY a recurring cadence, e.g. "every 5 minutes", "daily at 09:00", ' +
              '"every monday at 09:00". MagicFlux\'s scheduler only supports recurring cron -- it ' +
              'cannot run a workflow once at a specific date/time and stop. If the user asked for a ' +
              'one-time/absolute run (e.g. "today at 14:45", "tomorrow at 9am", a specific date), do ' +
              'NOT force it into a recurring cadence here -- the generation step will reject it. ' +
              'Ask the user to restate it as a recurring schedule instead.',
          },
          timezone: {
            type: 'string',
            description:
              'Phase 9.8.8: REQUIRED whenever trigger is "schedule". The IANA timezone the user\'s ' +
              'schedule times mean, e.g. "Africa/Algiers", "America/New_York", "UTC". Never guess or ' +
              'default this from IP/locale -- ask the user which timezone they mean if it is not ' +
              'stated or already known from their profile. A schedule request without a clear ' +
              'timezone must not be silently treated as UTC.',
          },
          automation_style: {
            type: 'string',
            description: 'How automated: fully_automatic, approval_required, manual_trigger',
          },
          required_capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Capability-first requirements inferred from intent, e.g. market_data, scheduling, send_message, database_storage',
          },
          skill_packs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Activated skill packs that should influence workflow structure, e.g. CRYPTO PACK, ECOMMERCE PACK',
          },
          block_blueprint: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Ordered workflow block hints from block composer. External-side-effect examples: ' +
              'trigger_schedule, scraper, ai_reasoner, messaging_send. Internal/deterministic ' +
              'examples (no platform involved): condition, set_field -- use these for a branch-and-' +
              'assign automation whose condition is a deterministic formula already in the data ' +
              '(e.g. "if amount > 100 then mark as VIP"). Phase 9.9.1: when the decision requires ' +
              'genuine AI judgment over unstructured criteria (e.g. "classify this lead as Hot/Warm/' +
              'Cold based on budget, urgency, and purchase intent", intent/sentiment detection), use ' +
              'ai_classifier BEFORE any condition block that reads its result -- never condition ' +
              'alone branching on a field nothing computes. Phase 9.9.2: when the request needs a ' +
              'real person to approve/reject/decide before continuing (e.g. "flag for human review", ' +
              '"require approval"), use human_review -- never condition/set_field alone, which create ' +
              'no durable, actionable review record.',
          },
          nodes_description: {
            type: 'string',
            description:
              'Describe each node in the workflow in plain language. Phase 9.8.7: this must include ' +
              'every concrete literal value the user actually provided -- the exact recipient ' +
              'address, subject line, message/body text, Slack channel, webhook path, or other ' +
              'concrete parameter -- copied verbatim, not summarized. A description like "sends an ' +
              'email with a specified subject and message" is NOT sufficient when the user gave a ' +
              'real subject and message; write the actual text. Placeholder values such as ' +
              '"recipient@example.com", "Your Subject Here", or "Your message content here" are ' +
              'forbidden whenever the user supplied a real value for that field -- only use them ' +
              'when the user genuinely left that field unspecified.',
          },
          record_identity_fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Phase 9.9.4D: ONLY when this automation processes a real-world entity (a lead, order, ' +
              'ticket, contact, etc.) whose data gets saved somewhere (Airtable, a database, a ' +
              'spreadsheet) -- list the identity/contact fields that IDENTIFY that entity, using the ' +
              'exact same field names the trigger payload/rest of the graph uses, e.g. ["name","email"] ' +
              'for a lead-intake webhook. This is a SEPARATE, narrower decision from what an Airtable ' +
              'node\'s own "fields" mapping ends up looking like: this list is enforced by deterministic ' +
              'code on every save-to-Airtable node in the graph, so declaring it here (once, per request) ' +
              'guarantees those fields can never silently disappear from the mapping across regenerations, ' +
              'no matter what else (e.g. an AI classifier\'s confidence score) also gets added. Omit ' +
              'entirely for automations with no such entity/no persistence step -- never invent fields ' +
              'here that were not actually part of the request.',
          },
        },
      },
    },
  },
  // Phase 9.8.1 -- deploy_workflow_to_n8n and activate_workflow removed.
  // They deployed to an external n8n instance (misconfigured to
  // localhost:5678 in production -- confirmed by the failed deployment_versions
  // row from the Phase 9.8 Founder incident) and never persisted to this
  // app's own `workflows` table, unlike the canonical native runtime
  // (activateWorkflow() / POST /api/workflows/[id]/lifecycle). Reference
  // audit confirmed no legitimate feature depends on these tools or on
  // deploy_queue's routing for them: the Founder-only Managed Setup admin
  // flow (app/api/admin/deploy/route.ts) makes its own direct n8n fetch()
  // calls, entirely independent of this agent tool-calling loop. Approve +
  // Deploy in the Builder is now a deterministic REST call
  // (components/builder/chat-interface.tsx), never a chat message these
  // tools could be invoked from.
  {
    type: 'function',
    function: {
      name: 'test_workflow',
      description:
        'Run a test execution of a deployed workflow to verify it works correctly. ' +
        'Returns execution status, logs, and any errors.',
      parameters: {
        type: 'object',
        required: ['workflow_id'],
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The n8n workflow ID to test',
          },
          trigger_node: {
            type: 'string',
            description: 'Optional: specific trigger node name to start from',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_credential',
      description:
        'Validate that an API key or credential is syntactically correct and optionally reachable. ' +
        'Call this when the user provides an API key before using it.',
      parameters: {
        type: 'object',
        required: ['provider', 'credential_value'],
        properties: {
          provider: {
            type: 'string',
            description: 'Credential provider: openai, groq, claude, shopify, gmail, slack, airtable',
          },
          credential_value: {
            type: 'string',
            description: 'The API key or credential string to validate',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_workflow_status',
      description:
        'Get the current status of a deployed workflow: active/inactive, last execution time, execution count.',
      parameters: {
        type: 'object',
        required: ['workflow_id'],
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The n8n workflow ID to check',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_execution_logs',
      description:
        'Fetch recent execution logs for a workflow to show what happened during runs.',
      parameters: {
        type: 'object',
        required: ['workflow_id'],
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The n8n workflow ID',
          },
          limit: {
            type: 'number',
            description: 'Number of recent executions to retrieve (default: 5)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_workflow_architecture',
      description:
        'Generate a clear, numbered step-by-step explanation of how the automation will work. ' +
        'Call this only when the user asks for explanation or when a quick summary is needed after generation.',
      parameters: {
        type: 'object',
        required: ['workflow_name', 'steps'],
        properties: {
          workflow_name: {
            type: 'string',
            description: 'Name of the automation',
          },
          steps: {
            type: 'array',
            description: 'Each step in the workflow execution flow',
            items: { type: 'string' },
          },
          integrations_required: {
            type: 'array',
            description: 'List of integrations/credentials needed',
            items: { type: 'string' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_credential',
      description:
        'Ask the user to provide a specific credential or API key needed for the workflow. ' +
        'This triggers the credential collection UI.',
      parameters: {
        type: 'object',
        required: ['provider', 'reason'],
        properties: {
          provider: {
            type: 'string',
            description: 'The provider needing credentials: openai, groq, claude, shopify, gmail, slack, airtable',
          },
          reason: {
            type: 'string',
            description: 'Why this credential is needed in plain language',
          },
          instructions: {
            type: 'string',
            description: 'How to get this credential (e.g. "Go to platform.openai.com → API Keys → Create new key")',
          },
        },
      },
    },
  },
];
