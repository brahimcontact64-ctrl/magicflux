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
const WORKFLOW_A = 'wf-a';

function seedSequence(status: string, threadId = 'thread-x') {
  const conversationId = `conv-${threadId}`;
  tables.runtime_conversations.push({
    id: conversationId,
    user_id: USER_A,
    workflow_id: WORKFLOW_A,
    execution_id: 'exec-1',
    provider: 'gmail',
    provider_thread_id: threadId,
    entity_reference: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const sequenceId = `seq-${threadId}`;
  tables.runtime_followup_sequences.push({
    id: sequenceId,
    user_id: USER_A,
    workflow_id: WORKFLOW_A,
    execution_id: 'exec-1',
    conversation_id: conversationId,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    replied_at: null,
    cancelled_at: null,
    completed_at: null,
    last_transition_reason: null,
  });
  return { conversationId, sequenceId };
}

function baseEvent(overrides: Partial<InboundReplyEvent> = {}): InboundReplyEvent {
  return {
    provider: 'gmail',
    providerMessageId: 'msg-1',
    providerThreadId: 'thread-x',
    senderHash: 'hash',
    senderDomain: 'example.com',
    receivedAt: new Date().toISOString(),
    inReplyTo: null,
    references: null,
    ...overrides,
  };
}

describe('processInboundReply', () => {
  it('a valid, strongly-correlated reply transitions the sequence to replied', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    const { sequenceId } = seedSequence('active');

    const result = await processInboundReply(baseEvent(), { userId: USER_A });

    expect(result.outcome).toBe('sequence_transitioned');
    if (result.outcome === 'sequence_transitioned') {
      expect(result.sequenceId).toBe(sequenceId);
      expect(result.previousStatus).toBe('active');
    }
    expect(tables.runtime_followup_sequences.find((s) => s.id === sequenceId)?.status).toBe('replied');
  });

  it('duplicate inbound delivery of the SAME provider message id is an idempotent no-op -- never transitions twice', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('active');

    const first = await processInboundReply(baseEvent({ providerMessageId: 'dup-msg' }), { userId: USER_A });
    const second = await processInboundReply(baseEvent({ providerMessageId: 'dup-msg' }), { userId: USER_A });

    expect(first.outcome).toBe('sequence_transitioned');
    expect(second.outcome).toBe('duplicate');
    // Exactly one inbound_reply_events row for this provider_message_id.
    expect(tables.runtime_inbound_reply_events.filter((e) => e.provider_message_id === 'dup-msg').length).toBe(1);
  });

  it('an unknown reply (no correlation match) is observed but never cancels anything', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');

    const result = await processInboundReply(baseEvent({ providerThreadId: 'thread-unknown', providerMessageId: 'unknown-msg' }), { userId: USER_A });

    expect(result.outcome).toBe('no_match');
    expect(tables.runtime_inbound_reply_events.find((e) => e.provider_message_id === 'unknown-msg')?.correlation_status).toBe('no_match');
  });

  it('an ambiguous reply produces a safe no-op / review-required result -- never an automatic transition', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('active', 'thread-amb-a');
    const seqB = seedSequence('active', 'thread-amb-b');
    tables.runtime_outbound_messages.push({
      id: 'out-amb',
      user_id: USER_A,
      sequence_id: seqB.sequenceId,
      conversation_id: seqB.conversationId,
      provider: 'gmail',
      provider_message_id: '<amb@example.com>',
      provider_thread_id: null,
      in_reply_to_message_id: null,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const result = await processInboundReply(baseEvent({ providerThreadId: 'thread-amb-a', inReplyTo: '<amb@example.com>', providerMessageId: 'amb-msg' }), { userId: USER_A });

    expect(result.outcome).toBe('ambiguous');
    // Neither candidate sequence was touched.
    expect(tables.runtime_followup_sequences.every((s) => s.status === 'active')).toBe(true);
  });

  it('a reply to an already-completed sequence is a safe no-op, reported distinctly', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('completed');

    const result = await processInboundReply(baseEvent({ providerMessageId: 'msg-completed' }), { userId: USER_A });

    expect(result.outcome).toBe('sequence_already_terminal');
    if (result.outcome === 'sequence_already_terminal') expect(result.currentStatus).toBe('completed');
  });

  it('a reply to an already-cancelled sequence is a safe no-op, reported distinctly', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('cancelled');

    const result = await processInboundReply(baseEvent({ providerMessageId: 'msg-cancelled' }), { userId: USER_A });

    expect(result.outcome).toBe('sequence_already_terminal');
    if (result.outcome === 'sequence_already_terminal') expect(result.currentStatus).toBe('cancelled');
  });

  it('a SECOND, different reply message to an already-replied sequence is an idempotent no-op -- never a duplicate lifecycle transition', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('replied');

    const result = await processInboundReply(baseEvent({ providerMessageId: 'msg-another-reply' }), { userId: USER_A });

    expect(result.outcome).toBe('sequence_already_terminal');
    if (result.outcome === 'sequence_already_terminal') expect(result.currentStatus).toBe('replied');
  });

  it('rejects a malformed/invalid payload safely -- never reaches correlation or persistence', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');

    const result = await processInboundReply(baseEvent({ providerMessageId: '' }), { userId: USER_A });

    expect(result.outcome).toBe('rejected_invalid_payload');
    expect(tables.runtime_inbound_reply_events.length).toBe(0);
  });

  it('RESTART/RECOVERY: reprocessing the exact same message after a simulated crash is a safe idempotent no-op, not a second transition', async () => {
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence('active');

    // First "attempt" succeeds and transitions the sequence.
    const first = await processInboundReply(baseEvent({ providerMessageId: 'crash-msg' }), { userId: USER_A });
    expect(first.outcome).toBe('sequence_transitioned');

    // A crash-recovery re-delivery of the SAME message (e.g. a poller that
    // didn't get to advance its own cursor before crashing) must be a
    // no-op, not a second attempt to transition an already-replied sequence
    // reported as a fresh transition.
    const replay = await processInboundReply(baseEvent({ providerMessageId: 'crash-msg' }), { userId: USER_A });
    expect(replay.outcome).toBe('duplicate');
  });
});
