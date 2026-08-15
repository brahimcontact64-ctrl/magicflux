import { z } from 'zod';

import type { ConversationState } from '@/lib/conversation-agent';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';
import {
  extractProvidersFromWorkflowGraph,
  filterProvidersToGraphAllowList,
  normalizeProvider as normalizeGraphProvider,
} from '@/lib/agent/provider-allowlist';
import { sanitizeAutomationBrainForGraph } from '@/lib/automation/sanitize-automation-brain-for-graph';
import type { PatternClassification } from '@/lib/automation/types';

const RUNTIME_STATE_VERSION = 2;
const RUNTIME_PERSIST_KEY = 'magicflux.builder.runtime_state';
const LEGACY_CHAT_PERSIST_KEY = 'magicflux.builder.chat_state';
const LEGACY_WORKFLOW_GRAPH_PERSIST_KEY = 'magicflux.builder.workflow_graph';
const LEGACY_AUTOMATION_BRAIN_PERSIST_KEY = 'magicflux.builder.automation_brain';
const LEGACY_SESSION_PERSIST_KEY = 'magicflux.builder.session';

export type MessageRole = 'user' | 'assistant';

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  options?: string[];
  timestamp: Date;
};

export type AgentEvent = {
  type: string;
  label: string;
  detail?: string;
  workflowId?: string;
  workflowUrl?: string;
};

export type CredentialRequest = {
  provider: string;
  reason: string;
  instructions?: string;
};

export type ApprovalRequest = {
  actionKey: string;
  actionType: string;
  reason: string;
  status: string;
};

export type ProgressCard = {
  id: string;
  title: string;
  detail?: string;
  tone: 'working' | 'success' | 'warning';
};

export type LiveNodeState = 'generating' | 'configuring' | 'validating' | 'connected' | 'failed' | 'deployed';

export type LiveWorkflowNode = {
  id: string;
  label: string;
  kind: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
  position: [number, number];
  state: LiveNodeState;
  visible?: boolean;
};

export type LiveWorkflowEdge = {
  from: string;
  to: string;
  animated?: boolean;
  active?: boolean;
};

export type LiveWorkflowStatus = {
  nodes: LiveWorkflowNode[];
  edges: LiveWorkflowEdge[];
  narration: string[];
  integrationsConnected: number;
  integrationsTotal: number;
  validated: boolean;
  readyToDeploy: boolean;
};

export type AutomationBrainSummary = {
  inferredIntent: string;
  capabilities: Array<{ key: string; reason: string; confidence: number }>;
  activatedSkillPacks: Array<{
    name: string;
    description: string;
    capabilities: string[];
    tools: string[];
    matchScore: number;
    classification?: PatternClassification;
  }>;
  matchedPatterns: Array<{
    name: string;
    category: string;
    score: number;
    estimatedCost: number;
    estimatedComplexity: 'simple' | 'moderate' | 'complex';
    risk: 'low' | 'medium' | 'high';
    classification?: PatternClassification;
  }>;
  composition: {
    executionFrequency: string;
    expectedInputs: string[];
    expectedOutputs: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedCostUsd: number;
    latencyEstimateMs: number;
    risks: string[];
    blocks: Array<{ id: string; category: string; name: string; capabilities: string[] }>;
  };
};

export type IntegrationCardItem = {
  provider: string;
  displayName: string;
  reason: string;
  connected: boolean;
  requiredFields: string[];
};

export type MessageUi = Message & {
  progressCards?: ProgressCard[];
  credentialRequests?: CredentialRequest[];
  integrationCards?: IntegrationCardItem[];
  approvalRequests?: ApprovalRequest[];
  workflowUrl?: string;
  workflowActive?: boolean;
  liveWorkflow?: LiveWorkflowStatus;
  workflowGraph?: WorkflowGraphSummary;
  automationBrain?: AutomationBrainSummary;
};

export type WorkflowSummarySnapshot = {
  nodes: number;
  triggers: number;
  actions: number;
  branches: number;
  schedule: string;
  risk: 'Low' | 'Medium' | 'High';
  latencySeconds: number;
  estimatedCostLabel: string;
};

export type DeployState = {
  blocked: boolean;
  ready: boolean;
  workflowActive: boolean;
  workflowUrl?: string;
};

export type ApprovalState = {
  requests: ApprovalRequest[];
};

export type BuilderRuntimeState = {
  version: number;
  session: { id: string };
  conversation: MessageUi[];
  workflowGraph?: WorkflowGraphSummary;
  automationBrain?: AutomationBrainSummary;
  integrationCards: IntegrationCardItem[];
  workflowSummary?: WorkflowSummarySnapshot;
  deployState: DeployState;
  approvalState: ApprovalState;
  liveWorkflow?: LiveWorkflowStatus;
  activeAssistantMessageId?: string;
};

type PersistedMessage = Omit<MessageUi, 'timestamp'> & { timestamp: string };

type PersistedBuilderRuntimeState = Omit<BuilderRuntimeState, 'conversation'> & {
  conversation: PersistedMessage[];
};

const RuntimeStateSchema = z.object({
  version: z.number().int().min(1),
  session: z.object({ id: z.string().min(1) }),
  conversation: z.array(
    z.object({
      id: z.string().min(1),
      role: z.enum(['user', 'assistant']),
      content: z.string(),
      options: z.array(z.string()).optional(),
      timestamp: z.string(),
      progressCards: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            detail: z.string().optional(),
            tone: z.enum(['working', 'success', 'warning']),
          })
        )
        .optional(),
      credentialRequests: z
        .array(
          z.object({
            provider: z.string(),
            reason: z.string(),
            instructions: z.string().optional(),
          })
        )
        .optional(),
      integrationCards: z
        .array(
          z.object({
            provider: z.string(),
            displayName: z.string(),
            reason: z.string(),
            connected: z.boolean(),
            requiredFields: z.array(z.string()),
          })
        )
        .optional(),
      approvalRequests: z
        .array(
          z.object({
            actionKey: z.string(),
            actionType: z.string(),
            reason: z.string(),
            status: z.string(),
          })
        )
        .optional(),
      workflowUrl: z.string().optional(),
      workflowActive: z.boolean().optional(),
      liveWorkflow: z.any().optional(),
      workflowGraph: z.any().optional(),
      automationBrain: z.any().optional(),
    })
  ),
  workflowGraph: z.any().optional(),
  automationBrain: z.any().optional(),
  integrationCards: z.array(
    z.object({
      provider: z.string(),
      displayName: z.string(),
      reason: z.string(),
      connected: z.boolean(),
      requiredFields: z.array(z.string()),
    })
  ),
  workflowSummary: z
    .object({
      nodes: z.number(),
      triggers: z.number(),
      actions: z.number(),
      branches: z.number(),
      schedule: z.string(),
      risk: z.enum(['Low', 'Medium', 'High']),
      latencySeconds: z.number(),
      estimatedCostLabel: z.string(),
    })
    .optional(),
  deployState: z.object({
    blocked: z.boolean(),
    ready: z.boolean(),
    workflowActive: z.boolean(),
    workflowUrl: z.string().optional(),
  }),
  approvalState: z.object({
    requests: z.array(
      z.object({
        actionKey: z.string(),
        actionType: z.string(),
        reason: z.string(),
        status: z.string(),
      })
    ),
  }),
  liveWorkflow: z.any().optional(),
  activeAssistantMessageId: z.string().optional(),
});

export function validateRuntimeState(input: unknown): {
  success: true;
  data: BuilderRuntimeState;
} | {
  success: false;
  error: string;
} {
  const parsed = RuntimeStateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
  }

  const normalized = fromPersistedRuntimeState(parsed.data as PersistedBuilderRuntimeState);
  return { success: true, data: normalized };
}

export function createRuntimeState(seed?: Partial<BuilderRuntimeState>): BuilderRuntimeState {
  const normalizedWorkflowGraph = normalizeHydratedWorkflowGraph(seed?.workflowGraph);
  const normalizedAutomationBrain = sanitizeAutomationBrainForGraph(seed?.automationBrain, normalizedWorkflowGraph);
  const normalizedConversation = (seed?.conversation ?? [defaultWelcomeMessage()]).map((message) => {
    const messageWorkflowGraph = normalizeHydratedWorkflowGraph(message.workflowGraph ?? normalizedWorkflowGraph);
    return {
      ...message,
      workflowGraph: messageWorkflowGraph,
      automationBrain: sanitizeAutomationBrainForGraph(message.automationBrain, messageWorkflowGraph),
    };
  });
  const normalizedWorkflowSummary = normalizedWorkflowGraph
    ? deriveWorkflowSummary(normalizedWorkflowGraph)
    : seed?.workflowSummary;

  console.log({
    stage: 'STATE-WRITE',
    source: 'lib/builder/runtime-state.ts createRuntimeState',
    incomingCapabilities: normalizedAutomationBrain?.capabilities?.map((x) => x.key),
    prevCapabilities: undefined,
    graphTrigger: normalizedWorkflowGraph?.nodes?.find((n) => n.kind === 'trigger'),
    schedule: normalizedWorkflowSummary?.schedule,
  });

  return {
    version: RUNTIME_STATE_VERSION,
    session: { id: seed?.session?.id ?? `conv-${Date.now()}` },
    conversation: normalizedConversation,
    workflowGraph: normalizedWorkflowGraph,
    automationBrain: normalizedAutomationBrain,
    integrationCards: seed?.integrationCards ?? [],
    workflowSummary: normalizedWorkflowSummary,
    deployState: seed?.deployState ?? {
      blocked: false,
      ready: false,
      workflowActive: false,
    },
    approvalState: seed?.approvalState ?? { requests: [] },
    liveWorkflow: seed?.liveWorkflow,
    activeAssistantMessageId: seed?.activeAssistantMessageId,
  };
}

export function migrateRuntimeState(storage: Storage): BuilderRuntimeState {
  const rawRuntime = storage.getItem(RUNTIME_PERSIST_KEY);
  if (rawRuntime) {
    try {
      const parsed = JSON.parse(rawRuntime) as unknown;
      const validated = validateRuntimeState(parsed);
      if (validated.success) return validated.data;
      storage.removeItem(RUNTIME_PERSIST_KEY);
    } catch {
      storage.removeItem(RUNTIME_PERSIST_KEY);
    }
  }

  const migrated = loadLegacyRuntimeState(storage);
  persistRuntimeState(storage, migrated);
  return migrated;
}

export function persistRuntimeState(storage: Storage, state: BuilderRuntimeState): void {
  const persisted = toPersistedRuntimeState(state);
  storage.setItem(RUNTIME_PERSIST_KEY, JSON.stringify(persisted));
}

export function restoreRuntimeState(storage: Storage): BuilderRuntimeState {
  const migrated = migrateRuntimeState(storage);
  const validated = validateRuntimeState(toPersistedRuntimeState(migrated));
  if (validated.success) return validated.data;
  storage.removeItem(RUNTIME_PERSIST_KEY);
  return createRuntimeState();
}

export function clearRuntimeState(storage: Storage): void {
  storage.removeItem(RUNTIME_PERSIST_KEY);
  storage.removeItem(LEGACY_CHAT_PERSIST_KEY);
  storage.removeItem(LEGACY_WORKFLOW_GRAPH_PERSIST_KEY);
  storage.removeItem(LEGACY_AUTOMATION_BRAIN_PERSIST_KEY);
  storage.removeItem(LEGACY_SESSION_PERSIST_KEY);
}

export function defaultWelcomeMessage(): MessageUi {
  return {
    id: 'welcome',
    role: 'assistant',
    content: "Hey there! I'm here to help you build automations. What are you looking to automate today?",
    timestamp: new Date(),
  };
}

export function normalizeProviderMentions(value: string): string {
  return value
    .replace(/\bwhatsapp\b/gi, 'WhatsApp')
    .replace(/\bemail\b/gi, 'Email')
    .replace(/\bopenai\b/gi, 'OpenAI')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bdeepgram\b/gi, 'Deepgram')
    .replace(/\bcoinmarketcap\b/gi, 'CoinMarketCap')
    .replace(/\bgrok\b/gi, 'Grok')
    .replace(/\bairtable\b/gi, 'Airtable')
    .replace(/\bslack\b/gi, 'Slack');
}

export function sanitizeVisibleText(input: unknown, fallback = ''): string {
  const raw = typeof input === 'string' ? input : fallback;
  if (!raw) return fallback;

  const noFences = raw.replace(/```[\s\S]*?```/g, ' ').trim();
  if (!noFences) return fallback;

  const compact = noFences.replace(/\s+/g, ' ').trim();
  const likelyInternal =
    (/[\[{].*[\]}]/.test(compact) && /"\w+"\s*:\s*/.test(compact)) ||
    /(workflow_json|queue[_-]?id|execution[_-]?id|trace[_-]?id|correlation[_-]?id|runtime|internal|payload|args|metadata|debug)/i.test(compact);

  if (likelyInternal) {
    return fallback || 'I prepared this step securely and can continue with the next action.';
  }

  return normalizeProviderMentions(compact).slice(0, 3000);
}

export function normalizeAssistantCopy(
  content: string,
  _brain?: AutomationBrainSummary | null
): string {
  return normalizeProviderMentions(content);
}

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeWorkflowNodeLabel(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return 'Workflow step';

  const compact = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (compact.includes('whatsapp')) return 'WhatsApp';
  if (compact.includes('email send') || compact === 'email') return 'Email';
  if (compact.includes('openai')) return 'OpenAI';
  if (compact.includes('claude') || compact.includes('anthropic')) return 'Claude';
  if (compact.includes('deepgram')) return 'Deepgram';
  if (compact.includes('airtable')) return 'Airtable';
  if (compact.includes('slack')) return 'Slack';
  if (compact.includes('coinmarketcap')) return 'CoinMarketCap';
  if (compact.includes('http request')) return 'API Request';
  if (compact.includes('cron') || compact.includes('schedule')) return 'Schedule';
  if (compact.includes('webhook')) return 'Webhook';

  return toTitleCase(cleaned.replace(/[_-]+/g, ' '));
}

function getTriggerPriorityScore(node: WorkflowGraphSummary['nodes'][number]): number {
  const provider = normalizeGraphProvider(String(node.provider ?? node.integration ?? ''));
  const label = `${node.label ?? ''} ${node.name ?? ''} ${provider}`.toLowerCase();
  if (provider === 'stripe' && /webhook/.test(label)) return 4;
  if (/webhook/.test(label)) return 3;
  if (/manual/.test(label)) return 2;
  if (/schedule|cron|interval/.test(label)) return 1;
  return 0;
}

function selectPreferredTrigger(graph: WorkflowGraphSummary): WorkflowGraphSummary['nodes'][number] | undefined {
  const triggers = graph.nodes.filter((node) => node.kind === 'trigger');
  if (triggers.length === 0) return undefined;

  return triggers.reduce((best, current) => {
    const bestScore = getTriggerPriorityScore(best);
    const currentScore = getTriggerPriorityScore(current);
    return currentScore > bestScore ? current : best;
  });
}

export function createLiveWorkflowStatus(graph: WorkflowGraphSummary): LiveWorkflowStatus {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    label: node.kind === 'trigger' ? String(node.displayName || node.label || node.name || 'Trigger') : normalizeWorkflowNodeLabel(node.label || node.name),
    kind: node.kind,
    position: node.position,
    state: 'generating' as const,
    visible: true,
  }));

  const integrationsTotal = Math.max(1, new Set(graph.integrations).size);

  return {
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge, animated: true })),
    narration: ['Creating workflow graph'],
    integrationsConnected: 0,
    integrationsTotal,
    validated: false,
    readyToDeploy: false,
  };
}

function appendNarration(lines: string[], line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return lines;
  if (lines[lines.length - 1] === trimmed) return lines;
  return [...lines, trimmed].slice(-8);
}

function narrationFromSignal(input: { toolName?: string; event?: AgentEvent; status?: string }): string | null {
  if (input.event?.type === 'generating_workflow') return 'Setting up the workflow...';
  if (input.event?.type === 'deploying') return 'Getting this deployed...';
  if (input.event?.type === 'activating') return 'Turning it on...';
  if (input.event?.type === 'testing') return 'Running a quick test...';
  if (input.event?.type === 'requesting_credential') return 'Connecting the integration...';
  if (input.event?.type === 'workflow_ready') return 'All set and ready to go!';
  if (input.event?.type === 'error') return 'Working through this...';

  if (input.toolName === 'generate_workflow_json') return 'Building the workflow structure...';
  if (input.toolName === 'deploy_workflow_to_n8n') return 'Deploying to the platform...';
  if (input.toolName === 'activate_workflow') return 'Activating the automation...';
  if (input.toolName === 'test_workflow') return 'Testing everything works...';

  if (input.status && /deploy/i.test(input.status)) return 'Deploying now...';
  if (input.status && /design|build|blueprint/i.test(input.status)) return 'Designing the flow...';
  if (input.status && /test|check|validat/i.test(input.status)) return 'Validating the setup...';
  return null;
}

export function updateLiveWorkflow(
  status: LiveWorkflowStatus,
  signal: { event?: AgentEvent; toolName?: string; status?: string }
): LiveWorkflowStatus {
  const next: LiveWorkflowStatus = {
    ...status,
    nodes: status.nodes.map((node) => ({ ...node })),
    edges: status.edges.map((edge) => ({ ...edge })),
    narration: [...status.narration],
  };

  const narrated = narrationFromSignal(signal);
  if (narrated) {
    next.narration = appendNarration(next.narration, narrated);
  }

  const firstVisible = next.nodes.find((node) => node.visible !== false);
  const firstWorking = next.nodes.find(
    (node) => node.visible !== false && !['connected', 'deployed', 'failed'].includes(node.state)
  );

  if (signal.event?.type === 'error') {
    const target = firstWorking ?? firstVisible;
    if (target) target.state = 'failed';
    next.readyToDeploy = false;
  } else if (signal.toolName === 'generate_workflow_json' || signal.event?.type === 'generating_workflow') {
    if (firstWorking) firstWorking.state = 'configuring';
  } else if (
    signal.toolName === 'validate_credential' ||
    signal.event?.type === 'testing' ||
    (signal.status && /validat|test|check/i.test(signal.status))
  ) {
    if (firstWorking) firstWorking.state = 'validating';
    next.validated = false;
  } else if (
    signal.toolName === 'request_credential' ||
    signal.event?.type === 'requesting_credential' ||
    (signal.status && /connect/i.test(signal.status))
  ) {
    if (firstWorking) firstWorking.state = 'connected';
  } else if (
    signal.toolName === 'deploy_workflow_to_n8n' ||
    signal.toolName === 'activate_workflow' ||
    signal.event?.type === 'deploying' ||
    signal.event?.type === 'activating' ||
    signal.event?.type === 'workflow_ready'
  ) {
    next.nodes = next.nodes.map((node) =>
      node.visible === false
        ? node
        : {
            ...node,
            state: signal.event?.type === 'workflow_ready' || signal.toolName === 'activate_workflow' ? 'deployed' : 'connected',
          }
    );
    next.validated = true;
    next.readyToDeploy = true;
  }

  const connectedCount = next.nodes.filter(
    (node) =>
      node.visible !== false &&
      (node.kind === 'trigger' || node.kind === 'action' || node.kind === 'ai') &&
      (node.state === 'connected' || node.state === 'deployed')
  ).length;
  next.integrationsConnected = Math.min(next.integrationsTotal, connectedCount);

  return next;
}

function normalizeProviderName(value: string): string {
  const normalized = normalizeGraphProvider(value);
  if (!normalized || normalized === 'core' || normalized === 'integration') return '';
  if (normalized.includes('webhook')) return 'webhook';
  if (normalized.includes('scheduler') || normalized.includes('cron') || normalized.includes('schedule')) return 'scheduler';
  if (normalized.includes('vision')) return 'vision_ai';
  if (normalized.includes('httprequest') || normalized.includes('http_request')) return 'httprequest';
  return normalized;
}

function providerDisplayName(provider: string): string {
  if (provider === 'grok') return 'Grok';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'claude') return 'Claude';
  if (provider === 'email') return 'Email';
  if (provider === 'whatsapp') return 'WhatsApp';
  if (provider === 'deepgram') return 'Deepgram';
  if (provider === 'vision_ai') return 'Vision AI';
  if (provider === 'coinmarketcap') return 'CoinMarketCap';
  if (provider === 'telegram') return 'Telegram';
  if (provider === 'supabase') return 'Supabase';
  if (provider === 'postgres') return 'Postgres';
  return toTitleCase(provider.replaceAll('_', ' '));
}

function providerRequiredFields(provider: string): string[] {
  if (provider === 'coinmarketcap') return ['API key'];
  if (provider === 'grok') return ['xAI/Grok API key', 'Optional model'];
  if (provider === 'openai') return ['OpenAI API key'];
  if (provider === 'claude') return ['Anthropic API key'];
  if (provider === 'facebook') return ['Access token', 'Page ID'];
  if (provider === 'canva') return ['Canva API key'];
  if (provider === 'google_sheets') return ['Google service account', 'Spreadsheet ID'];
  if (provider === 'telegram') return ['Bot token', 'Chat ID'];
  if (provider === 'whatsapp') return ['Phone number ID', 'Access token'];
  if (provider === 'deepgram') return ['Deepgram API key'];
  if (provider === 'airtable') return ['Base ID', 'Table name', 'Access token'];
  if (provider === 'slack') return ['Bot token', 'Channel'];
  if (provider === 'email') return ['SMTP host', 'Username', 'Password'];
  return [];
}

export function deriveIntegrationCards(
  graph?: WorkflowGraphSummary,
  requests: CredentialRequest[] = [],
  requiredProviders: string[] = []
): IntegrationCardItem[] {
  const blockedProviders = new Set(['core', 'integration', 'scheduler', 'httprequest', 'http_request', 'ai_provider', 'utility', 'webhook']);
  const requestByProvider = new Map(requests.map((req) => [normalizeProviderName(req.provider), req]));
  const providerAllowList = new Set(extractProvidersFromWorkflowGraph(graph));
  const enforceAllowList = providerAllowList.size > 0;
  const byProvider = new Map<string, IntegrationCardItem>();

  const addProvider = (providerInput: string, preferredDisplayName?: string, preferredFields: string[] = []) => {
    const provider = normalizeProviderName(providerInput);
    if (!provider || blockedProviders.has(provider)) return;
    if (enforceAllowList && !providerAllowList.has(provider)) return;

    const existing = byProvider.get(provider);
    const request = requestByProvider.get(provider);
    const requiredFields = preferredFields.length > 0 ? preferredFields : providerRequiredFields(provider);

    const next: IntegrationCardItem = {
      provider,
      displayName: preferredDisplayName || existing?.displayName || providerDisplayName(provider),
      reason: request?.reason || existing?.reason || 'Review this integration before deployment.',
      connected: provider === 'supabase' && !request,
      requiredFields,
    };

    byProvider.set(provider, next);
  };

  for (const node of graph?.nodes ?? []) {
    if (!node.requiresCredentials) continue;
    const schemaFields = (node.credentialSchema ?? []).map((field) => field.label).filter(Boolean);
    addProvider(node.provider ?? node.integration ?? '', node.displayName, schemaFields);
  }

  for (const provider of filterProvidersToGraphAllowList(requests.map((request) => request.provider), graph)) {
    addProvider(provider);
  }
  for (const provider of filterProvidersToGraphAllowList(requiredProviders, graph)) {
    addProvider(provider);
  }

  if (byProvider.has('grok')) {
    byProvider.delete('openai');
    byProvider.delete('anthropic');
    byProvider.delete('gemini');
    byProvider.delete('groq');
    byProvider.delete('xai');
  }

  if (byProvider.has('claude')) {
    byProvider.delete('openai');
    byProvider.delete('anthropic');
  }

  return Array.from(byProvider.values());
}

function hasScheduleTrigger(graph?: WorkflowGraphSummary): boolean {
  if (!graph) return false;
  return graph.nodes.some((node) => {
    if (node.kind !== 'trigger') return false;
    const type = String(node.type ?? '').toLowerCase();
    const provider = String(node.provider ?? '').toLowerCase();
    const capability = String(node.capability ?? '').toLowerCase();
    return provider === 'scheduler'
      || capability === 'scheduling'
      || type === 'cron'
      || type.endsWith('.cron')
      || type.endsWith('.scheduletrigger');
  });
}

function normalizeHydratedWorkflowGraph(graph?: WorkflowGraphSummary): WorkflowGraphSummary | undefined {
  if (!graph) return undefined;
  const scheduleDetected = hasScheduleTrigger(graph);
  return {
    ...graph,
    ...(scheduleDetected ? {} : { schedule: undefined }),
  };
}

function formatDollars(value: number): string {
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

function detectSchedule(graph: WorkflowGraphSummary): string {
  const trigger = selectPreferredTrigger(graph);
  if (!trigger) return 'On-demand/manual';
  const type = String(trigger.type ?? '').toLowerCase();
  const provider = String(trigger.provider ?? '').toLowerCase();
  const capability = String(trigger.capability ?? '').toLowerCase();
  const isScheduled = provider === 'scheduler'
    || capability === 'scheduling'
    || type === 'cron'
    || type.endsWith('.cron')
    || type.endsWith('.scheduletrigger');
  if (!isScheduled) return 'On-demand/manual';
  return String(trigger.displayName || trigger.label || trigger.name || 'Scheduled trigger');
}

const AI_PROVIDER_IDS = new Set(['openai', 'claude', 'cloudflare_ai', 'elevenlabs', 'deepgram']);

/**
 * Classifies workflow risk from provider/capability profile and node counts.
 * Single-provider, low-capability, no-AI/storage/monitoring workflows are
 * always Low regardless of how many nodes the graph emitted.
 */
export function classifyWorkflowRisk(
  providers: string[],
  capabilities: string[],
  aiNodeCount: number,
  actionCount: number,
  branches: number
): 'Low' | 'Medium' | 'High' {
  const containsAI = aiNodeCount > 0 || providers.some((p) => AI_PROVIDER_IDS.has(p));
  const containsStorage = capabilities.some((c) => c === 'database_storage');
  const containsMonitoring = capabilities.includes('monitoring');
  const containsDatabase = capabilities.some((c) => c === 'database_storage' || c === 'memory');

  if (
    providers.length <= 1 &&
    capabilities.length <= 2 &&
    !containsAI &&
    !containsStorage &&
    !containsMonitoring &&
    !containsDatabase
  ) {
    return 'Low';
  }

  if (actionCount >= 4 || aiNodeCount >= 2 || branches >= 2) return 'High';
  if (actionCount >= 2 || aiNodeCount >= 1 || branches >= 1) return 'Medium';
  return 'Low';
}

function riskLevel(graph: WorkflowGraphSummary): 'Low' | 'Medium' | 'High' {
  const actionCount = graph.nodes.filter((node) => node.kind === 'action').length;
  const aiCount = graph.nodes.filter((node) => node.kind === 'ai').length;
  const providers = [...new Set(
    graph.nodes.map((n) => n.provider).filter((p): p is string => Boolean(p))
  )];
  const capabilities = [...new Set(
    graph.nodes.map((n) => n.capability).filter(Boolean)
  )];
  return classifyWorkflowRisk(providers, capabilities, aiCount, actionCount, graph.branches);
}

export function deriveWorkflowSummary(graph?: WorkflowGraphSummary): WorkflowSummarySnapshot | undefined {
  if (!graph) return undefined;
  const triggers = graph.nodes.filter((node) => node.kind === 'trigger').length;
  const actions = graph.nodes.filter((node) => node.kind === 'action').length;
  return {
    nodes: graph.nodes.length,
    triggers,
    actions,
    branches: graph.branches,
    schedule: detectSchedule(graph),
    risk: riskLevel(graph),
    latencySeconds: Math.max(1, Math.round((graph.estimatedLatencyMs ?? 0) / 1000)),
    estimatedCostLabel: formatDollars(graph.estimatedCostUsd ?? 0),
  };
}

export function toProgressCards(events: AgentEvent[]): ProgressCard[] {
  return events.map((event, index) => {
    const titleMap: Record<string, string> = {
      generating_workflow: 'Building your workflow',
      deploying: 'Deploying',
      activating: 'Activating',
      testing: 'Testing',
      requesting_credential: 'Need a connection',
      explaining_architecture: 'Putting it together',
      workflow_ready: 'Ready to go',
      error: 'Hit a snag',
    };
    const tone: ProgressCard['tone'] =
      event.type === 'error' ? 'warning' : event.type === 'workflow_ready' ? 'success' : 'working';

    return {
      id: `${event.type}-${index}-${event.label}-${event.detail ?? ''}-${Date.now()}`,
      title: sanitizeVisibleText(titleMap[event.type] ?? event.label, 'Progress update'),
      detail: sanitizeVisibleText(event.detail, ''),
      tone,
    };
  });
}

function toPersistedRuntimeState(state: BuilderRuntimeState): PersistedBuilderRuntimeState {
  const sanitizedAutomationBrain = sanitizeAutomationBrainForGraph(state.automationBrain, state.workflowGraph);
  return {
    ...state,
    automationBrain: sanitizedAutomationBrain,
    version: RUNTIME_STATE_VERSION,
    conversation: state.conversation.map((message) => ({
      ...message,
      automationBrain: sanitizeAutomationBrainForGraph(message.automationBrain, message.workflowGraph ?? state.workflowGraph),
      timestamp: message.timestamp.toISOString(),
    })),
  };
}

function fromPersistedRuntimeState(raw: PersistedBuilderRuntimeState): BuilderRuntimeState {
  const conversation = (raw.conversation ?? []).map((message) => ({
    ...message,
    timestamp: new Date(message.timestamp),
  }));

  const hydratedWorkflowGraph = normalizeHydratedWorkflowGraph(raw.workflowGraph);
  const hydratedAutomationBrain = sanitizeAutomationBrainForGraph(raw.automationBrain, hydratedWorkflowGraph);
  const hydratedWorkflowSummary = hydratedWorkflowGraph ? deriveWorkflowSummary(hydratedWorkflowGraph) : raw.workflowSummary;

  const runtimeState = createRuntimeState({
    ...raw,
    version: RUNTIME_STATE_VERSION,
    conversation: conversation.length > 0 ? conversation : [defaultWelcomeMessage()],
    workflowGraph: hydratedWorkflowGraph,
    automationBrain: hydratedAutomationBrain,
    integrationCards: raw.integrationCards ?? [],
    workflowSummary: hydratedWorkflowSummary,
    deployState: raw.deployState ?? { blocked: false, ready: false, workflowActive: false },
    approvalState: raw.approvalState ?? { requests: [] },
  });

  console.log({
    stage: 'STATE-WRITE',
    source: 'lib/builder/runtime-state.ts fromPersistedRuntimeState',
    incomingCapabilities: runtimeState.automationBrain?.capabilities?.map((x) => x.key),
    prevCapabilities: raw.automationBrain?.capabilities?.map((x) => x.key),
    graphTrigger: hydratedWorkflowGraph?.nodes?.find((n) => n.kind === 'trigger'),
    schedule: runtimeState.workflowSummary?.schedule,
  });

  return runtimeState;
}

function loadLegacyRuntimeState(storage: Storage): BuilderRuntimeState {
  let sessionId = `conv-${Date.now()}`;
  let conversation: MessageUi[] = [defaultWelcomeMessage()];

  const savedSession = storage.getItem(LEGACY_SESSION_PERSIST_KEY);
  if (savedSession) {
    try {
      const parsed = JSON.parse(savedSession) as { sessionId?: string };
      if (parsed.sessionId) sessionId = parsed.sessionId;
    } catch {
      storage.removeItem(LEGACY_SESSION_PERSIST_KEY);
    }
  }

  const raw = storage.getItem(LEGACY_CHAT_PERSIST_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { sessionId?: string; messages?: PersistedMessage[] };
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        conversation = parsed.messages.map((message) => ({
          ...message,
          timestamp: new Date(message.timestamp),
        }));
      }
    } catch {
      storage.removeItem(LEGACY_CHAT_PERSIST_KEY);
    }
  }

  let graph: WorkflowGraphSummary | undefined;
  let brain: AutomationBrainSummary | undefined;

  const rawGraph = storage.getItem(LEGACY_WORKFLOW_GRAPH_PERSIST_KEY);
  if (rawGraph) {
    try {
      graph = JSON.parse(rawGraph) as WorkflowGraphSummary;
    } catch {
      storage.removeItem(LEGACY_WORKFLOW_GRAPH_PERSIST_KEY);
    }
  }

  const rawBrain = storage.getItem(LEGACY_AUTOMATION_BRAIN_PERSIST_KEY);
  if (rawBrain) {
    try {
      brain = JSON.parse(rawBrain) as AutomationBrainSummary;
    } catch {
      storage.removeItem(LEGACY_AUTOMATION_BRAIN_PERSIST_KEY);
    }
  }

  const assistantMessage = [...conversation].reverse().find((message) => message.role === 'assistant');
  const integrationCards = deriveIntegrationCards(graph, []);
  const blocked = integrationCards.some((card) => !card.connected && card.requiredFields.length > 0);

  return createRuntimeState({
    session: { id: sessionId },
    conversation,
    workflowGraph: graph,
    automationBrain: brain,
    integrationCards,
    workflowSummary: deriveWorkflowSummary(graph),
    deployState: {
      blocked,
      ready: Boolean(graph) && !blocked,
      workflowActive: Boolean(assistantMessage?.workflowActive),
      workflowUrl: assistantMessage?.workflowUrl,
    },
    approvalState: {
      requests: assistantMessage?.approvalRequests ?? [],
    },
    liveWorkflow: graph
      ? updateLiveWorkflow(createLiveWorkflowStatus(graph), {
          status: assistantMessage?.workflowActive ? 'deployed' : 'design',
        })
      : undefined,
    activeAssistantMessageId: assistantMessage?.id,
  });
}

export type StreamToolEvent = {
  event?: AgentEvent;
  toolName?: string;
  workflowGraph?: WorkflowGraphSummary;
};

export type FinalResponsePayload = {
  success?: boolean;
  error?: string;
  assistant?: { content: string; options?: string[] };
  agentEvents?: AgentEvent[];
  credentialRequests?: Array<{ provider: string; reason: string; instructions?: string }>;
  approvalRequests?: Array<{ actionKey: string; actionType: string; reason: string; status: string }>;
  integrationWizard?: { autoLaunch: boolean; required: string[] };
  workflow?: { id: string; url: string; active: boolean } | null;
  workflowGraph?: WorkflowGraphSummary | null;
  automationBrain?: AutomationBrainSummary | null;
  safety?: { mode: 'safe' | 'staging' | 'production' };
  runtime?: { configured: boolean; error: string | null };
  state?: ConversationState;
  planner?: { readyToBuild?: boolean; canonicalPrompt?: string | null };
  sessionId?: string;
};