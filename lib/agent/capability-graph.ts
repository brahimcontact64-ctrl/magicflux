/**
 * Capability Graph — universal automation intelligence layer.
 *
 * Steps:
 *   1  Capability model + PROVIDER_CAPABILITY_GRAPH
 *   2  resolveProvidersFromCapabilities()
 *   3  extractWorkflowCapabilities()
 *   4  buildWorkflowGrammar()
 *   5  PatternMemory — save/find/score
 *   6  detectMissingRequirements() + requestMissingRequirements()
 *   7  simulateWorkflow()
 */

import { CANONICAL_PROVIDERS, normalizeProvider } from '@/lib/agent/provider-allowlist';
import { parseRequestedProvidersFromPrompt } from '@/lib/agent/provider-allowlist';
import {
  getProviderCredentialSchema,
} from '@/lib/agent/provider-credential-registry';

// ── Step 1: Capability model ─────────────────────────────────────────────────

export type WorkflowCapability =
  | 'send_message'
  | 'receive_message'
  | 'send_email'
  | 'create_invoice'
  | 'create_payment_link'
  | 'upload_file'
  | 'save_record'
  | 'schedule'
  | 'webhook'
  | 'crm_create_contact'
  | 'crm_update_contact'
  | 'generate_document'
  | 'search_data'
  | 'create_calendar_event'
  | 'notify'
  | 'transform_data'
  | 'store_memory'
  | 'retrieve_memory';

/** All canonical providers plus graph-only extended ones. */
export const CAPABILITY_GRAPH_PROVIDERS = [
  ...CANONICAL_PROVIDERS,
  'notion',
  'google_calendar',
] as const;

export type CapabilityGraphProvider = typeof CAPABILITY_GRAPH_PROVIDERS[number];

export type ProviderCapabilities = {
  provider: CapabilityGraphProvider;
  capabilities: WorkflowCapability[];
};

export const PROVIDER_CAPABILITY_GRAPH: ProviderCapabilities[] = [
  // ── Messaging ──────────────────────────────────────────────────────────────
  {
    provider: 'telegram',
    capabilities: ['send_message', 'receive_message', 'webhook', 'notify'],
  },
  {
    provider: 'whatsapp',
    capabilities: ['send_message', 'receive_message', 'notify'],
  },
  {
    provider: 'slack',
    capabilities: ['send_message', 'receive_message', 'notify', 'webhook'],
  },
  {
    provider: 'facebook',
    capabilities: ['send_message', 'receive_message', 'notify', 'webhook'],
  },
  {
    provider: 'twitter',
    capabilities: ['send_message', 'receive_message', 'webhook', 'notify'],
  },
  // ── Email ──────────────────────────────────────────────────────────────────
  {
    provider: 'gmail',
    capabilities: ['send_email', 'receive_message', 'notify'],
  },
  // ── Google Workspace ───────────────────────────────────────────────────────
  {
    provider: 'google_drive',
    capabilities: ['upload_file', 'store_memory', 'retrieve_memory', 'generate_document'],
  },
  {
    provider: 'google_sheets',
    capabilities: ['save_record', 'retrieve_memory', 'store_memory', 'search_data', 'transform_data'],
  },
  {
    provider: 'google_calendar',
    capabilities: ['create_calendar_event', 'schedule', 'notify', 'retrieve_memory'],
  },
  // ── Payments ───────────────────────────────────────────────────────────────
  {
    provider: 'stripe',
    capabilities: ['create_invoice', 'create_payment_link', 'webhook', 'save_record'],
  },
  // ── Ecommerce ──────────────────────────────────────────────────────────────
  {
    provider: 'shopify',
    capabilities: ['save_record', 'webhook', 'receive_message', 'search_data'],
  },
  // ── CRM ────────────────────────────────────────────────────────────────────
  {
    provider: 'hubspot',
    capabilities: ['crm_create_contact', 'crm_update_contact', 'save_record', 'search_data', 'notify'],
  },
  // ── Data / Storage ─────────────────────────────────────────────────────────
  {
    provider: 'airtable',
    capabilities: ['save_record', 'retrieve_memory', 'store_memory', 'search_data'],
  },
  {
    provider: 'supabase',
    capabilities: ['save_record', 'retrieve_memory', 'store_memory', 'search_data', 'webhook'],
  },
  {
    provider: 'notion',
    capabilities: ['save_record', 'store_memory', 'retrieve_memory', 'generate_document', 'search_data'],
  },
  // ── AI ─────────────────────────────────────────────────────────────────────
  {
    provider: 'openai',
    capabilities: ['transform_data', 'generate_document', 'search_data', 'retrieve_memory'],
  },
  {
    provider: 'claude',
    capabilities: ['transform_data', 'generate_document', 'search_data', 'retrieve_memory'],
  },
  {
    provider: 'cloudflare_ai',
    capabilities: ['transform_data', 'generate_document'],
  },
  {
    provider: 'elevenlabs',
    capabilities: ['generate_document', 'notify', 'transform_data'],
  },
  {
    provider: 'deepgram',
    capabilities: ['transform_data', 'retrieve_memory', 'search_data'],
  },
  // ── Creative ───────────────────────────────────────────────────────────────
  {
    provider: 'canva',
    capabilities: ['generate_document', 'upload_file', 'store_memory'],
  },
];

// ── Step 2: Capability Resolver ──────────────────────────────────────────────

export type CapabilityResolverResult = {
  provider: CapabilityGraphProvider;
  matchedCapabilities: WorkflowCapability[];
  confidence: number;
};

/**
 * Returns all providers that satisfy at least one of the requested capabilities,
 * scored by how many capabilities they cover (coverage weight 0.7) and how
 * specific they are to those capabilities (specificity weight 0.3).
 */
export function resolveProvidersFromCapabilities(
  capabilities: WorkflowCapability[]
): CapabilityResolverResult[] {
  if (capabilities.length === 0) return [];

  const results: CapabilityResolverResult[] = [];

  for (const entry of PROVIDER_CAPABILITY_GRAPH) {
    const matched = capabilities.filter((c) => entry.capabilities.includes(c));
    if (matched.length === 0) continue;

    const coverage = matched.length / capabilities.length;
    const specificity = matched.length / entry.capabilities.length;
    const confidence = Math.min(100, Math.round((coverage * 0.7 + specificity * 0.3) * 100));

    results.push({
      provider: entry.provider,
      matchedCapabilities: matched,
      confidence,
    });
  }

  return results.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.matchedCapabilities.length - a.matchedCapabilities.length,
  );
}

/** Returns the single best provider for a capability, or null if none match. */
export function resolveProviderForCapability(
  capability: WorkflowCapability,
): CapabilityGraphProvider | null {
  const results = resolveProvidersFromCapabilities([capability]);
  return results[0]?.provider ?? null;
}

// ── Step 3: Intent Resolver ──────────────────────────────────────────────────

type CapabilitySignal = {
  patterns: RegExp[];
  capability: WorkflowCapability;
};

const CAPABILITY_SIGNALS: CapabilitySignal[] = [
  {
    patterns: [/\bsend\b.*\bmessage\b/i, /\bsend\b.*\btext\b/i, /\breply\b/i, /\bpost\b.*\bchat\b/i],
    capability: 'send_message',
  },
  {
    patterns: [/\breceive\b.*\bmessage\b/i, /\bnew\b.*\bmessage\b/i, /\bmessage\b.*\barrives?\b/i, /\bincoming\b.*\bmessage\b/i, /\blisten\b.*\bmessage\b/i, /\bwatch\b.*\bmessage\b/i],
    capability: 'receive_message',
  },
  {
    patterns: [/\bsend\b.*\bemail\b/i, /\bemail\b/i, /\bsmtp\b/i, /\bmail\b.*\bsend\b/i],
    capability: 'send_email',
  },
  {
    patterns: [/\binvoice\b/i, /\bcreate\b.*\binvoice\b/i, /\bgenerate\b.*\binvoice\b/i, /\bbill\b.*\bcustomer\b/i],
    capability: 'create_invoice',
  },
  {
    patterns: [/\bpayment\b.*\blink\b/i, /\bcheckout\b.*\blink\b/i, /\bpay\b.*\blink\b/i, /\bpayment\b.*\burl\b/i],
    capability: 'create_payment_link',
  },
  {
    patterns: [/\bupload\b.*\bfile\b/i, /\bfile\b.*\bupload\b/i, /\battach\b/i, /\bupload\b.*\bdrive\b/i, /\bsave\b.*\bfile\b/i, /\bsave\b.*\bdrive\b/i, /\bsave\b.*\bfolder\b/i, /\bstore\b.*\bdrive\b/i],
    capability: 'upload_file',
  },
  {
    patterns: [/\bsave\b.*\brecord\b/i, /\bstore\b.*\brecord\b/i, /\blog\b.*\bdata\b/i, /\bwrite\b.*\bdatabase\b/i, /\binsert\b.*\brow\b/i, /\bsave\b.*\bsheet\b/i],
    capability: 'save_record',
  },
  {
    patterns: [/\bschedule\b/i, /\bevery\b/i, /\bdaily\b/i, /\bweekly\b/i, /\bhourly\b/i, /\bcron\b/i, /\brecurring\b/i, /\bat\b.*\bam\b/i, /\bat\b.*\bpm\b/i],
    capability: 'schedule',
  },
  {
    patterns: [/\bwebhook\b/i, /\bhttp\b.*\btrigger\b/i, /\bcallback\b.*\burl\b/i, /\bhttp\b.*\bcallback\b/i],
    capability: 'webhook',
  },
  {
    patterns: [/\bcrm\b/i, /\bcreate\b.*\bcontact\b/i, /\badd\b.*\bcontact\b/i, /\bnew\b.*\blead\b/i, /\bcapture\b.*\blead\b/i],
    capability: 'crm_create_contact',
  },
  {
    patterns: [/\bupdate\b.*\bcontact\b/i, /\bupdate\b.*\bcrm\b/i, /\bsync\b.*\bcontact\b/i, /\bupdate\b.*\blead\b/i],
    capability: 'crm_update_contact',
  },
  {
    patterns: [/\bgenerate\b.*\bdocument\b/i, /\bcreate\b.*\bpdf\b/i, /\bpdf\b/i, /\breport\b/i, /\bgenerate\b.*\breport\b/i, /\bcreate\b.*\bdoc\b/i],
    capability: 'generate_document',
  },
  {
    patterns: [/\bsearch\b/i, /\bfind\b.*\bdata\b/i, /\bquery\b/i, /\blookup\b/i, /\bfetch\b.*\bdata\b/i, /\bretrieve\b.*\bdata\b/i],
    capability: 'search_data',
  },
  {
    patterns: [/\bcalendar\b/i, /\bschedule\b.*\bmeeting\b/i, /\bcreate\b.*\bevent\b/i, /\badd\b.*\bcalendar\b/i, /\bbook\b.*\bmeeting\b/i],
    capability: 'create_calendar_event',
  },
  {
    patterns: [/\bnotif/i, /\balert\b/i, /\bping\b/i, /\bremind\b/i, /\bsend\b.*\bnotif/i],
    capability: 'notify',
  },
  {
    patterns: [/\btransform\b/i, /\bconvert\b/i, /\bformat\b/i, /\bextract\b/i, /\bparse\b/i, /\banalyze\b/i, /\bprocess\b.*\bdata\b/i, /\bsummariz/i],
    capability: 'transform_data',
  },
  {
    patterns: [/\bstore\b.*\bmemory\b/i, /\bremember\b/i, /\bsave\b.*\bmemory\b/i],
    capability: 'store_memory',
  },
  {
    patterns: [/\bretrieve\b.*\bmemory\b/i, /\brecall\b/i, /\blook\b.*\bup\b.*\bmemory\b/i],
    capability: 'retrieve_memory',
  },
];

/**
 * Extracts WorkflowCapabilities from a free-text prompt using deterministic
 * keyword/regex patterns. No LLM calls.
 */
export function extractWorkflowCapabilities(prompt: string): WorkflowCapability[] {
  const found = new Set<WorkflowCapability>();

  for (const { patterns, capability } of CAPABILITY_SIGNALS) {
    if (patterns.some((re) => re.test(prompt))) {
      found.add(capability);
    }
  }

  // Structural verb promotion: bare "send" → send_message when no email keyword
  if (/\bsend\b/i.test(prompt) && !found.has('send_email') && !found.has('send_message')) {
    found.add('send_message');
  }
  // "payment" / "charge" without "link" → create_invoice
  if (/\bpayment\b|\bcharge\b/i.test(prompt) && !found.has('create_payment_link')) {
    found.add('create_invoice');
  }
  // "store" / "save" without qualifier → save_record
  if (/\bsave\b|\bstore\b/i.test(prompt) && !found.has('save_record') && !found.has('store_memory') && !found.has('upload_file')) {
    found.add('save_record');
  }
  // "when … arrives" / "on … event" → receive_message / webhook
  if (/\bwhen\b.*\barriv|\bon\b.*\bevent\b/i.test(prompt) && !found.has('receive_message')) {
    found.add('webhook');
  }

  return Array.from(found);
}

// ── Step 4: Workflow Grammar ──────────────────────────────────────────────────

export type WorkflowRole = 'trigger' | 'condition' | 'transform' | 'action' | 'storage' | 'notification';

export type WorkflowGrammar = {
  trigger: CapabilityGraphProvider[];
  condition: CapabilityGraphProvider[];
  transform: CapabilityGraphProvider[];
  action: CapabilityGraphProvider[];
  storage: CapabilityGraphProvider[];
  notification: CapabilityGraphProvider[];
  capabilities: WorkflowCapability[];
  confidence: number;
};

// Canonical role → capabilities that assign a provider to that role.
const ROLE_CAPABILITY_MAP: Record<WorkflowRole, WorkflowCapability[]> = {
  trigger:      ['receive_message', 'webhook', 'schedule'],
  condition:    ['search_data', 'retrieve_memory'],
  transform:    ['transform_data', 'generate_document'],
  action:       ['create_invoice', 'create_payment_link', 'crm_create_contact', 'crm_update_contact', 'create_calendar_event', 'send_email'],
  storage:      ['save_record', 'store_memory', 'upload_file'],
  notification: ['notify', 'send_message'],
};

function capabilitiesForRole(role: WorkflowRole): WorkflowCapability[] {
  return ROLE_CAPABILITY_MAP[role];
}

function assignRole(
  provider: CapabilityGraphProvider,
  providerCaps: WorkflowCapability[],
  isTrigger: boolean,
): WorkflowRole {
  // Explicit trigger context (first provider mentioned after "when/if/on")
  if (isTrigger && providerCaps.some((c) => capabilitiesForRole('trigger').includes(c))) {
    return 'trigger';
  }
  // Assign by first matching non-ambiguous role
  for (const role of ['action', 'storage', 'transform', 'notification', 'trigger', 'condition'] as WorkflowRole[]) {
    if (providerCaps.some((c) => capabilitiesForRole(role).includes(c))) {
      return role;
    }
  }
  return 'action';
}

/**
 * Maps a natural-language prompt to a canonical WorkflowGrammar:
 * { trigger, condition, transform, action, storage, notification }.
 */
export function buildWorkflowGrammar(prompt: string): WorkflowGrammar {
  const capabilities = extractWorkflowCapabilities(prompt);
  const resolvedProviders = resolveProvidersFromCapabilities(capabilities);
  const explicitProviders = parseRequestedProvidersFromPrompt(prompt)
    .map((p) => normalizeProvider(p))
    .filter((p): p is CapabilityGraphProvider =>
      CAPABILITY_GRAPH_PROVIDERS.includes(p as CapabilityGraphProvider),
    );

  // Identify trigger context: providers mentioned after temporal keywords
  const triggerContext = extractTriggerProviders(prompt);

  const grammar: WorkflowGrammar = {
    trigger: [],
    condition: [],
    transform: [],
    action: [],
    storage: [],
    notification: [],
    capabilities,
    confidence: 0,
  };

  const assigned = new Set<CapabilityGraphProvider>();

  // First pass: explicit providers from the prompt (highest priority)
  for (const provider of explicitProviders) {
    if (assigned.has(provider)) continue;
    const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === provider);
    if (!entry) continue;

    const relevantCaps = entry.capabilities.filter((c) => capabilities.includes(c));
    const isTrigger = triggerContext.includes(provider);
    const role = assignRole(provider, relevantCaps.length > 0 ? relevantCaps : entry.capabilities, isTrigger);
    grammar[role].push(provider);
    assigned.add(provider);
  }

  // Second pass: capability-resolved providers not already placed
  for (const resolved of resolvedProviders) {
    if (assigned.has(resolved.provider) || resolved.confidence < 30) continue;
    const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === resolved.provider);
    if (!entry) continue;

    const isTrigger = triggerContext.includes(resolved.provider);
    const role = assignRole(resolved.provider, resolved.matchedCapabilities, isTrigger);
    grammar[role].push(resolved.provider);
    assigned.add(resolved.provider);
  }

  const totalProviders = assigned.size;
  const totalCaps = capabilities.length;
  grammar.confidence = totalProviders > 0 && totalCaps > 0
    ? Math.min(95, Math.round(
        (resolvedProviders
          .filter((r) => assigned.has(r.provider))
          .reduce((sum, r) => sum + r.confidence, 0) /
          Math.max(1, resolvedProviders.filter((r) => assigned.has(r.provider)).length)),
      ))
    : 30;

  return grammar;
}

function extractTriggerProviders(prompt: string): CapabilityGraphProvider[] {
  const triggerRe = /(?:when|if|on|after|upon)\s+(?:a\s+|an\s+|new\s+)?([a-z_\s]+?)(?:\s+(?:is\s+)?(?:received|arrives?|created|triggered|sent|placed|occurs?|fires?))/i;
  const match = triggerRe.exec(prompt.toLowerCase());
  if (!match) return [];

  const fragment = match[1].trim();
  const provider = normalizeProvider(fragment);
  if (provider && CAPABILITY_GRAPH_PROVIDERS.includes(provider as CapabilityGraphProvider)) {
    return [provider as CapabilityGraphProvider];
  }
  return [];
}

// ── Step 5: Pattern Memory ────────────────────────────────────────────────────

export type PatternMemoryRecord = {
  id?: string;
  providers: string[];
  capabilities: WorkflowCapability[];
  domains: string[];
  workflow_json: Record<string, unknown>;
  confidence: number;
  usage_count: number;
  created_at?: string;
};

type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      gte: (col: string, val: number) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
    insert: (rows: unknown[]) => Promise<{ data: unknown[] | null; error: unknown }>;
    update: (vals: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => Promise<{ error: unknown }>;
    };
  };
};

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Persists a validated, deployed pattern to `automation_patterns`. */
export async function saveSuccessfulPattern(
  record: PatternMemoryRecord,
  db: SupabaseLike,
): Promise<{ id: string | null; error: string | null }> {
  const row = {
    providers: record.providers,
    capabilities: record.capabilities,
    domains: record.domains,
    workflow_json: record.workflow_json,
    confidence: record.confidence,
    usage_count: record.usage_count ?? 1,
    created_at: record.created_at ?? new Date().toISOString(),
  };

  const result = await db.from('automation_patterns').insert([row]);
  if (result.error) {
    return { id: null, error: String(result.error) };
  }
  const inserted = result.data?.[0] as Record<string, unknown> | undefined;
  return { id: (inserted?.id as string) ?? null, error: null };
}

/** Finds patterns with provider+capability overlap ≥ 0.5 Jaccard similarity. */
export async function findSimilarPatterns(
  providers: string[],
  capabilities: WorkflowCapability[],
  db: SupabaseLike,
  limit = 10,
): Promise<PatternMemoryRecord[]> {
  const result = await db
    .from('automation_patterns')
    .select('id,providers,capabilities,domains,workflow_json,confidence,usage_count,created_at')
    .gte('confidence', 0)
    .order('usage_count', { ascending: false })
    .limit(200);

  if (result.error || !result.data) return [];

  const rows = result.data as PatternMemoryRecord[];

  return rows
    .map((row) => {
      const providerSim = jaccardSimilarity(providers, row.providers ?? []);
      const capSim = jaccardSimilarity(capabilities, row.capabilities ?? []);
      const score = providerSim * 0.6 + capSim * 0.4;
      return { row, score };
    })
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => row);
}

/**
 * Adjusts confidence for a pattern based on how often similar provider
 * combinations have succeeded. Boost +2 per 10 usages of similar patterns,
 * capped at 95.
 */
export function calculatePatternConfidence(
  baseConfidence: number,
  similarPatterns: PatternMemoryRecord[],
): number {
  if (similarPatterns.length === 0) return baseConfidence;

  const totalUsage = similarPatterns.reduce((sum, p) => sum + (p.usage_count ?? 0), 0);
  const avgConfidence = similarPatterns.reduce((sum, p) => sum + p.confidence, 0) / similarPatterns.length;

  const usageBoost = Math.min(10, Math.floor(totalUsage / 10) * 2);
  const confidenceBoost = Math.round((avgConfidence - baseConfidence) * 0.3);
  const adjusted = baseConfidence + usageBoost + confidenceBoost;

  return Math.min(95, Math.max(10, adjusted));
}

// ── Step 6: Runtime Intelligence ──────────────────────────────────────────────

export type MissingRequirement = {
  provider: CapabilityGraphProvider;
  field: string;
  label: string;
  required: boolean;
};

export type RequirementCheckResult = {
  ready: boolean;
  missing: MissingRequirement[];
  message: string;
};

/**
 * Detects missing credentials for every provider in the grammar.
 * `installedProviders` is a set of provider names whose credentials are
 * already configured in the user's environment.
 */
export function detectMissingRequirements(
  grammar: WorkflowGrammar,
  installedProviders: Set<string> = new Set(),
): RequirementCheckResult {
  const allProviders: CapabilityGraphProvider[] = [
    ...grammar.trigger,
    ...grammar.action,
    ...grammar.storage,
    ...grammar.notification,
    ...grammar.transform,
    ...grammar.condition,
  ];

  const missing: MissingRequirement[] = [];

  for (const provider of allProviders) {
    if (installedProviders.has(provider)) continue;

    const schema = getProviderCredentialSchema(provider);
    for (const field of schema) {
      if (field.required) {
        missing.push({
          provider,
          field: field.key,
          label: field.label,
          required: true,
        });
      }
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    message: missing.length === 0
      ? 'All provider credentials are configured.'
      : `${missing.length} credential${missing.length === 1 ? '' : 's'} required before deployment.`,
  };
}

/** Generates human-friendly setup messages for each missing credential. */
export function requestMissingRequirements(result: RequirementCheckResult): string[] {
  if (result.ready) return [];

  const byProvider = new Map<string, MissingRequirement[]>();
  for (const req of result.missing) {
    const existing = byProvider.get(req.provider) ?? [];
    existing.push(req);
    byProvider.set(req.provider, existing);
  }

  const messages: string[] = [];
  for (const [provider, reqs] of byProvider) {
    const displayName = providerDisplayName(provider as CapabilityGraphProvider);
    const fields = reqs.map((r) => `"${r.label}"`).join(', ');
    messages.push(
      `To use ${displayName}, please provide: ${fields}.`,
    );
  }

  return messages;
}

function providerDisplayName(provider: CapabilityGraphProvider): string {
  const DISPLAY: Partial<Record<CapabilityGraphProvider, string>> = {
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    slack: 'Slack',
    gmail: 'Gmail',
    google_drive: 'Google Drive',
    google_sheets: 'Google Sheets',
    google_calendar: 'Google Calendar',
    stripe: 'Stripe',
    shopify: 'Shopify',
    hubspot: 'HubSpot',
    airtable: 'Airtable',
    supabase: 'Supabase',
    notion: 'Notion',
    openai: 'OpenAI',
    claude: 'Claude',
    cloudflare_ai: 'Cloudflare AI',
    elevenlabs: 'ElevenLabs',
    deepgram: 'Deepgram',
    canva: 'Canva',
    facebook: 'Facebook',
    twitter: 'X (Twitter)',
  };
  return DISPLAY[provider] ?? provider;
}

// ── Step 7: Simulation Mode ───────────────────────────────────────────────────

export type SimulatedNode = {
  provider: CapabilityGraphProvider;
  role: WorkflowRole;
  status: 'ready' | 'missing_credentials' | 'no_capability_match';
  missingFields: string[];
};

export type SimulationResult = {
  nodes: SimulatedNode[];
  missingConnections: string[];
  credentialGaps: RequirementCheckResult;
  validatorScore: number;
  deploymentReady: boolean;
  summary: string;
};

/**
 * Simulates the workflow before deployment:
 * - checks node capability coverage
 * - checks credential availability
 * - computes a validator score (0–100)
 * - returns structured diagnostic output
 */
export function simulateWorkflow(
  grammar: WorkflowGrammar,
  installedProviders: Set<string> = new Set(),
): SimulationResult {
  const roleEntries: Array<{ provider: CapabilityGraphProvider; role: WorkflowRole }> = [
    ...grammar.trigger.map((p) => ({ provider: p, role: 'trigger' as WorkflowRole })),
    ...grammar.condition.map((p) => ({ provider: p, role: 'condition' as WorkflowRole })),
    ...grammar.transform.map((p) => ({ provider: p, role: 'transform' as WorkflowRole })),
    ...grammar.action.map((p) => ({ provider: p, role: 'action' as WorkflowRole })),
    ...grammar.storage.map((p) => ({ provider: p, role: 'storage' as WorkflowRole })),
    ...grammar.notification.map((p) => ({ provider: p, role: 'notification' as WorkflowRole })),
  ];

  const credentialGaps = detectMissingRequirements(grammar, installedProviders);

  const missingCredentialProviders = new Set(
    credentialGaps.missing.map((r) => r.provider),
  );

  const nodes: SimulatedNode[] = roleEntries.map(({ provider, role }) => {
    const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === provider);
    const roleCaps = capabilitiesForRole(role);
    const hasCapabilityMatch = entry
      ? entry.capabilities.some((c) => roleCaps.includes(c))
      : false;

    if (!hasCapabilityMatch) {
      return { provider, role, status: 'no_capability_match' as const, missingFields: [] };
    }
    if (missingCredentialProviders.has(provider)) {
      const missing = credentialGaps.missing
        .filter((r) => r.provider === provider)
        .map((r) => r.label);
      return { provider, role, status: 'missing_credentials' as const, missingFields: missing };
    }
    return { provider, role, status: 'ready' as const, missingFields: [] };
  });

  const missingConnections: string[] = [];
  if (grammar.trigger.length === 0) missingConnections.push('No trigger defined — workflow has no entry point.');
  if (grammar.action.length === 0 && grammar.notification.length === 0 && grammar.storage.length === 0) {
    missingConnections.push('No action, notification, or storage defined — workflow has no output.');
  }

  const readyCount = nodes.filter((n) => n.status === 'ready').length;
  const totalNodes = nodes.length;
  const coverageScore = totalNodes > 0 ? (readyCount / totalNodes) * 60 : 0;
  const connectionScore = missingConnections.length === 0 ? 25 : 0;
  const confidenceScore = (grammar.confidence / 100) * 15;
  const validatorScore = Math.round(coverageScore + connectionScore + confidenceScore);

  const deploymentReady = validatorScore >= 70 && credentialGaps.ready;

  const summary = deploymentReady
    ? `Workflow is ready for deployment (score: ${validatorScore}/100).`
    : `Workflow cannot deploy yet (score: ${validatorScore}/100). ${credentialGaps.message}${missingConnections.length > 0 ? ' ' + missingConnections[0] : ''}`;

  return {
    nodes,
    missingConnections,
    credentialGaps,
    validatorScore,
    deploymentReady,
    summary,
  };
}
