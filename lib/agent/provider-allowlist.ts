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

/**
 * Free-text aliases under which each canonical provider can appear in pattern
 * metadata (names, descriptions, examples, intent keywords).
 *
 * Rules for inclusion:
 *   - Specific enough to avoid false positives in normal English prose.
 *   - Single-word abbreviations ('wa', 'tg', 'fb') rely on word-boundary
 *     matching at the call site (\b…\b) — they are NOT matched as substrings.
 *   - Generic words ('email', 'sheets', 'meta' alone) are excluded; they
 *     require a qualifying word to disambiguate ('google sheets', 'meta messaging').
 *
 * Each entry's first element is the canonical readable form (underscores
 * replaced by spaces). expandProviderAliases() always returns at least that.
 */
const PROVIDER_ALIASES_MAP: Readonly<Partial<Record<string, readonly string[]>>> = {
  whatsapp:      ['whatsapp', 'wa', 'whatsapp business', 'meta messaging'],
  telegram:      ['telegram', 'tg'],
  gmail:         ['gmail'],
  google_sheets: ['google sheets', 'googlesheets', 'gsheet', 'gsheets'],
  google_drive:  ['google drive',  'googledrive',  'gdrive'],
  slack:         ['slack'],
  openai:        ['openai', 'gpt', 'chatgpt'],
  claude:        ['claude', 'anthropic'],
  cloudflare_ai: ['cloudflare ai', 'workers ai'],
  facebook:      ['facebook', 'fb'],
  twitter:       ['twitter', 'x.com'],
  hubspot:       ['hubspot', 'hub spot'],
  shopify:       ['shopify'],
  stripe:        ['stripe'],
  airtable:      ['airtable'],
  supabase:      ['supabase'],
  elevenlabs:    ['elevenlabs'],
  deepgram:      ['deepgram'],
  canva:         ['canva'],
};

/**
 * Returns all text forms (canonical + aliases) under which a provider may
 * appear in pattern metadata. Callers should match each alias with a
 * word-boundary regex (\b…\b) rather than a plain substring check.
 *
 * For providers absent from the alias map the canonical space-normalised
 * form is returned so the function is always safe to call for any provider.
 */
export function expandProviderAliases(provider: string): readonly string[] {
  const mapped = PROVIDER_ALIASES_MAP[provider];
  if (mapped) return mapped;
  const token = provider.replace(/_/g, ' ');
  return token !== provider ? [token, provider] : [provider];
}

/**
 * Normalizes a metadata text fragment before alias scanning.
 * Replaces hyphens and underscores with spaces so compound forms like
 * "telegram_bot", "WA-Business", "GPT-4" are split into word tokens
 * that word-boundary regexes (\b…\b) can match correctly.
 *
 * Examples:
 *   "WA-Business"   → "wa business"
 *   "telegram_bot"  → "telegram bot"
 *   "GPT-4"         → "gpt 4"
 *   "hub-spot"      → "hub spot"
 */
export function normalizeForProviderScan(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── negation detection ────────────────────────────────────────────────────────

const NEGATION_TOKENS = new Set(['no', 'without', 'never', 'exclude', 'excluding', 'remove', 'disable']);
const COMPOUND_NEGATIONS = ['absolutely no'] as const;

function windowHasNegation(tokens: string[], windowStr: string): boolean {
  for (const compound of COMPOUND_NEGATIONS) {
    if (windowStr.endsWith(compound) || windowStr.includes(compound + ' ')) return true;
  }
  for (const token of tokens) {
    const clean = token.replace(/[''']/g, ''); // normalise don't / don't → dont
    if (NEGATION_TOKENS.has(clean) || clean === 'dont') return true;
  }
  return false;
}

function isNegatedAt(lower: string, termIndex: number): boolean {
  const before = lower.slice(0, termIndex);
  // Use only the current sentence (text after the last sentence-ender).
  // If the term opens a new sentence the fragment is empty → no negation.
  const parts = before.split(/[.!?\n]+/);
  const currentSentenceBefore = (parts[parts.length - 1] ?? '').trim();
  const tokens = currentSentenceBefore.split(/\s+/).filter(Boolean).slice(-6);
  const windowStr = tokens.join(' ');
  return windowHasNegation(tokens, windowStr);
}

/**
 * Returns true if every occurrence of `term` in `text` is preceded (within
 * the same sentence) by a negation word within a 6-token window.
 * Returns false if any occurrence is non-negated, or if the term is absent.
 *
 * Examples:
 *   isNegated("No Google Sheets", "Google Sheets")            → true
 *   isNegated("Telegram + Google Sheets integration", "Sheets") → false
 *   isNegated("No Sheets. Use Sheets for export.", "Sheets")  → false
 */
export function isNegated(text: string, term: string): boolean {
  const lower = text.toLowerCase();
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    found = true;
    if (!isNegatedAt(lower, m.index)) return false;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────

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

type ProviderAlias = { provider: string; test: (s: string) => boolean };

const PROVIDER_ALIAS_TABLE: ProviderAlias[] = [
  { provider: 'google_drive',  test: s => s.includes('google drive') || s.includes('googledrive') || s.includes('google-drive') || s.includes('google_drive') || s.includes('drive storage') || s.includes('save to drive') || s.includes('upload to drive') || s === 'gdrive' },
  { provider: 'google_sheets', test: s => s.includes('google sheets') || s.includes('googlesheets') || s.includes('google-sheet') || s.includes('google_sheet') || s.includes('sheets') },
  { provider: 'facebook',      test: s => s.includes('facebook') },
  { provider: 'canva',         test: s => s.includes('canva') },
  { provider: 'openai',        test: s => s.includes('openai') || s.includes('gpt') || /\b(o1|o3|o4)\b/.test(s) },
  { provider: 'telegram',      test: s => s.includes('telegram') },
  { provider: 'reddit',        test: s => s.includes('reddit') },
  { provider: 'whatsapp',      test: s => s.includes('whatsapp') },
  { provider: 'gmail',         test: s => s.includes('emailsend') || s.includes('email') || s.includes('smtp') || s.includes('gmail') },
  { provider: 'claude',        test: s => s.includes('anthropic') || s.includes('claude') },
  { provider: 'deepgram',      test: s => s.includes('deepgram') },
  { provider: 'elevenlabs',    test: s => s.includes('elevenlabs') },
  { provider: 'airtable',      test: s => s.includes('airtable') },
  { provider: 'slack',         test: s => s.includes('slack') },
  { provider: 'hubspot',       test: s => s.includes('hubspot') },
  { provider: 'cloudflare_ai', test: s => s.includes('cloudflare ai') || s.includes('cloudflare_ai') || s.includes('workers ai') || s.includes('workers_ai') },
  { provider: 'twitter',       test: s => s.includes('xai') || s.includes('grok') || s === 'x' || s.includes('twitter') },
  { provider: 'coinmarketcap', test: s => s.includes('coinmarketcap') || s === 'cmc' },
  { provider: 'supabase',      test: s => s.includes('supabase') },
  { provider: 'postgres',      test: s => s.includes('postgres') },
  { provider: 'shopify',       test: s => s.includes('shopify') },
  { provider: 'stripe',        test: s => s.includes('stripe') },
];

export function normalizeProvider(value: string): string {
  const cleaned = value.toLowerCase().trim();
  if (!cleaned) return '';

  const matches = PROVIDER_ALIAS_TABLE.filter(({ test }) => test(cleaned));
  if (matches.length === 1) return matches[0].provider;
  if (matches.length > 1) return '';  // ambiguous compound input — filtered downstream
  return toProviderToken(cleaned);
}

export const PROMPT_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
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
  const lower = text.toLowerCase();

  const providers = new Set<string>();
  for (const { pattern, provider } of PROMPT_PROVIDER_PATTERNS) {
    // Iterate all occurrences; skip this provider only if every occurrence is negated.
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    let hasNonNegatedMatch = false;

    while ((match = re.exec(text)) !== null) {
      if (!isNegatedAt(lower, match.index)) {
        hasNonNegatedMatch = true;
        break;
      }
    }

    if (!hasNonNegatedMatch) continue;
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
