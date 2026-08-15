import { verifyProviderConnection, assertTrustedUserId } from './storage';
import { getProviderCredentials, getRequiredCredentials } from './provider-registry';
import type { NodeCredentialValidation } from './types';

// ─── Per-provider validation ──────────────────────────────────────────────────

export async function validateProviderCredentials(
  provider: string,
  userId: string,
): Promise<NodeCredentialValidation> {
  assertTrustedUserId(userId);

  const fields = getProviderCredentials(provider);
  if (fields.length === 0) {
    return { provider, connected: true, missing: [] };
  }

  const status = await verifyProviderConnection(userId, provider).catch(() => ({
    connected: false as boolean,
    missing: getRequiredCredentials(provider).map((f) => f.key),
  }));

  return { provider, connected: status.connected, missing: status.missing };
}

// ─── Multi-provider workflow validation ───────────────────────────────────────
// Validates all credential-requiring providers for a set of node types.

export async function validateWorkflowCredentials(
  providers: string[],
  userId: string,
): Promise<NodeCredentialValidation[]> {
  assertTrustedUserId(userId);

  const unique = [...new Set(providers)];
  return Promise.all(unique.map((p) => validateProviderCredentials(p, userId)));
}

// ─── Pre-execution guard ──────────────────────────────────────────────────────
// Returns true if ALL listed providers have complete credentials.

export async function allCredentialsPresent(
  providers: string[],
  userId: string,
): Promise<boolean> {
  const results = await validateWorkflowCredentials(providers, userId);
  return results.every((r) => r.connected);
}
