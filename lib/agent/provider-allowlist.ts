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

export const FORBIDDEN_PROVIDER_PATTERNS: RegExp[] = [
  /notify/i,
  /notification/i,
  /message/i,
  /storage/i,
  /upload/i,
  /dispatch/i,
  /manager/i,
  /action/i,
  /utility/i,
  /handler/i,
];

export const CANONICAL_PROVIDERS = [
  'stripe',
  'airtable',
  'openai',
  'slack',
  'gmail',
  'google_drive',
  'google_sheets',
  'telegram',
  'shopify',
  'hubspot',
  'elevenlabs',
  'claude',
  'facebook',
  'canva',
  'twitter',
  'whatsapp',
  'cloudflare_ai',
  'deepgram',
  'supabase',
] as const;

const CANONICAL_PROVIDER_SET = new Set<string>(CANONICAL_PROVIDERS);

export function toProviderToken(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

export function isCanonicalProvider(value: string): boolean {
  return CANONICAL_PROVIDER_SET.has(value);
}

export function hasForbiddenProviderPattern(value: string): boolean {
  if (!value) return false;
  return FORBIDDEN_PROVIDER_PATTERNS.some((pattern) => pattern.test(value));
}

export function isStrictProviderMode(): boolean {
  return process.env.STRICT_PROVIDER_MODE === 'true' || process.env.NEXT_PUBLIC_STRICT_PROVIDER_MODE === 'true';
}

export function normalizeProvider(value: string): string {
  const cleaned = value.toLowerCase().trim();
  if (!cleaned) return '';

  if (cleaned.includes('google drive') || cleaned.includes('googledrive') || cleaned.includes('drive storage') || cleaned.includes('save to drive') || cleaned.includes('upload to drive') || cleaned.includes('drive')) return 'google_drive';
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
  if (cleaned.includes('emailsend') || cleaned.includes('email') || cleaned.includes('smtp') || cleaned.includes('gmail')) return 'gmail';
  if (cleaned.includes('anthropic') || cleaned.includes('claude')) return 'claude';
  if (cleaned.includes('deepgram')) return 'deepgram';
  if (cleaned.includes('elevenlabs')) return 'elevenlabs';
  if (cleaned.includes('airtable')) return 'airtable';
  if (cleaned.includes('slack')) return 'slack';
  if (cleaned.includes('hubspot')) return 'hubspot';
  if (cleaned.includes('cloudflare ai') || cleaned.includes('cloudflare_ai') || cleaned.includes('workers ai') || cleaned.includes('workers_ai')) return 'cloudflare_ai';
  if (cleaned.includes('xai') || cleaned.includes('grok') || cleaned.includes('groq') || cleaned === 'x' || cleaned.includes('twitter')) return 'twitter';
  if (cleaned.includes('coinmarketcap') || cleaned === 'cmc') return 'coinmarketcap';
  if (cleaned.includes('supabase')) return 'supabase';
  if (cleaned.includes('postgres')) return 'postgres';

  return toProviderToken(cleaned);
}

const PROMPT_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\bstripe\b/i, provider: 'stripe' },
  { pattern: /\bairtable\b/i, provider: 'airtable' },
  { pattern: /\bopenai\b|\bgpt[-\s]?4\b|\bgpt\b/i, provider: 'openai' },
  { pattern: /\bgoogle\s*drive\b|\bgoogledrive\b|\bdrive storage\b|\bsave to drive\b|\bupload to google drive\b|\bupload to drive\b/i, provider: 'google_drive' },
  { pattern: /\bgoogle\s*sheets\b|\bgooglesheets\b/i, provider: 'google_sheets' },
  { pattern: /\bslack\b/i, provider: 'slack' },
  { pattern: /\bgmail\b|\bemail\b|\bsmtp\b/i, provider: 'gmail' },
  { pattern: /\btelegram\b/i, provider: 'telegram' },
  { pattern: /\bfacebook\b/i, provider: 'facebook' },
  { pattern: /\bcanva\b/i, provider: 'canva' },
  { pattern: /\bhubspot\b/i, provider: 'hubspot' },
  { pattern: /\bshopify\b/i, provider: 'shopify' },
  { pattern: /\belevenlabs\b/i, provider: 'elevenlabs' },
  { pattern: /\bclaude\b|\banthropic\b/i, provider: 'claude' },
  { pattern: /\bcloudflare\s*ai\b|\bworkers\s*ai\b/i, provider: 'cloudflare_ai' },
  { pattern: /\bcoinmarketcap\b|\bcmc\b/i, provider: 'coinmarketcap' },
  { pattern: /\bsupabase\b/i, provider: 'supabase' },
  { pattern: /\bwhatsapp\b/i, provider: 'whatsapp' },
  { pattern: /\bdeepgram\b/i, provider: 'deepgram' },
  { pattern: /\breddit\b/i, provider: 'reddit' },
  { pattern: /\btwitter\b|\bx\.com\b/i, provider: 'twitter' },
];

export function parseRequestedProvidersFromPrompt(prompt: string): string[] {
  const text = String(prompt ?? '');
  if (!text.trim()) return [];

  const providers = new Set<string>();
  for (const { pattern, provider } of PROMPT_PROVIDER_PATTERNS) {
    if (!pattern.test(text)) continue;
    const normalized = normalizeProvider(provider);
    if (!normalized || BLOCKED.has(normalized) || hasForbiddenProviderPattern(normalized) || !isCanonicalProvider(normalized)) continue;
    providers.add(normalized);
  }

  return Array.from(providers);
}

export function extractAllProvidersFromWorkflowGraph(graph?: WorkflowGraphSummary | null): string[] {
  if (!graph) return [];

  const providers = new Set<string>();
  for (const node of graph.nodes ?? []) {
    const provider = normalizeProvider(String(node.provider ?? node.integration ?? ''));
    if (!provider || BLOCKED.has(provider) || hasForbiddenProviderPattern(provider) || !isCanonicalProvider(provider)) continue;
    providers.add(provider);
  }

  return Array.from(providers);
}

export function extractProvidersFromWorkflowGraph(graph?: WorkflowGraphSummary | null): string[] {
  if (!graph) return [];

  const providers = new Set<string>();
  for (const node of graph.nodes ?? []) {
    if (!node.requiresCredentials) continue;
    const provider = normalizeProvider(node.provider ?? node.integration ?? '');
    if (!provider || BLOCKED.has(provider) || hasForbiddenProviderPattern(provider) || !isCanonicalProvider(provider)) continue;
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
