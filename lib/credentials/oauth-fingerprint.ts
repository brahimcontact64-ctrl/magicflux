/**
 * Incident 9.9.17K -- safe, non-secret fingerprints of OAuth client
 * configuration, so two independently-deployed runtimes (Vercel and
 * Railway) can prove they are presenting the SAME OAuth client identity to
 * a provider without either side ever transmitting, logging, or displaying
 * the actual client id/secret.
 *
 * A SHA-256 digest is a one-way function: recovering the input from the
 * fingerprint is computationally infeasible, and truncating to 16 hex
 * characters (64 bits) still leaves collision risk astronomically below
 * "two different real client secrets happen to fingerprint the same" for
 * this deployment's scale (a handful of providers, not billions of
 * comparisons). This is the same threat model as a git commit's short hash
 * or a TLS certificate's displayed fingerprint prefix -- a comparison aid,
 * not a secret itself.
 *
 * Fingerprints are computed from the SAME normalized value
 * (readOAuthClientCredentials' whitespace-trimmed read) that is actually
 * sent to the provider, so a fingerprint match is a genuine guarantee of
 * runtime behavioral equivalence, not just of the raw env var text.
 */

import { createHash } from 'crypto';
import {
  getOAuthProviderConfig,
  listOAuthProviders,
  readOAuthClientCredentials,
} from './oauth-providers';

const FINGERPRINT_LENGTH = 16; // hex chars (64 bits) -- enough to distinguish, never to recover

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Incident 9.9.17L -- the same one-way, truncated SHA-256 fingerprint,
 * exposed for non-client-credential secrets (specifically, a stored
 * refresh_token) so a token's IDENTITY can be tracked/compared across
 * events (did this refresh use the same token as last time? did the value
 * change between two writes to storage?) without ever recording the token
 * itself. Returns null for an empty/absent value so "no token" is never
 * confused with "a token that fingerprints to some value".
 */
export function fingerprintSecret(value: string | null | undefined): string | null {
  return value ? fingerprint(value) : null;
}

export type OAuthClientFingerprint = {
  provider: string;
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  configured: boolean;
  clientIdFingerprint: string | null;
  clientSecretFingerprint: string | null;
};

/**
 * Non-secret identity of the CURRENT process -- which platform, and which
 * named environment/service on it -- so a fingerprint reading can be
 * attributed to "Railway runtime-worker" vs. "Vercel production" without
 * guessing from context. Every value here is already non-sensitive
 * deployment metadata (platform-injected, never a credential).
 */
export function getRuntimeIdentity(): { platform: string; environment: string | null; service: string | null } {
  if (process.env.VERCEL) {
    return {
      platform: 'vercel',
      environment: process.env.VERCEL_ENV ?? null,
      service: process.env.VERCEL_GIT_REPO_SLUG ?? null,
    };
  }
  if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_NAME) {
    return {
      platform: 'railway',
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
      service: process.env.RAILWAY_SERVICE_NAME ?? null,
    };
  }
  return { platform: 'unknown', environment: process.env.NODE_ENV ?? null, service: null };
}

/** Fingerprint for a single OAuth provider's currently-configured client credentials. */
export function computeOAuthClientFingerprint(provider: string): OAuthClientFingerprint | null {
  const config = getOAuthProviderConfig(provider);
  if (!config) return null;

  const { clientId, clientSecret } = readOAuthClientCredentials(config);
  const configured = Boolean(clientId && clientSecret);

  return {
    provider,
    clientIdEnvVar: config.clientIdEnv,
    clientSecretEnvVar: config.clientSecretEnv,
    configured,
    clientIdFingerprint: clientId ? fingerprint(clientId) : null,
    clientSecretFingerprint: clientSecret ? fingerprint(clientSecret) : null,
  };
}

/** Fingerprints for every registered OAuth provider, for a single boot-time/diagnostic snapshot. */
export function computeAllOAuthClientFingerprints(): OAuthClientFingerprint[] {
  return listOAuthProviders()
    .map((provider) => computeOAuthClientFingerprint(provider))
    .filter((fp): fp is OAuthClientFingerprint => fp !== null);
}
