import 'server-only';

import { correlateInboundReply } from './correlate';
import { getFollowupSequence, markInboundReplyEventProcessed, reserveInboundReplyEvent, transitionFollowupSequence } from './storage';
import type { InboundReplyEvent, ProcessInboundReplyResult, SequenceStatus } from './types';

/**
 * Workflow #2 Phase A -- stop-on-reply orchestration. This is the ONLY
 * place that decides what happens when an inbound reply arrives; a future
 * provider poller (e.g. gmail-poll.ts) does nothing more than normalize its
 * own wire format into InboundReplyEvent and call this function once per
 * message.
 *
 * A reply means REPLIED, never HOT/WARM/COLD or any other qualification
 * judgment -- this module has no opinion on what a correlated reply should
 * cause downstream; it only records the fact and appends a durable event
 * (sequence_replied, via transitionFollowupSequence) that later workflow
 * logic can branch from.
 *
 * Ordering is deliberate: correlate FIRST, then attempt the idempotent
 * reserve with the correlation result already baked into the row. If the
 * reserve loses a concurrent race (another delivery of the exact same
 * provider_message_id won first), this request's own correlation result is
 * discarded entirely and 'duplicate' is returned -- whichever request won
 * the insert is authoritative, exactly mirroring
 * lib/runtime/idempotency.ts's reserveIdempotencyKey() pattern.
 */

function isValidEvent(event: InboundReplyEvent): string | null {
  if (!event.provider || typeof event.provider !== 'string') return 'provider is required.';
  if (!event.providerMessageId || typeof event.providerMessageId !== 'string') return 'providerMessageId is required.';
  if (!event.receivedAt || isNaN(new Date(event.receivedAt).getTime())) return 'receivedAt must be a valid timestamp.';
  return null;
}

function logObservability(fields: Record<string, unknown>): void {
  // Structured, secret-free observability line -- never the message body,
  // never a raw sender address, never credential material. See the field
  // list in this module's own tests for exactly what is/isn't logged.
  console.log('[inbound-reply]', JSON.stringify(fields));
}

export async function processInboundReply(event: InboundReplyEvent, params: { userId: string }): Promise<ProcessInboundReplyResult> {
  const validationError = isValidEvent(event);
  if (validationError) {
    logObservability({ received: true, provider: event.provider ?? null, rejected: true, reason: validationError });
    return { outcome: 'rejected_invalid_payload', reason: validationError };
  }

  const correlation = await correlateInboundReply(event, params.userId);

  const reserve = await reserveInboundReplyEvent({
    userId: params.userId,
    provider: event.provider,
    providerMessageId: event.providerMessageId,
    providerThreadId: event.providerThreadId,
    inReplyTo: event.inReplyTo,
    references: event.references,
    senderDomain: event.senderDomain,
    senderHash: event.senderHash,
    receivedAt: event.receivedAt,
    correlationStatus: correlation.status,
    matchedConversationId: correlation.status === 'strong_match' ? correlation.conversationId : null,
    matchedSequenceId: correlation.status === 'strong_match' ? correlation.sequenceId : null,
  });

  if (reserve.isDuplicate) {
    logObservability({ received: true, provider: event.provider, duplicate: true });
    return { outcome: 'duplicate', inboundReplyEventId: reserve.inboundReplyEventId ?? '' };
  }

  const inboundReplyEventId = reserve.inboundReplyEventId;

  if (correlation.status === 'no_match') {
    logObservability({ received: true, provider: event.provider, correlated: false, duplicate: false });
    await markInboundReplyEventProcessed(inboundReplyEventId);
    return { outcome: 'no_match', inboundReplyEventId };
  }

  if (correlation.status === 'ambiguous') {
    // Ambiguous matches MUST NOT cancel anything automatically -- Phase A's
    // own explicit safety requirement. Persisted/observable, never acted on.
    logObservability({ received: true, provider: event.provider, correlated: false, ambiguous: true, candidateCount: correlation.candidateSequenceIds.length });
    await markInboundReplyEventProcessed(inboundReplyEventId);
    return { outcome: 'ambiguous', inboundReplyEventId, candidateSequenceIds: correlation.candidateSequenceIds };
  }

  // strong_match
  const sequence = await getFollowupSequence(correlation.sequenceId);
  if (!sequence) {
    // Correlated to a sequence that no longer exists (should not happen
    // under normal FK/CASCADE behavior, but never assume -- fail safe).
    logObservability({ received: true, provider: event.provider, correlated: true, correlationMethod: correlation.method, sequenceFound: false });
    await markInboundReplyEventProcessed(inboundReplyEventId);
    return { outcome: 'no_match', inboundReplyEventId };
  }

  const transition = await transitionFollowupSequence({
    sequenceId: correlation.sequenceId,
    userId: sequence.userId,
    targetStatus: 'replied',
    reason: `Inbound reply correlated via ${correlation.method}.`,
    inboundReplyEventId,
  });

  await markInboundReplyEventProcessed(inboundReplyEventId);

  if (!transition.ok) {
    logObservability({
      received: true,
      provider: event.provider,
      correlated: true,
      correlationMethod: correlation.method,
      sequenceTransitioned: false,
      alreadyTerminal: true,
      currentStatus: transition.currentStatus ?? null,
    });
    return { outcome: 'sequence_already_terminal', inboundReplyEventId, sequenceId: correlation.sequenceId, currentStatus: (transition.currentStatus ?? sequence.status) as SequenceStatus };
  }

  if (transition.alreadyInState) {
    logObservability({
      received: true,
      provider: event.provider,
      correlated: true,
      correlationMethod: correlation.method,
      sequenceTransitioned: false,
      alreadyTerminal: true,
      currentStatus: transition.newStatus,
    });
    return { outcome: 'sequence_already_terminal', inboundReplyEventId, sequenceId: correlation.sequenceId, currentStatus: transition.newStatus };
  }

  logObservability({
    received: true,
    provider: event.provider,
    correlated: true,
    correlationMethod: correlation.method,
    duplicate: false,
    ambiguous: false,
    sequenceTransitioned: true,
    pendingFollowupSuppressed: true,
    previousStatus: transition.previousStatus,
    newStatus: transition.newStatus,
  });

  return { outcome: 'sequence_transitioned', inboundReplyEventId, sequenceId: correlation.sequenceId, previousStatus: (transition.previousStatus ?? 'active') as SequenceStatus };
}
