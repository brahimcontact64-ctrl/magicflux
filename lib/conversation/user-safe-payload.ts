import { getProviderCredentialSchema } from '@/lib/agent/provider-credential-registry';
import { hasForbiddenProviderPattern, isCanonicalProvider } from '@/lib/agent/provider-allowlist';
import { sanitizeAutomationBrainForGraph } from '@/lib/automation/sanitize-automation-brain-for-graph';

type SafeProgressStatus = 'working' | 'success' | 'warning' | 'error';

type SafeAgentEvent = {
  type: string;
  label: string;
  detail?: string;
};

const TOOL_NAME_ALLOWLIST = new Set([
  'generate_workflow_json',
  'explain_workflow_architecture',
  'request_credential',
  'validate_credential',
  'deploy_workflow_to_n8n',
  'activate_workflow',
  'test_workflow',
  'get_execution_logs',
]);

const INTERNAL_FIELD_PATTERN =
  /(workflow_json|queue[_-]?id|execution[_-]?id|trace[_-]?id|correlation[_-]?id|tool[_-]?args|runtime[_-]?state|provider[_-]?metadata|metadata|debug|secret|token|env|internal|payload|graph|nodes|connections|n8n)/i;

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;

function normalizeProvider(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!cleaned || cleaned === 'core' || cleaned === 'integration') return 'core';
  if (cleaned.includes('googledrive') || cleaned.includes('drivestorage') || cleaned.includes('savetodrive') || cleaned.includes('uploadtodrive') || cleaned.includes('drive')) return 'google_drive';
  if (cleaned.includes('whatsapp')) return 'whatsapp';
  if (cleaned.includes('emailsend') || cleaned.includes('email') || cleaned.includes('smtp') || cleaned.includes('gmail')) return 'gmail';
  if (cleaned.includes('openai')) return 'openai';
  if (cleaned.includes('claude') || cleaned.includes('anthropic')) return 'claude';
  if (cleaned.includes('deepgram')) return 'deepgram';
  if (cleaned.includes('coinmarketcap') || cleaned === 'cmc') return 'coinmarketcap';
  if (cleaned.includes('telegram')) return 'telegram';
  if (cleaned.includes('slack')) return 'slack';
  if (cleaned.includes('airtable')) return 'airtable';
  if (cleaned.includes('supabase')) return 'supabase';
  if (cleaned.includes('reddit')) return 'reddit';
  if (cleaned.includes('shopify')) return 'shopify';
  if (cleaned.includes('stripe')) return 'stripe';
  if (cleaned.includes('twitter') || cleaned === 'x' || cleaned.includes('xai') || cleaned.includes('grok') || cleaned.includes('groq')) return 'twitter';
  return cleaned;
}

function providerDisplayName(provider: string): string {
  if (provider === 'whatsapp') return 'WhatsApp';
  if (provider === 'google_drive') return 'Google Drive';
  if (provider === 'gmail') return 'Gmail';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'claude') return 'Claude';
  if (provider === 'deepgram') return 'Deepgram';
  if (provider === 'coinmarketcap') return 'CoinMarketCap';
  if (provider === 'telegram') return 'Telegram';
  if (provider === 'slack') return 'Slack';
  if (provider === 'airtable') return 'Airtable';
  if (provider === 'supabase') return 'Supabase';
  if (provider === 'reddit') return 'Reddit';
  if (provider === 'shopify') return 'Shopify';
  if (provider === 'stripe') return 'Stripe';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function sanitizeText(input: unknown, fallback = ''): string {
  const raw = typeof input === 'string' ? input : fallback;
  const withoutFences = raw.replace(CODE_FENCE_PATTERN, ' ').trim();
  if (!withoutFences) return fallback;

  const compact = withoutFences.replace(/\s+/g, ' ').trim();
  const isJsonLike = (/^[\[{]/.test(compact) && /[\]}]$/.test(compact)) || /"\w+"\s*:\s*/.test(compact);

  if (isJsonLike && INTERNAL_FIELD_PATTERN.test(compact)) {
    return fallback;
  }

  const strippedIds = compact
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[redacted-id]')
    .replace(/\b(queue|execution|trace|correlation)[_-]id\b/gi, '[redacted-id-field]');

  return strippedIds.slice(0, 2000).trim();
}

function sanitizeProgressStatus(value: unknown): SafeProgressStatus {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'error') return 'error';
  if (raw === 'warning') return 'warning';
  if (raw === 'success' || raw === 'done') return 'success';
  return 'working';
}

function sanitizeToolName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  return TOOL_NAME_ALLOWLIST.has(input) ? input : undefined;
}

function sanitizeAgentEvents(input: unknown): SafeAgentEvent[] {
  if (!Array.isArray(input)) return [];
  const safeEvents: SafeAgentEvent[] = [];
  for (const row of input) {
    const item = row as Record<string, unknown>;
    const label = sanitizeText(item.label, 'Progress update');
    if (!label) continue;
    const detail = sanitizeText(item.detail, '');
    safeEvents.push({
      type: typeof item.type === 'string' ? item.type : 'event',
      label,
      ...(detail ? { detail } : {}),
    });
  }
  return safeEvents;
}

function sanitizeCredentialCards(input: unknown): Array<{ provider: string; reason: string; instructions?: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((row) => {
      const item = row as Record<string, unknown>;
      const provider = sanitizeText(item.provider, '').toLowerCase();
      const reason = sanitizeText(item.reason, 'Connect integration to continue.');
      if (!provider || !reason) return null;
      const instructions = sanitizeText(item.instructions, '');
      return {
        provider,
        reason,
        ...(instructions ? { instructions } : {}),
      };
    })
    .filter((row): row is { provider: string; reason: string; instructions?: string } => Boolean(row));
}

function sanitizeApprovalCards(input: unknown): Array<{ actionType: string; reason: string; status: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((row) => {
      const item = row as Record<string, unknown>;
      const actionType = sanitizeText(item.actionType, '').slice(0, 120);
      const reason = sanitizeText(item.reason, 'Approval is required before continuing.');
      const status = sanitizeText(item.status, 'pending').slice(0, 32).toLowerCase();
      if (!actionType || !reason) return null;
      return { actionType, reason, status };
    })
    .filter((row): row is { actionType: string; reason: string; status: string } => Boolean(row));
}

function sanitizeWorkflowPreview(input: unknown):
  | {
      nodeCount: number;
      edgeCount: number;
      integrations: string[];
      estimatedLatencyMs?: number;
      estimatedCostUsd?: number;
    }
  | null {
  if (!input || typeof input !== 'object') return null;
  const graph = input as Record<string, unknown>;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;
  const integrations = Array.isArray(graph.integrations)
    ? graph.integrations
        .map((v) => sanitizeText(v, '').toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  if (nodes === 0 && edges === 0 && integrations.length === 0) return null;
  return {
    nodeCount: nodes,
    edgeCount: edges,
    integrations,
    ...(typeof graph.estimatedLatencyMs === 'number' ? { estimatedLatencyMs: graph.estimatedLatencyMs } : {}),
    ...(typeof graph.estimatedCostUsd === 'number' ? { estimatedCostUsd: graph.estimatedCostUsd } : {}),
  };
}

function sanitizeWorkflowGraph(input: unknown):
  | {
      nodes: Array<{
        id: string;
        name: string;
        label: string;
        type: string;
        kind: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
        provider: string;
        capability: string;
        requiresCredentials: boolean;
        credentialSchema: Array<{ key: string; label: string; required: boolean }>;
        displayName: string;
        position: [number, number];
      }>;
      edges: Array<{ from: string; to: string }>;
      integrations: string[];
      branches: number;
      schedule?: string;
      estimatedLatencyMs?: number;
      estimatedCostUsd?: number;
    }
  | null {
  if (!input || typeof input !== 'object') return null;

  const raw = input as Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((row) => {
          const node = row as Record<string, unknown>;
          const id = sanitizeText(node.id, '').slice(0, 120);
          const name = sanitizeText(node.name, '').slice(0, 160);
          const label = sanitizeText(node.label, name).slice(0, 160);
          const type = sanitizeText(node.type, 'unknown').slice(0, 180);
          const kindRaw = sanitizeText(node.kind, 'utility').toLowerCase();
          const kind = (['trigger', 'action', 'condition', 'ai', 'utility'].includes(kindRaw)
            ? kindRaw
            : 'utility') as 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
          const provider = sanitizeText(node.provider, 'core').toLowerCase().slice(0, 80);
          const normalizedProvider = normalizeProvider(provider);
          const canonicalProvider = isCanonicalProvider(normalizedProvider) ? normalizedProvider : 'core';
          const providerRejected = hasForbiddenProviderPattern(normalizedProvider)
            || (normalizedProvider !== 'core' && normalizedProvider !== 'integration' && !isCanonicalProvider(normalizedProvider));
          const capability = sanitizeText(node.capability, 'workflow_step').toLowerCase().slice(0, 80);
          const credentialSchema = providerRejected ? [] : getProviderCredentialSchema(canonicalProvider);
          const requiresCredentials = credentialSchema.length > 0;
          const displayName = sanitizeText(node.displayName, providerDisplayName(canonicalProvider)).slice(0, 120);
          const pos = Array.isArray(node.position) ? node.position : [0, 0];
          const x = typeof pos[0] === 'number' ? pos[0] : 0;
          const y = typeof pos[1] === 'number' ? pos[1] : 0;

          if (!id || !name) return null;
          return {
            id,
            name,
            label,
            type,
            kind,
            provider: canonicalProvider,
            capability,
            requiresCredentials,
            credentialSchema,
            displayName,
            position: [x, y] as [number, number],
          };
        })
        .filter((row): row is {
          id: string;
          name: string;
          label: string;
          type: string;
          kind: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
          provider: string;
          capability: string;
          requiresCredentials: boolean;
          credentialSchema: Array<{ key: string; label: string; required: boolean }>;
          displayName: string;
          position: [number, number];
        } => Boolean(row))
    : [];

  const edges = Array.isArray(raw.edges)
    ? raw.edges
        .map((row) => {
          const edge = row as Record<string, unknown>;
          const from = sanitizeText(edge.from, '').slice(0, 120);
          const to = sanitizeText(edge.to, '').slice(0, 120);
          if (!from || !to) return null;
          return { from, to };
        })
        .filter((row): row is { from: string; to: string } => Boolean(row))
    : [];

  const integrations = Array.isArray(raw.integrations)
    ? raw.integrations
        .map((value) => sanitizeText(value, '').toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  if (nodes.length === 0 && edges.length === 0 && integrations.length === 0) return null;

  return {
    nodes,
    edges,
    integrations,
    branches: typeof raw.branches === 'number' ? raw.branches : 0,
    ...(sanitizeText(raw.schedule, '') ? { schedule: sanitizeText(raw.schedule, '') } : {}),
    ...(typeof raw.estimatedLatencyMs === 'number' ? { estimatedLatencyMs: raw.estimatedLatencyMs } : {}),
    ...(typeof raw.estimatedCostUsd === 'number' ? { estimatedCostUsd: raw.estimatedCostUsd } : {}),
  };
}

function sanitizeDeploymentSummary(input: unknown):
  | {
      active: boolean;
      workflowUrl?: string;
      status: 'not_deployed' | 'deployed' | 'active';
    }
  | null {
  if (!input || typeof input !== 'object') return null;
  const workflow = input as Record<string, unknown>;
  const active = Boolean(workflow.active);
  const workflowUrl = sanitizeText(workflow.url, '');
  return {
    active,
    ...(workflowUrl ? { workflowUrl } : {}),
    status: active ? 'active' : workflowUrl ? 'deployed' : 'not_deployed',
  };
}

function sanitizeAutomationBrain(input: unknown):
  | {
      inferredIntent: string;
      capabilities: Array<{ key: string; reason: string; confidence: number }>;
      activatedSkillPacks: Array<{ name: string; description: string; capabilities: string[]; tools: string[]; matchScore: number }>;
      matchedPatterns: Array<{ name: string; category: string; score: number; estimatedCost: number; estimatedComplexity: string; risk: string }>;
      providerResolutions: Array<{ provider: string; capabilities: string[]; confidence: number }>;
      composition: {
        executionFrequency: string;
        expectedInputs: string[];
        expectedOutputs: string[];
        complexity: string;
        estimatedCostUsd: number;
        latencyEstimateMs: number;
        risks: string[];
      };
    }
  | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
        .map((row) => {
          const item = row as Record<string, unknown>;
          const key = sanitizeText(item.key, '').toLowerCase().slice(0, 80);
          const reason = sanitizeText(item.reason, '').slice(0, 220);
          const confidence = typeof item.confidence === 'number' ? Math.max(0, Math.min(100, item.confidence)) : 0;
          if (!key) return null;
          return { key, reason, confidence };
        })
        .filter((row): row is { key: string; reason: string; confidence: number } => Boolean(row))
        .slice(0, 24)
    : [];

  const activatedSkillPacks = Array.isArray(raw.activatedSkillPacks)
    ? raw.activatedSkillPacks
        .map((row) => {
          const item = row as Record<string, unknown>;
          const name = sanitizeText(item.name, '').slice(0, 120);
          if (!name) return null;
          return {
            name,
            description: sanitizeText(item.description, '').slice(0, 220),
            capabilities: Array.isArray(item.capabilities)
              ? item.capabilities.map((value) => sanitizeText(value, '').toLowerCase()).filter(Boolean).slice(0, 12)
              : [],
            tools: Array.isArray(item.tools)
              ? item.tools.map((value) => sanitizeText(value, '').toLowerCase()).filter(Boolean).slice(0, 12)
              : [],
            matchScore: typeof item.matchScore === 'number' ? item.matchScore : 0,
          };
        })
        .filter((row): row is { name: string; description: string; capabilities: string[]; tools: string[]; matchScore: number } => Boolean(row))
        .slice(0, 10)
    : [];

  const matchedPatterns = Array.isArray(raw.matchedPatterns)
    ? raw.matchedPatterns
        .map((row) => {
          const item = row as Record<string, unknown>;
          const name = sanitizeText(item.name, '').slice(0, 120);
          if (!name) return null;
          return {
            name,
            category: sanitizeText(item.category, 'general').toLowerCase().slice(0, 60),
            score: typeof item.score === 'number' ? item.score : 0,
            estimatedCost: typeof item.estimatedCost === 'number' ? item.estimatedCost : 0,
            estimatedComplexity: sanitizeText(item.estimatedComplexity, 'moderate').toLowerCase().slice(0, 24),
            risk: sanitizeText(item.risk, 'medium').toLowerCase().slice(0, 24),
          };
        })
        .filter((row): row is { name: string; category: string; score: number; estimatedCost: number; estimatedComplexity: string; risk: string } => Boolean(row))
        .slice(0, 10)
    : [];

  const providerResolutions = Array.isArray(raw.providerResolutions)
    ? raw.providerResolutions
        .map((row) => {
          const item = row as Record<string, unknown>;
          const provider = sanitizeText(item.provider, '').toLowerCase().slice(0, 80);
          if (!provider) return null;
          return {
            provider,
            capabilities: Array.isArray(item.capabilities)
              ? item.capabilities.map((value) => sanitizeText(value, '').toLowerCase()).filter(Boolean).slice(0, 10)
              : [],
            confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(100, item.confidence)) : 0,
          };
        })
        .filter((row): row is { provider: string; capabilities: string[]; confidence: number } => Boolean(row))
        .slice(0, 12)
    : [];

  const compositionRaw = (raw.composition ?? {}) as Record<string, unknown>;
  const composition = {
    executionFrequency: sanitizeText(compositionRaw.executionFrequency, 'Event-driven'),
    expectedInputs: Array.isArray(compositionRaw.expectedInputs)
      ? compositionRaw.expectedInputs.map((value) => sanitizeText(value, '')).filter(Boolean).slice(0, 12)
      : [],
    expectedOutputs: Array.isArray(compositionRaw.expectedOutputs)
      ? compositionRaw.expectedOutputs.map((value) => sanitizeText(value, '')).filter(Boolean).slice(0, 12)
      : [],
    complexity: sanitizeText(compositionRaw.complexity, 'moderate').toLowerCase().slice(0, 24),
    estimatedCostUsd: typeof compositionRaw.estimatedCostUsd === 'number' ? compositionRaw.estimatedCostUsd : 0,
    latencyEstimateMs: typeof compositionRaw.latencyEstimateMs === 'number' ? compositionRaw.latencyEstimateMs : 0,
    risks: Array.isArray(compositionRaw.risks)
      ? compositionRaw.risks.map((value) => sanitizeText(value, '')).filter(Boolean).slice(0, 8)
      : [],
  };

  if (capabilities.length === 0 && matchedPatterns.length === 0 && providerResolutions.length === 0) {
    return null;
  }

  return {
    inferredIntent: sanitizeText(raw.inferredIntent, 'Automation request'),
    capabilities,
    activatedSkillPacks,
    matchedPatterns,
    providerResolutions,
    composition,
  };
}

function sanitizeTokenPayload(payload: unknown): { text: string } {
  const raw = payload as Record<string, unknown>;
  const safeText = sanitizeText(raw?.text, '');
  if (!safeText || INTERNAL_FIELD_PATTERN.test(safeText)) {
    return { text: '' };
  }
  return { text: safeText };
}

function sanitizeStatusPayload(payload: unknown): { label: string; status: SafeProgressStatus } {
  const raw = payload as Record<string, unknown>;
  return {
    label: sanitizeText(raw?.message ?? raw?.label, 'Working on your automation...'),
    status: sanitizeProgressStatus(raw?.type ?? raw?.status),
  };
}

function sanitizeToolEventPayload(payload: unknown): {
  event: SafeAgentEvent;
  toolName?: string;
  workflowPreview?: NonNullable<ReturnType<typeof sanitizeWorkflowPreview>>;
  workflowGraph?: NonNullable<ReturnType<typeof sanitizeWorkflowGraph>>;
} {
  const raw = payload as Record<string, unknown>;
  const event = (raw?.event ?? {}) as Record<string, unknown>;

  const safeEvent: SafeAgentEvent = {
    type: typeof event.type === 'string' ? event.type : 'event',
    label: sanitizeText(event.label, 'Progress update'),
    detail: sanitizeText(event.detail, ''),
  };

  const workflowPreview = sanitizeWorkflowPreview(raw?.workflowGraph);
  const workflowGraph = sanitizeWorkflowGraph(raw?.workflowGraph);

  return {
    event: safeEvent,
    ...(sanitizeToolName(raw?.toolName) ? { toolName: sanitizeToolName(raw?.toolName) } : {}),
    ...(workflowPreview ? { workflowPreview } : {}),
    ...(workflowGraph ? { workflowGraph } : {}),
  };
}

function sanitizeFinalPayload(payload: unknown): {
  payload: {
    assistant: { content: string; options?: string[] };
    agentEvents: SafeAgentEvent[];
    credentialRequests: Array<{ provider: string; reason: string; instructions?: string }>;
    approvalRequests: Array<{ actionType: string; reason: string; status: string }>;
    workflowPreview: ReturnType<typeof sanitizeWorkflowPreview>;
    workflowGraph: ReturnType<typeof sanitizeWorkflowGraph>;
    automationBrain: ReturnType<typeof sanitizeAutomationBrain>;
    deploymentStatus: ReturnType<typeof sanitizeDeploymentSummary>;
  };
} {
  const rawEnvelope = payload as Record<string, unknown>;
  const raw = ((rawEnvelope.payload ?? rawEnvelope) ?? {}) as Record<string, unknown>;
  const assistant = (raw.assistant ?? {}) as Record<string, unknown>;
  const options = Array.isArray(assistant.options)
    ? assistant.options.map((option) => sanitizeText(option, '')).filter(Boolean).slice(0, 6)
    : [];
  const workflowGraph = sanitizeWorkflowGraph(raw.workflowGraph);
  const automationBrain = sanitizeAutomationBrainForGraph(
    sanitizeAutomationBrain(raw.automationBrain),
    (workflowGraph ?? undefined) as any
  );

  return {
    payload: {
      assistant: {
        content: sanitizeText(assistant.content, 'I prepared your automation and can continue with the next step.'),
        ...(options.length > 0 ? { options } : {}),
      },
      agentEvents: sanitizeAgentEvents(raw.agentEvents),
      credentialRequests: sanitizeCredentialCards(raw.credentialRequests),
      approvalRequests: sanitizeApprovalCards(raw.approvalRequests),
      workflowPreview: sanitizeWorkflowPreview(raw.workflowGraph),
      workflowGraph,
      automationBrain,
      deploymentStatus: sanitizeDeploymentSummary(raw.workflow),
    },
  };
}

function sanitizeErrorPayload(payload: unknown): { message: string } {
  const raw = payload as Record<string, unknown>;
  return {
    message: sanitizeText(raw?.message, 'Conversation streaming failed'),
  };
}

export function createUserSafeAssistantPayload(
  event: 'token' | 'status' | 'tool_event' | 'final' | 'error',
  payload: unknown
): Record<string, unknown> {
  if (event === 'token') return sanitizeTokenPayload(payload);
  if (event === 'status') return sanitizeStatusPayload(payload);
  if (event === 'tool_event') return sanitizeToolEventPayload(payload);
  if (event === 'final') return sanitizeFinalPayload(payload);
  return sanitizeErrorPayload(payload);
}
