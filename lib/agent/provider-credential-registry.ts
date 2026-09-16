import { normalizeProvider } from '@/lib/agent/provider-allowlist';

export type ProviderCredentialField = {
  key: string;
  label: string;
  required: boolean;
};

const PROVIDER_CREDENTIAL_REGISTRY: Record<string, ProviderCredentialField[]> = {
  telegram: [
    { key: 'bot_token', label: 'Bot Token', required: true },
    { key: 'chat_id', label: 'Chat ID', required: true },
  ],
  google_sheets: [
    { key: 'service_account', label: 'Service Account JSON', required: true },
    { key: 'spreadsheet_id', label: 'Spreadsheet ID', required: true },
  ],
  facebook: [
    { key: 'access_token', label: 'Access Token', required: true },
    { key: 'page_id', label: 'Page ID', required: true },
  ],
  openai: [
    { key: 'api_key', label: 'API Key', required: true },
  ],
  canva: [
    { key: 'oauth_access_token', label: 'OAuth Access Token', required: true },
  ],
  stripe: [
    { key: 'secret_key', label: 'Secret Key', required: true },
  ],
  airtable: [
    { key: 'airtable_token', label: 'Airtable Token', required: true },
    { key: 'base_id', label: 'Base ID', required: true },
  ],
  // Phase 9.9.8 -- product-truth fix. This registry drives the Builder's
  // node-level "Configure X" required-field text (via
  // lib/conversation/user-safe-payload.ts's sanitizeWorkflowGraph(), which
  // recomputes credentialSchema live from here on every turn -- never from
  // whatever a node's own stored parameters happened to say at generation
  // time) and the Builder connect modal's manual-field fallback schema. It
  // had drifted from the canonical credential contract each provider's real,
  // working connection actually uses (lib/credentials/provider-registry.ts):
  // slack never reads/validates a signing_secret anywhere in this codebase
  // (grep confirms zero real usage outside this now-corrected stale entry),
  // and gmail's real, current connection path (Phase 9.9.7A/B) is a single
  // Google OAuth grant -- a normal user is never meant to obtain or paste a
  // client_id/client_secret/refresh_token themselves (those are platform-
  // level server secrets). SMTP remains an available fallback transport
  // (components/builder/integration-connect-modal.tsx's "Use SMTP instead"),
  // but is a UI-only alternate path, not part of gmail's default credential
  // requirement -- its fixed field list now lives locally in that modal
  // (GMAIL_SMTP_FALLBACK_SCHEMA) rather than here, so it can never leak back
  // into the default "Configure Gmail" card text as if OAuth needed it too.
  slack: [
    { key: 'bot_token', label: 'Bot Token', required: true },
  ],
  gmail: [
    { key: 'oauth_google_gmail', label: 'Google OAuth', required: true },
  ],
  hubspot: [
    { key: 'private_app_token', label: 'Private App Token', required: true },
  ],
  shopify: [
    { key: 'store_domain', label: 'Store Domain', required: true },
    { key: 'admin_access_token', label: 'Admin Access Token', required: true },
  ],
  elevenlabs: [
    { key: 'api_key', label: 'API Key', required: true },
  ],
  claude: [
    { key: 'api_key', label: 'API Key', required: true },
  ],
  twitter: [
    { key: 'bearer_token', label: 'Bearer Token', required: true },
  ],
  cloudflare_ai: [
    { key: 'account_id', label: 'Account ID', required: true },
    { key: 'api_token', label: 'API Token', required: true },
  ],
};

const PROVIDER_ALIASES: Record<string, string> = {
  googlesheets: 'google_sheets',
  google_sheet: 'google_sheets',
  google_spreadsheets: 'google_sheets',
  email: 'gmail',
  smtp: 'gmail',
  xai: 'twitter',
  grok: 'twitter',
  twitterx: 'twitter',
  cloudflare: 'cloudflare_ai',
  cloudflareai: 'cloudflare_ai',
};

function toRegistryProvider(provider: string | null | undefined): string {
  const normalized = normalizeProvider(String(provider ?? ''));
  if (!normalized) return '';
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export function getProviderCredentialSchema(provider: string | null | undefined): ProviderCredentialField[] {
  const key = toRegistryProvider(provider);
  const schema = PROVIDER_CREDENTIAL_REGISTRY[key] ?? [];
  return schema.map((field) => ({ ...field }));
}

export function providerHasCredentialSchema(provider: string | null | undefined): boolean {
  return getProviderCredentialSchema(provider).length > 0;
}
