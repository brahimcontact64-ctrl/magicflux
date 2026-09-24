import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';
import type { InboundReplyEvent } from '@/lib/runtime/inbound-reply/types';

let tables: FakeTables;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeInboundReplyDb(tables)),
}));

beforeEach(() => {
  tables = makeEmptyTables();
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_A = 'wf-a';
const WORKFLOW_B = 'wf-b';

function seedConversationWithSequence(params: { userId: string; workflowId: string; threadId: string; status?: string }) {
  const conversationId = `conv-${params.threadId}-${params.userId}`;
  tables.runtime_conversations.push({
    id: conversationId,
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: null,
    provider: 'gmail',
    provider_thread_id: params.threadId,
    entity_reference: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const sequenceId = `seq-${params.threadId}-${params.userId}`;
  tables.runtime_followup_sequences.push({
    id: sequenceId,
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: null,
    conversation_id: conversationId,
    status: params.status ?? 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    replied_at: null,
    cancelled_at: null,
    completed_at: null,
    last_transition_reason: null,
  });
  return { conversationId, sequenceId };
}

function seedOutboundMessage(params: { userId: string; sequenceId: string; conversationId: string; providerMessageId: string; providerThreadId?: string }) {
  tables.runtime_outbound_messages.push({
    id: `out-${params.providerMessageId}`,
    user_id: params.userId,
    sequence_id: params.sequenceId,
    conversation_id: params.conversationId,
    provider: 'gmail',
    provider_message_id: params.providerMessageId,
    provider_thread_id: params.providerThreadId ?? null,
    in_reply_to_message_id: null,
    sent_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
}

function baseEvent(overrides: Partial<InboundReplyEvent>): InboundReplyEvent {
  return {
    provider: 'gmail',
    providerMessageId: 'msg-inbound-1',
    providerThreadId: null,
    senderHash: 'hash',
    senderDomain: 'example.com',
    receivedAt: new Date().toISOString(),
    inReplyTo: null,
    references: null,
    ...overrides,
  };
}

describe('correlateInboundReply', () => {
  it('strongly correlates via provider_thread_id', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const { sequenceId } = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-1' });

    const result = await correlateInboundReply(baseEvent({ providerThreadId: 'thread-1' }), USER_A);

    expect(result.status).toBe('strong_match');
    if (result.status === 'strong_match') {
      expect(result.sequenceId).toBe(sequenceId);
      expect(result.method).toBe('provider_thread_id');
    }
  });

  it('strongly correlates via In-Reply-To when no thread id is present', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const { sequenceId, conversationId } = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-2' });
    seedOutboundMessage({ userId: USER_A, sequenceId, conversationId, providerMessageId: '<out-msg-2@example.com>' });

    const result = await correlateInboundReply(baseEvent({ inReplyTo: '<out-msg-2@example.com>' }), USER_A);

    expect(result.status).toBe('strong_match');
    if (result.status === 'strong_match') {
      expect(result.sequenceId).toBe(sequenceId);
      expect(result.method).toBe('in_reply_to');
    }
  });

  it('strongly correlates via a References header entry', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const { sequenceId, conversationId } = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-3' });
    seedOutboundMessage({ userId: USER_A, sequenceId, conversationId, providerMessageId: '<out-msg-3@example.com>' });

    const result = await correlateInboundReply(
      baseEvent({ references: '<something-else@example.com> <out-msg-3@example.com>' }),
      USER_A
    );

    expect(result.status).toBe('strong_match');
    if (result.status === 'strong_match') {
      expect(result.sequenceId).toBe(sequenceId);
      expect(result.method).toBe('references');
    }
  });

  it('reports no_match when no strong identifier resolves to anything -- never guesses via sender address alone', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-unrelated' });

    const result = await correlateInboundReply(baseEvent({ providerThreadId: 'thread-does-not-exist' }), USER_A);

    expect(result.status).toBe('no_match');
  });

  it('reports ambiguous when independent signals resolve to DIFFERENT sequences -- never picks one', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const seqOne = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-4a' });
    const seqTwo = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-4b' });
    seedOutboundMessage({ userId: USER_A, sequenceId: seqTwo.sequenceId, conversationId: seqTwo.conversationId, providerMessageId: '<contradictory@example.com>' });

    const result = await correlateInboundReply(
      baseEvent({ providerThreadId: 'thread-4a', inReplyTo: '<contradictory@example.com>' }),
      USER_A
    );

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidateSequenceIds.sort()).toEqual([seqOne.sequenceId, seqTwo.sequenceId].sort());
    }
  });

  it('still resolves a strong match even when the matched sequence is already terminal -- correlation and transition-eligibility are separate concerns', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const { sequenceId } = seedConversationWithSequence({ userId: USER_A, workflowId: WORKFLOW_A, threadId: 'thread-5', status: 'cancelled' });

    const result = await correlateInboundReply(baseEvent({ providerThreadId: 'thread-5' }), USER_A);

    expect(result.status).toBe('strong_match');
    if (result.status === 'strong_match') expect(result.sequenceId).toBe(sequenceId);
  });

  it('TENANT ISOLATION: an identical thread-id string belonging to a different user never cross-matches', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    // Same literal thread id string, but owned by USER_B, not USER_A.
    seedConversationWithSequence({ userId: USER_B, workflowId: WORKFLOW_B, threadId: 'shared-thread-id' });

    const result = await correlateInboundReply(baseEvent({ providerThreadId: 'shared-thread-id' }), USER_A);

    expect(result.status).toBe('no_match');
  });

  it('TENANT ISOLATION: an identical outbound provider-message-id string belonging to a different user never cross-matches via In-Reply-To', async () => {
    const { correlateInboundReply } = await import('@/lib/runtime/inbound-reply/correlate');
    const seq = seedConversationWithSequence({ userId: USER_B, workflowId: WORKFLOW_B, threadId: 'thread-b' });
    seedOutboundMessage({ userId: USER_B, sequenceId: seq.sequenceId, conversationId: seq.conversationId, providerMessageId: '<shared-message-id@example.com>' });

    const result = await correlateInboundReply(baseEvent({ inReplyTo: '<shared-message-id@example.com>' }), USER_A);

    expect(result.status).toBe('no_match');
  });
});
