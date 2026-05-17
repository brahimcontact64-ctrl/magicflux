import { createServiceClient } from '@/lib/supabase-server';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';
import {
  extractProvidersFromWorkflowGraph,
  isStrictProviderMode,
  normalizeProvider,
} from '@/lib/agent/provider-allowlist';
import { sanitizeAutomationBrainForGraph } from './sanitize-automation-brain-for-graph';
import type {
  AutomationBrainResult,
  BlockBlueprint,
  CapabilityInference,
  PatternMatch,
  ProviderResolution,
  SkillPackActivation,
  WorkflowCompositionBlueprint,
} from './types';

type PatternRow = {
  id: string;
  name: string;
  category: string;
  description: string;
  intent_keywords: string[] | null;
  required_tools: string[] | null;
  optional_tools: string[] | null;
  required_capabilities: string[] | null;
  risk: 'low' | 'medium' | 'high';
  estimated_cost: number;
  estimated_complexity: 'simple' | 'moderate' | 'complex';
  schedule_patterns: string[] | null;
  examples: string[] | null;
  popularity_score: number | null;
};

type SkillPackRow = {
  id: string;
  name: string;
  description: string;
  tools: string[] | null;
  capabilities: string[] | null;
  patterns: string[] | null;
  activation_keywords: string[] | null;
};

type DomainSkillPackDefinition = {
  name: string;
  description: string;
  capabilities: string[];
  tools: string[];
};

type DomainPackDefinition = {
  key: 'ecommerce' | 'restaurant' | 'lead_generation' | 'real_estate' | 'short_term_rentals';
  name: string;
  signals: string[];
  capabilities: string[];
  skillPacks: DomainSkillPackDefinition[];
  defaultPatternName: string;
  category: string;
  description: string;
};

const CAPABILITY_SIGNALS: Array<{ capability: string; signals: string[]; reason: string }> = [
  { capability: 'market_data', signals: ['coinmarketcap', 'coingecko', 'crypto', 'token', 'price'], reason: 'Market signals detected.' },
  { capability: 'scheduling', signals: ['every', 'hourly', 'daily', 'weekly', 'cron', 'schedule', 'minutes'], reason: 'Recurring execution requested.' },
  { capability: 'notifications', signals: ['alert', 'notify', 'notification', 'ping'], reason: 'User needs proactive notifications.' },
  { capability: 'send_message', signals: ['telegram', 'discord', 'whatsapp', 'slack', 'send message'], reason: 'Outbound messaging required.' },
  { capability: 'receive_message', signals: ['inbound', 'incoming message', 'receive', 'dm', 'chat'], reason: 'Inbound messaging signal found.' },
  { capability: 'database_storage', signals: ['supabase', 'database', 'log', 'store', 'save record'], reason: 'Persistent storage requested.' },
  { capability: 'chatbot', signals: ['assistant', 'ai employee', 'chatbot', 'copilot', 'agent'], reason: 'Conversational AI behavior requested.' },
  { capability: 'memory', signals: ['memory', 'remember', 'context', 'history'], reason: 'Memory requirement detected.' },
  { capability: 'vision_analysis', signals: ['image', 'photo', 'vision', 'screenshot', 'picture'], reason: 'Vision/media analysis requested.' },
  { capability: 'speech_to_text', signals: ['voice', 'audio', 'transcribe', 'call'], reason: 'Voice transcript capability needed.' },
  { capability: 'text_to_speech', signals: ['speak', 'voice response', 'tts'], reason: 'Audio response requested.' },
  { capability: 'scraping', signals: ['scrape', 'crawl', 'extract website', 'web data'], reason: 'Web extraction requested.' },
  { capability: 'search', signals: ['search', 'lookup', 'find leads', 'monitor posts', 'reddit'], reason: 'Search requirement detected.' },
  { capability: 'crm', signals: ['crm', 'hubspot', 'salesforce', 'lead'], reason: 'CRM workflow behavior detected.' },
  { capability: 'calendar', signals: ['calendar', 'bookings', 'appointment'], reason: 'Scheduling/calendar operations requested.' },
  { capability: 'document_extraction', signals: ['invoice', 'document', 'pdf', 'contract', 'receipt'], reason: 'Document parsing detected.' },
  { capability: 'social_posting', signals: ['linkedin', 'x.com', 'social', 'post', 'instagram'], reason: 'Social publishing needed.' },
  { capability: 'monitoring', signals: ['monitor', 'health', 'status', 'uptime', 'errors'], reason: 'Monitoring behavior requested.' },
  { capability: 'payment', signals: ['stripe', 'paypal', 'payment', 'checkout'], reason: 'Payment behavior requested.' },
  { capability: 'lead_enrichment', signals: ['enrich', 'lead enrichment', 'company data'], reason: 'Lead enrichment behavior detected.' },
  { capability: 'email_send', signals: ['email', 'smtp', 'sendgrid', 'gmail'], reason: 'Email sending requested.' },
  { capability: 'webhook', signals: ['webhook', 'callback', 'http'], reason: 'Webhook/event ingress requested.' },
  { capability: 'vector_search', signals: ['rag', 'embeddings', 'semantic search', 'vector'], reason: 'Knowledge retrieval signal detected.' },
  { capability: 'order_management', signals: ['order', 'orders', 'checkout', 'purchase'], reason: 'Order workflow behavior detected.' },
  { capability: 'product_catalog', signals: ['product catalog', 'catalog', 'products', 'sku'], reason: 'Product catalog handling requested.' },
  { capability: 'inventory', signals: ['inventory', 'stock', 'availability'], reason: 'Inventory management requested.' },
  { capability: 'analytics', signals: ['analytics', 'metrics', 'dashboard', 'performance'], reason: 'Analytics requirement detected.' },
  { capability: 'reporting', signals: ['report', 'reports', 'weekly report', 'summary report'], reason: 'Reporting requirement detected.' },
];

const PHRASE_CAPABILITY_RULES: Array<{
  signals: string[];
  capabilities: Array<{ key: string; confidence: number; reason: string }>;
}> = [
  {
    signals: ['understands product images', 'product images', 'product image'],
    capabilities: [
      { key: 'vision_analysis', confidence: 96, reason: 'Prompt requires image understanding.' },
      { key: 'product_recognition', confidence: 94, reason: 'Prompt requires recognizing products from images.' },
      { key: 'image_understanding', confidence: 92, reason: 'Prompt explicitly requires image understanding.' },
    ],
  },
  {
    signals: ['voice notes', 'voice note', 'audio note'],
    capabilities: [
      { key: 'speech_to_text', confidence: 97, reason: 'Voice notes require transcription.' },
      { key: 'audio_processing', confidence: 93, reason: 'Voice notes require audio processing.' },
      { key: 'voice_orders', confidence: 88, reason: 'Voice intake indicates spoken ordering flow.' },
    ],
  },
  {
    signals: ['weekly reports', 'weekly report'],
    capabilities: [
      { key: 'analytics', confidence: 93, reason: 'Weekly reports require analytics.' },
      { key: 'reporting', confidence: 97, reason: 'Weekly reports require reporting.' },
    ],
  },
  {
    signals: ['creates orders automatically', 'creates orders', 'create orders'],
    capabilities: [
      { key: 'order_management', confidence: 95, reason: 'Prompt requires automated order creation.' },
      { key: 'database_storage', confidence: 82, reason: 'Order creation typically persists records.' },
    ],
  },
  {
    signals: ['reddit lead finder', 'lead finder', 'hot leads'],
    capabilities: [
      { key: 'search', confidence: 95, reason: 'Lead finder requires search capability.' },
      { key: 'lead_enrichment', confidence: 90, reason: 'Lead workflows benefit from enrichment.' },
      { key: 'ai_scoring', confidence: 88, reason: 'Hot lead prioritization implies AI scoring.' },
    ],
  },
];

const DOMAIN_PACKS: DomainPackDefinition[] = [
  {
    key: 'ecommerce',
    name: 'Ecommerce',
    signals: ['ecommerce', 'shopify', 'store', 'product', 'cart', 'checkout', 'inventory'],
    capabilities: ['product_catalog', 'image_understanding', 'cart', 'order_management', 'whatsapp_sales', 'payment', 'inventory'],
    skillPacks: [
      {
        name: 'Ecommerce Core',
        description: 'Catalog, cart, order and checkout intelligence for digital storefronts.',
        capabilities: ['product_catalog', 'cart', 'order_management', 'inventory'],
        tools: ['shopify', 'postgres', 'stripe'],
      },
      {
        name: 'Vision AI',
        description: 'Recognize products and visual context from customer-submitted images.',
        capabilities: ['vision_analysis', 'product_recognition', 'image_understanding'],
        tools: ['openai_vision', 'grok_vision'],
      },
      {
        name: 'WhatsApp Commerce',
        description: 'Handle conversational selling and order confirmation on WhatsApp.',
        capabilities: ['send_message', 'receive_message', 'whatsapp_sales'],
        tools: ['whatsapp'],
      },
    ],
    defaultPatternName: 'AI Ecommerce Sales Assistant',
    category: 'commerce',
    description: 'Conversational ecommerce assistant with product understanding and order automation.',
  },
  {
    key: 'restaurant',
    name: 'Restaurant',
    signals: ['restaurant', 'kitchen', 'menu', 'food', 'reservation', 'voice notes'],
    capabilities: ['voice_orders', 'kitchen_alerts', 'menu_system', 'order_management', 'customer_notifications', 'reporting'],
    skillPacks: [
      {
        name: 'Restaurant Core',
        description: 'Menu, kitchen and order routing for restaurant operations.',
        capabilities: ['menu_system', 'order_management', 'kitchen_alerts'],
        tools: ['pos', 'postgres', 'slack'],
      },
      {
        name: 'Voice AI',
        description: 'Process voice notes into structured intents and orders.',
        capabilities: ['speech_to_text', 'audio_processing', 'voice_orders'],
        tools: ['deepgram', 'openai'],
      },
      {
        name: 'Reporting Ops',
        description: 'Generate recurring operational reports for managers.',
        capabilities: ['analytics', 'reporting'],
        tools: ['email', 'supabase'],
      },
    ],
    defaultPatternName: 'Restaurant Voice Ordering System',
    category: 'operations',
    description: 'Restaurant assistant for voice ordering, kitchen alerting and reporting.',
  },
  {
    key: 'lead_generation',
    name: 'Lead Generation',
    signals: ['lead', 'reddit', 'linkedin', 'prospect', 'crm', 'enrichment'],
    capabilities: ['reddit_scraping', 'linkedin', 'enrichment', 'ai_scoring', 'crm_sync', 'slack_notifications'],
    skillPacks: [
      {
        name: 'Lead Generation Core',
        description: 'Search, qualify and route leads into sales workflows.',
        capabilities: ['search', 'lead_enrichment', 'ai_scoring', 'crm_sync'],
        tools: ['reddit', 'linkedin', 'crm'],
      },
      {
        name: 'Reddit Prospecting',
        description: 'Mine Reddit discussions for high-intent opportunities.',
        capabilities: ['reddit_scraping', 'search'],
        tools: ['reddit'],
      },
      {
        name: 'Slack Notifications',
        description: 'Push high-intent lead alerts to sales teams in Slack.',
        capabilities: ['slack_notifications', 'notifications'],
        tools: ['slack'],
      },
    ],
    defaultPatternName: 'Property Lead Engine',
    category: 'sales',
    description: 'Lead generation and qualification pipeline with outreach routing.',
  },
  {
    key: 'real_estate',
    name: 'Real Estate',
    signals: ['real estate', 'property lead', 'buyer', 'seller', 'showing', 'followups'],
    capabilities: ['lead_capture', 'qualification', 'scheduling', 'crm', 'whatsapp_followups'],
    skillPacks: [
      {
        name: 'Real Estate Core',
        description: 'Capture, qualify and schedule property leads.',
        capabilities: ['lead_capture', 'qualification', 'scheduling', 'crm'],
        tools: ['crm', 'calendar', 'whatsapp'],
      },
    ],
    defaultPatternName: 'Property Lead Engine',
    category: 'real_estate',
    description: 'Real-estate lead qualification and follow-up workflow.',
  },
  {
    key: 'short_term_rentals',
    name: 'Short-term rentals',
    signals: ['airbnb', 'short-term rental', 'guest', 'booking', 'cleaning workflow', 'rental'],
    capabilities: ['booking_sync', 'guest_messages', 'ai_responses', 'cleaning_workflow'],
    skillPacks: [
      {
        name: 'Guest Automation',
        description: 'Coordinate guest messaging, AI responses and operational follow-up.',
        capabilities: ['booking_sync', 'guest_messages', 'ai_responses', 'cleaning_workflow'],
        tools: ['airbnb', 'email', 'slack'],
      },
    ],
    defaultPatternName: 'Airbnb Guest Automation',
    category: 'hospitality',
    description: 'Guest communications and booking operations for short-term rentals.',
  },
];

const PROVIDER_BY_CAPABILITY: Record<string, string[]> = {
  market_data: ['coinmarketcap', 'coingecko'],
  send_message: ['telegram', 'whatsapp', 'slack'],
  receive_message: ['telegram', 'whatsapp'],
  chatbot: ['openai', 'claude', 'grok'],
  database_storage: ['supabase', 'postgres'],
  memory: ['supabase', 'redis'],
  scheduling: ['scheduler'],
  social_posting: ['x', 'linkedin'],
  crm: ['hubspot', 'salesforce'],
  email_send: ['email', 'gmail'],
  vision_analysis: ['grok', 'openai_vision'],
  speech_to_text: ['deepgram', 'openai'],
  text_to_speech: ['elevenlabs', 'openai_tts'],
  document_extraction: ['ocr', 'openai'],
  monitoring: ['internal_runtime', 'datadog'],
  payment: ['stripe', 'paypal'],
  product_recognition: ['openai_vision', 'grok_vision'],
  image_understanding: ['openai_vision', 'grok_vision'],
  audio_processing: ['deepgram', 'openai'],
  analytics: ['supabase', 'postgres'],
  reporting: ['email', 'slack'],
  order_management: ['postgres', 'shopify'],
  product_catalog: ['shopify', 'postgres'],
  cart: ['shopify', 'stripe'],
  inventory: ['shopify', 'postgres'],
  whatsapp_sales: ['whatsapp'],
  voice_orders: ['deepgram', 'whatsapp'],
  kitchen_alerts: ['slack', 'whatsapp'],
  menu_system: ['postgres', 'supabase'],
  customer_notifications: ['whatsapp', 'email'],
  reddit_scraping: ['reddit'],
  enrichment: ['apollo', 'clearbit'],
  ai_scoring: ['claude', 'openai'],
  crm_sync: ['hubspot', 'salesforce'],
  slack_notifications: ['slack'],
};

const BLOCK_LIBRARY: BlockBlueprint[] = [
  { id: 'trigger_schedule', category: 'trigger', name: 'Schedule Trigger', capabilities: ['scheduling'] },
  { id: 'trigger_webhook', category: 'trigger', name: 'Webhook Trigger', capabilities: ['webhook'] },
  { id: 'ai_reasoner', category: 'ai', name: 'AI Reasoning', capabilities: ['chatbot', 'memory'] },
  { id: 'memory_store', category: 'memory', name: 'Memory Store', capabilities: ['memory', 'vector_search'] },
  { id: 'db_writer', category: 'database', name: 'Database Writer', capabilities: ['database_storage'] },
  { id: 'scraper', category: 'scraping', name: 'Scraper/API Fetch', capabilities: ['scraping', 'search', 'market_data'] },
  { id: 'messaging_send', category: 'messaging', name: 'Messaging Sender', capabilities: ['send_message', 'notifications'] },
  { id: 'voice_ingest', category: 'voice', name: 'Voice Ingest', capabilities: ['speech_to_text'] },
  { id: 'voice_reply', category: 'voice', name: 'Voice Reply', capabilities: ['text_to_speech'] },
  { id: 'vision_parser', category: 'vision', name: 'Vision Parser', capabilities: ['vision_analysis'] },
  { id: 'crm_sync', category: 'crm', name: 'CRM Sync', capabilities: ['crm', 'lead_enrichment'] },
  { id: 'approval_gate', category: 'approval', name: 'Human Approval', capabilities: ['notifications'] },
  { id: 'payment_action', category: 'payment', name: 'Payment Action', capabilities: ['payment'] },
  { id: 'runtime_monitor', category: 'monitoring', name: 'Runtime Monitor', capabilities: ['monitoring'] },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function addCapabilityScore(
  scores: Map<string, { reason: string; confidence: number }>,
  capability: string,
  reason: string,
  confidence: number
) {
  const current = scores.get(capability);
  if (!current || confidence > current.confidence) {
    scores.set(capability, { reason, confidence });
  }
}

function inferCapabilities(prompt: string): CapabilityInference[] {
  const normalized = normalize(prompt);
  const scores = new Map<string, { reason: string; confidence: number }>();

  for (const rule of CAPABILITY_SIGNALS) {
    let hits = 0;
    for (const signal of rule.signals) {
      if (normalized.includes(signal)) hits += 1;
    }
    if (hits === 0) continue;

    const confidence = Math.min(96, 48 + hits * 16);
    addCapabilityScore(scores, rule.capability, rule.reason, confidence);
  }

  for (const rule of PHRASE_CAPABILITY_RULES) {
    const matched = rule.signals.some((signal) => normalized.includes(signal));
    if (!matched) continue;

    for (const capability of rule.capabilities) {
      addCapabilityScore(scores, capability.key, capability.reason, capability.confidence);
    }
  }

  if (scores.size === 0) {
    addCapabilityScore(scores, 'chatbot', 'Default capability baseline for automation requests.', 40);
    addCapabilityScore(scores, 'notifications', 'Automation flows typically need status signaling.', 35);
  }

  return Array.from(scores.entries())
    .map(([key, value]) => ({ key, reason: value.reason, confidence: value.confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}

function detectDomainPack(prompt: string, capabilities: CapabilityInference[]): DomainPackDefinition | null {
  const normalized = normalize(prompt);
  const capabilitySet = new Set(capabilities.map((capability) => capability.key));

  const ranked = DOMAIN_PACKS.map((pack) => {
    const signalHits = pack.signals.filter((signal) => normalized.includes(signal)).length;
    const capabilityHits = pack.capabilities.filter((capability) => capabilitySet.has(capability)).length;
    return {
      pack,
      score: signalHits * 18 + capabilityHits * 10,
    };
  }).sort((a, b) => b.score - a.score);

  return ranked[0] && ranked[0].score >= 14 ? ranked[0].pack : null;
}

function inferMarketWorkflowName(capabilities: string[], prompt: string): string {
  const normalized = normalize(prompt);
  const capabilitySet = new Set(capabilities);

  if (
    capabilitySet.has('product_catalog') ||
    capabilitySet.has('cart') ||
    capabilitySet.has('payment') ||
    capabilitySet.has('inventory') ||
    capabilitySet.has('image_understanding')
  ) {
    return 'AI Ecommerce Sales Assistant';
  }

  if (
    capabilitySet.has('voice_orders') ||
    capabilitySet.has('kitchen_alerts') ||
    capabilitySet.has('menu_system') ||
    capabilitySet.has('reporting') ||
    normalized.includes('restaurant')
  ) {
    return 'Restaurant Voice Ordering System';
  }

  if (
    capabilitySet.has('reddit_scraping') ||
    capabilitySet.has('linkedin') ||
    capabilitySet.has('enrichment') ||
    capabilitySet.has('ai_scoring') ||
    capabilitySet.has('crm_sync')
  ) {
    return normalized.includes('reddit') ? 'Reddit Lead Hunter' : 'Lead Generation Automation';
  }

  if (
    capabilitySet.has('lead_capture') ||
    capabilitySet.has('qualification') ||
    capabilitySet.has('scheduling') ||
    capabilitySet.has('whatsapp_followups')
  ) {
    return 'Property Lead Engine';
  }

  if (
    capabilitySet.has('booking_sync') ||
    capabilitySet.has('guest_messages') ||
    capabilitySet.has('cleaning_workflow')
  ) {
    return 'Airbnb Guest Automation';
  }

  if (capabilities.some((capability) => capability.includes('report') || capability.includes('analytics'))) {
    return 'AI Reporting Assistant';
  }

  if (normalized.includes('lead')) {
    return 'AI Lead Routing Assistant';
  }

  return 'AI Workflow Assistant';
}

function mergeDomainCapabilities(
  capabilities: CapabilityInference[],
  domainPack: DomainPackDefinition | null
): CapabilityInference[] {
  if (!domainPack) return capabilities;

  const merged = new Map(capabilities.map((capability) => [capability.key, capability]));
  for (const capability of domainPack.capabilities) {
    const existing = merged.get(capability);
    if (!existing) {
      merged.set(capability, {
        key: capability,
        reason: `${domainPack.name} domain intelligence inferred this capability.`,
        confidence: 82,
      });
      continue;
    }

    merged.set(capability, {
      ...existing,
      confidence: Math.max(existing.confidence, 82),
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
}

function domainPatternName(prompt: string, domainPack: DomainPackDefinition): string {
  const normalized = normalize(prompt);
  if (domainPack.key === 'lead_generation' && normalized.includes('reddit')) return 'Reddit Lead Hunter';
  if (domainPack.key === 'restaurant' && (normalized.includes('voice') || normalized.includes('voice notes'))) {
    return 'Restaurant Voice Ordering System';
  }
  return domainPack.defaultPatternName;
}

function inferExecutionFrequency(prompt: string, patterns: PatternMatch[]): string {
  const normalized = normalize(prompt);
  if (/every\s+15\s+min/.test(normalized) || /15\s+minutes/.test(normalized)) return 'Every 15 minutes';
  if (/hourly|every\s+hour/.test(normalized)) return 'Hourly';
  if (/daily|every\s+day|each\s+day/.test(normalized)) return 'Daily';
  if (/weekly|every\s+week/.test(normalized)) return 'Weekly';

  for (const pattern of patterns) {
    const schedule = pattern.schedulePatterns[0];
    if (schedule) return schedule;
  }

  return 'Event-driven';
}

function estimateLatencyMs(capabilities: string[]): number {
  let latency = 900;
  for (const capability of capabilities) {
    if (capability === 'chatbot') latency += 1800;
    else if (capability === 'vision_analysis') latency += 2200;
    else if (capability === 'database_storage') latency += 250;
    else if (capability === 'send_message' || capability === 'notifications') latency += 350;
    else latency += 180;
  }
  return latency;
}

function inferExpectedIO(capabilities: string[]): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];

  if (capabilities.includes('webhook')) inputs.push('Webhook payload');
  if (capabilities.includes('receive_message')) inputs.push('Incoming message event');
  if (capabilities.includes('market_data')) inputs.push('Market API data');
  if (capabilities.includes('vision_analysis')) inputs.push('Image content');
  if (capabilities.includes('document_extraction')) inputs.push('Document/PDF content');

  if (capabilities.includes('send_message')) outputs.push('Outbound chat message');
  if (capabilities.includes('email_send')) outputs.push('Outbound email');
  if (capabilities.includes('database_storage')) outputs.push('Persisted record/log');
  if (capabilities.includes('crm')) outputs.push('CRM record updates');
  if (capabilities.includes('monitoring')) outputs.push('Health metrics and traces');

  if (inputs.length === 0) inputs.push('User prompt and inferred context');
  if (outputs.length === 0) outputs.push('Structured automation action result');

  return { inputs: unique(inputs), outputs: unique(outputs) };
}

async function loadPatterns(): Promise<PatternRow[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('automation_patterns')
    .select('id,name,category,description,intent_keywords,required_tools,optional_tools,required_capabilities,risk,estimated_cost,estimated_complexity,schedule_patterns,examples,popularity_score')
    .limit(500);

  if (error || !data) return [];
  return data as PatternRow[];
}

async function loadSkillPacks(): Promise<SkillPackRow[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('skill_packs')
    .select('id,name,description,tools,capabilities,patterns,activation_keywords')
    .limit(100);

  if (error || !data) return [];
  return data as SkillPackRow[];
}

function scorePattern(prompt: string, inferredCapabilities: string[], row: PatternRow): number {
  const normalized = normalize(prompt);
  const keywords = row.intent_keywords ?? [];
  const requiredCaps = row.required_capabilities ?? [];
  const popularity = row.popularity_score ?? 0;

  let keywordScore = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword.toLowerCase())) keywordScore += 8;
  }

  const capOverlap = requiredCaps.filter((cap) => inferredCapabilities.includes(cap)).length;
  const capScore = capOverlap * 10;
  const popularityScore = Math.min(20, Math.max(0, popularity / 5));

  return keywordScore + capScore + popularityScore;
}

function selectPatterns(
  prompt: string,
  capabilities: CapabilityInference[],
  rows: PatternRow[],
  domainPack: DomainPackDefinition | null
): PatternMatch[] {
  const inferred = capabilities.map((capability) => capability.key);

  const ranked = rows
    .map((row) => {
      const score = scorePattern(prompt, inferred, row);
      return {
        id: row.id,
        name: row.name,
        category: row.category,
        description: row.description,
        requiredCapabilities: row.required_capabilities ?? [],
        requiredTools: row.required_tools ?? [],
        optionalTools: row.optional_tools ?? [],
        risk: row.risk,
        estimatedCost: Number(row.estimated_cost ?? 0),
        estimatedComplexity: row.estimated_complexity,
        schedulePatterns: row.schedule_patterns ?? [],
        examples: row.examples ?? [],
        score,
      } as PatternMatch;
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const selected = ranked.length > 0 ? ranked : [];

  if (domainPack) {
    const domainPattern: PatternMatch = {
      id: `domain-${domainPack.key}`,
      name: domainPatternName(prompt, domainPack),
      category: domainPack.category,
      description: domainPack.description,
      requiredCapabilities: domainPack.capabilities,
      requiredTools: unique(domainPack.skillPacks.flatMap((pack) => pack.tools)).slice(0, 4),
      optionalTools: ['supabase', 'slack', 'email'],
      risk: domainPack.key === 'restaurant' ? 'medium' : 'low',
      estimatedCost: domainPack.key === 'ecommerce' ? 0.03 : domainPack.key === 'restaurant' ? 0.025 : 0.018,
      estimatedComplexity: domainPack.key === 'ecommerce' || domainPack.key === 'restaurant' ? 'complex' : 'moderate',
      schedulePatterns: [inferExecutionFrequency(prompt, selected)],
      examples: [`Domain-tuned workflow for ${domainPack.name.toLowerCase()}`],
      score: 180,
    };

    return [
      domainPattern,
      ...selected.filter((pattern) => pattern.name !== domainPattern.name).slice(0, 5),
    ];
  }

  if (selected.length > 0) return selected;

  const inferredName = inferMarketWorkflowName(inferred, prompt);

  return [
    {
      id: 'fallback-pattern',
      name: inferredName,
      category: 'general',
      description: 'Capability-first workflow pattern assembled from the inferred domain signals.',
      requiredCapabilities: inferred,
      requiredTools: [],
      optionalTools: ['webhook', 'scheduler'],
      risk: 'medium',
      estimatedCost: 0.02,
      estimatedComplexity: inferred.length > 5 ? 'complex' : inferred.length > 2 ? 'moderate' : 'simple',
      schedulePatterns: ['event-driven'],
      examples: ['Composed from capability-first inference'],
      score: 50,
    },
  ];
}

function activateSkillPacks(
  prompt: string,
  capabilities: CapabilityInference[],
  packs: SkillPackRow[],
  domainPack: DomainPackDefinition | null
): SkillPackActivation[] {
  const normalized = normalize(prompt);
  const capabilitySet = new Set(capabilities.map((capability) => capability.key));

  const syntheticPacks: SkillPackActivation[] = (domainPack?.skillPacks ?? []).map((pack, index) => {
    const capHits = pack.capabilities.filter((capability) => capabilitySet.has(capability)).length;
    const toolHits = pack.tools.filter((tool) => normalized.includes(tool.toLowerCase())).length;
    return {
      id: `domain-pack-${domainPack?.key}-${index}`,
      name: pack.name,
      description: pack.description,
      tools: pack.tools,
      capabilities: pack.capabilities,
      patterns: [domainPatternName(prompt, domainPack!)],
      matchScore: 70 + capHits * 8 + toolHits * 12,
    };
  });

  const dbPacks = packs
    .map((pack) => {
      const keywords = pack.activation_keywords ?? [];
      const packCaps = pack.capabilities ?? [];

      let keywordHits = 0;
      for (const keyword of keywords) {
        if (normalized.includes(keyword.toLowerCase())) keywordHits += 1;
      }

      const capHits = packCaps.filter((cap) => capabilitySet.has(cap)).length;
      const score = keywordHits * 12 + capHits * 8;

      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        tools: pack.tools ?? [],
        capabilities: packCaps,
        patterns: pack.patterns ?? [],
        matchScore: score,
      } as SkillPackActivation;
    })
    .filter((row) => row.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);

  const merged = new Map<string, SkillPackActivation>();
  for (const pack of [...syntheticPacks, ...dbPacks]) {
    const existing = merged.get(pack.name);
    if (!existing || pack.matchScore > existing.matchScore) {
      merged.set(pack.name, pack);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}

function resolveProviders(prompt: string, capabilities: CapabilityInference[]): ProviderResolution[] {
  const normalized = normalize(prompt);
  const results: ProviderResolution[] = [];

  const explicitProviderAliases: Record<string, string[]> = {
    claude: ['claude', 'anthropic'],
    openai: ['openai', 'gpt'],
    grok: ['grok', 'xai'],
    whatsapp: ['whatsapp'],
    deepgram: ['deepgram'],
    airtable: ['airtable'],
    slack: ['slack'],
    reddit: ['reddit'],
    coinmarketcap: ['coinmarketcap'],
    email: ['email', 'smtp', 'gmail'],
  };

  for (const capability of capabilities) {
    const providers = PROVIDER_BY_CAPABILITY[capability.key] ?? [];
    if (providers.length === 0) continue;

    const aliasMention = Object.entries(explicitProviderAliases).find(([, aliases]) =>
      aliases.some((alias) => normalized.includes(alias))
    )?.[0];
    const exactMention = providers.find((provider) => normalized.includes(provider.toLowerCase()))
      ?? (aliasMention && providers.includes(aliasMention) ? aliasMention : undefined);
    const provider = exactMention ?? providers[0];
    const confidence = exactMention ? Math.min(99, capability.confidence + 10) : Math.max(45, capability.confidence - 12);

    results.push({
      provider,
      capabilities: [capability.key],
      confidence,
    });
  }

  const merged = new Map<string, ProviderResolution>();
  for (const row of results) {
    const existing = merged.get(row.provider);
    if (!existing) {
      merged.set(row.provider, row);
      continue;
    }
    merged.set(row.provider, {
      provider: row.provider,
      capabilities: unique([...existing.capabilities, ...row.capabilities]),
      confidence: Math.max(existing.confidence, row.confidence),
    });
  }

  const normalizedNames: Record<string, string> = {
    whatsapp: 'WhatsApp',
    email: 'Email',
    claude: 'Claude',
    openai: 'OpenAI',
    deepgram: 'Deepgram',
    coinmarketcap: 'CoinMarketCap',
  };

  return Array.from(merged.values())
    .map((provider) => ({
      ...provider,
      provider: normalizedNames[provider.provider] ?? provider.provider,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

function composeBlocks(capabilities: CapabilityInference[]): BlockBlueprint[] {
  const capabilitySet = new Set(capabilities.map((capability) => capability.key));

  const selected = BLOCK_LIBRARY.filter((block) =>
    block.capabilities.some((capability) => capabilitySet.has(capability))
  );

  const hasTrigger = selected.some((block) => block.category === 'trigger');
  if (!hasTrigger) {
    selected.unshift(BLOCK_LIBRARY.find((block) => block.id === 'trigger_webhook')!);
  }

  const hasMonitoring = selected.some((block) => block.category === 'monitoring');
  if (!hasMonitoring) {
    selected.push(BLOCK_LIBRARY.find((block) => block.id === 'runtime_monitor')!);
  }

  return unique(selected);
}

function inferRisks(capabilities: string[], patternRisk: Array<'low' | 'medium' | 'high'>): string[] {
  const risks = new Set<string>();

  if (patternRisk.includes('high')) risks.add('High-impact execution path detected from matched pattern.');
  if (capabilities.includes('payment')) risks.add('Payment flows require extra validation and approvals.');
  if (capabilities.includes('scraping')) risks.add('Scraping may face anti-bot and data-quality constraints.');
  if (capabilities.includes('chatbot')) risks.add('LLM summarization can produce occasional factual drift.');
  if (capabilities.includes('send_message')) risks.add('Outbound messaging needs rate-limit and abuse controls.');

  if (risks.size === 0) risks.add('Standard operational risk profile.');
  return Array.from(risks);
}

function buildComposition(
  prompt: string,
  capabilities: CapabilityInference[],
  patterns: PatternMatch[]
): WorkflowCompositionBlueprint {
  const capabilityKeys = capabilities.map((capability) => capability.key);
  const blocks = composeBlocks(capabilities);
  const { inputs, outputs } = inferExpectedIO(capabilityKeys);

  const estimatedCostUsd = Number(
    (patterns.reduce((sum, pattern) => sum + pattern.estimatedCost, 0) / Math.max(patterns.length, 1)).toFixed(4)
  );

  const complexityRank: Array<'simple' | 'moderate' | 'complex'> = patterns.map((pattern) => pattern.estimatedComplexity);
  const complexity = complexityRank.includes('complex')
    ? 'complex'
    : complexityRank.includes('moderate')
      ? 'moderate'
      : 'simple';

  return {
    blocks,
    expectedInputs: inputs,
    expectedOutputs: outputs,
    executionFrequency: inferExecutionFrequency(prompt, patterns),
    risks: inferRisks(capabilityKeys, patterns.map((pattern) => pattern.risk)),
    estimatedCostUsd,
    complexity,
    latencyEstimateMs: estimateLatencyMs(capabilityKeys),
  };
}

export function toAutomationBrainPromptContext(brain: AutomationBrainResult): string {
  const capabilityList = brain.capabilities.map((capability) => `${capability.key}(${capability.confidence})`).join(', ');
  const packList = brain.activatedSkillPacks.map((pack) => pack.name).join(', ');
  const patternList = brain.matchedPatterns.map((pattern) => pattern.name).join(', ');
  const providerList = brain.providerResolutions.map((provider) => `${provider.provider}: ${provider.capabilities.join('/')}`).join(', ');
  const blockList = brain.composition.blocks.map((block) => `${block.category}:${block.name}`).join(' -> ');

  return [
    'AUTOMATION KNOWLEDGE BRAIN CONTEXT (CAPABILITY-FIRST):',
    `Intent: ${brain.inferredIntent}`,
    `Capabilities: ${capabilityList || 'none'}`,
    `Activated skill packs: ${packList || 'none'}`,
    `Top patterns: ${patternList || 'none'}`,
    `Provider mapping candidates: ${providerList || 'none'}`,
    `Composed blocks: ${blockList || 'none'}`,
    `Execution frequency: ${brain.composition.executionFrequency}`,
    `Expected inputs: ${brain.composition.expectedInputs.join(', ')}`,
    `Expected outputs: ${brain.composition.expectedOutputs.join(', ')}`,
    `Estimated complexity: ${brain.composition.complexity}`,
    `Estimated cost usd: ${brain.composition.estimatedCostUsd}`,
    `Latency estimate ms: ${brain.composition.latencyEstimateMs}`,
  ].join('\n');
}

function inferPatternFromGraph(graph: WorkflowGraphSummary): PatternMatch {
  const providers = extractProvidersFromWorkflowGraph(graph);
  const providerSet = new Set(providers);
  const hasAi = graph.nodes.some((node) => node.kind === 'ai' || /openai|gpt|claude|grok/i.test(node.type));

  let name = 'Automation Graph Engine';
  if (providerSet.has('facebook') && providerSet.has('canva') && hasAi) {
    name = 'AI Content Growth Engine';
  } else if (providerSet.has('reddit') && providerSet.has('openai')) {
    name = 'AI Reddit Insights Engine';
  }

  return {
    id: 'graph-pattern',
    name,
    category: 'graph-derived',
    description: 'Pattern inferred from actual workflow graph providers and node composition.',
    requiredCapabilities: unique(graph.nodes.map((node) => node.capability).filter(Boolean)),
    requiredTools: providers,
    optionalTools: [],
    risk: graph.branches > 1 ? 'medium' : 'low',
    estimatedCost: Number((graph.estimatedCostUsd ?? 0).toFixed(4)),
    estimatedComplexity: graph.nodes.length > 8 ? 'complex' : graph.nodes.length > 4 ? 'moderate' : 'simple',
    schedulePatterns: [graph.schedule || 'Event-driven'],
    examples: ['Derived directly from workflow graph'],
    score: 100,
  };
}

function graphIndicatesScheduling(graph: WorkflowGraphSummary): boolean {
  return graph.nodes.some((node) => {
    if (node.kind !== 'trigger') return false;
    const haystack = `${node.type ?? ''} ${node.provider ?? ''} ${node.label ?? ''} ${node.name ?? ''}`.toLowerCase();
    return /cron|schedule|interval|scheduler/.test(haystack);
  });
}

export function constrainAutomationBrainToGraph(
  brain: AutomationBrainResult | undefined,
  workflowGraph?: WorkflowGraphSummary
): AutomationBrainResult | undefined {
  if (!brain || !workflowGraph) return brain;

  console.log({
    stage: 'before-capability-generation',
    trigger: workflowGraph.nodes.find((n) => n.kind === 'trigger'),
    schedule: workflowGraph.schedule,
    capabilities: brain.capabilities,
  });

  const providerAllowList = new Set(extractProvidersFromWorkflowGraph(workflowGraph));
  const hasCredentialAllowList = providerAllowList.size > 0;

  console.log({
    stage: 'PATTERN-TRACE',
    source: 'constrainAutomationBrainToGraph entry',
    matchedPatterns: brain.matchedPatterns?.map((x) => x.name),
    skillPacks: brain.activatedSkillPacks?.map((x) => x.name),
    providers: brain.providerResolutions,
    graphProviders: Array.from(providerAllowList),
    graphTrigger: workflowGraph.nodes.find((n) => n.kind === 'trigger'),
  });

  const providerResolutions = hasCredentialAllowList
    ? brain.providerResolutions
      .map((resolution) => ({
        ...resolution,
        provider: normalizeProvider(resolution.provider),
      }))
      .filter((resolution) => providerAllowList.has(resolution.provider))
    : brain.providerResolutions;

  const strict = isStrictProviderMode() && hasCredentialAllowList;
  const hasScheduleTrigger = graphIndicatesScheduling(workflowGraph);
  console.log({
    trigger: workflowGraph.nodes.find((node) => node.kind === 'trigger'),
    graphSchedule: workflowGraph.schedule,
    schedulingDetected: hasScheduleTrigger,
  });
  const capabilities = brain.capabilities;

  const activatedSkillPacks = hasCredentialAllowList
    ? brain.activatedSkillPacks.filter((pack) => {
      const toolHits = pack.tools
        .map((tool) => normalizeProvider(tool))
        .filter((tool) => providerAllowList.has(tool));
      return toolHits.length > 0;
    })
    : brain.activatedSkillPacks;

  const schedulingFilteredSkillPacks = activatedSkillPacks;

  const matchedPatterns = hasCredentialAllowList
    ? brain.matchedPatterns.filter((pattern) =>
      pattern.requiredTools
        .map((tool) => normalizeProvider(tool))
        .every((tool) => !tool || providerAllowList.has(tool))
    )
    : brain.matchedPatterns;

  const schedulingFilteredPatterns = matchedPatterns;

  console.log({
    stage: 'PATTERN-TRACE',
    source: 'constrainAutomationBrainToGraph filtered',
    matchedPatterns: schedulingFilteredPatterns?.map((x) => x.name),
    skillPacks: schedulingFilteredSkillPacks?.map((x) => x.name),
    providers: providerResolutions?.map((p) => p.provider),
    graphProviders: Array.from(providerAllowList),
    graphTrigger: workflowGraph.nodes.find((n) => n.kind === 'trigger'),
  });

  console.log({
    stage: 'after-pattern-match',
    matchedPatterns: schedulingFilteredPatterns,
  });

  console.log({
    stage: 'after-skill-pack-expansion',
    activatedSkillPacks: schedulingFilteredSkillPacks,
  });

  console.log({
    stage: 'after-capability-score',
    capabilities,
  });

  const mergedBrain = {
    ...brain,
    capabilities: strict ? capabilities : capabilities,
    providerResolutions: strict ? providerResolutions : providerResolutions,
    activatedSkillPacks: strict ? schedulingFilteredSkillPacks : schedulingFilteredSkillPacks,
    matchedPatterns: strict ? schedulingFilteredPatterns : schedulingFilteredPatterns,
    composition: brain.composition,
  };

  return sanitizeAutomationBrainForGraph(mergedBrain, workflowGraph);
}

export async function analyzeAutomationPrompt(prompt: string): Promise<AutomationBrainResult> {
  const inferredIntent = prompt.trim() || 'Build a dynamic automation';
  const inferredCapabilities = inferCapabilities(inferredIntent);
  const domainPack = detectDomainPack(inferredIntent, inferredCapabilities);
  const capabilities = mergeDomainCapabilities(inferredCapabilities, domainPack);

  console.log({
    stage: 'after-capability-score',
    capabilities,
  });

  const [patternRows, skillPackRows] = await Promise.all([loadPatterns(), loadSkillPacks()]);

  const matchedPatterns = selectPatterns(inferredIntent, capabilities, patternRows, domainPack);
  console.log({
    stage: 'after-pattern-match',
    matchedPatterns,
  });
  const activatedSkillPacks = activateSkillPacks(inferredIntent, capabilities, skillPackRows, domainPack);
  console.log({
    stage: 'after-skill-pack-expansion',
    activatedSkillPacks,
  });
  const providerResolutions = resolveProviders(inferredIntent, capabilities);
  const composition = buildComposition(inferredIntent, capabilities, matchedPatterns);

  console.log({
    stage: 'PATTERN-TRACE',
    matchedPatterns: matchedPatterns?.map((x) => x.name),
    skillPacks: activatedSkillPacks?.map((x) => x.name),
    providers: providerResolutions,
    requiredCredentials: undefined,
    graphProviders: undefined,
  });

  return {
    inferredIntent,
    capabilities,
    activatedSkillPacks,
    matchedPatterns,
    providerResolutions,
    composition,
  };
}
