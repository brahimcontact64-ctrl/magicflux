/**
 * Phase 9.5 Step I — openaiHandler security sweep. Every other provider
 * handler that surfaces a raw error string (airtable.ts, email.ts, http.ts)
 * passes it through redactText() first; this handler didn't, even though
 * the OpenAI SDK's thrown Error.message isn't a bounded, guaranteed-safe
 * value for every error shape it can produce.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';

const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: { apiKey: string }) {}
  },
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
    ...overrides,
  };
}

function integration(provider: string, credentials: Record<string, string>): UserIntegration {
  return { provider: provider as UserIntegration['provider'], credentials, status: 'connected' };
}

const node: EngineNode = { id: 'n1', name: 'Ask AI', type: 'n8n-nodes-base.openai', parameters: { prompt: 'Summarize this order.' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openaiHandler', () => {
  it('test mode never calls the SDK and returns a simulated preview', async () => {
    const { openaiHandler } = await import('../lib/workflow-runtime/node-handlers/openai');
    const result = await openaiHandler(node, {}, baseContext({ mode: 'test' }));

    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
  });

  it('fails cleanly when no OpenAI/Claude integration is connected', async () => {
    const { openaiHandler } = await import('../lib/workflow-runtime/node-handlers/openai');
    const result = await openaiHandler(node, {}, baseContext());

    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('OpenAI API key not configured');
  });

  it('a successful completion never echoes the API key anywhere in the result', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'Order #123 summary.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const { openaiHandler } = await import('../lib/workflow-runtime/node-handlers/openai');
    const ctx = baseContext({ integrations: [integration('openai', { api_key: 'sk-SECRET-value' })] });
    const result = await openaiHandler(node, {}, ctx);

    expect(result.status).toBe('success');
    expect(JSON.stringify(result)).not.toContain('sk-SECRET-value');
  });

  it('a thrown SDK error is redacted before reaching logs/error (no raw URL or key=value leakage)', async () => {
    createMock.mockRejectedValue(new Error(
      'Request failed for https://api.openai.com/v1/chat/completions?api_key=sk-SECRET-leak: 401 Unauthorized'
    ));

    const { openaiHandler } = await import('../lib/workflow-runtime/node-handlers/openai');
    const ctx = baseContext({ integrations: [integration('openai', { api_key: 'sk-test' })] });
    const result = await openaiHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('sk-SECRET-leak');
    expect(result.error).not.toContain('https://api.openai.com');
    expect(result.logs.join(' ')).not.toContain('sk-SECRET-leak');
  });
});
