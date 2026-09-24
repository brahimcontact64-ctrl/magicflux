import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import type { Conversation, FollowupSequence, OutboundMessage, SequenceStatus } from './types';

/**
 * Workflow #2 Phase A -- persistence for runtime_conversations /
 * runtime_followup_sequences / runtime_outbound_messages /
 * runtime_inbound_reply_events (see the migration file's header for the
 * full schema rationale).
 *
 * NOT YET LIVE: the migration is drafted but not applied (standing
 * schema-approval gate, same precedent as lib/connectors/storage.ts for
 * platform_connections). Every function here will fail with a real
 * Postgres error if called before that migration is approved and run --
 * nothing in this phase wires these functions into reachable production
 * code paths.
 */

type ConversationRow = {
  id: string;
  user_id: string;
  workflow_id: string;
  execution_id: string | null;
  provider: string;
  provider_thread_id: string;
  entity_reference: string | null;
  created_at: string;
  updated_at: string;
};

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    provider: row.provider,
    providerThreadId: row.provider_thread_id,
    entityReference: row.entity_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type SequenceRow = {
  id: string;
  user_id: string;
  workflow_id: string;
  execution_id: string | null;
  conversation_id: string;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
  replied_at: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  last_transition_reason: string | null;
};

function toSequence(row: SequenceRow): FollowupSequence {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    conversationId: row.conversation_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repliedAt: row.replied_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    lastTransitionReason: row.last_transition_reason,
  };
}

type OutboundMessageRow = {
  id: string;
  user_id: string;
  sequence_id: string;
  conversation_id: string;
  provider: string;
  provider_message_id: string;
  provider_thread_id: string | null;
  in_reply_to_message_id: string | null;
  sent_at: string;
};

function toOutboundMessage(row: OutboundMessageRow): OutboundMessage {
  return {
    id: row.id,
    userId: row.user_id,
    sequenceId: row.sequence_id,
    conversationId: row.conversation_id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    providerThreadId: row.provider_thread_id,
    inReplyToMessageId: row.in_reply_to_message_id,
    sentAt: row.sent_at,
  };
}

/**
 * Finds the conversation a thread id belongs to, if any. Used by the
 * correlation algorithm's strongest signal (provider_thread_id).
 *
 * Scoped by userId -- Phase A's own tenant-isolation requirement. A
 * provider's thread/message ids are unique within ONE account, but
 * runtime_conversations' own UNIQUE constraint is (workflow_id, provider,
 * provider_thread_id), not a global unique -- two different users could in
 * principle have colliding id strings (however unlikely for a real
 * provider). Correlation must never cross a tenant boundary on the strength
 * of an unscoped string match alone.
 */
export async function findConversationByThreadId(params: { userId: string; provider: string; providerThreadId: string }): Promise<Conversation | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_conversations')
    .select('*')
    .eq('user_id', params.userId)
    .eq('provider', params.provider)
    .eq('provider_thread_id', params.providerThreadId)
    .maybeSingle();
  return data ? toConversation(data as ConversationRow) : null;
}

/** Finds the outbound message a provider message id refers to (used for In-Reply-To / References correlation). Scoped by userId -- see findConversationByThreadId's note on tenant isolation. */
export async function findOutboundMessageByProviderMessageId(params: { userId: string; provider: string; providerMessageId: string }): Promise<OutboundMessage | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_outbound_messages')
    .select('*')
    .eq('user_id', params.userId)
    .eq('provider', params.provider)
    .eq('provider_message_id', params.providerMessageId)
    .maybeSingle();
  return data ? toOutboundMessage(data as OutboundMessageRow) : null;
}

/** All currently-active sequences for a conversation. In Phase A's own usage this is normally 0 or 1 rows (one sequence per conversation), but the schema allows more than one over a conversation's lifetime -- callers must treat 2+ results as ambiguous, never guess which one a reply meant. */
export async function findActiveSequencesForConversation(conversationId: string): Promise<FollowupSequence[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_followup_sequences')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('status', 'active');
  return ((data ?? []) as SequenceRow[]).map(toSequence);
}

/** ALL sequences for a conversation regardless of status -- used by correlation, which must still resolve a reply to an already-terminal sequence (so the caller can report "already replied/cancelled/completed" rather than a misleading "no_match"). Only the CAS transition itself enforces the 'active'-only rule. */
export async function findSequencesForConversation(conversationId: string): Promise<FollowupSequence[]> {
  const db = createServiceClient();
  const { data } = await db.from('runtime_followup_sequences').select('*').eq('conversation_id', conversationId);
  return ((data ?? []) as SequenceRow[]).map(toSequence);
}

export async function getFollowupSequence(sequenceId: string): Promise<FollowupSequence | null> {
  const db = createServiceClient();
  const { data } = await db.from('runtime_followup_sequences').select('*').eq('id', sequenceId).maybeSingle();
  return data ? toSequence(data as SequenceRow) : null;
}

/**
 * Owner-scoped variant of getFollowupSequence(), mirroring
 * lib/connectors/storage.ts's getConnectionForOwner()-vs-getConnectionById()
 * distinction: the unscoped lookup above is only ever called internally
 * (correlate.ts, process-reply.ts) on a sequenceId already proven to belong
 * to the caller's own userId by an earlier tenant-scoped lookup in the same
 * call chain. Any EXTERNAL caller -- in particular the mandatory send-time
 * guard (send-guard.ts), which a future, not-yet-built follow-up-sending
 * node handler will call with a sequenceId it read from its own execution's
 * rows -- must use this owner-scoped variant instead, so a wrong/forged
 * sequenceId can never read another tenant's sequence state.
 */
export async function getFollowupSequenceForOwner(sequenceId: string, userId: string): Promise<FollowupSequence | null> {
  const db = createServiceClient();
  const { data } = await db.from('runtime_followup_sequences').select('*').eq('id', sequenceId).eq('user_id', userId).maybeSingle();
  return data ? toSequence(data as SequenceRow) : null;
}

/** Idempotent: returns the existing conversation for (workflowId, provider, providerThreadId) if one exists, otherwise creates it. Mirrors lib/connectors/storage.ts's ensureConnection() pattern. */
export async function ensureConversation(params: { userId: string; workflowId: string; executionId?: string | null; provider: string; providerThreadId: string; entityReference?: string | null }): Promise<Conversation> {
  const existing = await findConversationByThreadId({ userId: params.userId, provider: params.provider, providerThreadId: params.providerThreadId });
  if (existing) return existing;

  const db = createServiceClient();
  const { data, error } = await db
    .from('runtime_conversations')
    .insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      execution_id: params.executionId ?? null,
      provider: params.provider,
      provider_thread_id: params.providerThreadId,
      entity_reference: params.entityReference ?? null,
    })
    .select('*')
    .single();

  if (error || !data) throw new Error(`Failed to create conversation: ${error?.message}`);
  return toConversation(data as ConversationRow);
}

/** Creates a new active follow-up sequence for a conversation. A future send-node calls this once, at sequence start. */
export async function createFollowupSequence(params: { userId: string; workflowId: string; executionId?: string | null; conversationId: string }): Promise<FollowupSequence> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('runtime_followup_sequences')
    .insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      execution_id: params.executionId ?? null,
      conversation_id: params.conversationId,
      status: 'active',
    })
    .select('*')
    .single();

  if (error || !data) throw new Error(`Failed to create follow-up sequence: ${error?.message}`);
  return toSequence(data as SequenceRow);
}

/** Records an outbound message's correlation metadata. Called by a FUTURE follow-up-sending node handler (out of scope this phase) immediately after a real send succeeds. */
export async function recordOutboundMessage(params: { userId: string; sequenceId: string; conversationId: string; provider: string; providerMessageId: string; providerThreadId?: string | null; inReplyToMessageId?: string | null }): Promise<OutboundMessage> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('runtime_outbound_messages')
    .insert({
      user_id: params.userId,
      sequence_id: params.sequenceId,
      conversation_id: params.conversationId,
      provider: params.provider,
      provider_message_id: params.providerMessageId,
      provider_thread_id: params.providerThreadId ?? null,
      in_reply_to_message_id: params.inReplyToMessageId ?? null,
    })
    .select('*')
    .single();

  if (error || !data) throw new Error(`Failed to record outbound message: ${error?.message}`);
  return toOutboundMessage(data as OutboundMessageRow);
}

export type TransitionSequenceResult =
  | { ok: true; alreadyInState: boolean; previousStatus: SequenceStatus | null; newStatus: SequenceStatus; executionId: string | null; workflowId: string }
  | { ok: false; reason: string; currentStatus?: SequenceStatus | null };

type TransitionRpcRow = {
  ok: boolean;
  already_in_state: boolean;
  previous_status: string | null;
  new_status: string;
  current_status: string | null;
  execution_id: string | null;
  workflow_id: string | null;
  reason: string | null;
};

/**
 * Atomically transitions a sequence via transition_followup_sequence_atomic()
 * (the migration's CAS-UPDATE + audit-event-append function -- see its own
 * header comment for the full transition table). This is the ONLY way any
 * code in this codebase should change a sequence's status; never a plain
 * UPDATE from application code, which would not be atomic with the audit
 * trail.
 */
export async function transitionFollowupSequence(params: { sequenceId: string; userId: string; targetStatus: 'replied' | 'cancelled' | 'completed'; reason: string; inboundReplyEventId?: string | null }): Promise<TransitionSequenceResult> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('transition_followup_sequence_atomic', {
    p_sequence_id: params.sequenceId,
    p_user_id: params.userId,
    p_target_status: params.targetStatus,
    p_reason: params.reason,
    p_inbound_reply_event_id: params.inboundReplyEventId ?? null,
  });

  if (error) {
    return { ok: false, reason: 'Failed to transition the sequence due to a database error.' };
  }

  const row = (Array.isArray(data) ? data[0] : data) as TransitionRpcRow | undefined;
  if (!row) return { ok: false, reason: 'The database did not return a result for this transition.' };

  if (!row.ok) {
    return { ok: false, reason: row.reason ?? 'Unable to transition this sequence.', currentStatus: row.current_status as SequenceStatus | null };
  }

  return {
    ok: true,
    alreadyInState: row.already_in_state,
    previousStatus: row.previous_status as SequenceStatus | null,
    newStatus: row.new_status as SequenceStatus,
    executionId: row.execution_id,
    workflowId: String(row.workflow_id),
  };
}

export type ReserveInboundReplyResult =
  | { isDuplicate: false; inboundReplyEventId: string }
  | { isDuplicate: true; inboundReplyEventId: string | null };

/**
 * Idempotently reserves (provider, providerMessageId) by inserting a
 * runtime_inbound_reply_events row. Mirrors
 * lib/runtime/idempotency.ts's reserveIdempotencyKey() exactly: the
 * database's UNIQUE (provider, provider_message_id) constraint is the sole
 * arbiter of "first writer wins" -- a single atomic round trip, not a
 * check-then-insert race. A unique-violation (23505) means this exact
 * inbound message was already processed; the pre-existing event id is
 * looked up and returned instead of inserting a duplicate.
 */
export async function reserveInboundReplyEvent(params: {
  userId: string;
  provider: string;
  providerMessageId: string;
  providerThreadId: string | null;
  inReplyTo: string | null;
  references: string | null;
  senderDomain: string | null;
  senderHash: string | null;
  receivedAt: string;
  correlationStatus: 'strong_match' | 'ambiguous' | 'no_match';
  matchedConversationId?: string | null;
  matchedSequenceId?: string | null;
}): Promise<ReserveInboundReplyResult> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('runtime_inbound_reply_events')
    .insert({
      user_id: params.userId,
      provider: params.provider,
      provider_message_id: params.providerMessageId,
      provider_thread_id: params.providerThreadId,
      in_reply_to: params.inReplyTo,
      references_header: params.references,
      sender_domain: params.senderDomain,
      sender_hash: params.senderHash,
      received_at: params.receivedAt,
      correlation_status: params.correlationStatus,
      matched_conversation_id: params.matchedConversationId ?? null,
      matched_sequence_id: params.matchedSequenceId ?? null,
    })
    .select('id')
    .single();

  if (!error && data) {
    return { isDuplicate: false, inboundReplyEventId: String((data as { id: string }).id) };
  }

  if (error?.code !== '23505') {
    throw new Error(`Failed to reserve inbound reply event: ${error?.message}`);
  }

  const { data: existing } = await db
    .from('runtime_inbound_reply_events')
    .select('id')
    .eq('provider', params.provider)
    .eq('provider_message_id', params.providerMessageId)
    .maybeSingle();

  return { isDuplicate: true, inboundReplyEventId: existing ? String((existing as { id: string }).id) : null };
}

export async function markInboundReplyEventProcessed(inboundReplyEventId: string): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_inbound_reply_events').update({ processed_at: new Date().toISOString() }).eq('id', inboundReplyEventId);
}
