/**
 * Phase 9.9.0 — Complex Workflow Branching Integrity.
 *
 * Root cause (production investigation, lead-routing workflow): classifyNode()
 * in lib/agent/workflow-graph.ts used to end its AI-provider regex with a bare
 * `ai` alternative, which matches ANY node type merely CONTAINING the
 * substring "ai" -- including n8n-nodes-base.airtable ("**ai**rtable") and
 * n8n-nodes-base.gmail ("gm**ai**l"). Both got silently misclassified as
 * kind:'ai' instead of kind:'action', which is why the Builder's own summary
 * reported "Actions: 1" for a workflow that genuinely had three action nodes
 * (Airtable, Slack, Gmail) -- confirmed via buildWorkflowGraphSummary(), the
 * single source of truth the summary card is derived from.
 */

import { describe, it, expect } from 'vitest';
import { buildWorkflowGraphSummary } from '../lib/agent/workflow-graph';

function kindFor(type: string): string {
  const graph = buildWorkflowGraphSummary({
    nodes: [{ id: '1', name: 'Node', type, parameters: {} }],
    connections: {},
  });
  return graph.nodes[0].kind;
}

describe('classifyNode() via buildWorkflowGraphSummary (Phase 9.9.0 fix)', () => {
  it('Gmail is an action, not AI (regression: "gm-AI-l" substring)', () => {
    expect(kindFor('n8n-nodes-base.gmail')).toBe('action');
  });

  it('Airtable is an action, not AI (regression: "AI-rtable" substring)', () => {
    expect(kindFor('n8n-nodes-base.airtable')).toBe('action');
  });

  it('Slack is an action', () => {
    expect(kindFor('n8n-nodes-base.slack')).toBe('action');
  });

  it('genuine OpenAI nodes classify as ai', () => {
    expect(kindFor('n8n-nodes-base.openAi')).toBe('ai');
  });

  it('genuine Anthropic/Claude nodes classify as ai', () => {
    expect(kindFor('n8n-nodes-base.anthropic')).toBe('ai');
    expect(kindFor('n8n-nodes-base.claude')).toBe('ai');
  });

  it('genuine Gemini/Groq/LLM-labeled nodes classify as ai', () => {
    expect(kindFor('n8n-nodes-base.gemini')).toBe('ai');
    expect(kindFor('n8n-nodes-base.groq')).toBe('ai');
    expect(kindFor('custom.llmRouter')).toBe('ai');
  });

  it('unrelated strings merely containing "ai" are never misclassified as ai', () => {
    // "ai" appears inside "domain", "maintain", "airtable", "gmail" -- none
    // of these are AI nodes.
    expect(kindFor('n8n-nodes-base.airtableTrigger')).not.toBe('ai');
    expect(kindFor('custom.domainLookup')).not.toBe('ai');
    expect(kindFor('custom.maintainRecord')).not.toBe('ai');
  });

  it('the Builder workflow summary reports the true action count for the exact production lead-routing graph shape', () => {
    const graph = buildWorkflowGraphSummary({
      nodes: [
        { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: '2', name: 'Lead Classification', type: 'n8n-nodes-base.if', parameters: {} },
        { id: '3', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: {} },
        { id: '4', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: {} },
        { id: '5', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: {} },
        { id: '6', name: 'Human Review', type: 'n8n-nodes-base.set', parameters: {} },
      ],
      connections: {},
    });

    const actions = graph.nodes.filter((n) => n.kind === 'action').length;
    const triggers = graph.nodes.filter((n) => n.kind === 'trigger').length;
    const branches = graph.branches;

    expect(triggers).toBe(1);
    expect(actions).toBe(3); // Airtable, Slack, Gmail -- previously undercounted to 1
    expect(branches).toBe(1); // Lead Classification (if)
  });
});
