/**
 * AI Planner Engine
 * Converts natural language prompts into structured AutomationPlans.
 * Plans are deterministic + block-based — not hallucinated raw JSON.
 *
 * Flow: Prompt → PlannerIntent → AutomationPlan (Zod-validated) → BlockComposition
 */

import { z } from 'zod';
import { checkNodeCapability } from '@/lib/workflow-runtime/node-capabilities';
import {
  BLOCKS, PlacedBlock, BlockConnection, ComposedWorkflow,
  getBlocksByTags, collectEnvVars, collectDependencies, EnvVar, N8nNodePayload
} from '../blocks';
import {
  extractWorkflowCapabilities,
  buildWorkflowGrammar,
  resolveProvidersFromCapabilities,
  detectMissingRequirements,
  requestMissingRequirements,
  simulateWorkflow,
} from '@/lib/agent/capability-graph';
import type {
  WorkflowCapability,
  WorkflowGrammar,
  CapabilityResolverResult,
  RequirementCheckResult,
  MissingRequirement,
  SimulationResult,
  CapabilityGraphProvider,
} from '@/lib/agent/capability-graph';

// ─── PLAN TYPES ──────────────────────────────────────────────────────────────

export type TriggerType = 'webhook' | 'schedule' | 'shopify_order' | 'shopify_cart' | 'email' | 'manual';
export type ActionType = 'send_email' | 'slack_alert' | 'airtable_save' | 'airtable_fetch' | 'google_sheets' | 'shopify_update' | 'hubspot_contact' | 'sms' | 'http_call' | 'approval' | 'condition' | 'delay' | 'transform' | 'error_handler';

export interface PlannerStep {
  stepId: string;
  name: string;
  type: ActionType;
  description: string;
  blockId: string;
  required: boolean;
  dependsOn: string[];
}

export interface AutomationPlan {
  id: string;
  title: string;
  description: string;
  trigger: {
    type: TriggerType;
    blockId: string;
    description: string;
  };
  steps: PlannerStep[];
  integrations: string[];
  pattern: string;
  confidence: number;
  estimatedNodes: number;
  complexity: 'simple' | 'moderate' | 'complex';
  planReasoning: string;
  createdAt: string;
  // Extended fields (Phase 3.5)
  plannerModeUsed?: 'openai' | 'deterministic';
  assumptions?: string[];
  unsupportedRequirements?: string[];
  requiredCredentials?: string[];
  confidenceReason?: string;
}

// ── Capability Intelligence types ────────────────────────────────────────────

export type CapabilityIntelligenceResult = {
  extractedCapabilities: WorkflowCapability[];
  workflowGrammar: WorkflowGrammar;
  resolvedProviders: CapabilityResolverResult[];
  missingRequirements: RequirementCheckResult;
  simulation: SimulationResult;
  inferredIntegrations: string[];
};

export type DeploymentGateResult = {
  deploymentReady: boolean;
  missingRequirements: MissingRequirement[];
  userMessages: string[];
  simulation: SimulationResult;
  preservedResult: PlannerResult | null;
};

export interface PlannerResult {
  plan: AutomationPlan;
  composition: ComposedWorkflow;
  n8nJson: N8nWorkflow;
  envConfig: string;
  dependencies: ReturnType<typeof collectDependencies>;
  generationAdjusted?: boolean;
  generationWarning?: string;
  capabilityIntelligence?: CapabilityIntelligenceResult;
  proPlanner?: {
    intent: {
      trigger: { service: string; event: string; description: string };
      actions: Array<{ service: string; action: string; description: string }>;
      required_integrations: string[];
      forbidden_integrations: string[];
      assumptions: string[];
      confidence: number;
    };
    options: Array<{
      id: string;
      name: string;
      pros: string[];
      cons: string[];
      difficulty: number;
      reliability: number;
      requiredIntegrations: string[];
      estimatedSetupMinutes: number;
      score: number;
      reason: string;
    }>;
    recommendedOptionId: string;
    validation: {
      valid: boolean;
      checks: {
        intentMatch: boolean;
        requiredIntegrationsMatch: boolean;
        noForbiddenIntegrations: boolean;
        structureValid: boolean;
        connected: boolean;
        hasTrigger: boolean;
        hasAction: boolean;
      };
      detectedIntegrations: string[];
      errors: string[];
    };
    explanation: {
      whyChosen: string;
      nodeSummary: string[];
      credentialsNeeded: string[];
      userMustConfigure: string[];
      limitations: string[];
    };
  };
}

export type PlannerRejectionCode = 'CLARIFICATION_REQUIRED' | 'INCOMPLETE_INTENT' | 'UNSUPPORTED_REQUIREMENTS';

export class PlannerApiError extends Error {
  code: PlannerRejectionCode;
  mode?: 'clarification';
  missing?: Array<'trigger' | 'action' | 'data'>;
  questions?: string[];
  suggestions?: string[];
  examples?: string[];

  constructor(
    code: PlannerRejectionCode,
    message: string,
    extra?: {
      mode?: 'clarification';
      missing?: Array<'trigger' | 'action' | 'data'>;
      questions?: string[];
      suggestions?: string[];
      examples?: string[];
    }
  ) {
    super(message);
    this.name = 'PlannerApiError';
    this.code = code;
    this.mode = extra?.mode;
    this.missing = extra?.missing;
    this.questions = extra?.questions;
    this.suggestions = extra?.suggestions;
    this.examples = extra?.examples;
  }
}

// ─── n8n WORKFLOW TYPES ──────────────────────────────────────────────────────

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
  active: boolean;
  settings: { executionOrder: string };
  versionId: string;
}

// ─── ZOD SCHEMAS ─────────────────────────────────────────────────────────────

const PlannerStepSchema = z.object({
  stepId: z.string(),
  name: z.string(),
  type: z.enum(['send_email', 'slack_alert', 'airtable_save', 'airtable_fetch', 'google_sheets', 'shopify_update', 'hubspot_contact', 'sms', 'http_call', 'approval', 'condition', 'delay', 'transform', 'error_handler']),
  description: z.string(),
  blockId: z.string(),
  required: z.boolean(),
  dependsOn: z.array(z.string())
});

const AutomationPlanSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  trigger: z.object({
    type: z.enum(['webhook', 'schedule', 'shopify_order', 'shopify_cart', 'email', 'manual']),
    blockId: z.string().min(1),
    description: z.string()
  }),
  steps: z.array(PlannerStepSchema).min(1, 'Workflow must have at least one step'),
  integrations: z.array(z.string()),
  pattern: z.string(),
  confidence: z.number().min(0).max(100),
  estimatedNodes: z.number().min(1),
  complexity: z.enum(['simple', 'moderate', 'complex']),
  planReasoning: z.string(),
  createdAt: z.string(),
  plannerModeUsed: z.enum(['openai', 'deterministic']).optional(),
  assumptions: z.array(z.string()).optional(),
  unsupportedRequirements: z.array(z.string()).optional(),
  requiredCredentials: z.array(z.string()).optional(),
  confidenceReason: z.string().optional()
});

/** JSON Schema representation for use in OpenAI structured output.
 *  Exported so the API route can reference it without importing Zod. */
export const BLOCK_IDS = Object.keys(
  // We cannot import BLOCKS here directly in the schema export due to module init order,
  // so this is populated at call time. See openAIPlannerSchema() helper below.
  {} as Record<string, unknown>
);

/** Build the OpenAI function parameters schema using the live BLOCKS registry. */
export function buildOpenAIPlannerSchema(blockIds: string[]): Record<string, unknown> {
  const triggerTypes = ['webhook', 'schedule', 'shopify_order', 'shopify_cart', 'email', 'manual'];
  const actionTypes = ['send_email', 'slack_alert', 'airtable_save', 'airtable_fetch', 'google_sheets', 'shopify_update', 'hubspot_contact', 'sms', 'http_call', 'approval', 'condition', 'delay', 'transform', 'error_handler'];

  return {
    type: 'object',
    properties: {
      title:       { type: 'string', description: 'Short workflow title (3-6 words)' },
      description: { type: 'string', description: 'One-sentence description of what this workflow does' },
      pattern:     { type: 'string', description: 'Workflow pattern name (e.g. Order Processing, Intake & Log)' },
      trigger: {
        type: 'object',
        properties: {
          type:        { type: 'string', enum: triggerTypes, description: 'Trigger type' },
          blockId:     { type: 'string', enum: blockIds, description: 'Block ID from the approved registry' },
          description: { type: 'string', description: 'What triggers this workflow' }
        },
        required: ['type', 'blockId', 'description'],
        additionalProperties: false
      },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            stepId:      { type: 'string', description: 'Unique step identifier e.g. step_0, step_1' },
            name:        { type: 'string', description: 'Human-readable step name' },
            type:        { type: 'string', enum: actionTypes, description: 'Action type' },
            description: { type: 'string', description: 'What this step does' },
            blockId:     { type: 'string', enum: blockIds, description: 'Block ID from the approved registry' },
            required:    { type: 'boolean', description: 'Whether this step is required for the workflow to work' },
            dependsOn:   { type: 'array', items: { type: 'string' }, description: 'List of stepIds this step depends on' }
          },
          required: ['stepId', 'name', 'type', 'description', 'blockId', 'required', 'dependsOn'],
          additionalProperties: false
        },
        description: 'Ordered list of workflow steps'
      },
      integrations:            { type: 'array', items: { type: 'string' }, description: 'External services used (e.g. Shopify, Slack)' },
      confidence:              { type: 'number', minimum: 0, maximum: 100, description: 'How confident you are this plan is correct (0-100)' },
      complexity:              { type: 'string', enum: ['simple', 'moderate', 'complex'], description: 'Workflow complexity' },
      planReasoning:           { type: 'string', description: 'Explanation of why this plan was chosen' },
      assumptions:             { type: 'array', items: { type: 'string' }, description: 'Assumptions made about the user intent' },
      unsupportedRequirements: { type: 'array', items: { type: 'string' }, description: 'Parts of the request that cannot be fulfilled with available blocks' },
      requiredCredentials:     { type: 'array', items: { type: 'string' }, description: 'Credential names needed (e.g. Shopify API, Slack API)' },
      confidenceReason:        { type: 'string', description: 'Why confidence is at this level' }
    },
    required: ['title', 'description', 'pattern', 'trigger', 'steps', 'integrations', 'confidence', 'complexity', 'planReasoning', 'assumptions', 'unsupportedRequirements', 'requiredCredentials', 'confidenceReason'],
    additionalProperties: false
  };
}

function validatePlan(plan: AutomationPlan): void {
  const result = AutomationPlanSchema.safeParse(plan);
  if (!result.success) {
    const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid AutomationPlan: ${msg}`);
  }
  // Block ID cross-check
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];
  for (const id of allBlockIds) {
    if (!BLOCKS[id]) {
      throw new Error(`AutomationPlan references unknown block "${id}". Only registry blocks are permitted.`);
    }
  }
}

// ─── CAPABILITY INTELLIGENCE ─────────────────────────────────────────────────

const PROVIDER_INTEGRATION_NAMES: Record<string, string> = {
  telegram:      'Telegram',
  whatsapp:      'WhatsApp',
  slack:         'Slack',
  gmail:         'Gmail / SMTP',
  google_drive:  'Google Drive',
  google_sheets: 'Google Sheets',
  google_calendar: 'Google Calendar',
  stripe:        'Stripe',
  shopify:       'Shopify',
  hubspot:       'HubSpot',
  airtable:      'Airtable',
  supabase:      'Supabase',
  notion:        'Notion',
  openai:        'OpenAI',
  claude:        'Claude AI',
  cloudflare_ai: 'Cloudflare AI',
  elevenlabs:    'ElevenLabs',
  deepgram:      'Deepgram',
  canva:         'Canva',
  facebook:      'Facebook',
  twitter:       'X (Twitter)',
};

function providerToIntegrationName(provider: CapabilityGraphProvider | string): string {
  return PROVIDER_INTEGRATION_NAMES[provider] ?? provider;
}

function mergeInferredIntegrations(existing: string[], inferred: string[]): string[] {
  const result = [...existing];
  const existingLower = existing.map(s => s.toLowerCase());
  for (const item of inferred) {
    const itemLower = item.toLowerCase();
    const alreadyCovered = existingLower.some(
      e => e.includes(itemLower) || itemLower.includes(e),
    );
    if (!alreadyCovered) result.push(item);
  }
  return result;
}

function enrichWithCapabilityIntelligence(
  prompt: string,
  installedProviders: Set<string> = new Set(),
): CapabilityIntelligenceResult {
  const extractedCapabilities = extractWorkflowCapabilities(prompt);
  const workflowGrammar = buildWorkflowGrammar(prompt);
  const resolvedProviders = resolveProvidersFromCapabilities(extractedCapabilities);
  const missingRequirements = detectMissingRequirements(workflowGrammar, installedProviders);
  const simulation = simulateWorkflow(workflowGrammar, installedProviders);

  const allGrammarProviders: string[] = [
    ...workflowGrammar.trigger,
    ...workflowGrammar.action,
    ...workflowGrammar.storage,
    ...workflowGrammar.notification,
    ...workflowGrammar.transform,
    ...workflowGrammar.condition,
  ];
  const inferredIntegrations = [...new Set(allGrammarProviders)]
    .map(p => providerToIntegrationName(p))
    .filter(Boolean);

  return {
    extractedCapabilities,
    workflowGrammar,
    resolvedProviders,
    missingRequirements,
    simulation,
    inferredIntegrations,
  };
}

// ─── INTENT SIGNALS ──────────────────────────────────────────────────────────

const TRIGGER_SIGNALS: Record<TriggerType, string[]> = {
  webhook: ['webhook', 'form', 'submit', 'http', 'api call', 'request', 'when someone', 'intake'],
  schedule: ['daily', 'weekly', 'monthly', 'every day', 'every week', 'every month', 'cron', 'scheduled', 'automatically', 'recurring', '1st of', 'remind', 'every morning', 'morning', 'each day', 'each morning', 'each week', 'every night', 'nightly', 'hourly', 'every hour'],
  shopify_order: ['new order', 'order placed', 'shopify order', 'purchase', 'fulfillment', 'sold'],
  shopify_cart: ['abandoned cart', 'cart recovery', 'cart abandoned', 'checkout abandoned'],
  email: ['email received', 'when email', 'incoming email', 'email trigger'],
  manual: ['manual', 'on demand', 'button', 'run when']
};

const ACTION_SIGNALS: Record<ActionType, string[]> = {
  send_email: ['email', 'send email', 'gmail', 'notify email', 'confirmation', 'reminder', 'message', 'notification', 'notify', 'alert email', 'send notification'],
  slack_alert: ['slack', 'slack alert', 'slack message', 'slack notification', 'channel'],
  airtable_save: ['airtable', 'save to airtable', 'log to airtable', 'store', 'record', 'database'],
  airtable_fetch: ['fetch from airtable', 'get tenants', 'retrieve from airtable', 'pull from airtable'],
  google_sheets: ['google sheets', 'spreadsheet', 'sheets', 'log to sheets', 'excel'],
  shopify_update: ['update order', 'tag order', 'shopify update', 'mark fulfilled'],
  hubspot_contact: ['hubspot', 'crm', 'contact', 'lead', 'pipeline'],
  sms: ['sms', 'text message', 'twilio', 'whatsapp', 'phone'],
  http_call: ['webhook call', 'http request', 'api call', 'post to'],
  approval: ['approval', 'approve', 'review step', 'manager approval', 'sign off', 'human review'],
  condition: ['if', 'branch', 'conditional', 'depending on', 'check if', 'filter'],
  delay: ['wait', 'delay', 'pause', 'after', 'timer', 'hours later', 'days later'],
  transform: ['parse', 'transform', 'format', 'extract', 'process'],
  error_handler: ['error handling', 'catch error', 'on failure', 'error alert', 'error notification']
};

// ACTION → block ID mapping
const ACTION_TO_BLOCK: Record<ActionType, string> = {
  send_email: 'send_email_smtp',
  slack_alert: 'slack_message',
  airtable_save: 'airtable_create',
  airtable_fetch: 'airtable_search',
  google_sheets: 'google_sheets_append',
  shopify_update: 'shopify_update_order',
  hubspot_contact: 'hubspot_create_contact',
  sms: 'twilio_sms',
  http_call: 'http_request',
  approval: 'approval_node',
  condition: 'if_condition',
  delay: 'wait_delay',
  transform: 'code_transform',
  error_handler: 'error_handler'
};

const TRIGGER_TO_BLOCK: Record<TriggerType, string> = {
  webhook: 'webhook_trigger',
  schedule: 'schedule_trigger',
  shopify_order: 'shopify_order_trigger',
  shopify_cart: 'shopify_abandoned_cart_trigger',
  email: 'webhook_trigger',
  manual: 'webhook_trigger'
};

// ─── PATTERN LIBRARY ─────────────────────────────────────────────────────────

interface WorkflowPattern {
  id: string;
  name: string;
  triggerTypes: TriggerType[];
  requiredActions: ActionType[];
  optionalActions: ActionType[];
  keywords: string[];
  description: string;
}

const PATTERNS: WorkflowPattern[] = [
  {
    id: 'scheduled_report',
    name: 'Scheduled Report',
    triggerTypes: ['schedule'],
    // Only transform is technically required — all outputs are prompt-driven
    requiredActions: ['transform'],
    optionalActions: ['http_call', 'google_sheets', 'slack_alert', 'send_email', 'airtable_save'],
    keywords: ['morning', 'daily', 'send', 'report', 'yesterday', 'weekly', 'summary', 'every'],
    description: 'Run a scheduled job and push data to one or more destinations'
  },
  {
    id: 'notification_blast',
    name: 'Scheduled Notification',
    triggerTypes: ['schedule'],
    requiredActions: ['transform'],
    optionalActions: ['airtable_fetch', 'send_email', 'slack_alert', 'google_sheets', 'sms'],
    keywords: ['reminder', 'notify', 'blast', 'tenant', 'monthly', 'remind'],
    description: 'Fetch records on a schedule and send personalized notifications'
  },
  {
    id: 'intake_and_log',
    name: 'Intake & Log',
    triggerTypes: ['webhook'],
    requiredActions: ['transform'],
    optionalActions: ['airtable_save', 'send_email', 'slack_alert', 'hubspot_contact', 'approval', 'google_sheets'],
    keywords: ['intake', 'form', 'submit', 'inquiry', 'request', 'maintenance', 'ticket'],
    description: 'Receive submissions, save to database, send confirmations'
  },
  {
    id: 'order_processing',
    name: 'Order Processing',
    triggerTypes: ['shopify_order'],
    requiredActions: ['transform'],
    optionalActions: ['send_email', 'slack_alert', 'shopify_update', 'airtable_save', 'google_sheets'],
    keywords: ['order', 'shopify', 'purchase', 'fulfillment', 'customer'],
    description: 'Process Shopify orders with notifications and updates'
  },
  {
    id: 'cart_recovery',
    name: 'Cart Recovery Sequence',
    triggerTypes: ['shopify_cart'],
    requiredActions: ['transform', 'delay', 'send_email'],
    optionalActions: ['sms', 'slack_alert'],
    keywords: ['abandoned', 'cart', 'recovery', 'discount'],
    description: 'Multi-touch email sequence for abandoned shopping carts'
  },
  {
    id: 'guest_messaging',
    name: 'Guest Messaging',
    triggerTypes: ['webhook'],
    requiredActions: ['transform'],
    optionalActions: ['send_email', 'slack_alert', 'airtable_save', 'delay', 'sms'],
    keywords: ['guest', 'airbnb', 'booking', 'checkin', 'checkout', 'welcome', 'cleaner', 'cleaning'],
    description: 'Automated guest communication for short-term rentals'
  },
  {
    id: 'approval_workflow',
    name: 'Approval Workflow',
    triggerTypes: ['webhook'],
    requiredActions: ['transform', 'approval'],
    optionalActions: ['condition', 'send_email', 'slack_alert', 'airtable_save'],
    keywords: ['approval', 'approve', 'review', 'manager', 'sign off'],
    description: 'Human-in-the-loop approval with branch on decision'
  },
  {
    id: 'crm_ingestion',
    name: 'CRM Lead Ingestion',
    triggerTypes: ['webhook'],
    requiredActions: ['transform'],
    optionalActions: ['hubspot_contact', 'send_email', 'slack_alert', 'airtable_save'],
    keywords: ['lead', 'crm', 'contact', 'inquiry', 'leasing', 'prospect'],
    description: 'Capture inbound leads and push to CRM with follow-up'
  }
];

// ─── UNSUPPORTED REQUIREMENT DETECTION ──────────────────────────────────────

/**
 * Keywords that signal capabilities we cannot fulfill — no block exists for these.
 * Each entry has a display label and the keywords that trigger it.
 */
const UNSUPPORTED_SIGNALS: Array<{ label: string; keywords: string[] }> = [
  { label: 'WhatsApp Business API (native bot messaging)', keywords: ['whatsapp bot', 'whatsapp business', 'whatsapp api', 'whatsapp message'] },
  { label: 'Voice cloning or text-to-speech generation', keywords: ['voice cloning', 'voice clone', 'voice synthesis', 'text to speech', 'tts', 'elevenlabs', 'speech synthesis'] },
  { label: 'Bank payments or direct payment processing', keywords: ['bank payment', 'bank transfer', 'wire transfer', 'ach payment', 'plaid', 'open banking', 'bank api'] },
  { label: 'Stripe payments (requires separate Stripe integration)', keywords: ['stripe', 'stripe payment', 'credit card payment', 'payment processing', 'charge card'] },
  { label: 'Cryptocurrency or blockchain transactions', keywords: ['crypto', 'blockchain', 'bitcoin', 'ethereum', 'web3', 'nft', 'defi', 'smart contract'] },
  { label: 'AI/LLM generation (GPT, Claude, etc.)', keywords: ['gpt', 'openai', 'chatgpt', 'llm', 'large language model', 'ai generation', 'ai write', 'claude api', 'generate with ai'] },
  { label: 'Instagram or Facebook messaging', keywords: ['instagram dm', 'facebook messenger', 'instagram bot', 'meta api'] },
  { label: 'Airbnb native API (use webhook trigger instead)', keywords: ['airbnb api', 'airbnb webhook', 'airbnb native'] },
  { label: 'Zapier or Make.com native integration', keywords: ['zapier', 'make.com', 'integromat'] },
  { label: 'Video processing or generation', keywords: ['video generation', 'video editing', 'video processing', 'ffmpeg'] },
];

function detectUnsupportedRequirements(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const found: string[] = [];
  for (const { label, keywords } of UNSUPPORTED_SIGNALS) {
    if (keywords.some(kw => normalized.includes(kw))) {
      found.push(label);
    }
  }
  return found;
}

/** External-system keywords that require the user to configure a webhook on their end */
const EXTERNAL_WEBHOOK_SIGNALS = [
  'airbnb', 'booking.com', 'vrbo', 'homeaway', 'tripadvisor',
  'pms', 'property management', 'guesty', 'hostaway', 'lodgify',
  'marketplace', 'external system', 'third-party system'
];

function detectExternalWebhookAssumptions(prompt: string, trigger: TriggerType): string[] {
  if (trigger !== 'webhook') return [];
  const normalized = prompt.toLowerCase();
  const matched = EXTERNAL_WEBHOOK_SIGNALS.filter(s => normalized.includes(s));
  if (matched.length === 0) return [];
  return [
    `This requires configuring an external webhook from your ${matched.slice(0, 2).join(' / ')} system into n8n. There is no native ${matched[0]} trigger — you must set up webhook delivery in your booking or PMS platform to point to the n8n webhook URL generated after import.`
  ];
}

// ─── PLANNER ENGINE ──────────────────────────────────────────────────────────

function detectTrigger(prompt: string): TriggerType | null {
  const normalized = prompt.toLowerCase();
  for (const [type, signals] of Object.entries(TRIGGER_SIGNALS) as [TriggerType, string[]][]) {
    if (signals.some(s => normalized.includes(s))) return type;
  }
  return null;
}

function detectActions(prompt: string): ActionType[] {
  const normalized = prompt.toLowerCase();
  const detected: ActionType[] = [];

  for (const [action, signals] of Object.entries(ACTION_SIGNALS) as [ActionType, string[]][]) {
    if (signals.some(s => normalized.includes(s))) {
      detected.push(action);
    }
  }

  return detected;
}

function detectIntegrations(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const found: string[] = [];
  const checks: [string, string[]][] = [
    ['Shopify', ['shopify', 'order', 'cart', 'store']],
    ['Slack', ['slack']],
    ['Gmail / SMTP', ['email', 'gmail', 'smtp']],
    ['Airtable', ['airtable']],
    ['Google Sheets', ['google sheets', 'sheets', 'spreadsheet']],
    ['HubSpot', ['hubspot', 'crm']],
    ['Twilio', ['sms', 'twilio', 'whatsapp']],
    ['HTTP / Webhook', ['webhook', 'http', 'api']],
  ];
  for (const [name, signals] of checks) {
    if (signals.some(s => normalized.includes(s))) found.push(name);
  }
  return found;
}

function matchPattern(prompt: string, trigger: TriggerType, actions: ActionType[]): WorkflowPattern {
  const normalized = prompt.toLowerCase();

  let bestPattern = PATTERNS[0];
  let bestScore = 0;

  for (const pattern of PATTERNS) {
    let score = 0;

    if (pattern.triggerTypes.includes(trigger)) score += 5;

    for (const kw of pattern.keywords) {
      if (normalized.includes(kw)) score += 3;
    }

    for (const action of actions) {
      if (pattern.requiredActions.includes(action)) score += 2;
      if (pattern.optionalActions.includes(action)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPattern = pattern;
    }
  }

  return bestPattern;
}

function buildPlanSteps(pattern: WorkflowPattern, detectedActions: ActionType[]): PlannerStep[] {
  const steps: PlannerStep[] = [];
  const seen = new Set<ActionType>();
  const actionList: ActionType[] = [];

  // transform is always first — technically required to normalise upstream data
  actionList.push('transform');
  seen.add('transform');

  // Only add other pattern.requiredActions if the prompt also detected them.
  // This prevents pattern-injected steps the user never asked for.
  // Exception: cart_recovery delay+email pair is a coherent unit that requires both.
  for (const a of pattern.requiredActions) {
    if (a === 'transform') continue;
    if (detectedActions.includes(a) && !seen.has(a)) {
      actionList.push(a);
      seen.add(a);
    }
  }

  // Add all remaining detected actions (not transform, not already added)
  for (const a of detectedActions) {
    if (a !== 'transform' && !seen.has(a)) {
      actionList.push(a);
      seen.add(a);
    }
  }

  // Add optional pattern actions only if the prompt detected them
  for (const opt of pattern.optionalActions) {
    if (detectedActions.includes(opt) && !seen.has(opt)) {
      actionList.push(opt);
      seen.add(opt);
    }
  }

  let stepNum = 0;
  let prevStepId = '';

  for (const action of actionList) {
    const blockId = ACTION_TO_BLOCK[action];
    const block = BLOCKS[blockId];
    if (!block) continue;

    const stepId = `step_${stepNum}`;
    steps.push({
      stepId,
      name: block.name,
      type: action,
      description: block.description,
      blockId,
      // A step is marked required only when pattern explicitly requires it AND prompt asked for it
      required: pattern.requiredActions.includes(action) && detectedActions.includes(action),
      dependsOn: prevStepId ? [prevStepId] : []
    });

    prevStepId = stepId;
    stepNum++;
  }

  return steps;
}

function computeComplexity(stepCount: number): AutomationPlan['complexity'] {
  if (stepCount <= 3) return 'simple';
  if (stepCount <= 6) return 'moderate';
  return 'complex';
}

function generatePlanReasoning(
  plan: Omit<AutomationPlan, 'planReasoning' | 'createdAt' | 'id'>,
  prompt: string
): string {
  const triggerDesc: Record<TriggerType, string> = {
    webhook: 'a webhook trigger to receive incoming requests',
    schedule: 'a scheduled trigger to run automatically at set intervals',
    shopify_order: 'a Shopify new order webhook trigger',
    shopify_cart: 'a Shopify abandoned cart trigger',
    email: 'an email-based trigger',
    manual: 'a manual execution trigger'
  };

  const lines = [
    `Based on your prompt, I've designed a **${plan.pattern}** using ${triggerDesc[plan.trigger.type]}.`,
    `The workflow has ${plan.estimatedNodes} nodes: ${plan.steps.map(s => s.name).join(' → ')}.`,
    plan.integrations.length > 0
      ? `Integrations required: ${plan.integrations.join(', ')}.`
      : 'No external integrations required.',
    plan.complexity === 'complex'
      ? 'This is a complex workflow with multiple branches and conditions.'
      : `This is a ${plan.complexity} workflow, straightforward to deploy.`
  ];

  return lines.join(' ');
}

// ─── COMPOSE FROM PLAN ────────────────────────────────────────────────────────

function composeFromPlan(plan: AutomationPlan): ComposedWorkflow {
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];
  const placedBlocks: PlacedBlock[] = [];
  const connections: BlockConnection[] = [];

  let x = 100;
  const y = 300;
  const stepX = 250;

  const triggerBlock = BLOCKS[plan.trigger.blockId];
  if (triggerBlock) {
    placedBlocks.push({
      instanceId: `trigger_0`,
      blockId: plan.trigger.blockId,
      block: triggerBlock,
      position: [x, y],
      params: {}
    });
    x += stepX;
  }

  // Determine context hint for code_transform based on trigger type
  const codeContext =
    plan.trigger.type === 'shopify_order' ? 'shopify_order' :
    plan.trigger.type === 'shopify_cart' ? 'abandoned_cart' :
    'generic';

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const block = BLOCKS[step.blockId];
    if (!block) continue;

    placedBlocks.push({
      instanceId: `step_${i}`,
      blockId: step.blockId,
      block,
      position: [x, y],
      // Pass context hint to code_transform blocks so they generate relevant JS
      params: step.blockId === 'code_transform' ? { context: codeContext } : {}
    });

    connections.push({
      fromInstanceId: i === 0 ? 'trigger_0' : `step_${i - 1}`,
      fromPort: 0,
      toInstanceId: `step_${i}`,
      toPort: 0
    });

    x += stepX;
  }

  const envVars = collectEnvVars(allBlockIds);

  return {
    id: plan.id,
    name: plan.title,
    description: plan.description,
    blocks: placedBlocks,
    connections,
    envVars,
    createdAt: plan.createdAt
  };
}

// ─── n8n JSON BUILDER ────────────────────────────────────────────────────────

/**
 * Build n8n workflow JSON from composition using each block's buildN8nNode().
 * Every node is registry-sourced — no generic parameter guessing.
 */
function buildN8nWorkflow(plan: AutomationPlan, composition: ComposedWorkflow): N8nWorkflow {
  const nodes: N8nNode[] = [];

  // First pass: build instanceId → node name map so connections use names, not instanceIds.
  // n8n requires connection keys and node references to be node NAME strings, not internal IDs.
  const instanceToName: Record<string, string> = {};
  for (const placed of composition.blocks) {
    const payload = placed.block.buildN8nNode(
      placed.instanceId,
      placed.position,
      placed.params as Record<string, unknown>
    );
    instanceToName[placed.instanceId] = payload.name;
  }

  // Build next-node map using names (not instanceIds)
  const nextMap: Record<string, string[]> = {};
  for (const conn of composition.connections) {
    const fromName = instanceToName[conn.fromInstanceId];
    const toName = instanceToName[conn.toInstanceId];
    if (!fromName || !toName) continue;
    if (!nextMap[fromName]) nextMap[fromName] = [];
    nextMap[fromName].push(toName);
  }

  const mergedConnections: N8nWorkflow['connections'] = {};

  // Second pass: build node payloads and connections keyed by node name
  for (const placed of composition.blocks) {
    const payload: N8nNodePayload = placed.block.buildN8nNode(
      placed.instanceId,
      placed.position,
      placed.params as Record<string, unknown>
    );

    nodes.push({
      id: payload.id,
      name: payload.name,
      type: payload.type,
      typeVersion: payload.typeVersion,
      position: payload.position,
      parameters: payload.parameters,
      credentials: payload.credentials
    });

    const toNames = nextMap[payload.name] ?? [];
    // Pass node NAME as fromId so connection keys are names n8n can resolve
    const connEntry = placed.block.buildConnections(payload.name, toNames);
    Object.assign(mergedConnections, connEntry);
  }

  return {
    name: plan.title,
    nodes,
    connections: mergedConnections,
    active: false,
    settings: { executionOrder: 'v1' },
    versionId: plan.id
  };
}

function buildEnvConfig(plan: AutomationPlan, envVars: EnvVar[]): string {
  const lines = [
    `# MagicFlux — Generated Environment Config`,
    `# Workflow: ${plan.title}`,
    `# Generated: ${plan.createdAt}`,
    `# ==========================================`,
    ''
  ];

  const grouped: Record<string, EnvVar[]> = {};
  for (const v of envVars) {
    const group = v.key.split('_')[0] || 'GENERAL';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(v);
  }

  for (const [group, vars] of Object.entries(grouped)) {
    lines.push(`# ${group} Configuration`);
    for (const v of vars) {
      lines.push(`# ${v.description}`);
      lines.push(`${v.key}=${v.example || 'your_value_here'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Capability gate (Phase 9.1.6) ───────────────────────────────────────────
//
// Invariant: MagicFlux must never generate a workflow containing a node the
// certified runtime cannot actually execute. Checked here, right after the
// final n8nJson is assembled, against the SAME single source of truth the
// validator and runtime dispatch use (lib/workflow-runtime/node-capabilities.ts)
// — so planner generation can never drift from what activation will later
// accept. UNSUPPORTED_REQUIREMENTS is the existing error-code convention
// this file (and /api/planner's error handling) already uses for "this
// automation cannot be built with current capabilities" — no new error
// contract needed, and the message is the capability's own user-safe
// explanation, never a raw node type or internal handler name.
function assertNodesAreCapable(n8nJson: N8nWorkflow): void {
  const nodes = n8nJson?.nodes ?? [];
  const blocked: string[] = [];

  for (const node of nodes) {
    const capability = checkNodeCapability({ type: node.type, parameters: node.parameters });
    if (!capability.capable) blocked.push(capability.userMessage);
  }

  if (blocked.length > 0) {
    throw new Error(`UNSUPPORTED_REQUIREMENTS: This automation needs a capability that isn't available yet: ${[...new Set(blocked)].join(' ')}`);
  }
}

// ─── MAIN PLANNER FUNCTION ───────────────────────────────────────────────────

/**
 * Deterministic keyword-based planner.
 * Always synchronous, never calls external APIs, used as fallback when OpenAI is unavailable.
 */
export function createAutomationPlan(
  prompt: string,
  modeOverride?: AutomationPlan['plannerModeUsed'],
  installedProviders?: Set<string>,
): PlannerResult {
  const trigger = detectTrigger(prompt);
  if (!trigger) {
    throw new Error('INCOMPLETE_INTENT: Missing trigger. Describe when the workflow should run.');
  }

  const actions = detectActions(prompt);
  if (actions.length === 0) {
    throw new Error('INCOMPLETE_INTENT: Missing action. Describe what the workflow should do.');
  }

  const integrations = detectIntegrations(prompt);
  const pattern = matchPattern(prompt, trigger, actions);
  const steps = buildPlanSteps(pattern, actions);
  const unsupportedRequirements = detectUnsupportedRequirements(prompt);
  if (unsupportedRequirements.length > 0) {
    throw new Error('UNSUPPORTED_REQUIREMENTS: This automation cannot be built with current capabilities.');
  }

  if (steps.length === 0) {
    throw new Error('INCOMPLETE_INTENT: Missing action. Describe at least one executable action.');
  }

  const capabilityIntelligence = enrichWithCapabilityIntelligence(prompt, installedProviders);
  const mergedIntegrations = mergeInferredIntegrations(integrations, capabilityIntelligence.inferredIntegrations);

  const totalNodes = 1 + steps.length;
  const triggerBlockId = TRIGGER_TO_BLOCK[trigger];

  const planId = `plan_${Date.now()}`;
  const createdAt = new Date().toISOString();

  const normalizedPrompt = prompt.toLowerCase();
  const hasExplicitSequence = normalizedPrompt.includes('when') || normalizedPrompt.includes('every') || normalizedPrompt.includes('if');
  const confidence = Math.min(97, 70 + steps.length * 4 + integrations.length * 3 + (hasExplicitSequence ? 10 : 0));
  if (confidence < 85) {
    throw new Error('CLARIFICATION_REQUIRED: Please provide a clearer trigger and action.');
  }

  const planBase = {
    title: pattern.name,
    description: pattern.description,
    trigger: {
      type: trigger,
      blockId: triggerBlockId,
      description: BLOCKS[triggerBlockId]?.description || 'Trigger'
    },
    steps,
    integrations: mergedIntegrations,
    pattern: pattern.name,
    confidence,
    estimatedNodes: totalNodes,
    complexity: computeComplexity(totalNodes)
  };

  const plan: AutomationPlan = {
    id: planId,
    ...planBase,
    planReasoning: '',
    createdAt,
    plannerModeUsed: modeOverride ?? 'deterministic',
    assumptions: detectExternalWebhookAssumptions(prompt, trigger),
    unsupportedRequirements: [],
    requiredCredentials: mergedIntegrations,
    confidenceReason: 'Strict intent match and capability validation passed.'
  };

  plan.planReasoning = generatePlanReasoning(planBase, prompt);

  validatePlan(plan);

  const composition = composeFromPlan(plan);
  const n8nJson = buildN8nWorkflow(plan, composition);
  assertNodesAreCapable(n8nJson);
  const envVars = collectEnvVars([triggerBlockId, ...steps.map(s => s.blockId)]);
  const dependencies = collectDependencies([triggerBlockId, ...steps.map(s => s.blockId)]);
  const envConfig = buildEnvConfig(plan, envVars);

  return { plan, composition, n8nJson, envConfig, dependencies, capabilityIntelligence };
}

/**
 * Assemble a PlannerResult from an OpenAI-returned plan object.
 * Called by /api/planner after validating the structured output.
 * Throws if the plan references any unknown block IDs.
 */
export function assemblePlannerResult(
  rawPlan: Omit<AutomationPlan, 'id' | 'createdAt' | 'estimatedNodes'>,
  installedProviders?: Set<string>,
): PlannerResult {
  const planId = `plan_${Date.now()}`;
  const createdAt = new Date().toISOString();

  const plan: AutomationPlan = {
    ...rawPlan,
    id: planId,
    createdAt,
    estimatedNodes: 1 + rawPlan.steps.length,
    plannerModeUsed: 'openai'
  };

  // Strict validation — blocks must exist in registry
  validatePlan(plan);

  const composition = composeFromPlan(plan);
  const n8nJson = buildN8nWorkflow(plan, composition);
  assertNodesAreCapable(n8nJson);
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];
  const envVars = collectEnvVars(allBlockIds);
  const dependencies = collectDependencies(allBlockIds);
  const envConfig = buildEnvConfig(plan, envVars);

  const descriptionPrompt = [rawPlan.title, rawPlan.description, ...(rawPlan.integrations ?? [])].join(' ');
  const capabilityIntelligence = enrichWithCapabilityIntelligence(descriptionPrompt, installedProviders);

  return { plan, composition, n8nJson, envConfig, dependencies, capabilityIntelligence };
}

export function checkDeploymentGate(
  prompt: string,
  result: PlannerResult | null,
  installedProviders?: Set<string>,
): DeploymentGateResult {
  const intelligence = result?.capabilityIntelligence
    ?? enrichWithCapabilityIntelligence(prompt, installedProviders);

  const simulation = intelligence.simulation;
  const missingRequirements = intelligence.missingRequirements.missing;
  const userMessages = requestMissingRequirements(intelligence.missingRequirements);

  return {
    deploymentReady: simulation.deploymentReady && missingRequirements.length === 0,
    missingRequirements,
    userMessages,
    simulation,
    preservedResult: result,
  };
}

/**
 * Async planner entry point for client-side use.
 * Calls /api/planner which handles OpenAI or deterministic mode server-side.
 * Falls back to deterministic inline if the API call fails (e.g. network error).
 *
 * The plannerModeUsed field on the returned plan indicates which path was taken:
 *   'openai'        → OpenAI structured output used
 *   'deterministic' → keyword planner used (AI_PLANNER_MODE != openai)
 */
export async function createAutomationPlanAsync(prompt: string): Promise<PlannerResult> {
  try {
    const res = await fetch('/api/planner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    const data = await res.json().catch(() => null) as {
      success?: boolean;
      result?: PlannerResult;
      error?: string;
      message?: string;
      mode?: 'clarification';
      missing?: Array<'trigger' | 'action' | 'data'>;
      questions?: string[];
      suggestions?: string[];
      examples?: string[];
      generationAdjusted?: boolean;
      generationWarning?: string;
      proPlanner?: PlannerResult['proPlanner'];
    } | null;

    if (!res.ok) {
      const code = data?.error;
      const message = data?.message ?? data?.error ?? `Planner API returned ${res.status}`;
      if (code === 'CLARIFICATION_REQUIRED' || code === 'INCOMPLETE_INTENT' || code === 'UNSUPPORTED_REQUIREMENTS') {
        throw new PlannerApiError(code, message, {
          mode: data?.mode,
          missing: data?.missing,
          questions: data?.questions,
          suggestions: data?.suggestions,
          examples: data?.examples,
        });
      }
      throw new Error(message);
    }

    if (data?.success && data.result) {
      const result = data.result as PlannerResult;
      result.generationAdjusted = data.generationAdjusted;
      result.generationWarning = data.generationWarning;
      result.proPlanner = data.proPlanner ?? result.proPlanner;
      return result;
    }

    throw new Error(data?.error ?? 'Planner API returned no result');
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Planner request failed');
  }
}

export function modifyPlan(
  current: PlannerResult,
  modification: string
): PlannerResult {
  const normalized = modification.toLowerCase();

  let updatedPlan = { ...current.plan };
  const existingBlockIds = new Set(current.plan.steps.map(s => s.blockId));

  // Add Slack
  if (normalized.includes('slack') && !existingBlockIds.has('slack_message')) {
    updatedPlan.steps = [
      ...updatedPlan.steps,
      {
        stepId: `step_${updatedPlan.steps.length}`,
        name: 'Slack Message',
        type: 'slack_alert',
        description: 'Send a Slack notification',
        blockId: 'slack_message',
        required: false,
        dependsOn: [`step_${updatedPlan.steps.length - 1}`]
      }
    ];
    if (!updatedPlan.integrations.includes('Slack')) updatedPlan.integrations.push('Slack');
  }

  // Add approval
  if ((normalized.includes('approval') || normalized.includes('approve')) && !existingBlockIds.has('approval_node')) {
    const insertIdx = 1;
    const newSteps = [...updatedPlan.steps];
    newSteps.splice(insertIdx, 0, {
      stepId: `step_approval`,
      name: 'Approval Step',
      type: 'approval',
      description: 'Human approval gate before proceeding',
      blockId: 'approval_node',
      required: true,
      dependsOn: [newSteps[0]?.stepId ?? 'trigger']
    });
    updatedPlan.steps = newSteps;
  }

  // Add error handling
  if ((normalized.includes('error') || normalized.includes('failure')) && !existingBlockIds.has('error_handler')) {
    updatedPlan.steps = [
      ...updatedPlan.steps,
      {
        stepId: 'step_error',
        name: 'Error Handler',
        type: 'error_handler',
        description: 'Catch and report workflow errors',
        blockId: 'error_handler',
        required: false,
        dependsOn: []
      },
      {
        stepId: 'step_error_notify',
        name: 'Error Notification Email',
        type: 'send_email',
        description: 'Send email when errors occur',
        blockId: 'error_notify_email',
        required: false,
        dependsOn: ['step_error']
      }
    ];
  }

  // Add delay
  if ((normalized.includes('delay') || normalized.includes('wait')) && !existingBlockIds.has('wait_delay')) {
    updatedPlan.steps = [
      ...updatedPlan.steps,
      {
        stepId: `step_delay`,
        name: 'Wait / Delay',
        type: 'delay',
        description: 'Add a time delay before the next step',
        blockId: 'wait_delay',
        required: false,
        dependsOn: [`step_${updatedPlan.steps.length - 1}`]
      }
    ];
  }

  // Switch email to SMS
  if (normalized.includes('sms') || normalized.includes('text message') || normalized.includes('twilio')) {
    updatedPlan.steps = updatedPlan.steps.map(s =>
      s.blockId === 'send_email_smtp'
        ? { ...s, blockId: 'twilio_sms', name: 'Twilio SMS', type: 'sms' as ActionType, description: 'Send SMS via Twilio' }
        : s
    );
    if (!updatedPlan.integrations.includes('Twilio')) updatedPlan.integrations.push('Twilio');
  }

  // Add Google Sheets
  if ((normalized.includes('sheets') || normalized.includes('spreadsheet')) && !existingBlockIds.has('google_sheets_append')) {
    updatedPlan.steps = [
      ...updatedPlan.steps,
      {
        stepId: 'step_sheets',
        name: 'Google Sheets Append',
        type: 'google_sheets',
        description: 'Log data to Google Sheets',
        blockId: 'google_sheets_append',
        required: false,
        dependsOn: [`step_${updatedPlan.steps.length - 1}`]
      }
    ];
    if (!updatedPlan.integrations.includes('Google Sheets')) updatedPlan.integrations.push('Google Sheets');
  }

  updatedPlan.estimatedNodes = 1 + updatedPlan.steps.length;
  updatedPlan.complexity = updatedPlan.estimatedNodes <= 3 ? 'simple' : updatedPlan.estimatedNodes <= 6 ? 'moderate' : 'complex';

  // Remove any steps whose blockId is not in the registry (guard against stale modifications)
  updatedPlan.steps = updatedPlan.steps.filter(s => !!BLOCKS[s.blockId]);

  validatePlan(updatedPlan);

  const composition = composeFromPlan(updatedPlan);
  const n8nJson = buildN8nWorkflow(updatedPlan, composition);
  assertNodesAreCapable(n8nJson);
  const envVars = collectEnvVars([updatedPlan.trigger.blockId, ...updatedPlan.steps.map(s => s.blockId)]);
  const dependencies = collectDependencies([updatedPlan.trigger.blockId, ...updatedPlan.steps.map(s => s.blockId)]);
  const envConfig = buildEnvConfig(updatedPlan, envVars);

  return { plan: updatedPlan, composition, n8nJson, envConfig, dependencies };
}
