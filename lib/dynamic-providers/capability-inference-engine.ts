import type {
  AuthStrategy,
  Capability,
  ProviderCategory,
  ValidationStrategy,
} from './types';

const CAPABILITY_SEMANTIC_INDEX: Record<string, Capability[]> = {
  llm: ['llm_generation', 'chat_completion'],
  chat: ['chat_completion'],
  completion: ['chat_completion'],
  prompt: ['llm_generation'],
  embedding: ['embeddings'],
  vector: ['vector_search', 'embeddings'],
  notification: ['notifications'],
  message: ['messaging', 'notifications'],
  webhook: ['notifications'],
  database: ['database'],
  sql: ['database'],
  postgres: ['database'],
  storage: ['storage'],
  bucket: ['storage'],
  file: ['storage'],
  analytics: ['analytics'],
  metric: ['analytics'],
  payment: ['payments'],
  billing: ['payments'],
  scrape: ['scraping'],
  crawl: ['scraping'],
  schedule: ['scheduling'],
  cron: ['scheduling'],
  deploy: ['deployment'],
  runtime: ['deployment'],
};

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9\s._-]/g, ' ');
}

export function inferCapabilitiesFromText(input: string): Capability[] {
  const normalized = normalizeText(input);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const found = new Set<Capability>();

  for (const [signal, capabilities] of Object.entries(CAPABILITY_SEMANTIC_INDEX)) {
    if (!tokens.has(signal) && !normalized.includes(signal)) continue;
    for (const capability of capabilities) {
      found.add(capability);
    }
  }

  return Array.from(found);
}

export function inferProviderCategory(capabilities: Capability[]): ProviderCategory {
  const set = new Set(capabilities);
  if (set.has('llm_generation') || set.has('chat_completion') || set.has('embeddings')) return 'llm';
  if (set.has('messaging') || set.has('notifications')) return 'messaging';
  if (set.has('database') || set.has('vector_search')) return 'database';
  if (set.has('storage')) return 'storage';
  if (set.has('analytics')) return 'analytics';
  if (set.has('payments')) return 'payments';
  if (set.has('deployment') || set.has('scheduling')) return 'automation';
  return 'other';
}

export function inferLikelyCredentials(params: {
  capabilities: Capability[];
  authHints?: AuthStrategy[];
}): string[] {
  const creds = new Set<string>();

  for (const strategy of params.authHints ?? []) {
    if (strategy.type === 'bearer_token') creds.add('api_key');
    if (strategy.type === 'api_key_header') creds.add('api_key');
    if (strategy.type === 'custom_header') creds.add('api_key');
    if (strategy.type === 'oauth2') {
      creds.add('client_id');
      creds.add('client_secret');
    }
    if (strategy.type === 'basic_auth') {
      creds.add('username');
      creds.add('password');
    }
    if (strategy.type === 'query_key') creds.add('api_key');
    if (strategy.type === 'session_cookie') creds.add('session_cookie');
  }

  const set = new Set(params.capabilities);
  if (set.has('llm_generation') || set.has('chat_completion') || set.has('embeddings')) {
    creds.add('api_key');
  }
  if (set.has('database')) {
    if (!creds.has('api_key')) {
      creds.add('connection_url');
    }
  }
  if (set.has('messaging') && !creds.has('api_key')) {
    creds.add('webhook_url');
  }

  if (creds.size === 0) {
    creds.add('api_key');
  }

  return Array.from(creds);
}

export function inferValidationStrategy(capabilities: Capability[]): ValidationStrategy {
  const set = new Set(capabilities);
  if (set.has('chat_completion') || set.has('llm_generation')) return 'test_completion_call';
  if (set.has('database') || set.has('storage')) return 'list_resources';
  if (set.has('notifications') || set.has('messaging')) return 'sample_execution';
  return 'ping_endpoint';
}
