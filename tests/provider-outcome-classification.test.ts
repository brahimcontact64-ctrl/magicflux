/**
 * Phase 9.9.11 -- Part E/H: provider-call outcome classification
 * (lib/workflow-runtime/node-handlers/provider-outcome.ts and its wiring
 * into airtable.ts/slack.ts/email.ts).
 *
 * None of Airtable, Slack, or Gmail's APIs support a caller-supplied
 * idempotency key for the operations these handlers perform. The one
 * mechanism keeping a genuinely ambiguous outcome (a timeout/connection
 * loss that may have occurred AFTER the provider already processed the
 * request) from being blindly retried is this classification: a response
 * actually received from the provider (any status) is trustworthy and
 * safely retryable on a real rejection; a thrown fetch() error is
 * classified indeterminate and marked `nonRetryable` -- the EXISTING
 * contract (lib/workflow-runtime/types.ts, Phase 9.9.6) that
 * runtime/node-runner.ts's retry loop already respects, so this is a
 * closed, tested loop from classification through to "never retried".
 *
 * These tests use fetch() THROWING to simulate exactly the scenario H asks
 * to prove: "provider accepts request but response is lost" / "provider
 * returns timeout" -- a crash or dropped connection after the provider may
 * have already committed the effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

// The node-runner.ts integration test below constructs a real RuntimeStateStore
// (to prove the ACTUAL retry loop respects nonRetryable, not just the handler's
// own return value) -- its persistence/control methods are spied on the
// prototype per-test, but the constructor itself still calls
// createServiceClient(), which requires real Supabase env vars unless mocked.
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    const resolved = Promise.resolve({ data: null, error: null });
    for (const method of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'limit', 'order', 'maybeSingle', 'single']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = resolved.then.bind(resolved);
    chain.maybeSingle = vi.fn(() => resolved);
    chain.single = vi.fn(() => resolved);
    return { from: vi.fn(() => chain) };
  }),
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] }, ...overrides };
}

function integration(provider: string, credentials: Record<string, string>): UserIntegration {
  return { provider: provider as UserIntegration['provider'], credentials, status: 'connected' };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Airtable create -- indeterminate vs. definite-failure classification', () => {
  it('a network-level throw (timeout/connection loss) is classified indeterminate -- nonRetryable, never blindly retried', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const node: EngineNode = { id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: { Name: '={{$json["name"]}}' } } };
    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] });

    const result = await airtableHandler(node, { name: 'Acme' }, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.error).toMatch(/INDETERMINATE/);
  });

  it('a clean HTTP error response (Airtable explicitly rejected the request) is a normal, retryable failure -- never nonRetryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'INVALID_REQUEST' }, { ok: false, status: 422 }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const node: EngineNode = { id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: { Name: '={{$json["name"]}}' } } };
    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] });

    const result = await airtableHandler(node, { name: 'Acme' }, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable ?? false).toBe(false);
    expect(result.error).not.toMatch(/INDETERMINATE/);
  });

  it('a genuine success is completely unaffected by the new classification', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'recNEW123' }, { ok: true, status: 200 }));
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const node: EngineNode = { id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: { Name: '={{$json["name"]}}' } } };
    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] });

    const result = await airtableHandler(node, { name: 'Acme' }, ctx);

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).airtable_id).toBe('recNEW123');
  });
});

describe('Slack -- indeterminate vs. definite-failure classification', () => {
  it('a network-level throw is classified indeterminate -- nonRetryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const node: EngineNode = { id: '1', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'Hot lead' } };
    const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });

    const result = await slackHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.error).toMatch(/INDETERMINATE/);
  });

  it('a clean Slack API error response ({ok:false, error}) is a normal, retryable failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'channel_not_found' }));
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const node: EngineNode = { id: '1', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'Hot lead' } };
    const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });

    const result = await slackHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable ?? false).toBe(false);
  });

  it('the incoming-webhook-URL fallback path is also classified the same way on a network throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const node: EngineNode = { id: '1', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'Hot lead' } };
    const ctx = baseContext({ integrations: [integration('slack', { webhook_url: 'https://hooks.slack.com/services/T/B/X' })] });

    const result = await slackHandler(node, {}, ctx);

    expect(result.nonRetryable).toBe(true);
  });
});

describe('Gmail API send -- indeterminate vs. definite-failure classification', () => {
  it('a network-level throw / AbortSignal.timeout firing is classified indeterminate -- corrects the previous incorrect "always safely retryable" assumption', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node: EngineNode = { id: '1', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', message: 'New lead' } };
    const ctx = baseContext({ integrations: [integration('gmail', { access_token: 'ya29-test' })] });

    const result = await emailHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.error).toMatch(/INDETERMINATE/);
  });

  it('a clean Gmail API error response (e.g. invalid recipient) is a normal, retryable failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('{"error":"invalid recipient"}') } as unknown as Response);
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node: EngineNode = { id: '1', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', message: 'New lead' } };
    const ctx = baseContext({ integrations: [integration('gmail', { access_token: 'ya29-test' })] });

    const result = await emailHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable ?? false).toBe(false);
  });

  it('a genuine Gmail success is completely unaffected', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ id: 'msg123' }) } as unknown as Response);
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const node: EngineNode = { id: '1', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'lead@example.com', subject: 'Hi', message: 'New lead' } };
    const ctx = baseContext({ integrations: [integration('gmail', { access_token: 'ya29-test' })] });

    const result = await emailHandler(node, {}, ctx);

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).messageId).toBe('msg123');
  });
});

describe('node-runner.ts respects nonRetryable end-to-end -- an indeterminate outcome is never blindly retried', () => {
  it('a nonRetryable failure exhausts immediately, never re-invoking the handler', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const persistNodeState = vi.spyOn(RuntimeStateStore.prototype, 'persistNodeState').mockResolvedValue(undefined as never);
    vi.spyOn(RuntimeStateStore.prototype, 'getExecutionControl').mockResolvedValue({ cancelRequested: false, pauseRequested: false, resumeRequested: false } as never);

    const { NodeRunner } = await import('../runtime/node-runner');
    const runner = new NodeRunner(new RuntimeStateStore());
    const node: EngineNode = { id: '1', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: { Name: '={{$json["name"]}}' } } };

    const result = await runner.run({
      executionId: 'exec-1', workflowId: 'wf-1', userId: 'user-1', node, inputData: { name: 'Acme' },
      maxRetries: 3, mode: 'live',
      handlerContext: baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat1' })] }),
      correlationId: 'corr-1',
    });

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1); // exhausted on the FIRST attempt, never retried
    expect(fetchMock).toHaveBeenCalledTimes(1); // the provider was called exactly once
    persistNodeState.mockRestore();
  });
});
