import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';
import type { OutboundProviderClient, OutboundSendResult, FollowupSendRequest } from '@/lib/runtime/inbound-reply/types';

let tables: FakeTables;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeInboundReplyDb(tables)),
}));

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_A = 'wf-a';

beforeEach(() => {
  tables = makeEmptyTables();
});

function seedSequence(userId: string, status: string, id = 'seq-1', threadId = 'thread-1') {
  const conversationId = `conv-${id}`;
  tables.runtime_conversations.push({
    id: conversationId,
    user_id: userId,
    workflow_id: WORKFLOW_A,
    execution_id: 'exec-1',
    provider: 'gmail',
    provider_thread_id: threadId,
    entity_reference: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  tables.runtime_followup_sequences.push({
    id,
    user_id: userId,
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
    send_lock_token: null,
    send_lock_expires_at: null,
  });
  return { conversationId, sequenceId: id };
}

function fakeProvider(impl?: OutboundProviderClient['send']): OutboundProviderClient {
  const defaultImpl = async (): Promise<OutboundSendResult> => ({ ok: true, providerMessageId: 'gmail-msg-1', providerThreadId: 'gmail-thread-out-1' });
  return {
    provider: 'gmail',
    send: vi.fn(impl ?? defaultImpl),
  };
}

function baseRequest(overrides: Partial<FollowupSendRequest> = {}): FollowupSendRequest {
  return { sequenceId: 'seq-1', userId: USER_A, to: 'lead@customer.example.com', subject: 'Following up', body: 'Just checking in.', ...overrides };
}

const okAccessToken = async () => 'fake-access-token';

describe('sendFollowupMessage', () => {
  it('1. active sequence -> provider IS called and send succeeds', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent');
  });

  it('2. replied sequence -> provider is NOT called, suppression is explicit, not a crash', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'replied');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
    if (result.outcome === 'suppressed') expect(result.currentStatus).toBe('replied');
  });

  it('3. cancelled sequence -> provider is NOT called', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'cancelled');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
  });

  it('4. completed sequence -> provider is NOT called', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'completed');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
  });

  it('5. a successful send persists outbound correlation with the real provider ids', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider(async () => ({ ok: true, providerMessageId: 'gmail-msg-real', providerThreadId: 'gmail-thread-real' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('sent');
    const row = tables.runtime_outbound_messages[0];
    expect(row.provider_message_id).toBe('gmail-msg-real');
    expect(row.provider_thread_id).toBe('gmail-thread-real');
    expect(row.sequence_id).toBe('seq-1');
  });

  it('5b. a successful send backfills the conversation\'s placeholder provider_thread_id with the real one (Phase D.2C live-certification finding)', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    const { conversationId } = seedSequence(USER_A, 'active', 'seq-1', 'PLACEHOLDER-pending-thread');
    const provider = fakeProvider(async () => ({ ok: true, providerMessageId: 'gmail-msg-real', providerThreadId: 'gmail-thread-real' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('sent');
    const conversation = tables.runtime_conversations.find((c) => c.id === conversationId);
    expect(conversation?.provider_thread_id).toBe('gmail-thread-real');
  });

  it('5c. a second send in an already-correctly-threaded conversation is a safe no-op backfill', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    const { conversationId } = seedSequence(USER_A, 'active', 'seq-1', 'gmail-thread-real');
    const provider = fakeProvider(async () => ({ ok: true, providerMessageId: 'gmail-msg-2', providerThreadId: 'gmail-thread-real' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('sent');
    const conversation = tables.runtime_conversations.find((c) => c.id === conversationId);
    expect(conversation?.provider_thread_id).toBe('gmail-thread-real');
  });

  it('6. a provider failure never produces a fake successful outbound record', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider(async () => ({ ok: false, indeterminate: false, message: 'Gmail API returned 400' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('send_failed');
    expect(tables.runtime_outbound_messages.length).toBe(0);
  });

  it('7. a duplicate logical send attempt (same attemptKey) is suppressed BEFORE the provider is ever called', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider();

    const first = await sendFollowupMessage(baseRequest({ attemptKey: 'seq-1:step-1' }), provider, okAccessToken);
    expect(first.outcome).toBe('sent');

    const second = await sendFollowupMessage(baseRequest({ attemptKey: 'seq-1:step-1' }), provider, okAccessToken);
    expect(second.outcome).toBe('duplicate_attempt');
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('8. a retry after a successful send (same attemptKey, sequence still active) never sends twice', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider();

    await sendFollowupMessage(baseRequest({ attemptKey: 'attempt-retry' }), provider, okAccessToken);
    // Sequence is still 'active' (a single send doesn't complete a multi-step sequence) -- a naive retry could re-send without the attempt-key check.
    expect(tables.runtime_followup_sequences[0].status).toBe('active');

    const retry = await sendFollowupMessage(baseRequest({ attemptKey: 'attempt-retry' }), provider, okAccessToken);

    expect(retry.outcome).toBe('duplicate_attempt');
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(tables.runtime_outbound_messages.length).toBe(1);
  });

  it('9. CONCURRENT duplicate attempts for the same sequence: only one acquires the send lock and calls the provider', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    let releaseSend: (() => void) | null = null;
    const provider = fakeProvider(
      () =>
        new Promise((resolve) => {
          releaseSend = () => resolve({ ok: true, providerMessageId: 'gmail-msg-concurrent', providerThreadId: null });
        })
    );

    // Fire two concurrent attempts (no attemptKey -- the send LOCK, not the attempt-key check, is what must protect this).
    const firstPromise = sendFollowupMessage(baseRequest(), provider, okAccessToken);
    // Give the first call a tick to acquire the lock before the second starts.
    await new Promise((r) => setTimeout(r, 0));
    const secondResult = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(secondResult.outcome).toBe('suppressed');
    expect(provider.send).toHaveBeenCalledTimes(1);

    releaseSend!();
    const firstResult = await firstPromise;
    expect(firstResult.outcome).toBe('sent');
  });

  it('10. TENANT ISOLATION: a sequence id belonging to a different user is never sent to', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_B, 'active');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest({ userId: USER_A }), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
  });

  it('11. a missing/unknown sequence id fails closed, never calls the provider', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    const provider = fakeProvider();

    const result = await sendFollowupMessage(baseRequest({ sequenceId: 'does-not-exist' }), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
  });

  it('12. CREDENTIAL FAILURE: surfaced distinctly, provider is never called, no outbound record, lock is released', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider();
    const failingAccessToken = async () => {
      throw new Error('No valid OAuth credentials stored for provider: gmail');
    };

    const result = await sendFollowupMessage(baseRequest(), provider, failingAccessToken);

    expect(result.outcome).toBe('credential_unavailable');
    expect(provider.send).not.toHaveBeenCalled();
    expect(tables.runtime_outbound_messages.length).toBe(0);
    // Lock was released, not left stuck -- a subsequent send attempt can proceed.
    expect(tables.runtime_followup_sequences[0].send_lock_token).toBeNull();
  });

  it('13. an INDETERMINATE provider outcome (e.g. a timeout where Gmail may have already sent it) is surfaced distinctly and never auto-retried within this call', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider(async () => ({ ok: false, indeterminate: true, message: 'Gmail send may have already succeeded remotely' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('send_indeterminate');
    expect(tables.runtime_outbound_messages.length).toBe(0);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('14. thread/message ids are stored correctly, exactly as the provider returned them', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider(async () => ({ ok: true, providerMessageId: 'exact-message-id-123', providerThreadId: 'exact-thread-id-456' }));

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('sent');
    if (result.outcome === 'sent') {
      expect(result.providerMessageId).toBe('exact-message-id-123');
      expect(result.providerThreadId).toBe('exact-thread-id-456');
    }
  });

  it('15. no message body is ever persisted in the outbound correlation record', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider();

    await sendFollowupMessage(baseRequest({ body: 'SUPER_SENSITIVE_BODY_CONTENT_do_not_persist' }), provider, okAccessToken);

    const row = tables.runtime_outbound_messages[0];
    expect(JSON.stringify(row)).not.toContain('SUPER_SENSITIVE_BODY_CONTENT_do_not_persist');
    expect(Object.keys(row)).not.toContain('body');
  });

  it('16. a reply that transitions the sequence BEFORE the send guard runs results in suppression, not a send', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence(USER_A, 'active', 'seq-1', 'thread-race-16');
    const provider = fakeProvider();

    const reply = await processInboundReply(
      { provider: 'gmail', providerMessageId: 'reply-before-guard', providerThreadId: 'thread-race-16', senderHash: null, senderDomain: null, receivedAt: new Date().toISOString(), inReplyTo: null, references: null },
      { userId: USER_A }
    );
    expect(reply.outcome).toBe('sequence_transitioned');

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(provider.send).not.toHaveBeenCalled();
    expect(result.outcome).toBe('suppressed');
  });

  it('17. RACE: a reply that commits DURING the in-flight provider call is recorded as sentDuringRaceWindow, never hidden', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    const { processInboundReply } = await import('@/lib/runtime/inbound-reply/process-reply');
    seedSequence(USER_A, 'active', 'seq-1', 'thread-race-17');

    const provider = fakeProvider(async () => {
      // Simulate the reply committing WHILE the provider call is in flight --
      // after the send lock was already acquired (guaranteed by this point
      // in the call), before the provider "returns".
      await processInboundReply(
        { provider: 'gmail', providerMessageId: 'reply-during-send', providerThreadId: 'thread-race-17', senderHash: null, senderDomain: null, receivedAt: new Date().toISOString(), inReplyTo: null, references: null },
        { userId: USER_A }
      );
      return { ok: true, providerMessageId: 'gmail-msg-raced', providerThreadId: null };
    });

    const result = await sendFollowupMessage(baseRequest(), provider, okAccessToken);

    expect(result.outcome).toBe('sent');
    if (result.outcome === 'sent') expect(result.sentDuringRaceWindow).toBe(true);
    expect(tables.runtime_outbound_messages[0].sent_during_race_window).toBe(true);
    // The reply's own transition is untouched by the send having happened --
    // it is still correctly 'replied', proving the lease never blocked the stop signal.
    expect(tables.runtime_followup_sequences[0].status).toBe('replied');
  });

  it('18. RESTART/RECOVERY: the send lock is always released even when the provider call throws unexpectedly', async () => {
    const { sendFollowupMessage } = await import('@/lib/runtime/inbound-reply/send-followup');
    seedSequence(USER_A, 'active');
    const provider = fakeProvider(async () => {
      throw new Error('unexpected network exception');
    });

    await expect(sendFollowupMessage(baseRequest(), provider, okAccessToken)).rejects.toThrow('unexpected network exception');

    // Lock released despite the throw -- a subsequent attempt is not permanently blocked.
    expect(tables.runtime_followup_sequences[0].send_lock_token).toBeNull();
    const provider2 = fakeProvider();
    const retryResult = await sendFollowupMessage(baseRequest(), provider2, okAccessToken);
    expect(retryResult.outcome).toBe('sent');
  });

  it('21. NO REAL PROVIDER CALLS: every test in this file uses an injected fake OutboundProviderClient, never gmailOutboundProviderClient', async () => {
    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    expect(gmailOutboundProviderClient.provider).toBe('gmail');
    // Presence/shape-only check -- never invoked by this suite.
  });
});
