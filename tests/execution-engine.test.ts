/**
 * Mock execution engine tests.
 *
 * Verifies that each handler returns the expected shape,
 * and that the full engine correctly sequences steps.
 */

import { describe, it, expect } from 'vitest';
import { executeMockNode, executeMockWorkflow } from '../lib/execution/engine';
import { compileWorkflow } from '../lib/execution/compiler';
import { createMockContext } from '../lib/execution/plan-types';
import type { PlanNode } from '../lib/execution/plan-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<PlanNode>): PlanNode {
  return {
    id:         overrides.id ?? 'node-1',
    name:       overrides.name ?? 'Test Node',
    type:       overrides.type ?? 'n8n-nodes-base.webhook',
    parameters: overrides.parameters ?? {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// executeMockNode — individual handlers
// ═══════════════════════════════════════════════════════════════════════════

describe('executeMockNode — trigger handler', () => {
  it('returns success status', async () => {
    const ctx = createMockContext();
    const result = await executeMockNode(makeNode({ type: 'n8n-nodes-base.webhook' }), ctx);
    expect(result.status).toBe('success');
  });

  it('output contains triggerType', async () => {
    const ctx = createMockContext();
    const result = await executeMockNode(makeNode({ type: 'n8n-nodes-base.webhook' }), ctx);
    expect(result.output.triggerType).toBeDefined();
  });

  it('has non-negative durationMs', async () => {
    const ctx = createMockContext();
    const result = await executeMockNode(makeNode({ type: 'n8n-nodes-base.webhook' }), ctx);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('executeMockNode — email handler', () => {
  it('returns success when to is provided', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.emailSend',
      parameters: { to: 'test@example.com', subject: 'Hi', body: 'Hello' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
  });

  it('output contains messageId', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.emailSend',
      parameters: { to: 'test@example.com', subject: 'Hi', body: 'Hello' },
    });
    const result = await executeMockNode(node, ctx);
    expect(typeof result.output.messageId).toBe('string');
  });

  it('returns error when to is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.emailSend', parameters: {} });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
  });
});

describe('executeMockNode — slack handler', () => {
  it('returns success when channel is provided', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.slack',
      parameters: { channel: '#general', message: 'Hello!' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
    expect(result.output.ok).toBe(true);
  });

  it('returns error when channel is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.slack', parameters: {} });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
  });

  it('output channel matches input', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.slack',
      parameters: { channel: '#alerts', message: 'test' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.output.channel).toBe('#alerts');
  });
});

describe('executeMockNode — airtable handler', () => {
  it('returns success for list operation', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.airtable',
      parameters: { baseId: 'appXXX', tableId: 'tblXXX', operation: 'list' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
    expect(Array.isArray(result.output.records)).toBe(true);
  });

  it('returns error when baseId is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.airtable', parameters: { tableId: 'tbl' } });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
  });
});

describe('executeMockNode — http handler', () => {
  it('returns success when url is provided', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.httpRequest',
      parameters: { url: 'https://api.example.com', method: 'GET' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
    expect(result.output.statusCode).toBe(200);
  });

  it('returns error when url is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.httpRequest', parameters: {} });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
  });

  it('output contains url and method', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.httpRequest',
      parameters: { url: 'https://example.com', method: 'POST' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.output.url).toBe('https://example.com');
    expect(result.output.method).toBe('POST');
  });
});

describe('executeMockNode — delay handler', () => {
  it('returns success', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.wait',
      parameters: { amount: 5, unit: 'minutes' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
  });

  it('output contains waited and unit', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.wait',
      parameters: { amount: 2, unit: 'hours' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.output.waited).toBe(2);
    expect(result.output.unit).toBe('hours');
  });

  it('output contains simulated flag', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.wait', parameters: { amount: 1, unit: 'seconds' } });
    const result = await executeMockNode(node, ctx);
    expect(result.output.simulated).toBe(true);
  });
});

describe('executeMockNode — condition handler', () => {
  it('returns success when field is provided', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.if',
      parameters: { field: 'active', operation: 'equals', value: 'active' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
  });

  it('conditionResult true when field equals value', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.if',
      parameters: { field: 'hello', operation: 'equals', value: 'hello' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.conditionResult).toBe(true);
    expect(result.output.branch).toBe(0);
  });

  it('conditionResult false when field does not equal value', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.if',
      parameters: { field: 'foo', operation: 'equals', value: 'bar' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.conditionResult).toBe(false);
    expect(result.output.branch).toBe(1);
  });

  it('returns error when field is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.if', parameters: {} });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
  });
});

describe('executeMockNode — openai handler', () => {
  it('returns success when prompt is provided', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.openAi',
      parameters: { model: 'gpt-4o-mini', prompt: 'Summarise this text.' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
  });

  it('output contains model and content', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.openAi',
      parameters: { model: 'gpt-4o', prompt: 'Hello' },
    });
    const result = await executeMockNode(node, ctx);
    expect(result.output.model).toBe('gpt-4o');
    expect(typeof result.output.content).toBe('string');
  });

  it('output contains usage token counts', async () => {
    const ctx = createMockContext();
    const node = makeNode({
      type: 'n8n-nodes-base.openAi',
      parameters: { prompt: 'Test prompt' },
    });
    const result = await executeMockNode(node, ctx);
    const usage = result.output.usage as Record<string, number>;
    expect(typeof usage.prompt_tokens).toBe('number');
    expect(typeof usage.completion_tokens).toBe('number');
  });

  it('returns error when prompt is missing', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o' } });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('error');
  });
});

describe('executeMockNode — generic fallback handler', () => {
  it('unknown type uses generic handler and returns success', async () => {
    const ctx = createMockContext();
    const node = makeNode({ type: 'n8n-nodes-base.unknownNode' });
    const result = await executeMockNode(node, ctx);
    expect(result.status).toBe('success');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// executeMockWorkflow — full pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('executeMockWorkflow — full pipeline', () => {
  const LINEAR_PLAN = compileWorkflow({
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
      { name: 'Send Email', type: 'n8n-nodes-base.emailSend', parameters: { to: 'a@b.com', subject: 'Hi', body: 'Hello' } },
    ],
    connections: { Webhook: { main: [[{ node: 'Send Email' }]] } },
  });

  it('returns success for valid plan', async () => {
    const ctx = createMockContext();
    const summary = await executeMockWorkflow(LINEAR_PLAN, ctx);
    expect(summary.success).toBe(true);
  });

  it('all steps have results', async () => {
    const ctx = createMockContext();
    const summary = await executeMockWorkflow(LINEAR_PLAN, ctx);
    expect(summary.stepResults).toHaveLength(2);
  });

  it('returns immediately for invalid plan', async () => {
    const invalidPlan = compileWorkflow({ nodes: [], connections: {} });
    const ctx = createMockContext();
    const summary = await executeMockWorkflow(invalidPlan, ctx);
    expect(summary.success).toBe(false);
    expect(summary.stepResults).toHaveLength(0);
  });

  it('context.nodeResults contains results after execution', async () => {
    const ctx = createMockContext();
    await executeMockWorkflow(LINEAR_PLAN, ctx);
    expect(ctx.nodeResults.has('Webhook')).toBe(true);
    expect(ctx.nodeResults.has('Send Email')).toBe(true);
  });

  it('stops on error — subsequent nodes not executed', async () => {
    const plan = compileWorkflow({
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
        { name: 'Bad Email', type: 'n8n-nodes-base.emailSend', parameters: {} }, // missing 'to'
        { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#ch', message: 'x' } },
      ],
      connections: {
        Webhook:   { main: [[{ node: 'Bad Email' }]] },
        'Bad Email': { main: [[{ node: 'Slack' }]] },
      },
    });
    const ctx = createMockContext();
    const summary = await executeMockWorkflow(plan, ctx);
    expect(summary.success).toBe(false);
    expect(summary.failedNodeNames).toContain('Bad Email');
    // Slack should not have been executed
    expect(ctx.nodeResults.has('Slack')).toBe(false);
  });

  it('totalDurationMs is non-negative', async () => {
    const ctx = createMockContext();
    const summary = await executeMockWorkflow(LINEAR_PLAN, ctx);
    expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
