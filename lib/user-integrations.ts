import { createServiceClient } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow, type IntegrationProvider } from '@/lib/integrations';
import { decryptIntegrationCredentials } from '@/lib/security/encryption';
import {
  getAllConnectedProviders,
  verifyProviderConnection,
  getDecryptedProviderCredentials,
} from '@/lib/credentials/storage';
import { isOAuthProvider } from '@/lib/credentials/oauth-providers';
import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';

export type IntegrationStatus = 'connected' | 'invalid' | 'not_connected';

export type UserIntegration = {
  id?: string;
  provider: IntegrationProvider;
  credentials: Record<string, string>;
  status: IntegrationStatus;
  name?: string | null;
  last_verified_at?: string | null;
  created_at?: string;
};

// Providers connectable via the current Credentials UI / OAuth flow
// (lib/credentials/*, table `integration_credentials`) that also have a
// live workflow-runtime handler keyed on the legacy IntegrationProvider union.
const BRIDGED_PROVIDERS: ReadonlySet<IntegrationProvider> = new Set([
  'shopify', 'slack', 'airtable', 'gmail', 'google_drive', 'openai', 'custom',
]);

/**
 * Resolves one provider's credentials from the new integration_credentials
 * store into the shape the workflow runtime expects. OAuth providers (gmail,
 * google_drive) resolve to a ready-to-use, auto-refreshed access_token rather
 * than the raw stored token JSON — handlers never see refresh_token/expiry.
 * Returns null when the provider isn't connected there or resolution fails,
 * so callers can fall back to the legacy row for that provider.
 */
async function resolveBridgedIntegration(
  userId: string,
  provider: IntegrationProvider
): Promise<UserIntegration | null> {
  const status = await verifyProviderConnection(userId, provider).catch(() => null);
  if (!status?.connected) return null;

  try {
    if (isOAuthProvider(provider)) {
      const accessToken = await getValidAccessToken(userId, provider);
      return { provider, credentials: { access_token: accessToken }, status: 'connected' };
    }
    const credentials = await getDecryptedProviderCredentials(userId, provider);
    return { provider, credentials, status: 'connected' };
  } catch {
    return null;
  }
}

/**
 * Merges credentials connected via the new integration_credentials store
 * (Credentials UI, OAuth flow) into a set of legacy user_integrations rows.
 *
 * Root-cause fix: the Credentials UI, OAuth flow, and runtime pre-flight
 * validation all read/write `integration_credentials`, but every real node
 * handler previously only ever saw rows from the legacy `user_integrations`
 * table via this function — so a credential connected in the UI would pass
 * pre-flight and then fail at every node with "integration not configured".
 * New-system entries take precedence per provider since that is the store
 * users actually connect credentials through today.
 */
async function bridgeNewCredentialSystem(
  userId: string,
  legacyRows: UserIntegration[]
): Promise<UserIntegration[]> {
  const connectedProviders = await getAllConnectedProviders(userId).catch(() => [] as string[]);
  const candidates = connectedProviders.filter((p): p is IntegrationProvider =>
    BRIDGED_PROVIDERS.has(p as IntegrationProvider)
  );
  if (candidates.length === 0) return legacyRows;

  const bridged = (
    await Promise.all(candidates.map((p) => resolveBridgedIntegration(userId, p)))
  ).filter((row): row is UserIntegration => row !== null);

  if (bridged.length === 0) return legacyRows;

  const bridgedProviders = new Set(bridged.map((row) => row.provider));
  const remainingLegacy = legacyRows.filter((row) => !bridgedProviders.has(row.provider));
  return [...bridged, ...remainingLegacy];
}

export async function getUserIntegrations(
  userId: string,
  opts?: { connectedOnly?: boolean }
): Promise<UserIntegration[]> {
  const connectedOnly = opts?.connectedOnly ?? true;
  const db = createServiceClient();
  const { data, error } = await db
    .from('user_integrations')
    .select('id, provider, name, credentials, status, last_verified_at, created_at')
    .eq('user_id', userId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []).map((row) => ({
    id: row.id as string | undefined,
    provider: row.provider as IntegrationProvider,
    name: (row.name as string | null | undefined) ?? null,
    credentials: decryptIntegrationCredentials((row.credentials ?? {}) as Record<string, unknown>),
    status: (row.status ?? 'not_connected') as IntegrationStatus,
    last_verified_at: (row.last_verified_at as string | null | undefined) ?? null,
    created_at: row.created_at as string | undefined,
  }));

  const filtered = connectedOnly ? rows.filter((row) => row.status === 'connected') : rows;
  return bridgeNewCredentialSystem(userId, filtered);
}

export async function getWorkflowIntegrationStatus(userId: string, workflowJson: unknown) {
  const userIntegrations = await getUserIntegrations(userId, { connectedOnly: false });
  const requiredIntegrations = requiredProvidersFromWorkflow(workflowJson);
  const connected = new Set(
    userIntegrations
      .filter((item) => item.status === 'connected')
      .map((item) => item.provider)
  );
  const missingIntegrations = requiredIntegrations.filter((provider) => !connected.has(provider));
  const invalidIntegrations = userIntegrations
    .filter((item) => item.status === 'invalid')
    .map((item) => item.provider);

  return {
    required_integrations: requiredIntegrations,
    missing_integrations: missingIntegrations,
    invalid_integrations: invalidIntegrations,
    user_integrations: userIntegrations.filter((item) => item.status === 'connected'),
    user_integrations_all: userIntegrations,
  };
}

  /**
   * Resolve workflow-level integration selections
   * 1. Check workflow_integrations for explicitly selected integration per provider
   * 2. Fall back to user default (if only one connected for that provider)
   * 3. Return resolved credentials or throw if missing
   */
  export async function resolveWorkflowIntegrations(
    userId: string,
    workflowId: string,
    workflowJson: unknown
  ) {
    const db = createServiceClient();
    const requiredProviders = requiredProvidersFromWorkflow(workflowJson);
    const userIntegrations = await getUserIntegrations(userId, { connectedOnly: true });

    const byProvider = new Map<IntegrationProvider, UserIntegration[]>();
    for (const integration of userIntegrations) {
      const list = byProvider.get(integration.provider) ?? [];
      list.push(integration);
      byProvider.set(integration.provider, list);
    }

    const { data: workflowSelections, error: selectionError } = await db
      .from('workflow_integrations')
      .select('provider, integration_id')
      .eq('workflow_id', workflowId)
      .eq('user_id', userId);

    if (selectionError) {
      throw new Error(selectionError.message);
    }

    const selectedByProvider = new Map<IntegrationProvider, string>();
    (workflowSelections ?? []).forEach((row) => {
      selectedByProvider.set(row.provider as IntegrationProvider, row.integration_id as string);
    });

    const resolved = new Map<IntegrationProvider, UserIntegration>();
    const warnings: string[] = [];

    for (const provider of requiredProviders) {
      const available = byProvider.get(provider) ?? [];
      if (available.length === 0) {
        throw new Error(`SETUP_REQUIRED:${provider}`);
      }

      const selectedId = selectedByProvider.get(provider);
      if (selectedId) {
        const selected = available.find((item) => item.id === selectedId);
        if (selected) {
          resolved.set(provider, selected);
          continue;
        }
        throw new Error(`SETUP_REQUIRED:${provider}`);
      }

      if (available.length === 1) {
        resolved.set(provider, available[0]);
        continue;
      }

      throw new Error(`SETUP_REQUIRED:${provider}`);
    }

    return { resolved, warnings };
  }
