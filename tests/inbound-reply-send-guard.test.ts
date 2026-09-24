import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';

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

function seedSequence(userId: string, workflowId: string, status: string, id = 'seq-guard-1') {
  const conversationId = `conv-${id}`;
  tables.runtime_conversations.push({ id: conversationId, user_id: userId, workflow_id: workflowId, execution_id: null, provider: 'gmail', provider_thread_id: `thread-${id}`, entity_reference: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  tables.runtime_followup_sequences.push({
    id,
    user_id: userId,
    workflow_id: workflowId,
    execution_id: null,
    conversation_id: conversationId,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    replied_at: null,
    cancelled_at: null,
    completed_at: null,
    last_transition_reason: null,
  });
  return id;
}

describe('assertSequenceSendable', () => {
  it('allows a send when the sequence is active', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');
    const id = seedSequence(USER_A, WORKFLOW_A, 'active');

    const result = await assertSequenceSendable(id, USER_A);

    expect(result.sendable).toBe(true);
  });

  it('suppresses a send when the sequence has been replied to', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');
    const id = seedSequence(USER_A, WORKFLOW_A, 'replied');

    const result = await assertSequenceSendable(id, USER_A);

    expect(result.sendable).toBe(false);
    if (!result.sendable) expect(result.currentStatus).toBe('replied');
  });

  it('suppresses a send when the sequence has been cancelled or completed', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');
    const cancelledId = seedSequence(USER_A, WORKFLOW_A, 'cancelled', 'seq-cancelled');
    const completedId = seedSequence(USER_A, WORKFLOW_A, 'completed', 'seq-completed');

    expect((await assertSequenceSendable(cancelledId, USER_A)).sendable).toBe(false);
    expect((await assertSequenceSendable(completedId, USER_A)).sendable).toBe(false);
  });

  it('fails closed for an unknown sequence id', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');

    const result = await assertSequenceSendable('does-not-exist', USER_A);

    expect(result.sendable).toBe(false);
  });

  it('TENANT ISOLATION: a sequence id belonging to a different user is never reported sendable', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');
    const id = seedSequence(USER_B, WORKFLOW_A, 'active');

    const result = await assertSequenceSendable(id, USER_A);

    expect(result.sendable).toBe(false);
  });

  it('CRITICAL RACE CONDITION: a reply that commits between "follow-up due" and "about to send" is caught by the guard, not missed', async () => {
    const { assertSequenceSendable } = await import('@/lib/runtime/inbound-reply/send-guard');
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    const id = seedSequence(USER_A, WORKFLOW_A, 'active', 'seq-race');
    // Give the seeded conversation a real thread id the reply can correlate against.
    const conversation = tables.runtime_conversations.find((c) => c.id === 'conv-seq-race')!;

    // Simulate the exact interleaving the spec requires protection against:
    // a retry-dispatcher-style resume decides the follow-up is due and is
    // ABOUT to call the (not-yet-built) send node -- but does the
    // mandatory guard check first, as every send path must.
    const beforeReply = await assertSequenceSendable(id, USER_A);
    expect(beforeReply.sendable).toBe(true);

    // The reply arrives and commits its transition BEFORE the actual
    // provider send call would have fired.
    const replyResult = await processInboundReply(
      {
        provider: 'gmail',
        providerMessageId: 'race-msg-1',
        providerThreadId: String(conversation.provider_thread_id),
        senderHash: 'hash',
        senderDomain: 'example.com',
        receivedAt: new Date().toISOString(),
        inReplyTo: null,
        references: null,
      },
      { userId: USER_A }
    );
    expect(replyResult.outcome).toBe('sequence_transitioned');

    // The guard, checked immediately before the send (as mandated), now
    // correctly suppresses it -- the send never happens.
    const afterReply = await assertSequenceSendable(id, USER_A);
    expect(afterReply.sendable).toBe(false);
    if (!afterReply.sendable) expect(afterReply.currentStatus).toBe('replied');
  });
});
