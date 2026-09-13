/**
 * Phase 9.9.1 — AI Structured Classification Capability.
 *
 * aiClassifierHandler (lib/workflow-runtime/node-handlers/ai-classifier.ts)
 * is the first real, reusable AI-inference runtime capability -- a
 * deterministic, schema-validated wrapper around the platform's own
 * server-side OpenAI key (never a user-connected integration). All tests
 * here mock the OpenAI SDK; no live/paid model calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';

const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: { apiKey: string }) {}
  },
}));

const recordAiUsageMock = vi.fn().mockResolvedValue({ estimatedCostUsd: 0 });
vi.mock('@/lib/agent/observability', () => ({
  recordAiUsage: (...args: unknown[]) => recordAiUsageMock(...args),
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

function leadNode(overrides: Record<string, unknown> = {}): EngineNode {
  return {
    id: '2',
    name: 'Classify Lead',
    type: 'magicflux-nodes.aiClassifier',
    parameters: {
      instruction: 'Classify this lead as Hot, Warm, or Cold based on budget, urgency, and purchase intent.',
      allowedLabels: ['Hot', 'Warm', 'Cold'],
      confidenceThreshold: 0.6,
      ...overrides,
    },
  };
}

function mockCompletion(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  createMock.mockResolvedValueOnce({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage,
  });
}

const ORIGINAL_ENV = process.env.OPENAI_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test-platform-key';
});

describe('aiClassifierHandler', () => {
  it('Hot output: valid classification is preserved verbatim with confidence and reason', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.91, reason: 'High budget and urgent timeline.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), { name: 'Jane', budget: 50000 }, baseContext());

    expect(result.status).toBe('success');
    const output = result.outputData as Record<string, unknown>;
    expect(output.classification).toBe('Hot');
    expect(output.confidence).toBe(0.91);
    expect(output.reason).toBe('High budget and urgent timeline.');
    expect(output.needs_review).toBe(false);
  });

  it('Warm output', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.7, reason: 'Moderate interest.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), { name: 'Sam' }, baseContext());
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).classification).toBe('Warm');
  });

  it('Cold output', async () => {
    mockCompletion(JSON.stringify({ classification: 'Cold', confidence: 0.8, reason: 'No budget indicated.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), { name: 'Alex' }, baseContext());
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).classification).toBe('Cold');
  });

  it('low-confidence classification sets needs_review:true', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.3, reason: 'Ambiguous signals.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), {}, baseContext());
    expect(result.status).toBe('success');
    const output = result.outputData as Record<string, unknown>;
    expect(output.needs_review).toBe(true);
    expect(output.confidence).toBe(0.3);
  });

  it('malformed AI output (invalid JSON) is retried, and a subsequent valid response succeeds', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' } }], usage: {} });
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.85, reason: 'Recovered after retry.' }));

    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), {}, baseContext());

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).classification).toBe('Hot');
    expect(result.logs.some((l) => l.toLowerCase().includes('malformed'))).toBe(true);
  });

  it('an out-of-range confidence value is treated as malformed and does not fabricate a clamped result', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 1.5, reason: 'Overconfident.' }));
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 1.5, reason: 'Still overconfident.' }));
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 1.5, reason: 'Still overconfident.' }));

    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), {}, baseContext());

    // Bounded retries (3 total attempts), then fail closed -- never a fabricated/clamped confidence.
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    expect(result.outputData).toBeNull();
  });

  it('unknown label is rejected -- exhausts bounded retries and fails closed rather than accepting an unlisted label', async () => {
    mockCompletion(JSON.stringify({ classification: 'Lukewarm', confidence: 0.8, reason: 'Invented label.' }));
    mockCompletion(JSON.stringify({ classification: 'Lukewarm', confidence: 0.8, reason: 'Invented label.' }));
    mockCompletion(JSON.stringify({ classification: 'Lukewarm', confidence: 0.8, reason: 'Invented label.' }));

    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), {}, baseContext());

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/not one of the allowed labels/i);
  });

  it('original input data is preserved unchanged alongside the new classification fields', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Good fit.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const input = { leadId: 'lead-42', name: 'Priya', email: 'priya@example.com', budget: 100000 };
    const result = await aiClassifierHandler(leadNode(), input, baseContext());

    const output = result.outputData as Record<string, unknown>;
    expect(output.leadId).toBe('lead-42');
    expect(output.name).toBe('Priya');
    expect(output.email).toBe('priya@example.com');
    expect(output.budget).toBe(100000);
  });

  it('secrets in the input data are excluded from the prompt sent to the model', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Fine.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const input = { name: 'Jordan', api_key: 'sk-super-secret-value', password: 'hunter2', budget: 5000 };
    await aiClassifierHandler(leadNode(), input, baseContext());

    expect(createMock).toHaveBeenCalledTimes(1);
    const sentPrompt = createMock.mock.calls[0][0].messages[0].content as string;
    expect(sentPrompt).not.toContain('sk-super-secret-value');
    expect(sentPrompt).not.toContain('hunter2');
    expect(sentPrompt).toContain('Jordan');
    expect(sentPrompt).toContain('5000');
  });

  it('extractFields are validated and merged into the output when present', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Strong fit.', urgencyLevel: 'immediate' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const node = leadNode({ extractFields: [{ name: 'urgencyLevel', description: 'how urgent' }] });
    const result = await aiClassifierHandler(node, {}, baseContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).urgencyLevel).toBe('immediate');
  });

  it('missing required params fails closed without calling the model at all', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const node: EngineNode = { id: '2', name: 'Broken', type: 'magicflux-nodes.aiClassifier', parameters: {} };

    const result = await aiClassifierHandler(node, {}, baseContext());
    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/instruction/i);
  });

  it('test mode never calls the real API and returns a deterministic simulated result', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { name: 'Test Lead' }, baseContext({ mode: 'test' }));

    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
    const output = result.outputData as Record<string, unknown>;
    expect(output.classification).toBe('Hot'); // first allowed label
    expect(output.name).toBe('Test Lead');
  });

  it('records AI usage via the existing accounting path when a userId is present', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Fine.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    await aiClassifierHandler(leadNode(), {}, baseContext({ userId: 'user-1', workflowId: 'wf-1' }));

    expect(recordAiUsageMock).toHaveBeenCalledTimes(1);
    const call = recordAiUsageMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.userId).toBe('user-1');
    expect(call.agentName).toBe('runtime');
    expect(call.provider).toBe('openai');
  });

  it('does not record usage when no userId is present (e.g. a disposable/anonymous test run)', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Fine.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    await aiClassifierHandler(leadNode(), {}, baseContext());
    expect(recordAiUsageMock).not.toHaveBeenCalled();
  });

  it('fails closed with no API call when the platform AI provider is not configured', async () => {
    delete process.env.OPENAI_API_KEY;
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), {}, baseContext());
    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    process.env.OPENAI_API_KEY = ORIGINAL_ENV;
  });

  it('a network/API error fails immediately without retrying (retries are reserved for malformed model output)', async () => {
    createMock.mockRejectedValueOnce(new Error('connection reset'));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');

    const result = await aiClassifierHandler(leadNode(), {}, baseContext());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
  });
});
