import { hasForbiddenProviderPattern, isCanonicalProvider, normalizeProvider as normalizeCanonicalProvider } from '@/lib/agent/provider-allowlist';
import { getProviderCredentialSchema } from '@/lib/agent/provider-credential-registry';

type N8nNode = {
  id?: string;
  name?: string;
  type?: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  label?: string;
  displayName?: string;
  provider?: string | null;
  integration?: string;
  capability?: string;
  requiresCredentials?: boolean;
  credentialSchema?: Array<{ key?: string; label?: string; required?: boolean }>;
  kind?: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
};

type N8nConnections = Record<string, { main?: Array<Array<{ node: string }>> }>;

function providerDisplayName(provider: string): string {
  if (provider === 'facebook') return 'Facebook';
  if (provider === 'canva') return 'Canva';
  if (provider === 'google_sheets') return 'Google Sheets';
  if (provider === 'google_drive') return 'Google Drive';
  if (provider === 'twitter') return 'X';
  if (provider === 'whatsapp') return 'WhatsApp';
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

export type WorkflowGraphNode = {
  id: string;
  name: string;
  label: string;
  type: string;
  position: [number, number];
  integration: string;
  provider: string | null;
  capability: string;
  requiresCredentials: boolean;
  credentialSchema: Array<{ key: string; label: string; required: boolean }>;
  displayName: string;
  kind: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
};

export type WorkflowGraphEdge = {
  from: string;
  to: string;
};

export type WorkflowGraphSummary = {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  executionOrder: string[];
  integrations: string[];
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
  retryNodes: string[];
  branches: number;
  schedule?: string;
};

const COST_BY_NODE_TYPE: Array<{ match: RegExp; latencyMs: number; costUsd: number; kind: WorkflowGraphNode['kind']; integration: string }> = [
  { match: /trigger|webhook|schedule|cron/i, latencyMs: 30, costUsd: 0, kind: 'trigger', integration: 'core' },
  { match: /openai|anthropic|gemini|groq|llm|ai/i, latencyMs: 2200, costUsd: 0.01, kind: 'ai', integration: 'ai' },
  { match: /if|switch|merge|wait/i, latencyMs: 120, costUsd: 0, kind: 'condition', integration: 'core' },
  { match: /gmail|email|slack|shopify|airtable|notion|hubspot|twilio/i, latencyMs: 500, costUsd: 0.001, kind: 'action', integration: 'integration' },
  { match: /.*/, latencyMs: 150, costUsd: 0, kind: 'utility', integration: 'core' },
];

function classifyNode(node: N8nNode): Pick<WorkflowGraphNode, 'kind' | 'integration' | 'estimatedLatencyMs' | 'estimatedCostUsd'> {
  const type = String(node.type ?? 'unknown');
  for (const rule of COST_BY_NODE_TYPE) {
    if (rule.match.test(type)) {
      return {
        kind: rule.kind,
        integration: rule.integration,
        estimatedLatencyMs: rule.latencyMs,
        estimatedCostUsd: rule.costUsd,
      };
    }
  }

  return {
    kind: 'utility',
    integration: 'core',
    estimatedLatencyMs: 150,
    estimatedCostUsd: 0,
  };
}

function inferScheduleLabel(node: N8nNode): string {
  const raw = JSON.stringify(node.parameters ?? {}).toLowerCase();
  if (/\*\/15\s+\*\s+\*\s+\*\s+\*/.test(raw) || (/15/.test(raw) && /minute|minutely/.test(raw))) {
    return 'Every 15 minutes';
  }
  if (/\*\/5\s+\*\s+\*\s+\*\s+\*/.test(raw) || (/5/.test(raw) && /minute|minutely/.test(raw))) {
    return 'Every 5 minutes';
  }
  if (/hour/.test(raw)) return 'Hourly schedule';
  if (/day|daily/.test(raw)) return 'Daily schedule';
  return 'Scheduled trigger';
}

function isScheduleTrigger(node: Pick<WorkflowGraphNode, 'kind' | 'label' | 'name' | 'provider' | 'type'>): boolean {
  if (node.kind !== 'trigger') return false;
  const haystack = `${node.label} ${node.name} ${node.provider ?? ''} ${node.type}`.toLowerCase();
  return /schedule|cron|interval|hourly|daily|minutely/.test(haystack);
}

function extractExplicitNodeMetadata(node: N8nNode): Pick<WorkflowGraphNode, 'provider' | 'capability' | 'requiresCredentials' | 'credentialSchema' | 'displayName' | 'label' | 'kind' | 'integration'> {
  const classified = classifyNode(node);
  const paramsMeta = ((node.parameters ?? {})['providerMeta'] ?? {}) as Record<string, unknown>;

  const providerInput =
    node.provider
    ?? (typeof node.integration === 'string' ? node.integration : null)
    ?? (typeof paramsMeta.provider === 'string' ? paramsMeta.provider : null)
    ?? null;

  const normalizedProvider = providerInput ? normalizeCanonicalProvider(String(providerInput)) : null;
  const canonicalProvider = normalizedProvider && isCanonicalProvider(normalizedProvider) && !hasForbiddenProviderPattern(normalizedProvider)
    ? normalizedProvider
    : null;
  const credentialSchema = getProviderCredentialSchema(canonicalProvider);
  const requiresCredentials = credentialSchema.length > 0;

  const rawKind = node.kind ?? (typeof paramsMeta.kind === 'string' ? paramsMeta.kind : undefined);
  const kind: WorkflowGraphNode['kind'] =
    rawKind === 'trigger' || rawKind === 'action' || rawKind === 'condition' || rawKind === 'ai' || rawKind === 'utility'
      ? rawKind
      : classified.kind;

  const name = String(node.name ?? 'Workflow step');
  const label = String(node.label ?? paramsMeta.label ?? (kind === 'trigger' ? inferScheduleLabel(node) : name));
  const displayName = String(node.displayName ?? paramsMeta.displayName ?? (canonicalProvider ? providerDisplayName(canonicalProvider) : name));
  const capability = String(node.capability ?? paramsMeta.capability ?? (canonicalProvider ? `${canonicalProvider}_operation` : 'workflow_step'));

  return {
    provider: canonicalProvider,
    capability,
    requiresCredentials,
    credentialSchema,
    displayName,
    label,
    kind,
    integration: canonicalProvider ?? classified.integration,
  };
}

export function buildWorkflowGraphSummary(workflow: { nodes?: unknown; connections?: unknown }): WorkflowGraphSummary {
  const rawNodes = Array.isArray(workflow.nodes) ? (workflow.nodes as N8nNode[]) : [];
  const connections = (workflow.connections ?? {}) as N8nConnections;

  const nodes: WorkflowGraphNode[] = rawNodes.map((n, index) => {
    const classified = classifyNode(n);
    const semantic = extractExplicitNodeMetadata(n);
    return {
      id: String(n.id ?? `node-${index + 1}`),
      name: String(n.name ?? `Node ${index + 1}`),
      label: semantic.label,
      type: String(n.type ?? 'unknown'),
      position: Array.isArray(n.position) ? n.position : [index * 180, 40],
      kind: semantic.kind,
      integration: semantic.integration,
      provider: semantic.provider,
      capability: semantic.capability,
      requiresCredentials: semantic.requiresCredentials,
      credentialSchema: semantic.credentialSchema,
      displayName: semantic.displayName,
      estimatedLatencyMs: classified.estimatedLatencyMs,
      estimatedCostUsd: classified.estimatedCostUsd,
    };
  });

  const nameToId = new Map(nodes.map((n) => [n.name, n.id]));

  const edges: WorkflowGraphEdge[] = [];
  for (const [sourceName, mapping] of Object.entries(connections)) {
    const sourceId = nameToId.get(sourceName);
    if (!sourceId) continue;
    const outputs = mapping.main ?? [];
    for (const lane of outputs) {
      for (const dest of lane) {
        const targetId = nameToId.get(String(dest.node));
        if (targetId) {
          edges.push({ from: sourceId, to: targetId });
        }
      }
    }
  }

  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const executionOrder: string[] = [];

  while (queue.length > 0) {
    const next = queue.shift()!;
    executionOrder.push(next);
    for (const edge of edges.filter((e) => e.from === next)) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 1) - 1);
      if ((indegree.get(edge.to) ?? 0) === 0) queue.push(edge.to);
    }
  }

  const retryNodes = nodes
    .filter((n) => /retry|wait|errortrigger|error/i.test(n.type) || /retry|wait/i.test(n.name))
    .map((n) => n.id);

  const integrations = Array.from(
    new Set(
      nodes
        .map((n) => normalizeCanonicalProvider(n.provider ?? 'core'))
        .map((provider) => providerDisplayName(provider))
    )
  );

  const branches = nodes.filter((n) => n.kind === 'condition').length;
  const estimatedLatencyMs = nodes.reduce((sum, n) => sum + n.estimatedLatencyMs, 0);
  const estimatedCostUsd = Number(nodes.reduce((sum, n) => sum + n.estimatedCostUsd, 0).toFixed(4));
  const scheduleNode = nodes.find((n) => n.provider === 'scheduler' || isScheduleTrigger(n));
  const schedule = scheduleNode?.label;

  return {
    nodes,
    edges,
    executionOrder,
    integrations,
    estimatedLatencyMs,
    estimatedCostUsd,
    retryNodes,
    branches,
    schedule,
  };
}
