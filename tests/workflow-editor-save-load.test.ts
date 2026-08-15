/**
 * Visual builder save/load pipeline tests.
 *
 * Tests the complete data flow:
 *   generated workflow → visual editor conversion → save → load → validate
 *
 * All tests use pure data transformations (no DOM, no React Flow rendering).
 */

import { describe, it, expect } from 'vitest';
import { workflowJsonToRF, rfToWorkflowJson } from '../lib/workflow-editor/convert';
import { validateWorkflow } from '../lib/workflow-validator';
import type { WorkflowJson } from '../lib/workflow-editor/types';

// ─── Sample workflows ─────────────────────────────────────────────────────────

const SIMPLE_WORKFLOW: WorkflowJson = {
  name: 'Shopify to Slack',
  nodes: [
    { name: 'Shopify Trigger', type: 'n8n-nodes-base.shopifyTrigger', parameters: {} },
    { name: 'Slack',           type: 'n8n-nodes-base.slack',          parameters: {} },
  ],
  connections: {
    'Shopify Trigger': { main: [[{ node: 'Slack' }]] },
  },
};

const CONDITION_WORKFLOW: WorkflowJson = {
  name: 'VIP Router',
  nodes: [
    { name: 'Webhook',    type: 'n8n-nodes-base.webhook',   parameters: {} },
    { name: 'VIP Check',  type: 'n8n-nodes-base.if',        parameters: {} },
    { name: 'VIP Slack',  type: 'n8n-nodes-base.slack',     parameters: {} },
    { name: 'Bulk Email', type: 'n8n-nodes-base.emailSend', parameters: {} },
  ],
  connections: {
    Webhook:   { main: [[{ node: 'VIP Check' }]] },
    'VIP Check': { main: [[{ node: 'VIP Slack' }], [{ node: 'Bulk Email' }]] },
  },
};

const FANOUT_WORKFLOW: WorkflowJson = {
  name: 'Fan-out',
  nodes: [
    { name: 'Trigger',  type: 'n8n-nodes-base.webhook',   parameters: {} },
    { name: 'Slack',    type: 'n8n-nodes-base.slack',     parameters: {} },
    { name: 'Airtable', type: 'n8n-nodes-base.airtable',  parameters: {} },
    { name: 'Email',    type: 'n8n-nodes-base.emailSend', parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'Slack' }, { node: 'Airtable' }, { node: 'Email' }]] },
  },
};

const WAIT_WORKFLOW: WorkflowJson = {
  name: 'Wait and notify',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook',   parameters: {} },
    { name: 'Wait',    type: 'n8n-nodes-base.wait',      parameters: {} },
    { name: 'Email',   type: 'n8n-nodes-base.emailSend', parameters: {} },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Wait' }]] },
    Wait:    { main: [[{ node: 'Email' }]] },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function saveLoad(initial: WorkflowJson): WorkflowJson {
  const { rfNodes, rfEdges } = workflowJsonToRF(initial);
  return rfToWorkflowJson(rfNodes, rfEdges, initial.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// Save / load fidelity
// ═══════════════════════════════════════════════════════════════════════════

describe('Save/load — simple workflow', () => {
  it('node count preserved', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(rt.nodes).toHaveLength(2);
  });

  it('node names preserved', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(rt.nodes.map((n) => n.name)).toContain('Shopify Trigger');
    expect(rt.nodes.map((n) => n.name)).toContain('Slack');
  });

  it('node types preserved', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(rt.nodes.map((n) => n.type)).toContain('n8n-nodes-base.shopifyTrigger');
  });

  it('connections preserved', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(rt.connections['Shopify Trigger'].main[0][0].node).toBe('Slack');
  });

  it('saved workflow is valid', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(validateWorkflow(rt as unknown).valid).toBe(true);
  });

  it('nodes include position after save/load', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    for (const n of rt.nodes) {
      expect(Array.isArray(n.position)).toBe(true);
    }
  });

  it('nodes include stable id after save/load', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    for (const n of rt.nodes) {
      expect(typeof n.id).toBe('string');
      expect(n.id!.length).toBeGreaterThan(0);
    }
  });
});

describe('Save/load — condition workflow', () => {
  it('all 4 nodes preserved', () => {
    expect(saveLoad(CONDITION_WORKFLOW).nodes).toHaveLength(4);
  });

  it('condition workflow is valid after save/load', () => {
    const rt = saveLoad(CONDITION_WORKFLOW);
    expect(validateWorkflow(rt as unknown).valid).toBe(true);
  });

  it('true branch preserved', () => {
    const rt = saveLoad(CONDITION_WORKFLOW);
    expect(rt.connections['VIP Check'].main[0][0].node).toBe('VIP Slack');
  });

  it('false branch preserved', () => {
    const rt = saveLoad(CONDITION_WORKFLOW);
    expect(rt.connections['VIP Check'].main[1][0].node).toBe('Bulk Email');
  });
});

describe('Save/load — fan-out workflow', () => {
  it('all 4 nodes preserved', () => {
    expect(saveLoad(FANOUT_WORKFLOW).nodes).toHaveLength(4);
  });

  it('fan-out workflow is valid after save/load', () => {
    const rt = saveLoad(FANOUT_WORKFLOW);
    expect(validateWorkflow(rt as unknown).valid).toBe(true);
  });

  it('all fan-out targets preserved', () => {
    const rt = saveLoad(FANOUT_WORKFLOW);
    const targets = rt.connections['Trigger'].main[0].map((e) => e.node);
    expect(targets).toContain('Slack');
    expect(targets).toContain('Airtable');
    expect(targets).toContain('Email');
  });
});

describe('Save/load — wait workflow', () => {
  it('wait workflow is valid after save/load', () => {
    const rt = saveLoad(WAIT_WORKFLOW);
    expect(validateWorkflow(rt as unknown).valid).toBe(true);
  });

  it('chained connections preserved', () => {
    const rt = saveLoad(WAIT_WORKFLOW);
    expect(rt.connections['Webhook'].main[0][0].node).toBe('Wait');
    expect(rt.connections['Wait'].main[0][0].node).toBe('Email');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stable round-trips (IDs persist across multiple saves)
// ═══════════════════════════════════════════════════════════════════════════

describe('Stable IDs across multiple save/load cycles', () => {
  it('IDs are stable across two cycles', () => {
    const rt1 = saveLoad(SIMPLE_WORKFLOW);
    const rt2 = saveLoad(rt1);
    const ids1 = rt1.nodes.map((n) => n.id!).sort();
    const ids2 = rt2.nodes.map((n) => n.id!).sort();
    expect(ids1).toEqual(ids2);
  });

  it('IDs are stable across three cycles', () => {
    const rt1 = saveLoad(SIMPLE_WORKFLOW);
    const rt2 = saveLoad(rt1);
    const rt3 = saveLoad(rt2);
    const ids1 = rt1.nodes.map((n) => n.id!).sort();
    const ids3 = rt3.nodes.map((n) => n.id!).sort();
    expect(ids1).toEqual(ids3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Node rename during visual edit
// ═══════════════════════════════════════════════════════════════════════════

describe('Node rename — edge integrity', () => {
  it('renaming a node updates connection source key', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    // Simulate rename: "Shopify Trigger" → "Order Received"
    const renamed = rfNodes.map((n) =>
      n.data.name === 'Shopify Trigger'
        ? { ...n, data: { ...n.data, name: 'Order Received' } }
        : n,
    );
    const wf = rfToWorkflowJson(renamed, rfEdges, SIMPLE_WORKFLOW.name);
    expect(wf.connections['Order Received']).toBeDefined();
    expect(wf.connections['Shopify Trigger']).toBeUndefined();
  });

  it('renaming target node updates connection target reference', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const renamed = rfNodes.map((n) =>
      n.data.name === 'Slack'
        ? { ...n, data: { ...n.data, name: 'Alert Channel' } }
        : n,
    );
    const wf = rfToWorkflowJson(renamed, rfEdges, SIMPLE_WORKFLOW.name);
    expect(wf.connections['Shopify Trigger'].main[0][0].node).toBe('Alert Channel');
  });

  it('renamed workflow is still valid', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const renamed = rfNodes.map((n) =>
      n.data.name === 'Slack'
        ? { ...n, data: { ...n.data, name: 'Alert Channel' } }
        : n,
    );
    const wf = rfToWorkflowJson(renamed, rfEdges, SIMPLE_WORKFLOW.name);
    expect(validateWorkflow(wf as unknown).valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Node addition during visual edit
// ═══════════════════════════════════════════════════════════════════════════

describe('Node addition — integrity', () => {
  it('adding a node increases node count', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const newNode = {
      id: 'new-node-uuid',
      type: 'workflowNode' as const,
      position: { x: 520, y: 0 },
      data: { name: 'Airtable', nodeType: 'n8n-nodes-base.airtable', parameters: {} },
    };
    const wf = rfToWorkflowJson([...rfNodes, newNode], rfEdges, SIMPLE_WORKFLOW.name);
    expect(wf.nodes).toHaveLength(3);
  });

  it('isolated new node produces no connection entry', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const newNode = {
      id: 'isolated-uuid',
      type: 'workflowNode' as const,
      position: { x: 0, y: 200 },
      data: { name: 'Orphan', nodeType: 'n8n-nodes-base.wait', parameters: {} },
    };
    const wf = rfToWorkflowJson([...rfNodes, newNode], rfEdges, SIMPLE_WORKFLOW.name);
    expect(wf.connections['Orphan']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Node deletion during visual edit
// ═══════════════════════════════════════════════════════════════════════════

describe('Node deletion — integrity', () => {
  it('deleting a node removes it from output', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const slackId = rfNodes.find((n) => n.data.name === 'Slack')!.id;
    const filtered = rfNodes.filter((n) => n.id !== slackId);
    const filteredEdges = rfEdges.filter((e) => e.source !== slackId && e.target !== slackId);
    const wf = rfToWorkflowJson(filtered, filteredEdges, SIMPLE_WORKFLOW.name);
    expect(wf.nodes.map((n) => n.name)).not.toContain('Slack');
  });

  it('deleting source node removes dangling connection', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(SIMPLE_WORKFLOW);
    const webhookId = rfNodes.find((n) => n.data.name === 'Shopify Trigger')!.id;
    const filtered = rfNodes.filter((n) => n.id !== webhookId);
    const filteredEdges = rfEdges.filter((e) => e.source !== webhookId && e.target !== webhookId);
    const wf = rfToWorkflowJson(filtered, filteredEdges, SIMPLE_WORKFLOW.name);
    expect(wf.connections['Shopify Trigger']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security: no credentials in generated workflow_json
// ═══════════════════════════════════════════════════════════════════════════

describe('Security — no credentials after save/load', () => {
  it('saved workflow nodes contain no api_key', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(JSON.stringify(rt.nodes)).not.toContain('"api_key"');
  });

  it('saved workflow nodes contain no password', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(JSON.stringify(rt.nodes)).not.toContain('"password"');
  });

  it('saved workflow nodes contain no accessToken', () => {
    const rt = saveLoad(SIMPLE_WORKFLOW);
    expect(JSON.stringify(rt.nodes)).not.toContain('"accessToken"');
  });
});
