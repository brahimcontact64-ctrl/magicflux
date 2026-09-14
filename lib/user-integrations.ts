import { createServiceClient } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow, canonicalizeProviderId, type IntegrationProvider } from '@/lib/integrations';
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

  // Phase 9.8.5 -- canonicalize at load time so every consumer of this
  // function (resolveWorkflowIntegrations(), getWorkflowIntegrationStatus())
  // sees a legacy 'email' row as 'gmail' -- the one identifier
  // requiredProvidersFromWorkflow() ever asks for. Storage and stored
  // credentials are untouched; only the in-memory provider label changes.
  const rows = (data ?? []).map((row) => ({
    id: row.id as string | undefined,
    provider: canonicalizeProviderId(row.provider as string) as IntegrationProvider,
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
 * Phase 9.9.4B -- the ONE canonical way to get a user's connected Airtable
 * Personal Access Token for server-side use (schema discovery, the Builder's
 * base/table/field pickers, pre-activation mapping verification).
 *
 * Root cause this exists to fix: those callers previously called
 * lib/credentials/storage.ts's getDecryptedProviderCredentials(userId,
 * 'airtable') directly, expecting a 'personal_access_token' key -- but that
 * reads the newer `integration_credentials` table (the dynamic-provider/
 * OAuth credential store), while Settings' actual Airtable connect flow
 * (app/api/integrations/shared.ts's saveIntegration()) writes the legacy
 * `user_integrations` table under the key 'airtable_token'. A real,
 * verified Settings connection was therefore invisible to Builder discovery
 * and to activation's own schema check, which both reported "Airtable is
 * not connected" despite Settings showing Connected. getUserIntegrations()
 * above is already the correct, single source of truth every other runtime
 * consumer uses -- it merges both storage systems with the right key
 * fallbacks and precedence. This just extracts the one thing schema
 * discovery needs from it. The token is never returned to the browser by
 * any caller of this function.
 */
export async function getConnectedAirtableToken(userId: string): Promise<string | null> {
  const integrations = await getUserIntegrations(userId, { connectedOnly: true });
  const airtable = integrations.find((row) => row.provider === 'airtable');
  if (!airtable) return null;
  const creds = airtable.credentials;
  return creds.personal_access_token || creds.airtable_token || creds.api_key || null;
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

    // Phase 9.9.4F -- workflow_integrations.provider stores the credential's
    // OWN raw label (e.g. 'email'), not necessarily the canonical provider
    // requiredProvidersFromWorkflow() reports (e.g. 'gmail') -- see
    // app/api/workflows/[id]/integrations/route.ts's POST handler for why
    // (a live DB CHECK constraint on this column doesn't allow 'gmail' at
    // all). Canonicalize here so an explicit selection stored under either
    // label is always found by its canonical key below.
    const selectedByProvider = new Map<IntegrationProvider, string>();
    (workflowSelections ?? []).forEach((row) => {
      selectedByProvider.set(canonicalizeProviderId(String(row.provider)) as IntegrationProvider, row.integration_id as string);
    });

    const resolved = new Map<IntegrationProvider, UserIntegration>();
    const warnings: string[] = [];

    for (const provider of requiredProviders) {
      const available = byProvider.get(provider) ?? [];

      // 'custom' (the generic HTTP node's optional API-key credential) must
      // never block execution — httpHandler already treats an absent 'custom'
      // integration as "no extra header to inject", not an error (many HTTP
      // nodes call unauthenticated public APIs with no credential at all).
      // Every other provider node type genuinely cannot function without its
      // credential, so those still fail closed with SETUP_REQUIRED.
      if (provider === 'custom') {
        if (available.length === 0) continue;
        const selectedId = selectedByProvider.get(provider);
        const selected = (selectedId && available.find((item) => item.id === selectedId)) || (available.length === 1 ? available[0] : undefined);
        if (selected) resolved.set(provider, selected);
        continue;
      }

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
