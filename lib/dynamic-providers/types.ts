export type Capability =
  | 'llm_generation'
  | 'chat_completion'
  | 'embeddings'
  | 'vector_search'
  | 'notifications'
  | 'messaging'
  | 'database'
  | 'storage'
  | 'analytics'
  | 'payments'
  | 'scraping'
  | 'scheduling'
  | 'deployment'
  | string;

export type ProviderCategory =
  | 'llm'
  | 'messaging'
  | 'database'
  | 'storage'
  | 'analytics'
  | 'payments'
  | 'automation'
  | 'other';

export type AuthStrategyType =
  | 'bearer_token'
  | 'api_key_header'
  | 'oauth2'
  | 'basic_auth'
  | 'custom_header'
  | 'query_key'
  | 'session_cookie';

export type AuthStrategy = {
  type: AuthStrategyType;
  headerName?: string;
  queryParam?: string;
  tokenPrefix?: string;
  usernameField?: string;
  passwordField?: string;
  cookieName?: string;
};

export type ValidationStrategy =
  | 'test_completion_call'
  | 'ping_endpoint'
  | 'list_resources'
  | 'sample_execution'
  | 'custom';

export type ProviderMetadata = {
  provider: string;
  displayName: string;
  providerType: ProviderCategory;
  capabilities: Capability[];
  requiredCredentials: string[];
  docsUrl?: string | null;
  logo?: string | null;
  authStrategy: AuthStrategy;
  validationStrategy: ValidationStrategy;
  endpointHints: string[];
  aliases?: string[];
  confidence: number;
  source: 'memory' | 'discovery' | 'reasoning';
};

export type ProviderReasoningResult = {
  providerType: ProviderCategory;
  likelyProvider: string;
  likelyCredentials: string[];
  likelyCapabilities: Capability[];
  likelyValidationMethod: ValidationStrategy;
  authStrategy: AuthStrategy;
  endpointHints: string[];
  confidence: number;
  metadata?: ProviderMetadata;
};

export type OpenApiDiscovery = {
  title?: string;
  description?: string;
  version?: string;
  servers: string[];
  paths: string[];
  securitySchemes: Array<{
    key: string;
    type: string;
    in?: string;
    name?: string;
    scheme?: string;
  }>;
  endpointHints: string[];
};

export type ProviderDiscoveryResult = {
  providerHint: string;
  resolvedProviderName: string;
  docsUrl?: string;
  homepageUrl?: string;
  openApiUrl?: string;
  discoveredCapabilities: Capability[];
  discoveredAuthStrategies: AuthStrategy[];
  endpointHints: string[];
  openApi?: OpenApiDiscovery;
  rawSignals: string[];
  confidence: number;
};

export type ProviderAdapter = {
  provider: string;
  capability: Capability;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: AuthStrategy;
  payloadTemplate?: Record<string, unknown>;
  payloadTransformer?: {
    mode: 'merge_input' | 'map_fields';
    mapping?: Record<string, string>;
  };
  responseTransformer?: {
    mode: 'identity' | 'pick_path';
    path?: string;
  };
  retryPolicy?: {
    attempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  validation?: {
    endpoint?: string;
    method?: 'GET' | 'POST';
    expectedStatuses?: number[];
  };
};

export type ProviderValidationReport = {
  ok: boolean;
  authSuccess: boolean;
  endpointReachable: boolean;
  sampleExecution: boolean;
  quotaHealthy: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
};

export type DynamicIntegrationCardModel = {
  provider: string;
  category: ProviderCategory;
  capabilities: Capability[];
  requiredCredentials: Array<{
    key: string;
    label: string;
    secret: boolean;
    placeholder?: string;
  }>;
  docsUrl?: string | null;
  logo?: string | null;
  authStrategy: AuthStrategy;
  validationStrategy: ValidationStrategy;
  endpointHints: string[];
};
