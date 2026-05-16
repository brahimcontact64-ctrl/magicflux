import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';

const BLOCKED = new Set([
  'core',
  'integration',
  'scheduler',
  'webhook',
  'utility',
  'httprequest',
  'http_request',
  'ai_provider',
]);

export function isStrictProviderMode(): boolean {
  return process.env.STRICT_PROVIDER_MODE === 'true' || process.env.NEXT_PUBLIC_STRICT_PROVIDER_MODE === 'true';
}

export function normalizeProvider(value: string): string {
  const cleaned = value.toLowerCase().trim();
  if (!cleaned) return '';

  if (cleaned.includes('google sheets') || cleaned.includes('googlesheets') || cleaned.includes('sheets')) return 'google_sheets';
  if (cleaned.includes('facebook')) return 'facebook';
  if (cleaned.includes('canva')) return 'canva';
  if (
    cleaned.includes('openai') ||
    cleaned.includes('gpt') ||
    cleaned.includes('gpt-4') ||
    cleaned.includes('gpt4') ||
    cleaned.includes('gpt-4o') ||
    /\b(o1|o3|o4)\b/.test(cleaned)
  ) return 'openai';
  if (cleaned.includes('telegram')) return 'telegram';
  if (cleaned.includes('reddit')) return 'reddit';
  if (cleaned.includes('whatsapp')) return 'whatsapp';
  if (cleaned.includes('emailsend') || cleaned.includes('email') || cleaned.includes('smtp') || cleaned.includes('gmail')) return 'email';
  if (cleaned.includes('anthropic') || cleaned.includes('claude')) return 'claude';
  if (cleaned.includes('deepgram')) return 'deepgram';
  if (cleaned.includes('airtable')) return 'airtable';
  if (cleaned.includes('slack')) return 'slack';
  if (cleaned.includes('xai') || cleaned.includes('grok') || cleaned.includes('groq')) return 'grok';
  if (cleaned.includes('coinmarketcap') || cleaned === 'cmc') return 'coinmarketcap';
  if (cleaned.includes('supabase')) return 'supabase';
  if (cleaned.includes('postgres')) return 'postgres';

  return cleaned.replace(/[^a-z0-9_]/g, '_');
}

export function extractProvidersFromWorkflowGraph(graph?: WorkflowGraphSummary | null): string[] {
  if (!graph) return [];

  const providers = new Set<string>();
  for (const node of graph.nodes ?? []) {
    if (!node.requiresCredentials) continue;
    const provider = normalizeProvider(node.provider ?? node.integration ?? '');
    if (!provider || BLOCKED.has(provider)) continue;
    providers.add(provider);
  }

  return Array.from(providers);
}

export function filterProvidersToGraphAllowList(
  providers: string[],
  graph?: WorkflowGraphSummary | null
): string[] {
  const allowList = new Set(extractProvidersFromWorkflowGraph(graph));
  if (allowList.size === 0) {
    return Array.from(
      new Set(
        providers
          .map((provider) => normalizeProvider(provider))
          .filter(Boolean)
      )
    );
  }

  const filtered = providers
    .map((provider) => normalizeProvider(provider))
    .filter((provider) => provider && allowList.has(provider));

  return Array.from(new Set(filtered));
}
