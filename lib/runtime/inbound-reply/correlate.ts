import 'server-only';

import { findConversationByThreadId, findOutboundMessageByInternetMessageId, findSequencesForConversation, getFollowupSequence } from './storage';
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
 *
 * Workflow #2 Phase D.3 -- In-Reply-To/References carry RFC 5322
 * Message-IDs (e.g. "<abc@mail.gmail.com>"), a completely different
 * identifier namespace from a provider's own API-native message id (e.g.
 * Gmail's "1a0ddf2d0cf1885e"). Live certification proved these can never
 * match each other. Both fallbacks therefore resolve against
 * runtime_outbound_messages.internet_message_id (findOutboundMessageByInternetMessageId),
 * never providerMessageId. provider_thread_id correlation is unaffected --
 * it was already comparing like with like and is unchanged here.
 */

const REFERENCES_ID_PATTERN = /<[^<>\s]+>/g;
const MESSAGE_ID_SHAPE = /^<[^<>\s]+>$/;

/**
 * Canonicalizes an RFC 5322 Message-ID for exact comparison: trims
 * surrounding whitespace (the one harmless formatting difference this phase
 * is required to tolerate -- e.g. header-folding artifacts) and rejects
 * anything that doesn't have the minimal "<non-empty-no-whitespace>" shape.
 * Deliberately NOT fuzzy: no case-folding, no stripping of internal
 * characters, no partial/substring matching -- an empty or malformed value
 * canonicalizes to null and can never match anything, exactly like a legacy
 * NULL internet_message_id column.
 */
export function canonicalizeInternetMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return MESSAGE_ID_SHAPE.test(trimmed) ? trimmed : null;
}

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

  const canonicalInReplyTo = canonicalizeInternetMessageId(event.inReplyTo);
  if (canonicalInReplyTo) {
    const outbound = await findOutboundMessageByInternetMessageId({ userId, provider: event.provider, internetMessageId: canonicalInReplyTo });
    if (outbound) {
      candidates.push(...(await candidatesFromConversation(outbound.conversationId, 'in_reply_to')));
    }
  }

  for (const refId of parseReferences(event.references)) {
    const canonicalRefId = canonicalizeInternetMessageId(refId);
    if (!canonicalRefId) continue;
    const outbound = await findOutboundMessageByInternetMessageId({ userId, provider: event.provider, internetMessageId: canonicalRefId });
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
