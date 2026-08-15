/**
 * OAuth provider configuration registry.
 *
 * Each entry defines the authorization + token endpoints, required scopes,
 * the credential key (matching provider-registry.ts), and the env var names
 * for the client credentials.
 *
 * Adding a new OAuth provider: add one entry here + register the corresponding
 * credential key in provider-registry.ts + add PROVIDER_CLIENT_ID / _SECRET
 * env vars in your deployment.
 */

export type OAuthProviderConfig = {
  /** Canonical provider identifier (matches provider-registry keys) */
  provider: string;
  /** OAuth 2.0 authorization endpoint */
  authUrl: string;
  /** OAuth 2.0 token endpoint */
  tokenUrl: string;
  /** Space-separated scopes requested during authorization */
  scopes: string[];
  /** Key under which the token JSON is stored in integration_credentials */
  credentialKey: string;
  /** Environment variable name for the OAuth client ID */
  clientIdEnv: string;
  /** Environment variable name for the OAuth client secret */
  clientSecretEnv: string;
  /** Provider-specific extra params appended to the authorization URL */
  extraAuthParams?: Record<string, string>;
};

const GOOGLE_EXTRA_PARAMS: Record<string, string> = {
  access_type: 'offline', // request a refresh_token
  prompt: 'consent',      // force consent screen so refresh_token is always returned
};

const OAUTH_PROVIDER_REGISTRY: Readonly<Record<string, OAuthProviderConfig>> = {
  gmail: {
    provider: 'gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    credentialKey: 'oauth_google_gmail',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: GOOGLE_EXTRA_PARAMS,
  },
  google_sheets: {
    provider: 'google_sheets',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    credentialKey: 'oauth_google_sheets',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: GOOGLE_EXTRA_PARAMS,
  },
  google_drive: {
    provider: 'google_drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/drive',
    ],
    credentialKey: 'oauth_google_drive',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: GOOGLE_EXTRA_PARAMS,
  },
  canva: {
    provider: 'canva',
    authUrl: 'https://www.canva.com/api/oauth/authorize',
    tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
    scopes: [
      'asset:read',
      'asset:write',
      'design:content:read',
      'design:content:write',
    ],
    credentialKey: 'oauth_access_token',
    clientIdEnv: 'CANVA_CLIENT_ID',
    clientSecretEnv: 'CANVA_CLIENT_SECRET',
  },
};

/** Returns config for an OAuth provider, or null if the provider is not supported. */
export function getOAuthProviderConfig(provider: string): OAuthProviderConfig | null {
  return OAUTH_PROVIDER_REGISTRY[provider] ?? null;
}

/** True when the provider has a registered OAuth flow. */
export function isOAuthProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(OAUTH_PROVIDER_REGISTRY, provider);
}

/** Returns all provider identifiers that have OAuth flows. */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDER_REGISTRY);
}

export type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

/**
 * Exchanges an authorization code for tokens using the provider's token endpoint.
 * Throws on network error or non-200 response.
 */
export async function exchangeOAuthCode(
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string
): Promise<OAuthTokenResponse> {
  const clientId = process.env[config.clientIdEnv] ?? '';
  const clientSecret = process.env[config.clientSecretEnv] ?? '';

  if (!clientId || !clientSecret) {
    throw new Error(`OAuth credentials not configured for provider: ${config.provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Token endpoint returned non-JSON response');
  }

  if (!res.ok || !data.access_token) {
    const desc = String(data.error_description ?? data.error ?? 'Token exchange failed');
    throw new Error(desc);
  }

  return {
    access_token: String(data.access_token),
    refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    token_type: data.token_type ? String(data.token_type) : 'Bearer',
  };
}

/**
 * Exchanges a refresh_token for a new access_token.
 * Throws on network error, non-200 response, or missing access_token.
 * Google may or may not return a new refresh_token — callers must preserve
 * the existing one when the response does not include it.
 */
export async function refreshOAuthToken(
  config: OAuthProviderConfig,
  refreshToken: string
): Promise<OAuthTokenResponse> {
  const clientId = process.env[config.clientIdEnv] ?? '';
  const clientSecret = process.env[config.clientSecretEnv] ?? '';

  if (!clientId || !clientSecret) {
    throw new Error(`OAuth credentials not configured for provider: ${config.provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Token endpoint returned non-JSON response');
  }

  if (!res.ok || !data.access_token) {
    const desc = String(data.error_description ?? data.error ?? 'Token refresh failed');
    throw new Error(desc);
  }

  return {
    access_token: String(data.access_token),
    // Providers (e.g. Google) may not return a new refresh_token on every refresh
    refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    token_type: data.token_type ? String(data.token_type) : 'Bearer',
  };
}

/**
 * Serializes OAuth tokens into the JSON value stored under the provider's
 * credential key.  Stored as a single encrypted JSON blob so the key count in
 * integration_credentials matches what provider-registry.ts expects.
 */
export function serializeOAuthTokens(tokens: OAuthTokenResponse): string {
  return JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    token_type: tokens.token_type ?? 'Bearer',
    expires_at: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : null,
  });
}
