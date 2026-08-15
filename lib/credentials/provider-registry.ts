import { normalizeProvider } from '@/lib/agent/provider-allowlist';

export type CredentialRequirement = {
  provider: string;
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  source: 'oauth' | 'api_key' | 'manual' | 'token';
  description: string;
};

const PROVIDER_CREDENTIAL_MAP: Readonly<Record<string, CredentialRequirement[]>> = {
  telegram: [
    { provider: 'telegram', key: 'bot_token', label: 'Bot Token', required: true, secret: true, source: 'token', description: 'Token from @BotFather on Telegram (starts with numbers:letters)' },
    { provider: 'telegram', key: 'chat_id', label: 'Chat ID', required: true, secret: false, source: 'manual', description: 'Target chat or channel ID (e.g. -100123456789)' },
  ],
  gmail: [
    { provider: 'gmail', key: 'oauth_google_gmail', label: 'Google OAuth', required: true, secret: true, source: 'oauth', description: 'Google account OAuth2 authorization' },
  ],
  slack: [
    { provider: 'slack', key: 'bot_token', label: 'Bot Token', required: true, secret: true, source: 'token', description: 'Slack Bot User OAuth Token (starts with xoxb-)' },
  ],
  shopify: [
    { provider: 'shopify', key: 'shop_domain', label: 'Shop Domain', required: true, secret: false, source: 'manual', description: 'Your Shopify store subdomain (e.g. mystore.myshopify.com)' },
    { provider: 'shopify', key: 'access_token', label: 'Admin Access Token', required: true, secret: true, source: 'api_key', description: 'Admin API access token from your Shopify custom app' },
  ],
  airtable: [
    { provider: 'airtable', key: 'personal_access_token', label: 'Personal Access Token', required: true, secret: true, source: 'api_key', description: 'Airtable PAT starting with "pat"' },
    { provider: 'airtable', key: 'base_id', label: 'Base ID', required: true, secret: false, source: 'manual', description: 'Airtable base ID (starts with app)' },
  ],
  hubspot: [
    { provider: 'hubspot', key: 'access_token', label: 'Private App Token', required: true, secret: true, source: 'api_key', description: 'HubSpot private app access token' },
  ],
  openai: [
    { provider: 'openai', key: 'api_key', label: 'API Key', required: true, secret: true, source: 'api_key', description: 'OpenAI API key (starts with sk-)' },
  ],
  claude: [
    { provider: 'claude', key: 'api_key', label: 'API Key', required: true, secret: true, source: 'api_key', description: 'Anthropic API key (starts with sk-ant-)' },
  ],
  stripe: [
    { provider: 'stripe', key: 'secret_key', label: 'Secret Key', required: true, secret: true, source: 'api_key', description: 'Stripe secret key (starts with sk_live_ or sk_test_)' },
    { provider: 'stripe', key: 'webhook_secret', label: 'Webhook Secret', required: false, secret: true, source: 'token', description: 'Stripe webhook endpoint signing secret (starts with whsec_)' },
  ],
  google_sheets: [
    { provider: 'google_sheets', key: 'oauth_google_sheets', label: 'Google OAuth', required: true, secret: true, source: 'oauth', description: 'Google account OAuth2 authorization for Sheets access' },
  ],
  google_drive: [
    { provider: 'google_drive', key: 'oauth_google_drive', label: 'Google OAuth', required: true, secret: true, source: 'oauth', description: 'Google account OAuth2 authorization for Drive access' },
  ],
  facebook: [
    { provider: 'facebook', key: 'access_token', label: 'Page Access Token', required: true, secret: true, source: 'token', description: 'Facebook page long-lived access token' },
    { provider: 'facebook', key: 'page_id', label: 'Page ID', required: true, secret: false, source: 'manual', description: 'Your Facebook page numeric ID' },
  ],
  twitter: [
    { provider: 'twitter', key: 'bearer_token', label: 'Bearer Token', required: true, secret: true, source: 'api_key', description: 'Twitter/X API v2 bearer token' },
  ],
  elevenlabs: [
    { provider: 'elevenlabs', key: 'api_key', label: 'API Key', required: true, secret: true, source: 'api_key', description: 'ElevenLabs API key from your account settings' },
  ],
  deepgram: [
    { provider: 'deepgram', key: 'api_key', label: 'API Key', required: true, secret: true, source: 'api_key', description: 'Deepgram API key from your project settings' },
  ],
  cloudflare_ai: [
    { provider: 'cloudflare_ai', key: 'account_id', label: 'Account ID', required: true, secret: false, source: 'manual', description: 'Your Cloudflare account ID from the dashboard' },
    { provider: 'cloudflare_ai', key: 'api_token', label: 'API Token', required: true, secret: true, source: 'token', description: 'Cloudflare API token with Workers AI permission' },
  ],
  whatsapp: [
    { provider: 'whatsapp', key: 'business_account_id', label: 'Business Account ID', required: true, secret: false, source: 'manual', description: 'Meta WhatsApp Business Account ID' },
    { provider: 'whatsapp', key: 'phone_number_id', label: 'Phone Number ID', required: true, secret: false, source: 'manual', description: 'WhatsApp Cloud API phone number ID' },
    { provider: 'whatsapp', key: 'access_token', label: 'Access Token', required: true, secret: true, source: 'token', description: 'Meta system user permanent access token' },
  ],
  canva: [
    { provider: 'canva', key: 'oauth_access_token', label: 'OAuth Access Token', required: true, secret: true, source: 'oauth', description: 'Canva Connect OAuth access token' },
  ],
  supabase: [
    { provider: 'supabase', key: 'project_url', label: 'Project URL', required: true, secret: false, source: 'manual', description: 'Your Supabase project URL (https://xxx.supabase.co)' },
    { provider: 'supabase', key: 'anon_key', label: 'Anon Key', required: true, secret: true, source: 'api_key', description: 'Supabase anon/public API key' },
  ],
  // Generic credential type for any provider not covered above — lets an
  // HTTP node reference an arbitrary API key without a dedicated provider
  // entry. Only one custom credential is supported per user today (the
  // storage layer keys rows by (user_id, provider) — see lib/credentials/storage.ts).
  custom: [
    { provider: 'custom', key: 'name', label: 'Name', required: true, secret: false, source: 'manual', description: 'A label for this credential (e.g. "Internal Metrics API")' },
    { provider: 'custom', key: 'header_name', label: 'Header Name', required: true, secret: false, source: 'manual', description: 'The HTTP header the key is sent in (e.g. Authorization, X-API-Key)' },
    { provider: 'custom', key: 'prefix', label: 'Prefix (optional)', required: false, secret: false, source: 'manual', description: 'Prepended to the value with a space, e.g. "Bearer"' },
    { provider: 'custom', key: 'api_key', label: 'API Key / Token', required: true, secret: true, source: 'api_key', description: 'The API key or token value' },
  ],
};

const REGISTRY_ALIASES: Record<string, string> = {
  email: 'gmail',
  smtp: 'gmail',
  googlesheets: 'google_sheets',
  google_sheet: 'google_sheets',
  googledrive: 'google_drive',
  cloudflare: 'cloudflare_ai',
  cloudflareai: 'cloudflare_ai',
  anthropic: 'claude',
  xai: 'twitter',
  grok: 'twitter',
};

function toRegistryKey(provider: string): string {
  const normalized = normalizeProvider(String(provider ?? ''));
  if (!normalized) return '';
  return REGISTRY_ALIASES[normalized] ?? normalized;
}

export function getProviderCredentials(provider: string): CredentialRequirement[] {
  const key = toRegistryKey(provider);
  if (!key) return [];
  return (PROVIDER_CREDENTIAL_MAP[key] ?? []).map((field) => ({ ...field }));
}

export function providerHasCredentials(provider: string): boolean {
  return getProviderCredentials(provider).length > 0;
}

export function getRequiredCredentials(provider: string): CredentialRequirement[] {
  return getProviderCredentials(provider).filter((f) => f.required);
}

export function getOptionalCredentials(provider: string): CredentialRequirement[] {
  return getProviderCredentials(provider).filter((f) => !f.required);
}

export function getProviderDisplayName(provider: string): string {
  const key = toRegistryKey(provider);
  const displayNames: Record<string, string> = {
    telegram: 'Telegram',
    gmail: 'Gmail',
    slack: 'Slack',
    shopify: 'Shopify',
    airtable: 'Airtable',
    hubspot: 'HubSpot',
    openai: 'OpenAI',
    claude: 'Claude (Anthropic)',
    stripe: 'Stripe',
    google_sheets: 'Google Sheets',
    google_drive: 'Google Drive',
    facebook: 'Facebook',
    twitter: 'Twitter / X',
    elevenlabs: 'ElevenLabs',
    deepgram: 'Deepgram',
    cloudflare_ai: 'Cloudflare AI',
    whatsapp: 'WhatsApp',
    canva: 'Canva',
    supabase: 'Supabase',
    custom: 'Custom API Key',
  };
  return displayNames[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
