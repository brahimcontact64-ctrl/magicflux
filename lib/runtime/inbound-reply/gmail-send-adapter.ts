import 'server-only';

import { sendViaGmailApi } from '@/lib/workflow-runtime/node-handlers/email';
import { canonicalizeInternetMessageId } from './correlate';
import type { OutboundProviderClient, OutboundSendResult } from './types';

/**
 * Workflow #2 Phase B -- a thin adapter conforming the EXISTING, certified
 * Gmail send implementation (sendViaGmailApi, exported from
 * lib/workflow-runtime/node-handlers/email.ts -- Workflow #1's own email
 * node handler) to the generic OutboundProviderClient contract. This file
 * contains ZERO Gmail HTTP/MIME logic of its own -- it exists only to
 * translate one result shape into another, so send-followup.ts never needs
 * to know Gmail exists.
 *
 * Phase D.3 -- the one exception to "zero Gmail logic of its own": after a
 * successful send, fetches the message's real, Gmail-confirmed RFC 5322
 * Message-ID header. This is deliberately a SEPARATE follow-up API call
 * here, not a change to sendViaGmailApi() itself (still used unmodified by
 * Workflow #1's emailHandler), for two reasons documented by the D.3
 * investigation:
 *   1. sendViaGmailApi()'s outgoing MIME sets no Message-ID header at all,
 *      so Gmail assigns one itself; there is no way to know it in advance.
 *   2. Gmail's users.messages.send response (the Message resource: id,
 *      threadId, labelIds) never includes header content, regardless of
 *      format -- only users.messages.get can return headers. There is no
 *      way to avoid this second call while still persisting a VERIFIED
 *      (not assumed/self-generated) Message-ID -- see this phase's own
 *      report for why generating our own was rejected without being able
 *      to empirically verify Gmail preserves a caller-supplied one
 *      unchanged (D.3 explicitly forbids a real send to test that).
 * A failure of this enrichment fetch NEVER fails the send itself -- the
 * message is already irreversibly sent by this point; internetMessageId
 * simply stays null, exactly like any other legacy/pre-D.3 outbound row.
 *
 * Phase D.4 production-readiness finding -- this degradation was
 * previously silent (bare catch, no signal at all). A structured,
 * secret-free log line makes a SYSTEMIC failure (e.g. every send losing
 * its internet_message_id, which would silently disable the In-Reply-To/
 * References correlation fallbacks fleet-wide) diagnosable, while an
 * occasional individual failure remains exactly as harmless as before --
 * never the access token, never the message body, only the Gmail message
 * id (already non-secret, already persisted elsewhere) and a short reason.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function logDegradation(gmailMessageId: string, reason: string): void {
  console.warn('[gmail-send-adapter] internet_message_id unavailable', JSON.stringify({ gmailMessageId, reason }));
}

async function fetchInternetMessageId(accessToken: string, gmailMessageId: string): Promise<string | null> {
  try {
    const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(gmailMessageId)}`);
    url.searchParams.set('format', 'metadata');
    url.searchParams.set('metadataHeaders', 'Message-ID');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      logDegradation(gmailMessageId, `metadata fetch returned HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { payload?: { headers?: Array<{ name: string; value: string }> } };
    const header = body.payload?.headers?.find((h) => h.name?.toLowerCase() === 'message-id');
    const canonical = canonicalizeInternetMessageId(header?.value ?? null);
    if (!canonical) logDegradation(gmailMessageId, 'Message-ID header missing or malformed in metadata response');
    return canonical;
  } catch (err) {
    // Enrichment only -- never surfaced as a send failure.
    logDegradation(gmailMessageId, err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}

export const gmailOutboundProviderClient: OutboundProviderClient = {
  provider: 'gmail',
  async send(params): Promise<OutboundSendResult> {
    const result = await sendViaGmailApi(params.accessToken, { to: params.to, subject: params.subject, body: params.body });
    if (result.ok) {
      const internetMessageId = await fetchInternetMessageId(params.accessToken, result.id);
      return { ok: true, providerMessageId: result.id, providerThreadId: result.threadId, internetMessageId };
    }
    if (result.indeterminate) {
      return { ok: false, indeterminate: true, message: result.message };
    }
    return { ok: false, indeterminate: false, message: result.message };
  },
};
