import {
  CANONICAL_PROVIDERS,
  isCanonicalProvider,
  isNegated,
  normalizeProvider,
  parseRequestedProvidersFromPrompt,
  PROMPT_PROVIDER_PATTERNS,
} from '@/lib/agent/provider-allowlist';
import type { ActionMode, ConstraintContext, ExecutionMode, IntentContext, ProviderIntentGraph, TriggerMode } from './types';

const AI_PROVIDERS = ['openai', 'claude', 'cloudflare_ai', 'elevenlabs', 'deepgram', 'twitter'];
const AI_CAPABILITIES = ['chatbot', 'memory', 'text_to_speech', 'speech_to_text', 'vision_analysis', 'vector_search', 'ai_scoring'];
const EXTRACTION_CAPABILITIES = ['document_extraction', 'scraping', 'search', 'lead_enrichment'];

const PROVIDER_ALIASES: Record<string, string[]> = {
  gmail: ['email', 'gmail', 'smtp'],
  google_sheets: ['google sheets', 'googlesheets', 'sheets'],
  google_drive: ['google drive', 'googledrive', 'drive'],
  cloudflare_ai: ['cloudflare ai', 'workers ai'],
};

const EXECUTION_MODE_SIGNALS: Record<ExecutionMode, string[]> = {
  'event-driven': ['when', 'arrives', 'arrive', 'received', 'triggered', 'event driven', 'new '],
  scheduled: ['every', 'daily', 'weekly', 'hourly', 'cron', 'schedule'],
  manual: ['manual', 'on demand', 'manually'],
  unknown: [],
};

const TRIGGER_MODE_SIGNALS: Record<TriggerMode, string[]> = {
  message: ['message', 'dm', 'chat', 'inbox'],
  email: ['email', 'gmail', 'inbox'],
  webhook: ['webhook', 'callback', 'http request'],
  scheduler: ['every', 'daily', 'weekly', 'hourly', 'cron', 'schedule'],
  unknown: [],
};

const ACTION_MODE_SIGNALS: Record<ActionMode, string[]> = {
  reply: ['reply', 'respond', 'answer back'],
  summarize: ['summarize', 'summary', 'digest'],
  sync: ['sync', 'mirror', 'copy to', 'push to'],
  notify: ['notify', 'alert', 'send notification'],
  transform: ['transform', 'extract', 'parse', 'format'],
  unknown: [],
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeText(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
}

function normalizeProviders(providers: string[]): string[] {
  return unique(
    providers
      .map((provider) => normalizeProvider(provider))
      .filter(Boolean)
  );
}

function aliasesForProvider(provider: string): string[] {
  return PROVIDER_ALIASES[provider] ?? [provider.replace(/_/g, ' ')];
}

function mergeCapabilities(...groups: string[][]): string[] {
  return unique(
    groups
      .flat()
      .map((capability) => capability.trim())
      .filter(Boolean)
  );
}

function scoreMode<TMode extends string>(normalized: string, signals: Record<TMode, string[]>): TMode {
  let bestMode = 'unknown' as TMode;
  let bestScore = 0;

  for (const [mode, candidates] of Object.entries(signals) as Array<[TMode, string[]]>) {
    if (mode === 'unknown') continue;
    const score = candidates.filter((candidate) => normalized.includes(candidate)).length;
    if (score > bestScore) {
      bestMode = mode;
      bestScore = score;
    }
  }

  return bestMode;
}

// Matches: no, without, never [use], exclude, excluding, remove, disable,
// absolutely no, don't use (normalized form: "don t use" or "dont use").
const FORBIDDEN_PREFIX_RE =
  '(?:absolutely\\s+no|(?:don\\s+t|dont)\\s+use|\\bno\\b|\\bwithout\\b' +
  '|\\bnever(?:\\s+use)?\\b|\\bexclude\\b|\\bexcluding\\b|\\bremove\\b|\\bdisable\\b)';

function parseForbiddenProvidersFromPrompt(normalized: string): string[] {
  const forbidden = new Set<string>();

  for (const provider of CANONICAL_PROVIDERS) {
    const aliases = aliasesForProvider(provider);
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`${FORBIDDEN_PREFIX_RE}\\s+${escaped}`);
      if (pattern.test(normalized)) {
        forbidden.add(provider);
        break;
      }
    }
  }

  return Array.from(forbidden);
}

function hasProviderOnlyPhrase(normalized: string, providers: string[]): boolean {
  return providers.some((provider) => {
    return aliasesForProvider(provider).some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\bonly\\s+${escaped}\\b|\\b${escaped}\\s+only\\b`).test(normalized);
    });
  });
}

function inferRequiredCapabilities(intent: IntentContext, normalized: string): string[] {
  const required: string[] = [];

  if (intent.executionMode === 'scheduled' || intent.triggerMode === 'scheduler') {
    required.push('scheduling');
  }

  if (intent.triggerMode === 'message') {
    required.push('receive_message');
  }

  if (intent.actionMode === 'reply' || normalized.includes('reply with') || normalized.includes('respond with')) {
    required.push('send_message');
  }

  if (intent.actionMode === 'summarize' && !/\bno\s+ai\b|\bwithout\s+ai\b|\bai\s+disabled\b/.test(normalized)) {
    required.push('chatbot');
  }

  return unique(required);
}

function inferForbiddenProviders(normalized: string): string[] {
  const forbidden = new Set<string>(parseForbiddenProvidersFromPrompt(normalized));

  if (/\bno\s+ai\b|\bwithout\s+ai\b|\bai\s+disabled\b/.test(normalized)) {
    for (const provider of AI_PROVIDERS) {
      forbidden.add(provider);
    }
  }

  return Array.from(forbidden);
}

function inferAllowedProviders(intent: IntentContext, normalized: string, requiredProviders: string[]): string[] {
  const allowed = new Set<string>();
  const explicitOnly = hasProviderOnlyPhrase(normalized, requiredProviders);

  if (requiredProviders.length > 0) {
    for (const provider of requiredProviders) {
      allowed.add(provider);
    }
  }

  if (!/\bno\s+ai\b|\bwithout\s+ai\b|\bai\s+disabled\b/.test(normalized) && intent.actionMode === 'summarize') {
    for (const provider of AI_PROVIDERS) {
      allowed.add(provider);
    }
  }

  if (intent.executionMode === 'scheduled') {
    allowed.add('scheduler');
  }

  if (!explicitOnly && intent.actionMode === 'unknown' && intent.triggerMode === 'unknown') {
    return [];
  }

  return Array.from(allowed);
}

export function extractIntentContext(prompt: string): IntentContext {
  const normalized = normalizeText(prompt);

  return {
    rawPrompt: prompt,
    requestedProviders: parseRequestedProvidersFromPrompt(prompt),
    executionMode: scoreMode(normalized, EXECUTION_MODE_SIGNALS),
    triggerMode: scoreMode(normalized, TRIGGER_MODE_SIGNALS),
    actionMode: scoreMode(normalized, ACTION_MODE_SIGNALS),
  };
}

export function extractHardConstraints(prompt: string): ConstraintContext {
  const normalized = normalizeText(prompt);
  const intent = extractIntentContext(prompt);

  // forbiddenProviders must be resolved before requiredProviders so negated
  // providers ("No Google Sheets") are subtracted before they can be promoted
  // to required status by parseRequestedProvidersFromPrompt.
  const forbiddenProviders = inferForbiddenProviders(normalized);
  const requiredProviders = unique([
    ...intent.requestedProviders,
    ...(intent.executionMode === 'scheduled' ? ['scheduler'] : []),
  ]).filter((p) => !forbiddenProviders.includes(p));
  const allowedProviders = inferAllowedProviders(intent, normalized, requiredProviders)
    .filter((provider) => !forbiddenProviders.includes(provider));
  const requiredCapabilities = inferRequiredCapabilities(intent, normalized);
  const forbiddenCapabilities = mergeCapabilities(
    /\bno\s+ai\b|\bwithout\s+ai\b|\bai\s+disabled\b/.test(normalized) ? AI_CAPABILITIES : [],
    /\bno\s+extraction\b|\bwithout\s+extraction\b|\bextraction\s+disabled\b/.test(normalized) ? EXTRACTION_CAPABILITIES : [],
    /\bno\s+monitor(?:ing)?\b/.test(normalized) ? ['monitoring'] : [],
    /\bno\s+(?:log(?:ging)?|analytics)\b/.test(normalized) ? ['analytics', 'reporting'] : [],
    /\bno\s+(?:log(?:ging)?|storage|database)\b/.test(normalized) ? ['database_storage'] : [],
    intent.executionMode === 'event-driven' ? ['scheduling', 'calendar'] : []
  );

  return {
    requiredProviders,
    allowedProviders,
    forbiddenProviders,
    requiredCapabilities,
    forbiddenCapabilities,
    executionMode: intent.executionMode,
    triggerMode: intent.triggerMode,
    actionMode: intent.actionMode,
    // identityLocked is true only when the user expressed an explicit
    // "X only" or "only X" restriction — not merely because providers were
    // mentioned.  "Forward Gmail to Slack. No Airtable." is NOT locked.
    // "Telegram only." IS locked.
    identityLocked: hasProviderOnlyPhrase(normalized, requiredProviders),
  };
}

export function isProviderAllowed(provider: string, constraints: ConstraintContext): boolean {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return true;
  if (constraints.allowedProviders.length > 0 && !constraints.allowedProviders.includes(normalizedProvider)) return false;
  if (constraints.forbiddenProviders.includes(normalizedProvider)) return false;
  return true;
}

export function isCapabilityAllowed(capability: string, constraints: ConstraintContext): boolean {
  return !constraints.forbiddenCapabilities.includes(capability);
}

export function filterProviders(providers: string[], constraints: ConstraintContext): string[] {
  return normalizeProviders(providers).filter((provider) => isProviderAllowed(provider, constraints));
}

export function filterCapabilities(capabilities: string[], constraints: ConstraintContext): string[] {
  const filtered = capabilities.filter((capability) => isCapabilityAllowed(capability, constraints));
  return unique([...filtered, ...constraints.requiredCapabilities.filter((capability) => isCapabilityAllowed(capability, constraints))]);
}

export function areProvidersAllowed(providers: string[], constraints: ConstraintContext): boolean {
  return filterProviders(providers, constraints).length === normalizeProviders(providers).length;
}

export function areCapabilitiesAllowed(capabilities: string[], constraints: ConstraintContext): boolean {
  return capabilities.every((capability) => isCapabilityAllowed(capability, constraints));
}

export function areSchedulePatternsAllowed(schedulePatterns: string[], constraints: ConstraintContext): boolean {
  if (constraints.executionMode !== 'event-driven') return true;
  return schedulePatterns.every((pattern) => {
    const normalized = pattern.toLowerCase();
    return normalized.includes('event-driven') || normalized.includes('manual') || normalized.includes('on-demand');
  });
}

export function violatesConstraints(
  _name: string,
  constraints: ConstraintContext,
  providers: string[] = [],
  capabilities: string[] = [],
  schedulePatterns: string[] = []
): boolean {
  if (!areProvidersAllowed(providers, constraints)) return true;
  if (!areCapabilitiesAllowed(capabilities, constraints)) return true;
  if (!areSchedulePatternsAllowed(schedulePatterns, constraints)) return true;
  return false;
}

export function shouldBoostPattern(
  providers: string[],
  capabilities: string[],
  constraints: ConstraintContext
): boolean {
  if (constraints.actionMode !== 'reply') return false;
  const filteredProviders = filterProviders(providers, constraints);
  const filteredCapabilities = filterCapabilities(capabilities, constraints);
  return filteredProviders.length > 0
    && filteredCapabilities.includes('send_message')
    && (filteredCapabilities.includes('receive_message') || constraints.triggerMode === 'email');
}

const COMPUTE_RISK_AI_CAP_SET = new Set([
  'chatbot', 'memory', 'vector_search', 'ai_scoring',
  'speech_to_text', 'text_to_speech', 'vision_analysis',
]);
const COMPUTE_RISK_AI_PROVIDERS = new Set([
  'openai', 'claude', 'cloudflare_ai', 'elevenlabs', 'deepgram',
]);
const COMPUTE_RISK_STORAGE_CAPS = new Set(['database_storage', 'memory']);
const COMPUTE_RISK_MONITORING_CAPS = new Set(['monitoring', 'analytics', 'reporting']);

export function computePatternRisk(
  capabilities: string[],
  constraints: ConstraintContext
): 'low' | 'medium' | 'high' {
  const providerCount = Math.max(
    constraints.allowedProviders.length,
    constraints.requiredProviders.length
  );
  const containsAI =
    capabilities.some((c) => COMPUTE_RISK_AI_CAP_SET.has(c)) ||
    constraints.allowedProviders.some((p) => COMPUTE_RISK_AI_PROVIDERS.has(p)) ||
    constraints.requiredProviders.some((p) => COMPUTE_RISK_AI_PROVIDERS.has(p));
  const containsStorage = capabilities.some((c) => COMPUTE_RISK_STORAGE_CAPS.has(c));
  const containsMonitoring = capabilities.some((c) => COMPUTE_RISK_MONITORING_CAPS.has(c));

  if (
    providerCount <= 1 &&
    capabilities.length <= 2 &&
    !containsAI &&
    !containsStorage &&
    !containsMonitoring
  ) {
    return 'low';
  }

  if (capabilities.length > 6) return 'high';
  return 'medium';
}

const PROVIDER_TRIGGER_SIGNALS: Partial<Record<string, RegExp>> = {
  telegram: /\bnew telegram\b|\btelegram message\b|\btelegram arrives?\b|\bwhen[^.]*telegram\b/i,
  gmail: /\bnew email\b|\bemail arrives?\b|\bemail received\b|\bincoming email\b|\bwhen[^.]*email\b|\bwhen[^.]*gmail\b/i,
  slack: /\bnew slack\b|\bslack message\b|\bwhen[^.]*slack\b/i,
  whatsapp: /\bnew whatsapp\b|\bwhatsapp message\b|\bwhatsapp arrives?\b|\bwhen[^.]*whatsapp\b/i,
  shopify: /\bnew order\b|\bshopify order\b|\bwhen[^.]*order\b/i,
  stripe: /\bpayment received\b|\bnew payment\b|\bwhen[^.]*payment\b/i,
  facebook: /\bnew facebook\b|\bfacebook message\b|\bwhen[^.]*facebook\b/i,
  twitter: /\bnew tweet\b|\btwitter mention\b|\bwhen[^.]*twitter\b/i,
  hubspot: /\bnew lead\b|\bwhen[^.]*hubspot\b/i,
};

const PROVIDER_ACTION_SIGNALS: Partial<Record<string, RegExp>> = {
  telegram: /\bsend[^.]*telegram\b|\breply[^.]*telegram\b|\btelegram[^.]*reply\b|\bnotify[^.]*telegram\b/i,
  gmail: /\bsend[^.]*email\b|\bemail[^.]*reply\b|\bnotify[^.]*email\b|\bsend[^.]*gmail\b/i,
  slack: /\bsend[^.]*slack\b|\bpost[^.]*slack\b|\bnotify[^.]*slack\b/i,
  whatsapp: /\bsend[^.]*whatsapp\b|\breply[^.]*whatsapp\b|\bnotify[^.]*whatsapp\b/i,
  google_sheets: /\badd[^.]*sheets\b|\bsave[^.]*sheets\b|\bsync[^.]*sheets\b|\bupdate[^.]*sheets\b|\bsheets[^.]*log\b/i,
  hubspot: /\bsave[^.]*hubspot\b|\bpush[^.]*hubspot\b|\bupdate[^.]*hubspot\b/i,
  supabase: /\bsave[^.]*supabase\b|\bstore[^.]*supabase\b|\blog[^.]*supabase\b/i,
  airtable: /\bsave[^.]*airtable\b|\bairtable[^.]*record\b|\bupdate[^.]*airtable\b/i,
  stripe: /\bcharge[^.]*stripe\b|\bpayment[^.]*stripe\b|\bstripe[^.]*charge\b/i,
};

export function buildProviderIntentGraph(prompt: string): ProviderIntentGraph[] {
  const results: ProviderIntentGraph[] = [];

  for (const { pattern, provider } of PROMPT_PROVIDER_PATTERNS) {
    const match = pattern.exec(prompt);
    if (!match) continue;
    if (isNegated(prompt, match[0])) continue;

    const normalized = normalizeProvider(provider);
    if (!normalized || !isCanonicalProvider(normalized)) continue;

    const sourceSignals = [match[0]];

    const providerCore = provider.replace(/_/g, '');
    const isDirectMention = new RegExp(`\\b${providerCore}\\b`, 'i').test(prompt);
    const confidence = isDirectMention ? 95 : 80;

    const triggerMatch = PROVIDER_TRIGGER_SIGNALS[provider]?.exec(prompt);
    const triggerSignals = triggerMatch ? [triggerMatch[0]] : [];

    const actionMatch = PROVIDER_ACTION_SIGNALS[provider]?.exec(prompt);
    const actionSignals = actionMatch ? [actionMatch[0]] : [];

    results.push({ provider: normalized, confidence, sourceSignals, triggerSignals, actionSignals });
  }

  return results;
}