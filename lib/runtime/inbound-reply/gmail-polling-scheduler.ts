import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { getOAuthProviderConfig } from '@/lib/credentials/oauth-providers';
import { pollGmailInboundReplies, type GmailApiClient, type PollGmailResult } from './gmail-poll';

/**
 * Workflow #2 Phase D.6 -- production Gmail-polling discovery + batch
 * orchestration. NOT wired into any cron schedule in this phase (see
 * app/api/cron/poll-gmail-replies/route.ts's own header) -- this module is
 * written, tested, and reusable, but inert until a future phase adds a
 * vercel.json entry after explicit authorization.
 *
 * Mirrors app/api/cron/reverify-credentials/route.ts's own established
 * pattern: fetch a bounded, deterministically-ordered candidate batch from
 * the database, then a per-candidate try/catch loop where one failure never
 * stops the rest. Deliberately does NOT introduce a new SQL function (unlike
 * reverify-credentials's get_stale_credential_users RPC) -- D.6 is
 * explicitly scoped to require zero production schema migration, and a
 * cross-table ORDER BY (the one thing that would need a custom function,
 * per that route's own comment on why PostgREST can't do it directly) isn't
 * needed here: ordering by integration_credentials.created_at ASC (a column
 * on the single table actually queried for ordering) is sufficient,
 * deterministic, and stable. True last-polled-at fairness (round-robining
 * mailboxes so one cold connection can never starve) would need a dedicated
 * column and is deliberately deferred to a future phase with its own
 * migration, once real usage volume justifies it -- not a correctness gap
 * at current/expected scale, where one bounded batch easily covers every
 * eligible mailbox well within a single cron cadence.
 */

const CANDIDATE_FETCH_CAP = 200; // generous upper bound before health-filtering -- never an unbounded full-table scan

function gmailCredentialKey(): string {
  const config = getOAuthProviderConfig('gmail');
  if (!config) throw new Error('Gmail OAuth provider is not registered.');
  return config.credentialKey;
}

/**
 * Discovers up to `limit` Gmail connections eligible for inbound-reply
 * polling: a real OAuth credential row (credential_key = the provider
 * registry's own 'oauth_google_gmail' constant -- never a bare
 * gmail_history_cursor-only row, which integration_credentials' own
 * (user_id, provider, credential_key) uniqueness means can exist as a
 * SEPARATE row for the same connection) with a 'healthy' verification
 * status. A revoked/invalid credential is never selected -- polling it
 * would just fail getValidAccessToken() every tick for no benefit, exactly
 * like reverify-credentials' own staleness filter avoids wasted work.
 *
 * Returns only opaque user ids -- never credential material, never an
 * email address.
 */
export async function discoverGmailPollingCandidates(limit: number): Promise<string[]> {
  const db = createServiceClient();
  const credentialKey = gmailCredentialKey();

  const { data: credRows, error: credError } = await db
    .from('integration_credentials')
    .select('user_id')
    .eq('provider', 'gmail')
    .eq('credential_key', credentialKey)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_FETCH_CAP);

  if (credError) throw new Error(`Failed to discover Gmail connections: ${credError.message}`);
  if (!credRows || credRows.length === 0) return [];

  const candidateIds = credRows.map((r) => String(r.user_id));

  const { data: verifications, error: verifyError } = await db
    .from('credential_verifications')
    .select('user_id, status')
    .eq('provider', 'gmail')
    .in('user_id', candidateIds);

  if (verifyError) throw new Error(`Failed to check Gmail credential health: ${verifyError.message}`);

  const healthyIds = new Set(
    (verifications ?? []).filter((v) => v.status === 'healthy').map((v) => String(v.user_id))
  );

  return candidateIds.filter((id) => healthyIds.has(id)).slice(0, limit);
}

export type GmailPollingBatchSummary = {
  discovered: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  repliesProcessed: number;
  /** Secret-free: "user <8-char-prefix>…: <short reason>" only -- see reverify-credentials/route.ts's own identical convention. Never a token, credential, or message body. */
  errors: string[];
};

function describePollOutcome(result: PollGmailResult): { skipped: boolean; repliesProcessed: number; note?: string } {
  switch (result.outcome) {
    case 'processed':
      return { skipped: false, repliesProcessed: result.messageResults.length };
    case 'bootstrapped':
      return { skipped: false, repliesProcessed: 0 };
    case 'resync_required':
      return { skipped: true, repliesProcessed: 0, note: 'resync_required' };
    case 'credential_unavailable':
      return { skipped: true, repliesProcessed: 0, note: 'credential_unavailable' };
  }
}

/**
 * Processes one bounded batch of eligible Gmail connections through the
 * EXISTING, certified pollGmailInboundReplies() pipeline -- no Gmail
 * history parsing, normalization, or correlation logic is duplicated here.
 * One mailbox's thrown error is isolated per-candidate and never stops the
 * remaining mailboxes in this batch (mirrors reverify-credentials' own
 * per-user try/catch loop exactly). `client` is test-only -- omitted in
 * production, pollGmailInboundReplies() defaults to the real Gmail client.
 */
export async function runGmailPollingBatch(limit: number, client?: GmailApiClient): Promise<GmailPollingBatchSummary> {
  const candidates = await discoverGmailPollingCandidates(limit);

  const summary: GmailPollingBatchSummary = {
    discovered: candidates.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    repliesProcessed: 0,
    errors: [],
  };

  for (const userId of candidates) {
    summary.attempted += 1;
    try {
      const result = await pollGmailInboundReplies(userId, client);
      const outcome = describePollOutcome(result);
      if (outcome.skipped) {
        summary.skipped += 1;
        if (outcome.note) summary.errors.push(`user ${userId.slice(0, 8)}…: ${outcome.note}`);
      } else {
        summary.succeeded += 1;
      }
      summary.repliesProcessed += outcome.repliesProcessed;
    } catch (err) {
      summary.failed += 1;
      const msg = err instanceof Error ? err.message : 'unknown error';
      summary.errors.push(`user ${userId.slice(0, 8)}…: ${msg}`);
    }
  }

  return summary;
}
