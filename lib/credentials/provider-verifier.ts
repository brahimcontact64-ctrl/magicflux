/**
 * Real API-based credential validation for each supported provider.
 * Every validator makes an actual request to the provider's endpoint.
 *
 * Security rules applied throughout:
 * - No credential values are ever logged
 * - Error messages are sanitized before returning to callers
 * - Raw API responses are never forwarded to clients
 * - Timeout enforced on every request (VALIDATION_TIMEOUT_MS)
 */

export const VALIDATION_TIMEOUT_MS = 10_000;

export type ValidationResult = {
  connected: boolean;
  errors: string[];
  metadata?: Record<string, unknown>;
};

type FetchResult = {
  ok: boolean;
  status: number;
  body: string;
};

async function timedFetch(url: string, init: RequestInit = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderValidationError('timeout', 'Connection timed out — provider may be unreachable');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class ProviderValidationError extends Error {
  constructor(public readonly kind: 'timeout' | 'network' | 'auth' | 'config', message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

function sanitize(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/(token|key|secret|password|pass|auth|bearer)\s*[:=][^\s"',;]+/gi, '$1=[redacted]')
    .slice(0, 220);
}

function mapStatus(status: number, provider: string, body: string): string {
  if (status === 401 || status === 403) {
    return `${provider}: Authentication failed — check your credentials`;
  }
  if (status === 404) {
    return `${provider}: Resource not found — check your configuration`;
  }
  if (status === 429) {
    return `${provider}: Rate limit exceeded — please try again shortly`;
  }
  if (status >= 500) {
    return `${provider}: Provider service error (${status}) — try again later`;
  }
  const excerpt = sanitize(body).slice(0, 80);
  return `${provider}: Unexpected response (${status})${excerpt ? `: ${excerpt}` : ''}`;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function validateTelegram(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.bot_token ?? '').trim();
  if (!token) return { connected: false, errors: ['Bot Token is required'] };

  if (!/^\d{6,}:[A-Za-z0-9_-]{35,}$/.test(token)) {
    return {
      connected: false,
      errors: ['Bot Token format is invalid (expected: numbers:alphanumeric, e.g. 123456:ABCdef…)'],
    };
  }

  let result: FetchResult;
  try {
    result = await timedFetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`
    );
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Telegram: Network error — check your connection'],
    };
  }

  if (!result.ok) {
    let detail = mapStatus(result.status, 'Telegram', result.body);
    try {
      const json = JSON.parse(result.body) as { description?: string };
      if (json.description) detail = `Telegram: ${sanitize(json.description)}`;
    } catch { /* ignore */ }
    return { connected: false, errors: [detail] };
  }

  let botInfo: { id?: number; username?: string } = {};
  try {
    const json = JSON.parse(result.body) as { ok: boolean; result?: { id: number; username?: string }; description?: string };
    if (!json.ok) {
      return { connected: false, errors: [`Telegram: ${sanitize(json.description ?? 'Invalid bot token')}`] };
    }
    botInfo = json.result ?? {};
  } catch {
    return { connected: false, errors: ['Telegram: Could not parse API response'] };
  }

  const metadata: Record<string, unknown> = {};
  if (botInfo.id) metadata.botId = botInfo.id;
  if (botInfo.username) metadata.username = botInfo.username;

  // Optional: verify chat_id if provided
  const chatId = (credentials.chat_id ?? '').trim();
  if (chatId) {
    try {
      const chatResult = await timedFetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/getChat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
        }
      );
      if (chatResult.ok) {
        const cj = JSON.parse(chatResult.body) as { ok: boolean; result?: { title?: string; type?: string } };
        if (cj.ok && cj.result) {
          if (cj.result.title) metadata.chatTitle = cj.result.title;
          if (cj.result.type) metadata.chatType = cj.result.type;
        }
      }
      // Chat validation is advisory — bot may not yet be added to the chat.
      // Do NOT fail the connection if getChat returns an error.
    } catch { /* advisory only */ }
  }

  return { connected: true, errors: [], metadata };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function validateSlack(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.bot_token ?? '').trim();
  if (!token) return { connected: false, errors: ['Bot Token is required'] };

  if (!token.startsWith('xoxb-') && !token.startsWith('xoxp-') && !token.startsWith('xoxa-')) {
    return {
      connected: false,
      errors: ['Slack Bot Token format is invalid (must start with xoxb-)'],
    };
  }

  let result: FetchResult;
  try {
    result = await timedFetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Slack: Network error — check your connection'],
    };
  }

  try {
    const json = JSON.parse(result.body) as { ok: boolean; error?: string; team?: string; user?: string; user_id?: string; team_id?: string };
    if (!json.ok) {
      const slackError = sanitize(json.error ?? 'unknown_error');
      const friendly =
        slackError === 'invalid_auth' ? 'Slack: Bot token is invalid or revoked' :
        slackError === 'token_revoked' ? 'Slack: Bot token has been revoked' :
        slackError === 'account_inactive' ? 'Slack: Bot account is inactive' :
        `Slack: Authentication failed (${slackError})`;
      return { connected: false, errors: [friendly] };
    }
    const metadata: Record<string, unknown> = {};
    if (json.team) metadata.team = json.team;
    if (json.team_id) metadata.teamId = json.team_id;
    if (json.user_id) metadata.botUserId = json.user_id;
    return { connected: true, errors: [], metadata };
  } catch {
    return { connected: false, errors: [mapStatus(result.status, 'Slack', result.body)] };
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function validateOpenAI(credentials: Record<string, string>): Promise<ValidationResult> {
  const key = (credentials.api_key ?? '').trim();
  if (!key) return { connected: false, errors: ['API Key is required'] };

  if (!key.startsWith('sk-')) {
    return { connected: false, errors: ['OpenAI API Key format is invalid (must start with sk-)'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'OpenAI: Network error — check your connection'],
    };
  }

  if (result.status === 401) {
    return { connected: false, errors: ['OpenAI: API key is invalid or expired'] };
  }
  if (result.status === 429) {
    return { connected: false, errors: ['OpenAI: Rate limit exceeded — please try again shortly'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'OpenAI', result.body)] };
  }

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── Claude (Anthropic) ────────────────────────────────────────────────────────

async function validateClaude(credentials: Record<string, string>): Promise<ValidationResult> {
  const key = (credentials.api_key ?? '').trim();
  if (!key) return { connected: false, errors: ['API Key is required'] };

  if (!key.startsWith('sk-ant-')) {
    return { connected: false, errors: ['Anthropic API Key format is invalid (must start with sk-ant-)'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Claude: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Claude: API key is invalid or unauthorized'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'Claude (Anthropic)', result.body)] };
  }

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── Shopify ───────────────────────────────────────────────────────────────────

function normalizeShopDomain(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try { return new URL(trimmed).host; } catch { return trimmed; }
  }
  return trimmed;
}

async function validateShopify(credentials: Record<string, string>): Promise<ValidationResult> {
  const domain = normalizeShopDomain(credentials.shop_domain ?? '');
  const token = (credentials.access_token ?? '').trim();

  if (!domain) return { connected: false, errors: ['Shop Domain is required'] };
  if (!token) return { connected: false, errors: ['Admin Access Token is required'] };

  if (!domain.includes('.')) {
    return { connected: false, errors: ['Shop Domain format is invalid (e.g. mystore.myshopify.com)'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (err instanceof ProviderValidationError) return { connected: false, errors: [err.message] };
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      return { connected: false, errors: ['Shopify: Store domain is unreachable — verify your shop domain'] };
    }
    return { connected: false, errors: ['Shopify: Network error — check your connection'] };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Shopify: Admin access token is invalid or lacks required permissions'] };
  }
  if (result.status === 404) {
    return { connected: false, errors: ['Shopify: Store not found — check your shop domain'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'Shopify', result.body)] };
  }

  let metadata: Record<string, unknown> = {};
  try {
    const json = JSON.parse(result.body) as { shop?: { name?: string; plan_name?: string; domain?: string } };
    if (json.shop) {
      if (json.shop.name) metadata.shopName = json.shop.name;
      if (json.shop.plan_name) metadata.plan = json.shop.plan_name;
    }
  } catch { /* optional metadata */ }

  return { connected: true, errors: [], metadata };
}

// ── Airtable ──────────────────────────────────────────────────────────────────

async function validateAirtable(credentials: Record<string, string>): Promise<ValidationResult> {
  const pat = (credentials.personal_access_token ?? '').trim();
  if (!pat) return { connected: false, errors: ['Personal Access Token is required'] };

  if (!pat.startsWith('pat')) {
    return { connected: false, errors: ['Airtable PAT format is invalid (must start with "pat")'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.airtable.com/v0/meta/bases?offset=&pageSize=1', {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Airtable: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Airtable: Personal Access Token is invalid or expired'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'Airtable', result.body)] };
  }

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── HubSpot ───────────────────────────────────────────────────────────────────

async function validateHubspot(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.access_token ?? '').trim();
  if (!token) return { connected: false, errors: ['Private App Token is required'] };

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.hubapi.com/account-info/v3/details', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'HubSpot: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['HubSpot: Access token is invalid or lacks required scopes'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'HubSpot', result.body)] };
  }

  let metadata: Record<string, unknown> = {};
  try {
    const json = JSON.parse(result.body) as { portalId?: number; uiDomain?: string };
    if (json.portalId) metadata.portalId = json.portalId;
  } catch { /* optional */ }

  return { connected: true, errors: [], metadata };
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async function validateStripe(credentials: Record<string, string>): Promise<ValidationResult> {
  const key = (credentials.secret_key ?? '').trim();
  if (!key) return { connected: false, errors: ['Secret Key is required'] };

  if (!key.startsWith('sk_live_') && !key.startsWith('sk_test_')) {
    return { connected: false, errors: ['Stripe Secret Key format is invalid (must start with sk_live_ or sk_test_)'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Stripe: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Stripe: Secret key is invalid or revoked'] };
  }
  if (!result.ok) {
    return { connected: false, errors: [mapStatus(result.status, 'Stripe', result.body)] };
  }

  let metadata: Record<string, unknown> = {};
  try {
    const json = JSON.parse(result.body) as { id?: string; display_name?: string; country?: string };
    if (json.id) metadata.accountId = json.id;
    if (json.display_name) metadata.displayName = json.display_name;
    if (json.country) metadata.country = json.country;
  } catch { /* optional */ }

  return { connected: true, errors: [], metadata };
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

async function validateWhatsApp(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.access_token ?? '').trim();
  const phoneNumberId = (credentials.phone_number_id ?? '').trim();
  const businessAccountId = (credentials.business_account_id ?? '').trim();

  if (!token) return { connected: false, errors: ['Access Token is required'] };
  if (!phoneNumberId) return { connected: false, errors: ['Phone Number ID is required'] };
  if (!businessAccountId) return { connected: false, errors: ['Business Account ID is required'] };

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number&access_token=${encodeURIComponent(token)}`;

  let result: FetchResult;
  try {
    result = await timedFetch(url);
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'WhatsApp: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['WhatsApp: Access token is invalid or expired'] };
  }
  if (result.status === 404) {
    return { connected: false, errors: ['WhatsApp: Phone Number ID not found — verify your configuration'] };
  }
  if (!result.ok) {
    let detail = mapStatus(result.status, 'WhatsApp', result.body);
    try {
      const json = JSON.parse(result.body) as { error?: { message?: string; code?: number } };
      if (json.error?.message) detail = `WhatsApp: ${sanitize(json.error.message)}`;
    } catch { /* ignore */ }
    return { connected: false, errors: [detail] };
  }

  let metadata: Record<string, unknown> = {};
  try {
    const json = JSON.parse(result.body) as { verified_name?: string; display_phone_number?: string };
    if (json.verified_name) metadata.verifiedName = json.verified_name;
    if (json.display_phone_number) metadata.phoneNumber = json.display_phone_number;
  } catch { /* optional */ }

  return { connected: true, errors: [], metadata };
}

// ── ElevenLabs ────────────────────────────────────────────────────────────────

async function validateElevenLabs(credentials: Record<string, string>): Promise<ValidationResult> {
  const key = (credentials.api_key ?? '').trim();
  if (!key) return { connected: false, errors: ['API Key is required'] };

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'ElevenLabs: Network error — check your connection'],
    };
  }

  if (result.status === 401) return { connected: false, errors: ['ElevenLabs: API key is invalid or expired'] };
  if (!result.ok) return { connected: false, errors: [mapStatus(result.status, 'ElevenLabs', result.body)] };

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── Deepgram ──────────────────────────────────────────────────────────────────

async function validateDeepgram(credentials: Record<string, string>): Promise<ValidationResult> {
  const key = (credentials.api_key ?? '').trim();
  if (!key) return { connected: false, errors: ['API Key is required'] };

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Deepgram: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Deepgram: API key is invalid or unauthorized'] };
  }
  if (!result.ok) return { connected: false, errors: [mapStatus(result.status, 'Deepgram', result.body)] };

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── Cloudflare AI ─────────────────────────────────────────────────────────────

async function validateCloudflareAI(credentials: Record<string, string>): Promise<ValidationResult> {
  const apiToken = (credentials.api_token ?? '').trim();
  const accountId = (credentials.account_id ?? '').trim();

  if (!apiToken) return { connected: false, errors: ['API Token is required'] };
  if (!accountId) return { connected: false, errors: ['Account ID is required'] };

  let result: FetchResult;
  try {
    result = await timedFetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Cloudflare AI: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Cloudflare AI: API token is invalid or expired'] };
  }
  if (!result.ok) return { connected: false, errors: [mapStatus(result.status, 'Cloudflare AI', result.body)] };

  try {
    const json = JSON.parse(result.body) as { success: boolean; result?: { status?: string } };
    if (!json.success || json.result?.status !== 'active') {
      return { connected: false, errors: ['Cloudflare AI: Token is not active'] };
    }
  } catch { /* ignore parse errors */ }

  return { connected: true, errors: [], metadata: { accountId } };
}

// ── Twitter / X ───────────────────────────────────────────────────────────────

async function validateTwitter(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.bearer_token ?? '').trim();
  if (!token) return { connected: false, errors: ['Bearer Token is required'] };

  let result: FetchResult;
  try {
    result = await timedFetch(
      'https://api.twitter.com/2/tweets/search/recent?query=from%3Atwitterdev&max_results=10',
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Twitter/X: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Twitter/X: Bearer token is invalid or lacks required scopes'] };
  }
  if (!result.ok) return { connected: false, errors: [mapStatus(result.status, 'Twitter/X', result.body)] };

  return { connected: true, errors: [], metadata: { verified: true } };
}

// ── Facebook ──────────────────────────────────────────────────────────────────

async function validateFacebook(credentials: Record<string, string>): Promise<ValidationResult> {
  const token = (credentials.access_token ?? '').trim();
  const pageId = (credentials.page_id ?? '').trim();

  if (!token) return { connected: false, errors: ['Page Access Token is required'] };
  if (!pageId) return { connected: false, errors: ['Page ID is required'] };

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(pageId)}?fields=name,id&access_token=${encodeURIComponent(token)}`;

  let result: FetchResult;
  try {
    result = await timedFetch(url);
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Facebook: Network error — check your connection'],
    };
  }

  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Facebook: Access token is invalid or expired'] };
  }
  if (result.status === 404) {
    return { connected: false, errors: ['Facebook: Page not found — check your Page ID'] };
  }
  if (!result.ok) {
    let detail = mapStatus(result.status, 'Facebook', result.body);
    try {
      const json = JSON.parse(result.body) as { error?: { message?: string } };
      if (json.error?.message) detail = `Facebook: ${sanitize(json.error.message)}`;
    } catch { /* ignore */ }
    return { connected: false, errors: [detail] };
  }

  let metadata: Record<string, unknown> = {};
  try {
    const json = JSON.parse(result.body) as { name?: string; id?: string };
    if (json.name) metadata.pageName = json.name;
  } catch { /* optional */ }

  return { connected: true, errors: [], metadata };
}

// ── Supabase ──────────────────────────────────────────────────────────────────

async function validateSupabase(credentials: Record<string, string>): Promise<ValidationResult> {
  const projectUrl = (credentials.project_url ?? '').trim().replace(/\/$/, '');
  const anonKey = (credentials.anon_key ?? '').trim();

  if (!projectUrl) return { connected: false, errors: ['Project URL is required'] };
  if (!anonKey) return { connected: false, errors: ['Anon Key is required'] };

  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(projectUrl)) {
    return { connected: false, errors: ['Supabase Project URL format is invalid (expected: https://xxx.supabase.co)'] };
  }

  let result: FetchResult;
  try {
    result = await timedFetch(`${projectUrl}/rest/v1/`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    });
  } catch (err) {
    return {
      connected: false,
      errors: [err instanceof ProviderValidationError ? err.message : 'Supabase: Network error — check your connection'],
    };
  }

  // Supabase returns 200 or 400 (no schema specified) for valid projects
  if (result.status === 401 || result.status === 403) {
    return { connected: false, errors: ['Supabase: Anon key is invalid or project access denied'] };
  }
  if (result.status === 404) {
    return { connected: false, errors: ['Supabase: Project not found — check your project URL'] };
  }
  if (result.status >= 500) {
    return { connected: false, errors: [mapStatus(result.status, 'Supabase', result.body)] };
  }

  return { connected: true, errors: [], metadata: { projectUrl } };
}

// ── OAuth providers — require authorization flow ───────────────────────────────

function requiresOAuthFlow(provider: string): ValidationResult {
  return {
    connected: false,
    errors: [`${provider} requires an OAuth authorization flow — use the OAuth connect button`],
    metadata: { requiresOAuthFlow: true },
  };
}

/**
 * The generic/custom API-key credential type has no fixed endpoint to
 * validate against — it's the user's arbitrary API. Format requirements
 * (name, header_name, api_key present) are already enforced by the connect
 * route via getRequiredCredentials() before this runs, so there is nothing
 * further to check here. Unlike OAuth providers, this is a real usable
 * credential immediately — it just can't be live-verified generically.
 */
async function validateCustom(): Promise<ValidationResult> {
  return { connected: true, errors: [] };
}

// ── Provider dispatcher ────────────────────────────────────────────────────────

type ProviderValidator = (credentials: Record<string, string>) => Promise<ValidationResult>;

const VALIDATORS: Record<string, ProviderValidator | undefined> = {
  telegram: validateTelegram,
  slack: validateSlack,
  openai: validateOpenAI,
  claude: validateClaude,
  shopify: validateShopify,
  airtable: validateAirtable,
  hubspot: validateHubspot,
  stripe: validateStripe,
  whatsapp: validateWhatsApp,
  elevenlabs: validateElevenLabs,
  deepgram: validateDeepgram,
  cloudflare_ai: validateCloudflareAI,
  twitter: validateTwitter,
  facebook: validateFacebook,
  supabase: validateSupabase,
  // OAuth providers — no API-key-based validation possible
  gmail: () => Promise.resolve(requiresOAuthFlow('Gmail')),
  google_sheets: () => Promise.resolve(requiresOAuthFlow('Google Sheets')),
  google_drive: () => Promise.resolve(requiresOAuthFlow('Google Drive')),
  canva: () => Promise.resolve(requiresOAuthFlow('Canva')),
  // Generic API key — no fixed endpoint to validate against.
  custom: validateCustom,
};

/**
 * Validates provider credentials against the real provider API.
 * Never logs credential values. Sanitizes all error messages before returning.
 */
export async function validateProviderConnection(
  provider: string,
  credentials: Record<string, string>
): Promise<ValidationResult> {
  const validator = VALIDATORS[provider];
  if (!validator) {
    return {
      connected: false,
      errors: [`No validator available for provider: ${provider}`],
    };
  }

  try {
    return await validator(credentials);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return {
      connected: false,
      errors: [`${provider}: Validation error — ${sanitize(msg)}`],
    };
  }
}
