import 'server-only';

import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';
import { getDecryptedProviderCredentials, saveProviderCredentials } from '@/lib/credentials/storage';
import { normalizeGmailMessage, type GmailMessageResource } from './gmail-normalize';
import { processInboundReply } from './process-reply';
import type { ProcessInboundReplyResult } from './types';

/**
 * Workflow #2 Phase A -- Gmail inbound-reply polling.
 *
 * ARCHITECTURE DECISION -- polling via users.history.list(), not
 * users.watch() + Cloud Pub/Sub push:
 *
 *   MagicFlux's existing production architecture is Vercel (stateless
 *   serverless functions + 6 cron-driven polling routes, all at 1-5 minute
 *   cadence: dispatch-schedules, dispatch-retries, self-heal,
 *   recover-review-resumes, recover-acknowledgment-resumes,
 *   reverify-credentials) plus a separate long-running worker (Railway).
 *   Polling is this architecture's established, idiomatic pattern for
 *   "check periodically for new work" -- adding a 7th poller is a
 *   zero-new-infrastructure change that reuses 100% of the existing
 *   credential/refresh code (getValidAccessToken, already handling Gmail's
 *   OAuth refresh lifecycle including Incident 9.9.17K/L's hardening).
 *
 *   Gmail push notifications (users.watch() + a Cloud Pub/Sub topic) would
 *   reduce latency, but require: a new GCP Pub/Sub topic and IAM grant per
 *   environment, a new public HTTPS endpoint that must independently verify
 *   Pub/Sub's own push authentication (a new security surface distinct from
 *   every existing inbound webhook route's signature-verification model),
 *   and a renewal job because watches expire after 7 days (itself another
 *   poller, just for housekeeping). None of that infrastructure exists
 *   today, and nothing in Phase A's scope requires sub-poll-interval
 *   latency. Polling is the smallest safe capability that fits the current
 *   architecture; watch/push is a reasonable LATER optimization once this
 *   foundation is live-certified (explicitly out of scope this phase).
 *
 * This module is NOT wired into any cron route or vercel.json entry in
 * this phase -- it is written and tested (against an injected fake Gmail
 * client, never a real one) but not deployed/scheduled. A future phase
 * wires pollGmailInboundReplies() into a new /api/cron/poll-gmail-replies
 * route after live Gmail certification.
 *
 * Cursor bootstrapping: on the FIRST poll for a user (no stored
 * gmail_history_cursor), this does NOT attempt to backfill or process any
 * existing mail -- it only records the current historyId as a baseline.
 * Treating "no cursor yet" as "process everything since the beginning of
 * this mailbox" would risk misinterpreting old, unrelated mail as replies
 * and is never worth the risk for a foundational phase.
 *
 * Failure behavior: a Gmail API failure (transient or auth) never advances
 * the stored cursor and never touches any sequence's state -- the next
 * poll simply retries the same range (existing retry/backoff pattern: try
 * again next cron tick, matching every other cron-driven poller in this
 * codebase). Cursor is only advanced after every message in a batch has
 * been processed; processInboundReply() is itself idempotent, so a crash
 * mid-batch before the cursor advances safely reprocesses (as no-op
 * duplicates) whatever already succeeded.
 */

export type GmailApiClient = {
  /** Returns the mailbox's current historyId without listing any history -- used only for first-poll bootstrapping. */
  getCurrentHistoryId(accessToken: string): Promise<string>;
  /** Lists messages added since startHistoryId. Gmail's own API returns 404 when startHistoryId is too old (history expired, ~30 days) -- callers must treat that as "resync required," never as "no new messages." */
  listHistory(params: { accessToken: string; startHistoryId: string }): Promise<{ historyId: string; addedMessageIds: string[] } | { expired: true }>;
  getMessage(params: { accessToken: string; messageId: string }): Promise<GmailMessageResource>;
};

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** The real Gmail API client. Never invoked by this milestone's automated tests -- exported so a future live-certification phase can use it, and so tests can assert its shape without calling it. */
export const realGmailApiClient: GmailApiClient = {
  async getCurrentHistoryId(accessToken: string): Promise<string> {
    const res = await fetch(`${GMAIL_API_BASE}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Gmail profile fetch failed: ${res.status}`);
    const body = (await res.json()) as { historyId?: string };
    if (!body.historyId) throw new Error('Gmail profile response missing historyId.');
    return body.historyId;
  },

  async listHistory({ accessToken, startHistoryId }): Promise<{ historyId: string; addedMessageIds: string[] } | { expired: true }> {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return { expired: true };
    if (!res.ok) throw new Error(`Gmail history.list failed: ${res.status}`);
    const body = (await res.json()) as { historyId?: string; history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }> };
    const addedMessageIds = (body.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id));
    return { historyId: body.historyId ?? startHistoryId, addedMessageIds };
  },

  async getMessage({ accessToken, messageId }): Promise<GmailMessageResource> {
    const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('format', 'metadata');
    url.searchParams.set('metadataHeaders', 'From');
    url.searchParams.append('metadataHeaders', 'In-Reply-To');
    url.searchParams.append('metadataHeaders', 'References');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Gmail messages.get failed: ${res.status}`);
    return (await res.json()) as GmailMessageResource;
  },
};

const HISTORY_CURSOR_KEY = 'gmail_history_cursor';

export type PollGmailResult =
  | { outcome: 'bootstrapped'; historyId: string }
  | { outcome: 'processed'; messageResults: ProcessInboundReplyResult[]; newHistoryId: string }
  | { outcome: 'resync_required' }
  | { outcome: 'credential_unavailable'; reason: string };

/**
 * Polls one user's Gmail account for new inbound messages since the last
 * stored history cursor, normalizes each into an InboundReplyEvent, and
 * feeds it to processInboundReply(). Never sends anything; read-only
 * against Gmail. `client` defaults to the real Gmail API client but is
 * always overridden by a fake in tests.
 */
export async function pollGmailInboundReplies(userId: string, client: GmailApiClient = realGmailApiClient): Promise<PollGmailResult> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(userId, 'gmail');
  } catch (err) {
    // Credential unavailable/revoked -- surface as an operational failure,
    // never touch any sequence state (nothing below has run yet).
    return { outcome: 'credential_unavailable', reason: err instanceof Error ? err.message : 'Failed to obtain a Gmail access token.' };
  }

  const stored = await getDecryptedProviderCredentials(userId, 'gmail');
  const cursor = stored[HISTORY_CURSOR_KEY];

  if (!cursor) {
    const historyId = await client.getCurrentHistoryId(accessToken);
    await saveProviderCredentials(userId, 'gmail', { [HISTORY_CURSOR_KEY]: historyId });
    return { outcome: 'bootstrapped', historyId };
  }

  const history = await client.listHistory({ accessToken, startHistoryId: cursor });
  if ('expired' in history) {
    // Gmail's history window (~30 days) elapsed since the last successful
    // poll -- never guess which messages might have been missed. A future
    // phase's resync path re-bootstraps the cursor; Phase A surfaces this
    // distinctly rather than silently resetting it here.
    return { outcome: 'resync_required' };
  }

  const messageResults: ProcessInboundReplyResult[] = [];
  for (const messageId of history.addedMessageIds) {
    const message = await client.getMessage({ accessToken, messageId });
    const event = normalizeGmailMessage(message);
    const result = await processInboundReply(event, { userId });
    messageResults.push(result);
  }

  // Cursor advances only after every message in this batch has been
  // processed -- see this module's own header note on crash safety.
  await saveProviderCredentials(userId, 'gmail', { [HISTORY_CURSOR_KEY]: history.historyId });

  return { outcome: 'processed', messageResults, newHistoryId: history.historyId };
}
