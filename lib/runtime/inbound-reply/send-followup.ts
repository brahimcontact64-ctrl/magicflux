import 'server-only';

import { randomUUID } from 'node:crypto';
import { acquireFollowupSendLock, findOutboundMessageByAttemptKey, getFollowupSequenceForOwner, recordOutboundMessage, releaseFollowupSendLock, updateConversationProviderThreadId } from './storage';
import { assertSequenceSendable } from './send-guard';
import type { FollowupSendRequest, FollowupSendResult, OutboundProviderClient } from './types';

/**
 * Workflow #2 Phase B -- the generic, reusable follow-up-send orchestration.
 * Provider-neutral: never imports Gmail (or any provider) directly -- a
 * caller supplies an OutboundProviderClient (e.g. gmail-send-adapter.ts's
 * thin wrapper around the EXISTING sendViaGmailApi) and an access-token
 * resolver (e.g. getValidAccessToken from lib/credentials/oauth-refresh.ts,
 * the SAME function Phase A's poller already reuses).
 *
 * Protocol, in order:
 *   1. Fast attempt-key pre-check -- a retry of an already-succeeded
 *      logical attempt never even reaches the provider.
 *   2. assertSequenceSendable() -- Phase A's mandatory authoritative guard.
 *   3. acquireFollowupSendLock() -- closes the concurrent-send race the
 *      guard alone cannot (two sends for the same sequence can never both
 *      proceed). See the Phase B migration's own header for the full
 *      analysis of the ONE race window this cannot close: a reply
 *      committing DURING the provider network call. That window is
 *      minimized (bounded by one provider round trip, not a poll interval)
 *      and made observable (sentDuringRaceWindow), never hidden.
 *   4. Provider call, only after 1-3 all succeed.
 *   5. On success ONLY: persist outbound correlation via
 *      recordOutboundMessage() -- a provider failure NEVER produces a fake
 *      successful outbound record.
 *   6. Always release the send lock (success, failure, or an unexpected
 *      throw) in a finally block.
 */

function logObservability(fields: Record<string, unknown>): void {
  // Structured, secret-free observability -- never a message body, OAuth
  // token, refresh token, or credential payload.
  console.log('[followup-send]', JSON.stringify(fields));
}

export async function sendFollowupMessage(
  request: FollowupSendRequest,
  client: OutboundProviderClient,
  getAccessToken: (userId: string) => Promise<string>
): Promise<FollowupSendResult> {
  logObservability({ followupDue: true, sequenceId: request.sequenceId, provider: client.provider });

  if (request.attemptKey) {
    const existing = await findOutboundMessageByAttemptKey(request.attemptKey);
    if (existing) {
      logObservability({ sequenceId: request.sequenceId, duplicateAttemptSuppressed: true });
      return { outcome: 'duplicate_attempt', existingOutboundMessageId: existing.id };
    }
  }

  const guard = await assertSequenceSendable(request.sequenceId, request.userId);
  logObservability({ sequenceId: request.sequenceId, sendGuardResult: guard.sendable ? 'sendable' : 'suppressed' });
  if (!guard.sendable) {
    return { outcome: 'suppressed', reason: guard.reason, currentStatus: guard.currentStatus };
  }

  const lockToken = randomUUID();
  const lock = await acquireFollowupSendLock({ sequenceId: request.sequenceId, userId: request.userId, lockToken });
  if (!lock.ok) {
    logObservability({ sequenceId: request.sequenceId, suppressed: true, reason: 'send_lock_not_acquired' });
    return { outcome: 'suppressed', reason: lock.reason, currentStatus: lock.currentStatus };
  }

  try {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(request.userId);
    } catch (err) {
      logObservability({ sequenceId: request.sequenceId, providerAttempt: false, credentialUnavailable: true });
      return { outcome: 'credential_unavailable', reason: err instanceof Error ? err.message : 'Failed to obtain provider credentials.' };
    }

    logObservability({ sequenceId: request.sequenceId, providerAttempt: true, provider: client.provider });
    const sendResult = await client.send({ accessToken, to: request.to, subject: request.subject, body: request.body });

    if (!sendResult.ok && sendResult.indeterminate) {
      // Mirrors the existing, already-established convention in
      // lib/workflow-runtime/node-handlers/email.ts: an indeterminate
      // outcome (Gmail may have already sent it; we genuinely don't know)
      // is NEVER auto-retried. This is the honest limit of what Gmail's
      // send API allows -- see this module's own report section on send
      // idempotency for the explicit statement of what is and isn't
      // guaranteed.
      logObservability({ sequenceId: request.sequenceId, providerSuccess: false, indeterminate: true });
      return { outcome: 'send_indeterminate', reason: sendResult.message };
    }
    if (!sendResult.ok) {
      logObservability({ sequenceId: request.sequenceId, providerSuccess: false, indeterminate: false });
      return { outcome: 'send_failed', reason: sendResult.message };
    }

    // Post-send re-check, purely for observability of the one race window
    // this architecture cannot close (see this module's own header note).
    // The send has already irreversibly happened by this point regardless
    // of the result -- this never blocks persisting the outbound record.
    const postSendGuard = await assertSequenceSendable(request.sequenceId, request.userId);
    const sentDuringRaceWindow = !postSendGuard.sendable;

    const sequence = await getFollowupSequenceForOwner(request.sequenceId, request.userId);
    if (!sequence) {
      logObservability({ sequenceId: request.sequenceId, providerSuccess: true, outboundCorrelationPersisted: false, error: 'sequence_disappeared_after_send' });
      return { outcome: 'send_failed', reason: 'Sequence disappeared after a successful send -- outbound correlation could not be persisted.' };
    }

    const outbound = await recordOutboundMessage({
      userId: request.userId,
      sequenceId: request.sequenceId,
      conversationId: sequence.conversationId,
      provider: client.provider,
      providerMessageId: sendResult.providerMessageId,
      providerThreadId: sendResult.providerThreadId,
      internetMessageId: sendResult.internetMessageId,
      attemptKey: request.attemptKey ?? null,
      sentDuringRaceWindow,
    });

    // Reconcile the conversation's provider_thread_id with the real thread
    // the provider just confirmed -- see updateConversationProviderThreadId()'s
    // own doc comment for why this is required (an outbound-initiated
    // conversation starts with a placeholder, never otherwise corrected)
    // and why it's always safe to call, not just on the first send.
    if (sendResult.providerThreadId) {
      await updateConversationProviderThreadId(sequence.conversationId, sendResult.providerThreadId);
    }

    logObservability({ sequenceId: request.sequenceId, providerSuccess: true, outboundCorrelationPersisted: true, sentDuringRaceWindow });

    return { outcome: 'sent', outboundMessageId: outbound.id, providerMessageId: outbound.providerMessageId, providerThreadId: outbound.providerThreadId, sentDuringRaceWindow };
  } finally {
    await releaseFollowupSendLock({ sequenceId: request.sequenceId, userId: request.userId, lockToken });
  }
}
