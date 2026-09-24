import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';
import type { EngineNode, NodeHandlerContext } from '@/lib/workflow-runtime/types';

let tables: FakeTables;
let schemaMissing = false;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeInboundReplyDb(tables, { schemaMissing })),
}));

let accessTokenImpl: () => Promise<string> = async () => 'fake-access-token';
vi.mock('@/lib/credentials/oauth-refresh', () => ({
  getValidAccessToken: vi.fn(() => accessTokenImpl()),
}));

let sendImpl: () => Promise<{ ok: true; providerMessageId: string; providerThreadId: string | null } | { ok: false; indeterminate: boolean; message: string }> = async () => ({
  ok: true,
  providerMessageId: 'gmail-msg-default',
  providerThreadId: 'gmail-thread-default',
});
const sendMock = vi.fn(() => sendImpl());
vi.mock('@/lib/runtime/inbound-reply/gmail-send-adapter', () => ({
  gmailOutboundProviderClient: { provider: 'gmail', send: () => sendMock() },
}));

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const WORKFLOW_A = 'wf-a';

beforeEach(() => {
  tables = makeEmptyTables();
  schemaMissing = false;
  accessTokenImpl = async () => 'fake-access-token';
  sendImpl = async () => ({ ok: true, providerMessageId: 'gmail-msg-default', providerThreadId: 'gmail-thread-default' });
  sendMock.mockClear();
});

function seedSequence(userId: string, status: string, id = 'seq-1', threadId = 'thread-1') {
  const conversationId = `conv-${id}`;
  tables.runtime_conversations.push({ id: conversationId, user_id: userId, workflow_id: WORKFLOW_A, execution_id: 'exec-1', provider: 'gmail', provider_thread_id: threadId, entity_reference: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  tables.runtime_followup_sequences.push({ id, user_id: userId, workflow_id: WORKFLOW_A, execution_id: 'exec-1', conversation_id: conversationId, status, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), replied_at: null, cancelled_at: null, completed_at: null, last_transition_reason: null, send_lock_token: null, send_lock_expires_at: null });
  return id;
}

function makeNode(overrides: Partial<EngineNode['parameters']> = {}, id = 'node-1'): EngineNode {
  return {
    id,
    name: 'Follow-up Send',
    type: 'magicflux-nodes.followUpSend',
    parameters: { sequenceId: 'seq-1', to: 'lead@customer.example.com', subject: 'Following up', body: 'Just checking in.', ...overrides },
  };
}

function makeContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    userId: USER_A,
    workflowId: WORKFLOW_A,
    executionId: 'exec-1',
    ...overrides,
  };
}

describe('Follow-up Send node -- registration and capability metadata', () => {
  it('1. the node is registered in HANDLER_NODE_ALLOWLIST', async () => {
    const { HANDLER_NODE_ALLOWLIST } = await import('@/lib/workflow-runtime/node-handlers');
    expect(HANDLER_NODE_ALLOWLIST.has('magicflux-nodes.followupsend')).toBe(true);
  });

  it('2. the capability validator recognizes the type (not "unknown") and correctly reports it as not yet usable', async () => {
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(false);
    if (!result.capable) {
      // Distinguishes this from the generic "no handler at all" message --
      // proves the validator recognizes the type specifically.
      expect(result.reason.toLowerCase()).toContain('migration');
    }
  });

  it('3. capability metadata is truthful: only gmail is declared as a supported provider, and the node is never falsely advertised as production-ready', async () => {
    const { PROVIDER_NODE_ALLOWLIST } = await import('@/lib/integrations');
    const gmailSet = PROVIDER_NODE_ALLOWLIST.get('gmail')!;
    expect(gmailSet.has('magicflux-nodes.followupsend')).toBe(true);
    for (const [provider, types] of PROVIDER_NODE_ALLOWLIST) {
      if (provider === 'gmail' || provider === 'email') continue;
      expect(types.has('magicflux-nodes.followupsend')).toBe(false);
    }
  });
});

describe('Follow-up Send node -- execution outcomes', () => {
  it('4. a valid active sequence -> SENT', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).followup_send_result).toBe('SENT');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('5. a replied sequence -> suppression result, node does NOT fail', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'replied');

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).followup_send_result).toBe('SUPPRESSED_SEQUENCE_REPLIED');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('6. a cancelled sequence -> suppression', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'cancelled');

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).followup_send_result).toBe('SUPPRESSED_SEQUENCE_CANCELLED');
  });

  it('7. a completed sequence -> suppression', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'completed');

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).followup_send_result).toBe('SUPPRESSED_SEQUENCE_COMPLETED');
  });

  it('8. a duplicate attempt (same deterministic key) -> DUPLICATE_ALREADY_SENT, provider not called again', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    await followUpSendHandler(makeNode(), {}, makeContext());
    const second = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(second.status).toBe('success');
    expect((second.outputData as Record<string, unknown>).followup_send_result).toBe('DUPLICATE_ALREADY_SENT');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('9. lock contention -> a safe, non-crashing, retryable result (LOCK_NOT_ACQUIRED)', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    tables.runtime_followup_sequences[0].send_lock_token = 'someone-elses-lock';
    tables.runtime_followup_sequences[0].send_lock_expires_at = new Date(Date.now() + 60_000).toISOString();

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).not.toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.followup_send_result).toBe('LOCK_NOT_ACQUIRED');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('Follow-up Send node -- deterministic attempt key', () => {
  it('10. the SAME logical retry (same execution + same node + same sequence) resolves to the identical attempt key', async () => {
    const { buildDeterministicAttemptKey, followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    await followUpSendHandler(makeNode(), {}, makeContext());
    const recordedKey = tables.runtime_outbound_messages[0].attempt_key;
    const expectedKey = buildDeterministicAttemptKey({ executionId: 'exec-1', nodeId: 'node-1', sequenceId: 'seq-1' });

    expect(recordedKey).toBe(expectedKey);

    // A second invocation with the identical context/node produces the SAME key again.
    const second = buildDeterministicAttemptKey({ executionId: 'exec-1', nodeId: 'node-1', sequenceId: 'seq-1' });
    expect(second).toBe(expectedKey);
  });

  it('11. a DIFFERENT logical follow-up step (a different node in the graph) gets a DIFFERENT attempt key', async () => {
    const { buildDeterministicAttemptKey } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    const stepOne = buildDeterministicAttemptKey({ executionId: 'exec-1', nodeId: 'node-1', sequenceId: 'seq-1' });
    const stepTwo = buildDeterministicAttemptKey({ executionId: 'exec-1', nodeId: 'node-2', sequenceId: 'seq-1' });
    expect(stepOne).not.toBe(stepTwo);
  });
});

describe('Follow-up Send node -- error/retry/indeterminate semantics', () => {
  it('12. a provider DEFINITE failure follows normal retry semantics (not nonRetryable)', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    sendImpl = async () => ({ ok: false, indeterminate: false, message: 'Gmail API returned 400' });

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).not.toBe(true);
    expect(result.error).toContain('PROVIDER_FAILED');
  });

  it('13. a provider INDETERMINATE result never causes an unsafe automatic resend -- nonRetryable, no outbound record', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    sendImpl = async () => ({ ok: false, indeterminate: true, message: 'Gmail send may have already succeeded remotely' });

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.failureClass).toBe('indeterminate');
    expect((result.outputData as Record<string, unknown> | null)?.followup_send_result).toBe('PROVIDER_INDETERMINATE');
    expect(tables.runtime_outbound_messages.length).toBe(0);
  });

  it('14a. CREDENTIAL FAILURE (permanent -- never connected): classified as blocked configuration, not a normal retry', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    accessTokenImpl = async () => {
      throw new Error('No valid OAuth credentials stored for provider: gmail');
    };

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.failureClass).toBe('blocked_configuration');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('14b. CREDENTIAL FAILURE (transient -- e.g. a refresh-endpoint network blip): treated as an ordinary retryable failure', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    accessTokenImpl = async () => {
      throw new Error('fetch failed: ETIMEDOUT contacting oauth2.googleapis.com');
    };

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).not.toBe(true);
  });

  it('15. a missing migration/schema produces a CLEAR infrastructure-readiness error, never "credential invalid" or "provider failed"', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');
    schemaMissing = true;

    const result = await followUpSendHandler(makeNode(), {}, makeContext());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('INFRASTRUCTURE_NOT_READY');
    expect(result.error).not.toMatch(/credential invalid/i);
    expect(result.error).not.toContain('PROVIDER_FAILED');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('Follow-up Send node -- expression resolution, tenant isolation, privacy', () => {
  it('16. sequenceId resolves from prior node output via the standard {{$json["field"]}} expression grammar', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active', 'seq-from-expression');

    const node = makeNode({ sequenceId: '={{$json["mySequenceId"]}}' });
    const result = await followUpSendHandler(node, { mySequenceId: 'seq-from-expression' }, makeContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).followup_send_result).toBe('SENT');
  });

  it('17. TENANT ISOLATION: a sequence owned by a different user is never sent to, regardless of node configuration', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_B, 'active');

    const result = await followUpSendHandler(makeNode(), {}, makeContext({ userId: USER_A }));

    expect(sendMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('18. no message body is ever persisted in the outbound correlation record', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    await followUpSendHandler(makeNode({ body: 'SENSITIVE_BODY_TEXT_do_not_persist' }), {}, makeContext());

    const row = tables.runtime_outbound_messages[0];
    expect(JSON.stringify(row)).not.toContain('SENSITIVE_BODY_TEXT_do_not_persist');
    expect(Object.keys(row)).not.toContain('body');
  });

  it('22. NO REAL PROVIDER CALLS: the mocked gmail-send-adapter is the only send path exercised by this suite', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    await followUpSendHandler(makeNode(), {}, makeContext());

    expect(sendMock).toHaveBeenCalledTimes(1); // only the mock, never a real network call
  });

  it('test mode: never touches sequence state or the provider, always simulates success', async () => {
    const { followUpSendHandler } = await import('@/lib/workflow-runtime/node-handlers/follow-up-send');
    seedSequence(USER_A, 'active');

    const result = await followUpSendHandler(makeNode(), {}, makeContext({ mode: 'test' }));

    expect(result.status).toBe('simulated_success');
    expect(sendMock).not.toHaveBeenCalled();
    expect(tables.runtime_outbound_messages.length).toBe(0);
    expect(tables.runtime_followup_sequences[0].status).toBe('active');
  });
});
