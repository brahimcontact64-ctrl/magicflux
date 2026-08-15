import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { createServiceClient } from '@/lib/supabase-server';
import { encryptSecretValue, decryptSecretValue } from '@/lib/security/encryption';
import {
  getRequiredCredentials,
  getOptionalCredentials,
  getProviderDisplayName,
  providerHasCredentials,
} from './provider-registry';

// ── UUID validation guard ─────────────────────────────────────────────────────

/**
 * Asserts that userId is a valid Supabase UUID.
 * Must be called at the entry point of every function that operates on user
 * data, ensuring client-supplied values are never silently used.
 *
 * All userId values must originate from:
 *   - getUserFromAccessToken() / getUserFromRequest()  (API routes)
 *   - A distinct-user-id query on integration_credentials (cron batch)
 * Never from client-supplied body fields or query params.
 */
export function assertTrustedUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new Error('SECURITY: userId must be a non-empty string');
  }
  if (!uuidValidate(userId) || uuidVersion(userId) !== 4) {
    throw new Error('SECURITY: userId is not a valid UUID v4');
  }
}

// ── Encryption helpers ────────────────────────────────────────────────────────

// Keys whose values must be encrypted at rest
const SECRET_KEY_SET = new Set([
  'bot_token',
  'access_token',
  'api_key',
  'oauth_token',
  'secret_key',
  'bearer_token',
  'oauth_google',          // legacy — kept for backward-compat reads
  'oauth_google_gmail',
  'oauth_google_sheets',
  'oauth_google_drive',
  'oauth_access_token',
  'personal_access_token',
  'api_token',
  'webhook_secret',
  'anon_key',
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_SET.has(key);
}

// AES-256-GCM encrypt/decrypt for a single value — delegates to the one shared
// implementation in lib/security/encryption.ts (also used by the legacy
// user_integrations store), so there is a single source of truth for the
// cipher, key derivation, and on-disk format across both credential systems.
const encryptValue = encryptSecretValue;
const decryptValue = decryptSecretValue;

export function maskSecretValue(value: string): string {
  if (!value) return '********';
  if (value.length <= 4) return '********';
  return `${'*'.repeat(8)}${value.slice(-4)}`;
}

// Pure helper: determines what rows would be stored for a credential set.
// Exported for testing without live DB.
export function buildCredentialRows(
  userId: string,
  provider: string,
  credentials: Record<string, string>,
  now: string
): Array<{
  user_id: string;
  provider: string;
  credential_key: string;
  encrypted_value: string;
  is_secret: boolean;
  created_at: string;
  updated_at: string;
}> {
  return Object.entries(credentials)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([key, value]) => {
      const secret = isSecretKey(key);
      return {
        user_id: userId,
        provider,
        credential_key: key,
        encrypted_value: secret ? encryptValue(String(value).trim()) : String(value).trim(),
        is_secret: secret,
        created_at: now,
        updated_at: now,
      };
    });
}

export type CredentialEntry = {
  provider: string;
  credential_key: string;
  value: string; // masked for secrets, plaintext for non-secrets
  is_secret: boolean;
  created_at: string;
  updated_at: string;
};

export type ProviderConnectionStatus = {
  connected: boolean;
  missing: string[];
};

export async function saveProviderCredentials(
  userId: string,
  provider: string,
  credentials: Record<string, string>
): Promise<void> {
  assertTrustedUserId(userId);

  const rows = buildCredentialRows(userId, provider, credentials, new Date().toISOString());
  if (rows.length === 0) return;

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - integration_credentials RLS INSERT/UPDATE policies enforce auth.uid() = user_id,
   *   which requires the caller to present a user JWT.  The storage layer is a
   *   server-side helper that does not receive user JWTs; callers pass only a
   *   verified userId string.
   * - userId has been validated by assertTrustedUserId() above and originates
   *   exclusively from Supabase JWT verification — never from client-supplied input.
   * - Client-supplied values are never trusted: credential values are validated
   *   by the connect route before reaching here, and keys are checked against
   *   the provider registry.
   */
  const db = createServiceClient();
  const { error } = await db
    .from('integration_credentials')
    .upsert(rows, { onConflict: 'user_id,provider,credential_key' });

  if (error) throw new Error(`Failed to save credentials: ${error.message}`);
}

export async function getProviderCredentialsForUser(
  userId: string,
  provider: string
): Promise<CredentialEntry[]> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - This function is called from server-side API routes and maintenance paths
   *   where no user JWT is threaded through the storage layer.
   * - userId is always sourced from a Supabase-verified JWT in the calling
   *   API route, or from a DB query in cron paths.
   * - Return values mask secret fields (maskSecretValue), so plaintext secrets
   *   are never exposed to callers.
   */
  const db = createServiceClient();
  const { data, error } = await db
    .from('integration_credentials')
    .select('provider, credential_key, encrypted_value, is_secret, created_at, updated_at')
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    provider: String(row.provider),
    credential_key: String(row.credential_key),
    value: row.is_secret
      ? maskSecretValue(row.encrypted_value as string)
      : (row.encrypted_value as string),
    is_secret: Boolean(row.is_secret),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export async function isProviderConnected(userId: string, provider: string): Promise<boolean> {
  const status = await verifyProviderConnection(userId, provider);
  return status.connected;
}

export async function deleteProviderCredentials(userId: string, provider: string): Promise<void> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - integration_credentials RLS DELETE policy enforces auth.uid() = user_id,
   *   which requires a user JWT that is not available in the storage layer.
   * - userId is validated by assertTrustedUserId() and sourced from a verified JWT.
   * - Deleting another user's rows is prevented by the userId filter on the query.
   */
  const db = createServiceClient();
  const { error } = await db
    .from('integration_credentials')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) throw new Error(error.message);
}

/**
 * Checks whether all required fields for a provider exist in integration_credentials.
 * Falls back to user_integrations for legacy connections saved via the old /api/integrations/save
 * route so existing users are not incorrectly marked as disconnected.
 */
export async function verifyProviderConnection(
  userId: string,
  provider: string
): Promise<ProviderConnectionStatus> {
  assertTrustedUserId(userId);

  const required = getRequiredCredentials(provider);
  if (required.length === 0) {
    return { connected: false, missing: [] };
  }

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - Called from both API routes (user JWT available) and internal maintenance
   *   paths (no user JWT).  A single implementation avoids dual code paths.
   * - userId is validated by assertTrustedUserId() above and never sourced from
   *   client-supplied input.
   * - All queries are filtered by the verified userId — no cross-user access
   *   is possible.
   */
  const db = createServiceClient();

  // Primary: check per-key table
  const { data: credData, error: credError } = await db
    .from('integration_credentials')
    .select('credential_key')
    .eq('user_id', userId)
    .eq('provider', provider);

  if (credError) throw new Error(credError.message);

  const presentKeys = new Set((credData ?? []).map((r) => String(r.credential_key)));
  const requiredKeys = required.map((f) => f.key);
  const missing = requiredKeys.filter((k) => !presentKeys.has(k));

  if (missing.length === 0) {
    return { connected: true, missing: [] };
  }

  // Fallback: check legacy user_integrations for backward compatibility
  const { data: legacyRow } = await db
    .from('user_integrations')
    .select('status')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('status', 'connected')
    .maybeSingle();

  if (legacyRow) {
    return { connected: true, missing: [] };
  }

  return { connected: false, missing };
}

export type ProviderCredentialSummary = {
  provider: string;
  displayName: string;
  missing: Array<{ key: string; label: string; secret: boolean; source: string; description: string; required: boolean }>;
  optional: Array<{ key: string; label: string; secret: boolean; source: string; description: string; required: boolean }>;
  ready: boolean;
  confidence: number;
};

// ── Verification status ───────────────────────────────────────────────────────

export type VerificationStatus = 'healthy' | 'expired' | 'invalid' | 'unknown';

export type CredentialVerification = {
  provider: string;
  verifiedAt: string | null;
  status: VerificationStatus;
  metadata?: Record<string, unknown>;
};

/**
 * Upserts the API-validation outcome for a provider into credential_verifications.
 * Called after a successful or failed real API check.
 */
export async function updateVerificationStatus(
  userId: string,
  provider: string,
  status: VerificationStatus,
  metadata?: Record<string, unknown>
): Promise<void> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - credential_verifications has no INSERT/UPDATE RLS policy for the
   *   authenticated role — all writes are intentionally server-side only
   *   (connect route, health check, cron job).
   * - userId is validated by assertTrustedUserId() and derived from a verified
   *   JWT or from a DB-sourced batch (cron).
   * - Client-supplied values are never trusted: status is a typed enum,
   *   metadata is opaque provider data attached by server-side validation.
   */
  const db = createServiceClient();
  const { error } = await db
    .from('credential_verifications')
    .upsert(
      {
        user_id: userId,
        provider,
        verified_at: new Date().toISOString(),
        status,
        metadata: metadata ?? null,
      },
      { onConflict: 'user_id,provider' }
    );

  if (error) throw new Error(`Failed to update verification status: ${error.message}`);
}

/**
 * Reads the last recorded verification status for a single provider.
 * Returns status='unknown' when no record exists (credentials never verified).
 */
export async function getVerificationStatus(
  userId: string,
  provider: string
): Promise<CredentialVerification> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - This function is called from both authenticated API routes (health check)
   *   and the cron path where no user JWT is available.
   * - Consistent service-role usage prevents a split-path architecture where
   *   the same function behaves differently depending on call context.
   * - The SELECT RLS policy on credential_verifications provides defense-in-depth
   *   for direct client queries; server-side reads use service role consistently.
   * - userId is validated by assertTrustedUserId() above.
   */
  const db = createServiceClient();
  const { data } = await db
    .from('credential_verifications')
    .select('verified_at, status, metadata')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();

  return {
    provider,
    verifiedAt: data ? String(data.verified_at) : null,
    status: (data?.status as VerificationStatus | undefined) ?? 'unknown',
    metadata: (data?.metadata as Record<string, unknown> | undefined) ?? undefined,
  };
}

/**
 * Returns all distinct provider names that have at least one credential row
 * for this user.  Used by the health check and stale-verifier.
 */
export async function getAllConnectedProviders(userId: string): Promise<string[]> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - Called from both authenticated API routes (health check) AND the cron
   *   path (no user JWT available).
   * - In the cron path, userId values come from a prior DB batch query, not
   *   from any client-supplied input.
   * - Consistent service-role usage avoids split-path logic.
   * - Query is filtered by the verified userId — no cross-user data leakage
   *   is possible.
   */
  const db = createServiceClient();
  const { data, error } = await db
    .from('integration_credentials')
    .select('provider')
    .eq('user_id', userId);

  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r) => String(r.provider)))];
}

/**
 * Returns the plaintext (decrypted) credentials for a provider.
 * Used internally by the stale-verifier to re-validate stored credentials.
 * The return value MUST NOT be sent to clients or written to any log.
 */
export async function getDecryptedProviderCredentials(
  userId: string,
  provider: string
): Promise<Record<string, string>> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - This function is ONLY called from server-side maintenance code (the
   *   stale-verifier, which runs inside the cron route).  No user JWT exists
   *   in the cron execution context.
   * - userId values reach this function via the cron batch query (distinct
   *   user_id from integration_credentials), never from client input.
   * - Decrypted values are used exclusively for in-process provider API
   *   validation; they are never logged, serialized to JSON responses, or
   *   written back to the database.
   * - AES-256-GCM decryption happens entirely server-side.
   */
  const db = createServiceClient();
  const { data, error } = await db
    .from('integration_credentials')
    .select('credential_key, encrypted_value, is_secret')
    .eq('user_id', userId)
    .eq('provider', provider);

  if (error) throw new Error(error.message);

  const result: Record<string, string> = {};
  for (const row of data ?? []) {
    const key = String(row.credential_key);
    const raw = String(row.encrypted_value);
    result[key] = row.is_secret ? decryptValue(raw) : raw;
  }
  return result;
}

/**
 * Atomically saves credentials + records the verification outcome in a single
 * Postgres transaction via save_credentials_with_verification().
 *
 * This replaces the previous two-step (save then verify) pattern in the connect
 * route, where a failure in updateVerificationStatus could leave credentials
 * saved but without a verification record.
 */
export async function saveCredentialsWithVerification(
  userId: string,
  provider: string,
  credentials: Record<string, string>,
  status: VerificationStatus,
  metadata?: Record<string, unknown>
): Promise<void> {
  assertTrustedUserId(userId);

  const now = new Date().toISOString();
  const allRows = buildCredentialRows(userId, provider, credentials, now);
  if (allRows.length === 0) throw new Error('No credential values provided');

  // Strip user_id / provider — passed as dedicated RPC params
  const rows = allRows.map(({ credential_key, encrypted_value, is_secret, created_at, updated_at }) => ({
    credential_key,
    encrypted_value,
    is_secret,
    created_at,
    updated_at,
  }));

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - Both integration_credentials (INSERT/UPDATE) and credential_verifications
   *   (INSERT/UPDATE) have no RLS policy for the authenticated role — all writes
   *   must go through the service role.
   * - The rpc() call executes save_credentials_with_verification() inside a
   *   single PL/pgSQL BEGIN/COMMIT block: either both tables are written or
   *   neither is (atomic).
   * - userId is validated by assertTrustedUserId() above and originates from a
   *   verified JWT or cron batch — never from client-supplied input.
   */
  const db = createServiceClient();
  const { error } = await db.rpc('save_credentials_with_verification', {
    p_user_id: userId,
    p_provider: provider,
    p_rows: rows,
    p_status: status,
    p_metadata: metadata ?? null,
  });

  if (error) throw new Error(`Failed to save credentials: ${error.message}`);
}

/**
 * Verifies all providers for a user in one pass, used by service.ts for field-level
 * credential accuracy in the automationBrain payload.
 */
export async function verifyAllProvidersForUser(
  userId: string,
  providers: string[]
): Promise<ProviderCredentialSummary[]> {
  assertTrustedUserId(userId);

  const filtered = [...new Set(providers)].filter((p) => providerHasCredentials(p));
  if (filtered.length === 0) return [];

  return Promise.all(
    filtered.map(async (provider) => {
      const status = await verifyProviderConnection(userId, provider).catch(() => ({
        connected: false,
        missing: getRequiredCredentials(provider).map((f) => f.key),
      }));

      const requiredFields = getRequiredCredentials(provider);
      const optionalFields = getOptionalCredentials(provider);

      return {
        provider,
        displayName: getProviderDisplayName(provider),
        missing: status.connected
          ? []
          : requiredFields.filter((f) => status.missing.includes(f.key)),
        optional: optionalFields,
        ready: status.connected,
        confidence: 100,
      };
    })
  );
}
