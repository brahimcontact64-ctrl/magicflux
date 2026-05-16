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
        'Returns workflow nodes, connections, and a human explanation of how it works.',
      parameters: {
        type: 'object',
        required: ['workflow_name', 'trigger', 'action', 'platform', 'nodes_description'],
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
            description: 'The primary action: auto_reply, send_slack_message, save_to_airtable, send_email, create_ticket, notify',
          },
          platform: {
            type: 'string',
            description: 'Main platform/integration: gmail, shopify, slack, airtable, instagram, whatsapp',
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
            description: 'Ordered workflow block hints from block composer, e.g. trigger_schedule, scraper, ai_reasoner, messaging_send',
          },
          nodes_description: {
            type: 'string',
            description: 'Describe each node in the workflow in plain language',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_workflow_to_n8n',
      description:
        'Deploy a generated workflow JSON to the local n8n instance. ' +
        'Call this after generate_workflow_json succeeds. ' +
        'Returns the workflow ID and URL.',
      parameters: {
        type: 'object',
        required: ['workflow_json', 'workflow_name'],
        properties: {
          workflow_json: {
            type: 'string',
            description: 'The stringified n8n workflow JSON to deploy',
          },
          workflow_name: {
            type: 'string',
            description: 'Name for the workflow',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'activate_workflow',
      description:
        'Activate a deployed workflow in n8n so it starts listening for triggers. ' +
        'Call this after deploy_workflow_to_n8n and credentials have been configured.',
      parameters: {
        type: 'object',
        required: ['workflow_id'],
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The n8n workflow ID to activate',
          },
        },
      },
    },
  },
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
