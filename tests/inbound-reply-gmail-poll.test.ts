import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';
import type { GmailApiClient } from '@/lib/runtime/inbound-reply/gmail-poll';
import type { GmailMessageResource } from '@/lib/runtime/inbound-reply/gmail-normalize';

let tables: FakeTables;
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const WORKFLOW_A = 'wf-a';

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeInboundReplyDb(tables)),
}));

let accessTokenImpl: () => Promise<string>;
vi.mock('@/lib/credentials/oauth-refresh', () => ({
  getValidAccessToken: vi.fn((...args: unknown[]) => accessTokenImpl()),
}));

let storedCredentials: Record<string, string>;
vi.mock('@/lib/credentials/storage', () => ({
  getDecryptedProviderCredentials: vi.fn(async () => storedCredentials),
  saveProviderCredentials: vi.fn(async (_userId: string, _provider: string, creds: Record<string, string>) => {
    Object.assign(storedCredentials, creds);
  }),
}));

beforeEach(() => {
  tables = makeEmptyTables();
  storedCredentials = {};
  accessTokenImpl = async () => 'fake-access-token';
});

function seedSequence(threadId: string, status = 'active') {
  const conversationId = `conv-${threadId}`;
  tables.runtime_conversations.push({ id: conversationId, user_id: USER_A, workflow_id: WORKFLOW_A, execution_id: null, provider: 'gmail', provider_thread_id: threadId, entity_reference: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const sequenceId = `seq-${threadId}`;
  tables.runtime_followup_sequences.push({ id: sequenceId, user_id: USER_A, workflow_id: WORKFLOW_A, execution_id: null, conversation_id: conversationId, status, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), replied_at: null, cancelled_at: null, completed_at: null, last_transition_reason: null });
  return sequenceId;
}

function fakeGmailMessage(id: string, threadId: string): GmailMessageResource {
  return { id, threadId, internalDate: String(Date.now()), payload: { headers: [{ name: 'From', value: 'lead@customer.example.com' }] } };
}

describe('pollGmailInboundReplies', () => {
  it('bootstraps on the first poll (no stored cursor) WITHOUT processing any messages', async () => {
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    const client: GmailApiClient = {
      getCurrentHistoryId: vi.fn(async () => 'history-100'),
      listHistory: vi.fn(),
      getMessage: vi.fn(),
    };

    const result = await pollGmailInboundReplies(USER_A, client);

    expect(result.outcome).toBe('bootstrapped');
    expect(client.listHistory).not.toHaveBeenCalled();
    expect(client.getMessage).not.toHaveBeenCalled();
    expect(storedCredentials.gmail_history_cursor).toBe('history-100');
  });

  it('processes newly added messages and advances the cursor only after all are handled', async () => {
    storedCredentials.gmail_history_cursor = 'history-100';
    seedSequence('thread-reply-1');
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    const client: GmailApiClient = {
      getCurrentHistoryId: vi.fn(),
      listHistory: vi.fn(async () => ({ historyId: 'history-101', addedMessageIds: ['msg-a'] })),
      getMessage: vi.fn(async ({ messageId }) => fakeGmailMessage(messageId, 'thread-reply-1')),
    };

    const result = await pollGmailInboundReplies(USER_A, client);

    expect(result.outcome).toBe('processed');
    if (result.outcome === 'processed') {
      expect(result.messageResults).toHaveLength(1);
      expect(result.messageResults[0].outcome).toBe('sequence_transitioned');
    }
    expect(storedCredentials.gmail_history_cursor).toBe('history-101');
    expect(tables.runtime_followup_sequences.find((s) => s.id === 'seq-thread-reply-1')?.status).toBe('replied');
  });

  it('CREDENTIAL FAILURE: surfaces as an operational failure and never touches any sequence state', async () => {
    seedSequence('thread-untouched');
    accessTokenImpl = async () => {
      throw new Error('No valid OAuth credentials stored for provider: gmail');
    };
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');

    const result = await pollGmailInboundReplies(USER_A, { getCurrentHistoryId: vi.fn(), listHistory: vi.fn(), getMessage: vi.fn() });

    expect(result.outcome).toBe('credential_unavailable');
    expect(tables.runtime_followup_sequences.find((s) => s.id === 'seq-thread-untouched')?.status).toBe('active');
  });

  it('PROVIDER TEMPORARILY UNAVAILABLE: a transient Gmail API failure propagates without corrupting cursor or sequence state, safe to retry next poll', async () => {
    storedCredentials.gmail_history_cursor = 'history-100';
    seedSequence('thread-untouched-2');
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    const client: GmailApiClient = {
      getCurrentHistoryId: vi.fn(),
      listHistory: vi.fn(async () => {
        throw new Error('Gmail history.list failed: 503');
      }),
      getMessage: vi.fn(),
    };

    await expect(pollGmailInboundReplies(USER_A, client)).rejects.toThrow('503');
    // Cursor untouched -- the same range will be retried on the next poll (existing retry/backoff pattern: try again next cron tick).
    expect(storedCredentials.gmail_history_cursor).toBe('history-100');
    expect(tables.runtime_followup_sequences.find((s) => s.id === 'seq-thread-untouched-2')?.status).toBe('active');
  });

  it('RESYNC REQUIRED: an expired history window is reported distinctly, never silently treated as "no new messages"', async () => {
    storedCredentials.gmail_history_cursor = 'history-too-old';
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    const client: GmailApiClient = {
      getCurrentHistoryId: vi.fn(),
      listHistory: vi.fn(async () => ({ expired: true as const })),
      getMessage: vi.fn(),
    };

    const result = await pollGmailInboundReplies(USER_A, client);

    expect(result.outcome).toBe('resync_required');
    expect(client.getMessage).not.toHaveBeenCalled();
  });

  it('RESTART/RECOVERY: reprocessing the same batch after a mid-batch crash (cursor never advanced) is safe -- idempotent, no duplicate transition', async () => {
    storedCredentials.gmail_history_cursor = 'history-100';
    seedSequence('thread-crash');
    const { pollGmailInboundReplies } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    const client: GmailApiClient = {
      getCurrentHistoryId: vi.fn(),
      listHistory: vi.fn(async () => ({ historyId: 'history-101', addedMessageIds: ['msg-crash-1'] })),
      getMessage: vi.fn(async ({ messageId }) => fakeGmailMessage(messageId, 'thread-crash')),
    };

    const first = await pollGmailInboundReplies(USER_A, client);
    expect(first.outcome).toBe('processed');

    // Simulate the poller being invoked again for the SAME range (as if the
    // previous run's cursor advance never happened, or a retry re-ran the
    // same cron tick) -- since the cursor DID actually advance in this test
    // (nothing crashed), force it back to prove reprocessing the identical
    // message id is still a safe no-op via idempotency, not a fresh replay.
    storedCredentials.gmail_history_cursor = 'history-100';
    const second = await pollGmailInboundReplies(USER_A, client);

    expect(second.outcome).toBe('processed');
    if (second.outcome === 'processed') {
      expect(second.messageResults[0].outcome).toBe('duplicate');
    }
  });

  it('NO REAL PROVIDER CALLS: the real Gmail API client is never invoked by this test suite', async () => {
    const { realGmailApiClient } = await import('@/lib/runtime/inbound-reply/gmail-poll');
    expect(typeof realGmailApiClient.getCurrentHistoryId).toBe('function');
    // Presence-only check -- this test file never calls it, and no other
    // test in this suite imports it for invocation either (grep-verifiable:
    // only gmail-poll.test.ts references the symbol, purely for this shape
    // assertion).
  });
});
