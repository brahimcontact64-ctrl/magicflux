/**
 * Workflow #2 Phase A -- provider-neutral domain types for inbound reply
 * detection and follow-up sequence cancellation. Generic MagicFlux runtime
 * infrastructure: nothing here names Gmail, Workflow #2, Sigma Plus, or
 * Hot/Warm/Cold. A provider-specific adapter (e.g. gmail-normalize.ts)
 * translates its own wire format into InboundReplyEvent before any of this
 * module's logic ever runs.
 */

/** A follow-up sequence's durable state. See the migration's own header
 * comment (transition_followup_sequence_atomic) for the full transition
 * table: only 'active' -> 'replied' | 'cancelled' | 'completed' is a real
 * transition; every other status is terminal. */
export type SequenceStatus = 'active' | 'completed' | 'cancelled' | 'replied';

export type FollowupSequence = {
  id: string;
  userId: string;
  workflowId: string;
  executionId: string | null;
  conversationId: string;
  status: SequenceStatus;
  createdAt: string;
  updatedAt: string;
  repliedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  lastTransitionReason: string | null;
};

export type Conversation = {
  id: string;
  userId: string;
  workflowId: string;
  executionId: string | null;
  provider: string;
  providerThreadId: string;
  entityReference: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutboundMessage = {
  id: string;
  userId: string;
  sequenceId: string;
  conversationId: string;
  provider: string;
  providerMessageId: string;
  providerThreadId: string | null;
  inReplyToMessageId: string | null;
  /** Caller-supplied stable identifier for "this exact logical follow-up attempt" (e.g. "<sequenceId>:step-1"), used to detect a retry of an already-succeeded send before ever contacting the provider again. Optional -- a caller that doesn't supply one loses only the fast pre-check, not correctness of the send lock itself. */
  attemptKey: string | null;
  /** True when the send path's own post-send re-check found the sequence had already transitioned away from 'active' DURING the provider call -- see send-lock.ts's own header note on why this race cannot be fully closed. */
  sentDuringRaceWindow: boolean;
  sentAt: string;
};

/**
 * A provider-neutral inbound reply event. Every field here is either a
 * stable provider-issued identifier (used for correlation) or a
 * deliberately minimized/low-sensitivity piece of metadata -- never a
 * message body, never a full recipient list, never a raw plaintext sender
 * address (see senderDomain/senderHash). rawProviderMetadata is bounded to
 * whatever a specific provider adapter judges safe to keep for debugging
 * (e.g. Gmail's own message id/label ids), never the message content.
 */
export type InboundReplyEvent = {
  provider: string;
  providerMessageId: string;
  providerThreadId: string | null;
  /** SHA-256 hash of the lowercased, trimmed sender address -- never the plaintext address itself. */
  senderHash: string | null;
  /** The sender's domain only (e.g. "example.com") -- low-sensitivity, useful for observability. */
  senderDomain: string | null;
  receivedAt: string;
  /** The RFC 5322 In-Reply-To header value, if present. */
  inReplyTo: string | null;
  /** The RFC 5322 References header value, if present (raw, whitespace-joined). */
  references: string | null;
  rawProviderMetadata?: Record<string, unknown>;
};

export type CorrelationMethod = 'provider_thread_id' | 'in_reply_to' | 'references' | 'none';

export type CorrelationResult =
  | { status: 'strong_match'; method: CorrelationMethod; conversationId: string; sequenceId: string }
  | { status: 'ambiguous'; candidateSequenceIds: string[] }
  | { status: 'no_match' };

export type ProcessInboundReplyResult =
  | { outcome: 'duplicate'; inboundReplyEventId: string }
  | { outcome: 'no_match'; inboundReplyEventId: string }
  | { outcome: 'ambiguous'; inboundReplyEventId: string; candidateSequenceIds: string[] }
  | { outcome: 'sequence_transitioned'; inboundReplyEventId: string; sequenceId: string; previousStatus: SequenceStatus }
  | { outcome: 'sequence_already_terminal'; inboundReplyEventId: string; sequenceId: string; currentStatus: SequenceStatus }
  | { outcome: 'rejected_invalid_payload'; reason: string };

/**
 * Workflow #2 Phase B -- the generic, provider-extensible outbound send
 * contract. A provider adapter (e.g. a thin Gmail wrapper around the
 * EXISTING lib/workflow-runtime/node-handlers/email.ts#sendViaGmailApi,
 * never a second implementation) conforms to this shape; the send
 * orchestration in send-followup.ts never imports a specific provider
 * directly, so a future Slack/SMS follow-up channel implements the same
 * interface without touching send-followup.ts at all.
 */
export type OutboundSendParams = { accessToken: string; to: string; subject: string; body: string };

export type OutboundSendResult =
  | { ok: true; providerMessageId: string; providerThreadId: string | null }
  | { ok: false; indeterminate: true; message: string }
  | { ok: false; indeterminate: false; message: string };

export type OutboundProviderClient = {
  provider: string;
  send(params: OutboundSendParams): Promise<OutboundSendResult>;
};

export type FollowupSendRequest = {
  sequenceId: string;
  userId: string;
  /** Stable identifier for "this exact logical follow-up attempt" (e.g. "<sequenceId>:step-1"). Strongly recommended -- see OutboundMessage.attemptKey's own doc comment. */
  attemptKey?: string;
  to: string;
  subject: string;
  body: string;
};

export type FollowupSendResult =
  | { outcome: 'duplicate_attempt'; existingOutboundMessageId: string }
  /** Covers both "not active" and "unknown sequence id" -- assertSequenceSendable() (Phase A) deliberately fails closed for an unknown id with the same shape as a genuinely inactive one; see its own doc comment. */
  | { outcome: 'suppressed'; reason: string; currentStatus: SequenceStatus }
  | { outcome: 'credential_unavailable'; reason: string }
  | { outcome: 'send_failed'; reason: string }
  | { outcome: 'send_indeterminate'; reason: string }
  | { outcome: 'sent'; outboundMessageId: string; providerMessageId: string; providerThreadId: string | null; sentDuringRaceWindow: boolean };
