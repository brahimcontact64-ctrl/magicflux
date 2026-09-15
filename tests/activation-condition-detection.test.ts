/**
 * Phase 9.9.5 — Activation False Conditional Detection.
 *
 * Production incident: activating the live-tested "Lead Classification and
 * Notification" workflow failed with
 *   Condition node "AI Classifier" (type: "magicflux-nodes.aiClassifier")
 *   must define at least two output ports in connections...
 * even though magicflux-nodes.aiClassifier is a linear, data-producing node
 * (classification, confidence, needs_review) that routes normally into a
 * real n8n-nodes-base.if node ("Needs Review?") -- it never branches
 * itself. Reproduced read-only against the real persisted workflow
 * (1d966d11-352d-4765-9311-80ed54235f24) before any fix: validateWorkflow()
 * returned exactly this INVALID_CONDITION_PORTS error.
 *
 * Root cause: lib/workflow-validator/index.ts (the validator
 * activateWorkflow() actually calls, per lib/workflow/lifecycle.ts) had its
 * OWN duplicate, substring-based condition predicate
 * (`type.includes('if'|'condition'|'switch'|'filter')`, with a manual
 * PROVIDER_EXACT_TYPES/start-node exclusion list bolted on to stop it
 * false-positiving on names like 'shopify' containing 'if') -- completely
 * independent of the canonical, exact-segment isConditionalNodeType() in
 * lib/workflow-runtime/node-capabilities.ts that branch-connection-guard.ts,
 * human-review-routing-guard.ts, ai-review-routing-guard.ts,
 * node-handlers/index.ts, and runtime/workflow-engine.ts already share
 * (Phase 9.9.3.1/9.9.4). Nobody had taught the validator's own copy about
 * 'magicflux-nodes.aiClassifier' ('class-IF-ier'). A second, near-identical
 * copy also existed in lib/ai-workflows/workflow-repair.ts's automatic
 * "fix condition node port count" repair step, which would have silently
 * INJECTED a fake second output port into any AI Classifier node it ever
 * repaired -- exactly the outcome this platform must never produce.
 *
 * Both are now fixed by deleting the duplicate predicates and importing the
 * one canonical isConditionalNodeType() instead.
 */

import { describe, it, expect } from 'vitest';
import { isConditionalNodeType } from '@/lib/workflow-runtime/node-capabilities';
import { validateWorkflow } from '@/lib/workflow-validator';
import { repairWorkflow } from '@/lib/ai-workflows/workflow-repair';

// The exact real topology (node types + connection shapes) confirmed via
// read-only production inspection of workflow
// 1d966d11-352d-4765-9311-80ed54235f24: Webhook Trigger -> AI Classifier ->
// Needs Review? (real IF) -> Human Review (branches Hot/Warm/Cold) and, on
// the auto-approved side, If Hot / If Warm / If Cold (real IFs) -> the
// Airtable/Slack/Gmail sinks.
function realTopologyNodes() {
  return [
    { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook' },
    { id: '2', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier' },
    { id: '3', name: 'Needs Review?', type: 'n8n-nodes-base.if' },
    { id: '4', name: 'Human Review', type: 'magicflux-nodes.humanReview' },
    { id: '5', name: 'If Hot', type: 'n8n-nodes-base.if' },
    { id: '6', name: 'If Warm', type: 'n8n-nodes-base.if' },
    { id: '7', name: 'If Cold', type: 'n8n-nodes-base.if' },
    { id: '8', name: 'Airtable Hot', type: 'n8n-nodes-base.airtable' },
    { id: '9', name: 'Slack Notification Hot', type: 'n8n-nodes-base.slack' },
    { id: '10', name: 'Gmail Hot', type: 'n8n-nodes-base.gmail' },
    { id: '11', name: 'Airtable Warm', type: 'n8n-nodes-base.airtable' },
    { id: '12', name: 'Gmail Warm', type: 'n8n-nodes-base.gmail' },
    { id: '13', name: 'Airtable Cold', type: 'n8n-nodes-base.airtable' },
  ];
}

function realTopologyConnections() {
  const to = (node: string) => ({ node, type: 'main', index: 0 });
  return {
    'Webhook Trigger': { main: [[to('AI Classifier')]] },
    'AI Classifier': { main: [[to('Needs Review?')]] },
    'Needs Review?': {
      main: [
        [to('Human Review')],
        [to('If Hot'), to('If Warm'), to('If Cold')],
      ],
    },
    'Human Review': {
      main: [
        [to('Airtable Hot'), to('Slack Notification Hot'), to('Gmail Hot')],
        [to('Airtable Warm'), to('Gmail Warm')],
        [to('Airtable Cold')],
      ],
    },
    'If Hot': { main: [[to('Airtable Hot'), to('Slack Notification Hot'), to('Gmail Hot')], []] },
    'If Warm': { main: [[to('Airtable Warm'), to('Gmail Warm')], []] },
    'If Cold': { main: [[to('Airtable Cold')], []] },
  };
}

function realWorkflow() {
  return { name: 'Lead Classification and Notification', nodes: realTopologyNodes(), connections: realTopologyConnections() };
}

describe('isConditionalNodeType -- the one canonical predicate', () => {
  it('AI Classifier is NOT a conditional node (it is linear, data-producing)', () => {
    expect(isConditionalNodeType('magicflux-nodes.aiClassifier')).toBe(false);
  });

  it('Human Review IS a conditional node (it genuinely branches Hot/Warm/Cold)', () => {
    expect(isConditionalNodeType('magicflux-nodes.humanReview')).toBe(true);
  });

  it('real n8n-nodes-base.if remains conditional', () => {
    expect(isConditionalNodeType('n8n-nodes-base.if')).toBe(true);
  });

  it('a provider type merely containing the substring "if" (shop-IF-y) is not conditional', () => {
    expect(isConditionalNodeType('n8n-nodes-base.shopify')).toBe(false);
  });
});

describe('validateWorkflow (activation gate) -- AI Classifier is never treated as a condition node', () => {
  it('the current persisted real topology passes activation validation cleanly', () => {
    const result = validateWorkflow(realWorkflow());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('AI Classifier with a single output port produces no INVALID_CONDITION_PORTS error', () => {
    const result = validateWorkflow(realWorkflow());
    const aiClassifierErrors = result.errors.filter((e) => e.message.includes('AI Classifier'));
    expect(aiClassifierErrors).toEqual([]);
  });

  it('Human Review is validated by its own dedicated 2+ port requirement (it genuinely branches)', () => {
    const wf = realWorkflow();
    // Collapse Human Review down to a single port -- this must still fail,
    // proving Human Review's branch requirement is real and independent of
    // the AI Classifier fix, not accidentally disabled alongside it.
    wf.connections['Human Review'] = { main: [[{ node: 'Airtable Hot', type: 'main', index: 0 }]] };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_CONDITION_PORTS' && e.message.includes('Human Review'))).toBe(true);
  });

  it('branch validation still rejects a malformed real IF node with only one output port', () => {
    const wf = realWorkflow();
    // Break "Needs Review?" (a real n8n-nodes-base.if) down to one port.
    wf.connections['Needs Review?'] = { main: [[{ node: 'Human Review', type: 'main', index: 0 }]] };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_CONDITION_PORTS' && e.message.includes('Needs Review?'))).toBe(true);
  });

  it('branch validation still rejects a malformed real IF node (If Hot) with only one output port', () => {
    const wf = realWorkflow();
    wf.connections['If Hot'] = { main: [[{ node: 'Airtable Hot', type: 'main', index: 0 }]] };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_CONDITION_PORTS' && e.message.includes('If Hot'))).toBe(true);
  });
});

describe('repairWorkflow -- must never inject a fake output port into AI Classifier', () => {
  it('an AI Classifier with a single output port is left untouched by the port-count repair step', () => {
    const input = {
      name: 'Test',
      nodes: [
        { name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook' },
        { name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier' },
        { name: 'Needs Review?', type: 'n8n-nodes-base.if' },
        { name: 'Human Review', type: 'magicflux-nodes.humanReview' },
      ],
      connections: {
        'Webhook Trigger': { main: [[{ node: 'AI Classifier' }]] },
        'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
        'Needs Review?': { main: [[{ node: 'Human Review' }], []] },
        'Human Review': { main: [[], [], []] },
      },
    };

    const result = repairWorkflow(input);

    expect(result.workflow.connections['AI Classifier'].main).toHaveLength(1);
    expect(result.changes.some((c) => c.description.includes('AI Classifier'))).toBe(false);
  });

  it('a genuine IF node with a missing second port is still repaired (branch-fixing is not disabled)', () => {
    const input = {
      name: 'Test',
      nodes: [
        { name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook' },
        { name: 'Some IF', type: 'n8n-nodes-base.if' },
        { name: 'Target', type: 'n8n-nodes-base.airtable' },
      ],
      connections: {
        'Webhook Trigger': { main: [[{ node: 'Some IF' }]] },
        'Some IF': { main: [[{ node: 'Target' }]] },
      },
    };

    const result = repairWorkflow(input);

    expect(result.workflow.connections['Some IF'].main).toHaveLength(2);
    expect(result.changes.some((c) => c.description.includes('Some IF'))).toBe(true);
  });
});
