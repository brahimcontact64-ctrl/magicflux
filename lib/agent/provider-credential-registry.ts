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
  slack: [
    { key: 'bot_token', label: 'Bot Token', required: true },
    { key: 'signing_secret', label: 'Signing Secret', required: true },
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
  x: [
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
  xai: 'x',
  grok: 'x',
  twitterx: 'x',
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
