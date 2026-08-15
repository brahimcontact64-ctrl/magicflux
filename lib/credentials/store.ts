import 'server-only';

import {
  verifyProviderConnection,
  isProviderConnected,
  getDecryptedProviderCredentials,
  getAllConnectedProviders,
  assertTrustedUserId,
} from './storage';
import { getProviderDisplayName } from './provider-registry';
import type { CredentialSummary, NodeCredentialValidation } from './types';

// ─── Runtime resolution ───────────────────────────────────────────────────────
// Returns decrypted plaintext credentials for server-side execution ONLY.
// The return value MUST NOT be logged, serialized to JSON responses, or sent to clients.

export async function resolveCredentialsForRuntime(
  userId: string,
  provider: string,
): Promise<Record<string, string>> {
  assertTrustedUserId(userId);
  return getDecryptedProviderCredentials(userId, provider);
}

// ─── Status queries ───────────────────────────────────────────────────────────
// Safe to return to UI — never contains credential values.

export async function getCredentialSummary(
  userId: string,
  provider: string,
): Promise<CredentialSummary> {
  assertTrustedUserId(userId);
  const status = await verifyProviderConnection(userId, provider).catch(() => ({
    connected: false as boolean,
    missing: [] as string[],
  }));
  return {
    provider,
    displayName: getProviderDisplayName(provider),
    status: status.connected ? 'connected' : 'missing',
    missingFields: status.missing,
  };
}

export async function listConnectedProviders(userId: string): Promise<string[]> {
  assertTrustedUserId(userId);
  return getAllConnectedProviders(userId);
}

// ─── Node credential validation ───────────────────────────────────────────────

export async function validateNodeCredentialProvider(
  provider: string,
  userId: string,
): Promise<NodeCredentialValidation> {
  assertTrustedUserId(userId);
  const status = await verifyProviderConnection(userId, provider).catch(() => ({
    connected: false as boolean,
    missing: [] as string[],
  }));
  return { provider, connected: status.connected, missing: status.missing };
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { isProviderConnected, verifyProviderConnection };
