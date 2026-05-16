import { BLOCKS } from '@/lib/blocks';
import {
  assemblePlannerResult,
  buildOpenAIPlannerSchema,
  createAutomationPlan,
  type PlannerResult,
} from '@/lib/planner';
import { requiredProvidersFromWorkflow, type IntegrationProvider } from '@/lib/integrations';
import { assessPromptIntent } from '@/lib/intent-validator';

export type PlannerIntent = {
  trigger: {
    service: string;
    event: string;
    description: string;
  };
  actions: Array<{
    service: string;
    action: string;
    description: string;
  }>;
  data_storage: string[];
  notifications: string[];
  required_integrations: IntegrationProvider[];
  forbidden_integrations: IntegrationProvider[];
  assumptions: string[];
  confidence: number;
};

export type WorkflowOption = {
  id: string;
  name: string;
  pros: string[];
  cons: string[];
  difficulty: number;
  reliability: number;
  requiredIntegrations: IntegrationProvider[];
  estimatedSetupMinutes: number;
  score: number;
  reason: string;
};

export type ProPlannerValidation = {
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
  detectedIntegrations: IntegrationProvider[];
  errors: string[];
};

export type ProPlannerPayload = {
  intent: PlannerIntent;
  options: WorkflowOption[];
  recommendedOptionId: string;
  validation: ProPlannerValidation;
  explanation: {
    whyChosen: string;
    nodeSummary: string[];
    credentialsNeeded: string[];
    userMustConfigure: string[];
    limitations: string[];
  };
};

export type ProPlannerResult = {
  plannerResult: PlannerResult;
  proPlanner: ProPlannerPayload;
  generationAdjusted: boolean;
  generationWarning?: string;
};

export type ProPlannerConfig = {
  apiKey?: string;
  mode: 'openai' | 'deterministic';
};

export const PRO_PLANNER_TEST_PROMPTS: Array<{ prompt: string; expected: string[] }> = [
  { prompt: 'When I receive an email, send me a Slack message', expected: ['email', 'slack'] },
  { prompt: 'When a Shopify order is created, save it in Airtable and notify Slack', expected: ['shopify', 'airtable', 'slack'] },
  { prompt: 'When a tenant submits a maintenance request, log it in Airtable and notify Slack', expected: ['airtable', 'slack'] },
  { prompt: 'Send SMS via Twilio when a new lead arrives', expected: [] },
  { prompt: 'Every morning send me a report email', expected: ['email'] },
];

function parseIntent(prompt: string): PlannerIntent {
  const text = prompt.toLowerCase();
  const required = new Set<IntegrationProvider>();

  if (text.includes('slack')) required.add('slack');
  if (text.includes('shopify')) required.add('shopify');
  if (text.includes('airtable')) required.add('airtable');
  if (text.includes('smtp') || text.includes('email') || text.includes('gmail')) required.add('email');

  const forbidden = (['shopify', 'airtable', 'slack', 'email'] as IntegrationProvider[])
    .filter((provider) => !required.has(provider));

  const triggerService =
    text.includes('shopify') ? 'shopify' :
    text.includes('schedule') || text.includes('every morning') || text.includes('daily') ? 'schedule' :
    text.includes('email') || text.includes('gmail') ? 'email' :
    text.includes('webhook') ? 'webhook' :
    'unknown';

  const actions: PlannerIntent['actions'] = [];
  if (text.includes('slack')) actions.push({ service: 'slack', action: 'send_message', description: 'Send a Slack message/notification' });
  if (text.includes('airtable')) actions.push({ service: 'airtable', action: 'save_record', description: 'Create or update Airtable record' });
  if (text.includes('email') || text.includes('gmail') || text.includes('smtp')) actions.push({ service: 'email', action: 'send_email', description: 'Send email notification/report' });
  if (text.includes('twilio') || text.includes('sms')) actions.push({ service: 'twilio', action: 'send_sms', description: 'Send SMS alert' });

  const assumptions: string[] = [];

  const strict = assessPromptIntent(prompt);
  const confidence = strict.confidence;

  return {
    trigger: {
      service: triggerService,
      event: triggerService === 'schedule' ? 'scheduled_run' : 'new_event',
      description: `Trigger from ${triggerService}`,
    },
    actions,
    data_storage: text.includes('airtable') ? ['airtable'] : [],
    notifications: text.includes('slack') ? ['slack'] : (text.includes('email') ? ['email'] : []),
    required_integrations: Array.from(required),
    forbidden_integrations: forbidden,
    assumptions,
    confidence,
  };
}

function buildOptions(intent: PlannerIntent): WorkflowOption[] {
  const primary: WorkflowOption = {
    id: 'opt_primary',
    name: 'Intent-aligned workflow',
    pros: ['Matches extracted intent', 'Deploy-ready graph'],
    cons: ['Requires connected credentials'],
    difficulty: 3,
    reliability: 8,
    requiredIntegrations: intent.required_integrations,
    estimatedSetupMinutes: 20,
    score: 0,
    reason: 'Strict mode: only one intent-aligned workflow is allowed.',
  };

  const intentMatch = primary.requiredIntegrations.every((i) => intent.required_integrations.includes(i)) ? 9 : 6;
  const simplicity = Math.max(1, 10 - primary.difficulty);
  const deployability = primary.estimatedSetupMinutes <= 20 ? 9 : 7;
  primary.score = primary.reliability + simplicity + intentMatch + deployability;

  return [primary];
}

function validatePlannerResult(
  result: PlannerResult,
  intent: PlannerIntent
): ProPlannerValidation {
  const detected = requiredProvidersFromWorkflow(result.n8nJson);
  const expectedSet = new Set(intent.required_integrations);
  const forbiddenSet = new Set(intent.forbidden_integrations);

  const hasTrigger = !!result.plan.trigger?.blockId;
  const hasAction = result.plan.steps.length > 0;
  const structureValid = !!result.n8nJson?.nodes?.length && !!result.n8nJson?.connections;

  const connectedTargets = new Set<string>();
  for (const outgoing of Object.values(result.n8nJson.connections ?? {})) {
    for (const branch of outgoing.main ?? []) {
      for (const edge of branch ?? []) {
        connectedTargets.add(edge.node);
      }
    }
  }
  const connected = (result.n8nJson.nodes ?? []).every((node, idx) => idx === 0 || connectedTargets.has(node.name));

  const requiredIntegrationsMatch = intent.required_integrations.every((provider) => detected.includes(provider));
  const noForbiddenIntegrations = detected.every((provider) => !forbiddenSet.has(provider));
  const intentMatch = requiredIntegrationsMatch && noForbiddenIntegrations;

  const errors: string[] = [];
  if (!intentMatch) errors.push('Generated workflow does not match intent integrations.');
  if (!requiredIntegrationsMatch) errors.push('Missing required integrations for prompt intent.');
  if (!noForbiddenIntegrations) errors.push('Generated workflow contains forbidden integrations.');
  if (!structureValid) errors.push('Workflow JSON structure is invalid.');
  if (!connected) errors.push('Workflow nodes are not connected correctly.');
  if (!hasTrigger) errors.push('Workflow is missing a trigger.');
  if (!hasAction) errors.push('Workflow is missing an action.');

  return {
    valid: errors.length === 0,
    checks: {
      intentMatch,
      requiredIntegrationsMatch,
      noForbiddenIntegrations,
      structureValid,
      connected,
      hasTrigger,
      hasAction,
    },
    detectedIntegrations: detected,
    errors,
  };
}

async function generateOpenAIPlan(prompt: string, option: WorkflowOption, intent: PlannerIntent, apiKey: string): Promise<PlannerResult> {
  const blockIds = Object.keys(BLOCKS);
  const schema = buildOpenAIPlannerSchema(blockIds);

  const systemPrompt = `You are the PRO MagicFlux planner. Produce a precise workflow plan.
STRICT:
- Use exact trigger + actions from intent.
- Do not include extra integrations.
- ONLY use services: ${intent.required_integrations.join(', ') || 'none'}.
- NEVER include forbidden services: ${intent.forbidden_integrations.join(', ') || 'none'}.
- Keep flow minimal and deployable.`;

  const userPrompt = `User prompt: ${prompt}
Detected intent: ${JSON.stringify(intent)}
Recommended option: ${option.name}
Option reason: ${option.reason}
Output a single best structured plan for this option.`;

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-2024-08-06',
      temperature: 0.15,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'automation_plan',
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => '');
    throw new Error(`OpenAI API error ${openaiRes.status}: ${errText}`);
  }

  const openaiData = await openaiRes.json();
  const content = openaiData.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty response');

  const rawPlan = JSON.parse(content) as Parameters<typeof assemblePlannerResult>[0];
  return assemblePlannerResult(rawPlan);
}

function buildExplanation(result: PlannerResult, recommended: WorkflowOption, validation: ProPlannerValidation): ProPlannerPayload['explanation'] {
  const nodeSummary = (result.n8nJson.nodes ?? []).map((node, idx) => `${idx + 1}. ${node.name}: ${node.type}`);
  const credentialsNeeded = validation.detectedIntegrations.map((i) => `${i} credentials`);

  return {
    whyChosen: `Selected ${recommended.name} because it scored highest on reliability, simplicity, intent match, and deployability (${recommended.score}).`,
    nodeSummary,
    credentialsNeeded,
    userMustConfigure: [
      'Connect required integrations in Settings > Integrations.',
      'Review node parameters and credentials before deploy.',
      'Run Setup & Test before deploying to production.',
    ],
    limitations: result.plan.unsupportedRequirements ?? [],
  };
}

export async function runProPlanner(prompt: string, config: ProPlannerConfig): Promise<ProPlannerResult> {
  const strict = assessPromptIntent(prompt);
  if (strict.unsupportedProviders.length > 0) {
    throw new Error(`UNSUPPORTED_REQUIREMENTS: This automation cannot be built with current capabilities (${strict.unsupportedProviders.join(', ')}).`);
  }
  if (strict.missing.length > 0) {
    throw new Error(`INCOMPLETE_INTENT: Your request is missing required parts: ${strict.missing.join(', ')}.`);
  }
  if (strict.confidence < 85) {
    throw new Error('CLARIFICATION_REQUIRED: Please provide a clearer trigger, action, and data target.');
  }

  const intent = parseIntent(prompt);
  if (intent.trigger.service === 'unknown') {
    throw new Error('INCOMPLETE_INTENT: Missing trigger. Describe when the workflow should run.');
  }
  if (intent.actions.length === 0) {
    throw new Error('INCOMPLETE_INTENT: Missing action. Describe what the workflow should do.');
  }
  const options = buildOptions(intent);
  const recommended = options[0];

  const candidate = (config.mode === 'openai' && config.apiKey)
    ? await generateOpenAIPlan(prompt, recommended, intent, config.apiKey)
    : createAutomationPlan(prompt, 'deterministic');

  const validation = validatePlannerResult(candidate, intent);
  if (!validation.valid) {
    throw new Error('Unable to generate accurate workflow. Please refine your request.');
  }

  const explanation = buildExplanation(candidate, recommended, validation);
  return {
    plannerResult: {
      ...candidate,
      proPlanner: {
        intent,
        options,
        recommendedOptionId: recommended.id,
        validation,
        explanation,
      },
    } as PlannerResult,
    proPlanner: {
      intent,
      options,
      recommendedOptionId: recommended.id,
      validation,
      explanation,
    },
    generationAdjusted: false,
    generationWarning: undefined,
  };
}
