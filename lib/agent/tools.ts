/**
 * MagicFlux Autonomous Agent — Tool Definitions
 *
 * These are the OpenAI function-calling tool definitions.
 * The AI decides which tools to call, in which order, with which parameters.
 */

import type OpenAI from 'openai';

export type AgentTool = OpenAI.Chat.Completions.ChatCompletionTool;

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
            description: 'The trigger type: new_email, new_order, webhook, schedule, new_message, form_submit',
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
            description: 'Output destination if different from platform',
          },
          ai_provider: {
            type: 'string',
            description: 'AI provider to use for generation: openai, claude, groq, gemini',
          },
          schedule: {
            type: 'string',
            description: 'Schedule expression if time-triggered, e.g. "daily", "every monday 9am"',
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
              'examples (no platform involved): condition, set_field -- use these for branch-and-' +
              'assign automations like "if X then mark/classify/tag as Y".',
          },
          nodes_description: {
            type: 'string',
            description: 'Describe each node in the workflow in plain language',
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
