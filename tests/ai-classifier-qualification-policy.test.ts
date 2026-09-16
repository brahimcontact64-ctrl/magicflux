/**
 * Phase 9.9.10 -- aiClassifierHandler's optional "qualificationPolicy"
 * parameter, handler-level integration (mocked OpenAI, no live/paid calls).
 *
 * Complements tests/qualification-policy.test.ts (pure evaluator logic) by
 * proving the handler actually WIRES the deterministic gate in front of the
 * AI call the way Part C requires: the LLM must never silently override a
 * deterministic business rule, and missing required evidence must never be
 * guessed at all.
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

vi.mock('@/lib/agent/observability', () => ({
  recordAiUsage: vi.fn().mockResolvedValue({ estimatedCostUsd: 0 }),
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] }, ...overrides };
}

const BASE_POLICY = {
  version: 1,
  allowedInputFields: ['budget_max', 'urgency', 'purchase_intent', 'desired_start', 'project_description'],
  fields: [
    { field: 'budget_max', required: true, kind: 'numeric', positiveMin: 100000, negativeMax: 10000 },
    { field: 'urgency', required: false, kind: 'enum', positiveValues: ['urgent'], negativeValues: ['someday'] },
    { field: 'purchase_intent', required: false, kind: 'enum', positiveValues: ['ready-to-start'], negativeValues: ['just-browsing'] },
    { field: 'desired_start', required: false, kind: 'enum', positiveValues: ['asap'], negativeValues: ['in-6-months'] },
    { field: 'project_description', required: false, kind: 'text' },
  ],
  contradictions: [
    { positiveField: 'budget_max', negativeField: 'purchase_intent', note: 'High budget but low purchase intent' },
    { positiveField: 'urgency', negativeField: 'purchase_intent', note: 'Urgent but weak purchase intent' },
    { positiveField: 'purchase_intent', negativeField: 'desired_start', note: 'Ready to buy but a distant start date' },
  ],
};

function leadNode(qualificationPolicy: unknown = BASE_POLICY): EngineNode {
  return {
    id: '2',
    name: 'Classify Lead',
    type: 'magicflux-nodes.aiClassifier',
    parameters: {
      instruction: 'Classify this lead as Hot, Warm, or Cold based on the business qualification policy.',
      allowedLabels: ['Hot', 'Warm', 'Cold'],
      confidenceThreshold: 0.6,
      qualificationPolicy,
    },
  };
}

function mockCompletion(content: string) {
  createMock.mockResolvedValueOnce({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test-platform-key';
});

describe('aiClassifierHandler + qualificationPolicy', () => {
  it('scenario 2/warm: strong mid-tier evidence classifies normally, qualification_status "classified"', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.8, reason: 'Moderate budget and intent.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 150000, purchase_intent: 'ready-to-start' }, baseContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown> | null)?.classification).toBe('Warm');
    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(false);
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('classified');
    expect(((result.outputData as Record<string, unknown> | null)?.positive_signals as unknown[]).length).toBeGreaterThan(0);
  });

  it('scenario 5: missing REQUIRED field (budget_max) skips the AI call entirely -- never guesses', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { urgency: 'urgent', purchase_intent: 'ready-to-start' }, baseContext());

    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('needs_information');
    expect((result.outputData as Record<string, unknown> | null)?.missing_required_fields).toEqual(['budget_max']);
    expect((result.outputData as Record<string, unknown> | null)?.confidence).toBe(0);
  });

  it('scenario 7: high budget + "just browsing" -- AI still called, but review is FORCED even if the model reports high confidence and no contradiction itself', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.95, reason: 'Big budget.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 700000, purchase_intent: 'just-browsing' }, baseContext());

    expect(createMock).toHaveBeenCalledTimes(1);
    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('needs_review');
    expect((result.outputData as Record<string, unknown> | null)?.contradictions).toContain('High budget but low purchase intent');
  });

  it('scenario 8: urgent + weak/negative purchase intent -- deterministic contradiction forces review', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.85, reason: 'Urgent but hesitant.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 150000, urgency: 'urgent', purchase_intent: 'just-browsing' }, baseContext());

    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.contradictions).toContain('Urgent but weak purchase intent');
  });

  it('scenario 9: "ready to buy" + distant start date -- deterministic contradiction forces review', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Ready to buy.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 700000, purchase_intent: 'ready-to-start', desired_start: 'in-6-months' }, baseContext());

    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.contradictions).toContain('Ready to buy but a distant start date');
  });

  it('scenario 10: structured/free-text contradiction -- an AI-REPORTED semantic contradiction also forces review even with no deterministic one', async () => {
    mockCompletion(JSON.stringify({
      classification: 'Warm',
      confidence: 0.85,
      reason: 'Text claims urgency but budget is moderate.',
      contradictions: ['The project description claims an urgent need but no other field supports that.'],
    }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(
      leadNode(),
      { budget_max: 150000, project_description: 'We need this done TODAY, extremely urgent!!!' },
      baseContext()
    );

    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('needs_review');
    expect((result.outputData as Record<string, unknown> | null)?.contradictions).toContain('The project description claims an urgent need but no other field supports that.');
  });

  it('scenario 15: deterministic policy cannot be overridden by LLM output -- confidence 0.99 and an empty AI-reported contradictions array still yields needs_review=true when the DETERMINISTIC evaluator found a contradiction', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.99, reason: 'Extremely confident.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 700000, purchase_intent: 'just-browsing' }, baseContext());

    expect((result.outputData as Record<string, unknown> | null)?.confidence).toBe(0.99);
    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true); // never silently overridden by the model's own high confidence
  });

  it('scenario 16: low confidence with NO contradictions still routes to Human Review, qualification_status reflects it', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.3, reason: 'Uncertain.', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { budget_max: 150000, purchase_intent: 'ready-to-start' }, baseContext());

    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('needs_review');
  });

  it('Part H: an untrusted extra webhook field, and a token/secret-shaped field, never reach the AI prompt', async () => {
    mockCompletion(JSON.stringify({ classification: 'Warm', confidence: 0.8, reason: 'ok', contradictions: [] }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    await aiClassifierHandler(
      leadNode(),
      { budget_max: 150000, purchase_intent: 'ready-to-start', access_token: 'ya29.super-secret-value', _conditionBranch: 0, random_untrusted_field: 'whatever' },
      baseContext()
    );

    const sentPrompt = String(createMock.mock.calls[0][0].messages[0].content);
    expect(sentPrompt).not.toContain('ya29.super-secret-value');
    expect(sentPrompt).not.toContain('_conditionBranch');
    expect(sentPrompt).not.toContain('random_untrusted_field');
  });

  it('a node with NO qualificationPolicy configured behaves exactly as before -- no new output fields at all', async () => {
    mockCompletion(JSON.stringify({ classification: 'Hot', confidence: 0.9, reason: 'Great fit.' }));
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(null), { name: 'Acme' }, baseContext());

    expect(result.outputData).not.toHaveProperty('qualification_status');
    expect(result.outputData).not.toHaveProperty('positive_signals');
    expect(result.outputData).not.toHaveProperty('negative_signals');
    expect(result.outputData).not.toHaveProperty('missing_required_fields');
    expect(result.outputData).not.toHaveProperty('contradictions');
  });

  it('test mode with a policy configured and a missing required field: still simulated, still flags needs_information, no real AI call', async () => {
    const { aiClassifierHandler } = await import('../lib/workflow-runtime/node-handlers/ai-classifier');
    const result = await aiClassifierHandler(leadNode(), { urgency: 'urgent' }, baseContext({ mode: 'test' }));

    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
    expect((result.outputData as Record<string, unknown> | null)?.qualification_status).toBe('needs_information');
    expect((result.outputData as Record<string, unknown> | null)?.needs_review).toBe(true);
  });
});
