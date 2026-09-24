import 'server-only';

import { findConversationByThreadId, findOutboundMessageByProviderMessageId, findSequencesForConversation, getFollowupSequence } from './storage';
import type { CorrelationMethod, CorrelationResult, InboundReplyEvent } from './types';

/**
 * Workflow #2 Phase A -- reply correlation. Strong-identifier only:
 * provider thread id, In-Reply-To, and References (RFC 5322) are each
 * independently resolved to a conversation, in priority order. Sender
 * email-address matching is DELIBERATELY NOT implemented as a fallback in
 * Phase A -- the spec explicitly requires it be "carefully constrained ...
 * if justified," and no such justification (a stored, trustworthy lead
 * email address to compare against) exists yet in this schema. A reply
 * that matches on no strong identifier is 'no_match', never guessed at via
 * sender address alone. Adding a constrained email fallback later is a
 * pure additive change to this one function.
 *
 * Multiple independent signals resolving to DIFFERENT conversations/
 * sequences is contradictory evidence and is reported as 'ambiguous', not
 * resolved by picking one -- an ambiguous match must never automatically
 * cancel anything (Phase A's own explicit safety requirement).
 */

const REFERENCES_ID_PATTERN = /<[^<>\s]+>/g;

function parseReferences(references: string | null): string[] {
  if (!references) return [];
  const matches = references.match(REFERENCES_ID_PATTERN);
  return matches ? matches.map((m) => m.trim()) : [];
}

type Candidate = { sequenceId: string; method: CorrelationMethod };

async function candidatesFromConversation(conversationId: string, method: CorrelationMethod): Promise<Candidate[]> {
  const sequences = await findSequencesForConversation(conversationId);
  return sequences.map((s) => ({ sequenceId: s.id, method }));
}

/** userId scopes every lookup this performs -- see storage.ts's findConversationByThreadId/findOutboundMessageByProviderMessageId for the tenant-isolation rationale. A reply is only ever correlated within the mailbox owner's own data. */
export async function correlateInboundReply(event: InboundReplyEvent, userId: string): Promise<CorrelationResult> {
  const candidates: Candidate[] = [];

  if (event.providerThreadId) {
    const conversation = await findConversationByThreadId({ userId, provider: event.provider, providerThreadId: event.providerThreadId });
    if (conversation) {
      candidates.push(...(await candidatesFromConversation(conversation.id, 'provider_thread_id')));
    }
  }

  if (event.inReplyTo) {
    const outbound = await findOutboundMessageByProviderMessageId({ userId, provider: event.provider, providerMessageId: event.inReplyTo });
    if (outbound) {
      candidates.push(...(await candidatesFromConversation(outbound.conversationId, 'in_reply_to')));
    }
  }

  for (const refId of parseReferences(event.references)) {
    const outbound = await findOutboundMessageByProviderMessageId({ userId, provider: event.provider, providerMessageId: refId });
    if (outbound) {
      candidates.push(...(await candidatesFromConversation(outbound.conversationId, 'references')));
    }
  }

  if (candidates.length === 0) {
    return { status: 'no_match' };
  }

  const distinctSequenceIds = Array.from(new Set(candidates.map((c) => c.sequenceId)));

  if (distinctSequenceIds.length > 1) {
    return { status: 'ambiguous', candidateSequenceIds: distinctSequenceIds };
  }

  const [sequenceId] = distinctSequenceIds;
  const winningCandidate = candidates.find((c) => c.sequenceId === sequenceId)!;

  // conversationId isn't carried on the candidate itself (only the
  // sequenceId, which is all identity resolution needs) -- a sequence
  // belongs to exactly one conversation via its own FK, so a single lookup
  // by id is authoritative regardless of which signal matched.
  const sequence = await getFollowupSequence(sequenceId);
  if (!sequence) throw new Error(`Correlated sequence ${sequenceId} disappeared between lookup and resolution.`);

  return {
    status: 'strong_match',
    method: winningCandidate.method,
    conversationId: sequence.conversationId,
    sequenceId,
  };
}
