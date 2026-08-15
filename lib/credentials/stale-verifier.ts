/**
 * Background re-verification of credentials that have not been checked
 * against their provider's live API within STALE_THRESHOLD_DAYS.
 *
 * Call verifyStaleCredentials(userId) from:
 *   - /api/cron/reverify-credentials  (daily scheduled job)
 *   - The health-check endpoint when a caller explicitly requests refresh
 *
 * Security model:
 *   - userId must always come from a verified Supabase JWT or from the cron
 *     batch query (distinct user_id from integration_credentials).
 *   - Client-supplied userId values are NEVER accepted.
 *   - getDecryptedProviderCredentials decrypts AES-256-GCM ciphertext
 *     in-process; the plaintext is never written to any log or response.
 */

import { createServiceClient } from '@/lib/supabase-server';
import {
  assertTrustedUserId,
  getDecryptedProviderCredentials,
  updateVerificationStatus,
  type VerificationStatus,
} from './storage';
import { validateProviderConnection } from './provider-verifier';

export const STALE_THRESHOLD_DAYS = 7;

export type StaleVerificationResult = {
  provider: string;
  status: VerificationStatus;
  errors?: string[];
  verifiedAt: string;
  wasStale: boolean;
};

/**
 * Re-verifies every provider whose last successful check was more than
 * STALE_THRESHOLD_DAYS ago (or that has never been verified).
 *
 * Providers whose metadata.requiresOAuthFlow=true are skipped — there is
 * no API-key-based check to perform for them.
 *
 * Returns one result per provider that was actually re-checked.
 */
export async function verifyStaleCredentials(userId: string): Promise<StaleVerificationResult[]> {
  assertTrustedUserId(userId);

  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - This function runs inside the cron route where no user JWT is available.
   * - userId values are sourced from the cron batch query
   *   (distinct user_id from integration_credentials), not from any
   *   client-supplied input.
   * - RLS would completely block both the credential reads and verification
   *   writes in the cron execution context.
   * - assertTrustedUserId() above validates that userId is a well-formed UUID.
   */
  const db = createServiceClient();

  // Collect distinct providers for this user
  const { data: credRows, error: credError } = await db
    .from('integration_credentials')
    .select('provider')
    .eq('user_id', userId);

  if (credError) throw new Error(credError.message);

  const providers = [...new Set((credRows ?? []).map((r) => String(r.provider)))];
  if (providers.length === 0) return [];

  // Load existing verification timestamps in one query
  const { data: verRows } = await db
    .from('credential_verifications')
    .select('provider, verified_at, status, metadata')
    .eq('user_id', userId)
    .in('provider', providers);

  const verMap = new Map<string, { verifiedAt: Date; metadata?: Record<string, unknown> }>();
  for (const v of verRows ?? []) {
    const meta = (v.metadata as Record<string, unknown> | null | undefined) ?? undefined;
    verMap.set(String(v.provider), {
      verifiedAt: new Date(String(v.verified_at)),
      metadata: meta,
    });
  }

  const staleMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const results: StaleVerificationResult[] = [];

  for (const provider of providers) {
    const existing = verMap.get(provider);
    const isStale = !existing || now - existing.verifiedAt.getTime() > staleMs;

    // OAuth providers are flagged in metadata at connect time — skip them
    if (existing?.metadata?.requiresOAuthFlow === true) continue;

    if (!isStale) continue;

    const verifiedAt = new Date().toISOString();

    try {
      const credentials = await getDecryptedProviderCredentials(userId, provider);

      if (Object.keys(credentials).length === 0) {
        await updateVerificationStatus(userId, provider, 'unknown');
        results.push({ provider, status: 'unknown', verifiedAt, wasStale: true });
        continue;
      }

      const result = await validateProviderConnection(provider, credentials);

      // requiresOAuthFlow discovered at validation time — record and skip
      if (result.metadata?.requiresOAuthFlow === true) {
        await updateVerificationStatus(userId, provider, 'unknown', result.metadata);
        continue;
      }

      const status: VerificationStatus = result.connected ? 'healthy' : 'invalid';
      await updateVerificationStatus(userId, provider, status, result.metadata);

      results.push({
        provider,
        status,
        errors: result.errors.length > 0 ? result.errors : undefined,
        verifiedAt,
        wasStale: true,
      });
    } catch (verifyErr) {
      const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      console.error(`[stale-verifier] provider=${provider} user=${userId.slice(0, 8)}…: ${errMsg}`);
      try {
        await updateVerificationStatus(userId, provider, 'unknown');
      } catch (updateErr) {
        const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        console.error(`[stale-verifier] failed to record unknown status for provider=${provider}: ${updateMsg}`);
      }
      results.push({ provider, status: 'unknown', verifiedAt, wasStale: true });
    }
  }

  return results;
}
