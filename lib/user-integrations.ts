import { createServiceClient } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow, canonicalizeProviderId, type IntegrationProvider } from '@/lib/integrations';
import { decryptIntegrationCredentials, CredentialDecryptionError } from '@/lib/security/encryption';
import {
  getAllConnectedProviders,
  verifyProviderConnection,
  getDecryptedProviderCredentials,
  getCredentialRowId,
} from '@/lib/credentials/storage';
import { isOAuthProvider, getOAuthProviderConfig } from '@/lib/credentials/oauth-providers';
import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';
import { logger } from '@/lib/runtime/logger';

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
  const status = await verifyProviderConnection(userId, provider).catch((err: unknown) => {
    // Incident 9.9.17G -- resolveWorkflowIntegrations() only ever surfaces a
    // bare "SETUP_REQUIRED:<provider>" regardless of WHY this returned
    // null, which made a genuine credential-row-exists-but-something-failed
    // case indistinguishable from "never connected at all" across three
    // separate live incidents. logger.warn already redacts its context
    // (lib/runtime/logger.ts -> redact()), and every error message reaching
    // this catch is one of: a generic DB error, or nothing at all (this
    // function has no other throw path) -- never token/secret material.
    logger.warn('integration_resolution.connection_check_failed', {
      provider,
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!status?.connected) return null;

  try {
    if (isOAuthProvider(provider)) {
      const accessToken = await getValidAccessToken(userId, provider);
      // Phase 9.9.8C -- the opaque, canonical identity for this OAuth
      // credential (integration_credentials' own real row id), so the
      // workflow-attachment selector (app/api/workflows/[id]/integrations)
      // and resolveWorkflowIntegrations() below have a stable, non-secret
      // id to reference -- previously omitted entirely for every OAuth
      // provider, which is exactly why a genuinely-connected Gmail OAuth
      // credential never appeared as attachable ("No connected
      // integrations") despite Settings correctly showing it Connected.
      // Best-effort: a lookup failure here must never break credential
      // resolution for actual workflow EXECUTION (the access_token above
      // already resolved successfully) -- only the attachment UI's
      // discoverability would be affected.
      const config = getOAuthProviderConfig(provider);
      const id = config
        ? await getCredentialRowId(userId, provider, config.credentialKey).catch(() => null)
        : null;
      return { ...(id ? { id } : {}), provider, credentials: { access_token: accessToken }, status: 'connected' };
    }
    const credentials = await getDecryptedProviderCredentials(userId, provider);
    return { provider, credentials, status: 'connected' };
  } catch (err) {
    // Incident 9.9.17G -- this is the exact swallow point that turned a real
    // Gmail OAuth failure (decrypt/config/refresh -- see
    // lib/credentials/oauth-refresh.ts's getValidAccessToken, whose own
    // thrown messages are already generic/safe: "No OAuth config for
    // provider: X", "No valid OAuth credentials stored for provider: X",
    // CredentialDecryptionError's fixed generic message, or Google's own
    // RFC 6749 error/error_description string) into an undifferentiated
    // "SETUP_REQUIRED:gmail" three separate times in production with zero
    // trace of which one actually happened. None of these messages ever
    // contain token/secret material by construction (see each throw site).
    logger.warn('integration_resolution.credential_resolve_failed', {
      provider,
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
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

  // Phase 9.9.7A -- fail-closed fix. `candidates` is exactly the set of
  // providers with a genuine, previously-completed connection in the new
  // integration_credentials system (e.g. a real Gmail OAuth grant,
  // saveCredentialsWithVerification() is atomic -- a row only exists here
  // once an exchange actually succeeded) -- that is the user's current,
  // ACTIVE choice for this provider. If resolving it now fails (an
  // expired/revoked OAuth refresh token, a decrypt failure), this must
  // fail closed, never silently fall through to an old legacy SMTP row
  // for the same provider: that would silently change which mailbox/
  // identity a workflow sends as, with the user never told their OAuth
  // connection broke. Previously this excluded only the SUCCESSFULLY
  // bridged providers from the legacy fallback set, so a broken OAuth
  // credential would silently resurrect a stale legacy credential instead
  // of surfacing SETUP_REQUIRED. Only a provider with NO attempted
  // new-system connection at all may fall back to legacy.
  const attemptedProviders = new Set(candidates);
  const remainingLegacy = legacyRows.filter((row) => !attemptedProviders.has(row.provider));
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
  //
  // Phase 9.9.5C -- decryptIntegrationCredentials() now fails closed
  // (throws CredentialDecryptionError) instead of silently returning raw
  // ciphertext as if it were the plaintext credential. A decrypt failure
  // on ONE row must not crash resolution for every OTHER integration this
  // user has connected (e.g. a broken Airtable credential must not also
  // take down an otherwise-working Slack/Email credential in the same
  // call) -- caught per row and reclassified as 'invalid', the same
  // status a credential that failed provider verification already gets,
  // so every existing downstream consumer (SETUP_REQUIRED activation/
  // live-test gates, the Builder's "Missing setup" indicator) already
  // knows how to block on it correctly with no new logic needed. The
  // credentials object is deliberately emptied, never the ciphertext.
  const rows = (data ?? []).map((row) => {
    const provider = canonicalizeProviderId(row.provider as string) as IntegrationProvider;
    const base = {
      id: row.id as string | undefined,
      provider,
      name: (row.name as string | null | undefined) ?? null,
      last_verified_at: (row.last_verified_at as string | null | undefined) ?? null,
      created_at: row.created_at as string | undefined,
    };
    try {
      return {
        ...base,
        credentials: decryptIntegrationCredentials((row.credentials ?? {}) as Record<string, unknown>),
        status: (row.status ?? 'not_connected') as IntegrationStatus,
      };
    } catch (err) {
      if (!(err instanceof CredentialDecryptionError)) throw err;
      console.error(`[user-integrations] credential decryption failed for integration ${base.id} (provider: ${provider}) -- treating as invalid, never using ciphertext as a credential`);
      return { ...base, credentials: {}, status: 'invalid' as IntegrationStatus };
    }
  });

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
    workflowJson: unknown,
    opts?: { fromNodeName?: string | null }
  ) {
    const db = createServiceClient();
    const requiredProviders = requiredProvidersFromWorkflow(workflowJson, opts);
    const userIntegrations = await getUserIntegrations(userId, { connectedOnly: true });

    const byProvider = new Map<IntegrationProvider, UserIntegration[]>();
    for (const integration of userIntegrations) {
      const list = byProvider.get(integration.provider) ?? [];
      list.push(integration);
      byProvider.set(integration.provider, list);
    }

    const { data: workflowSelections, error: selectionError } = await db
      .from('workflow_integrations')
      .select('provider, integration_id, credential_id')
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
    //
    // Phase 9.9.8E -- a row's opaque identity now lives in EITHER
    // integration_id (legacy) OR credential_id (OAuth/native), never both
    // (dual-FK migration). Exactly one is non-null per row, so this always
    // resolves to the single real id regardless of which table it came
    // from; every downstream match below is a plain opaque-id equality
    // check against getUserIntegrations()'s own `.id`, unaffected by which
    // column it originated from.
    const selectedByProvider = new Map<IntegrationProvider, string>();
    (workflowSelections ?? []).forEach((row) => {
      const selectedId = (row.integration_id ?? row.credential_id) as string | null;
      if (selectedId) {
        selectedByProvider.set(canonicalizeProviderId(String(row.provider)) as IntegrationProvider, selectedId);
      }
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
