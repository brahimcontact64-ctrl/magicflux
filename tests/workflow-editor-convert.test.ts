/**
 * Conversion layer tests — workflowJsonToRF ↔ rfToWorkflowJson
 *
 * All tests run in Node environment (no DOM / React Flow internals).
 * We test only the pure data-transformation logic.
 */

import { describe, it, expect } from 'vitest';
import {
  workflowJsonToRF,
  rfToWorkflowJson,
  isConditionNodeType,
  generateUniqueName,
  cloneNodes,
  cloneEdges,
} from '../lib/workflow-editor/convert';
import type { WorkflowJson } from '../lib/workflow-editor/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function linearWorkflow(): WorkflowJson {
  return {
    name: 'Test Linear',
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
      { name: 'Slack',   type: 'n8n-nodes-base.slack'   },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Slack' }]] },
    },
  };
}

function conditionWorkflow(): WorkflowJson {
  return {
    name: 'Test Condition',
    nodes: [
      { name: 'Trigger', type: 'n8n-nodes-base.webhook'  },
      { name: 'Branch',  type: 'n8n-nodes-base.if'       },
      { name: 'SlackOK', type: 'n8n-nodes-base.slack'    },
      { name: 'Email',   type: 'n8n-nodes-base.emailSend' },
    ],
    connections: {
      Trigger: { main: [[{ node: 'Branch' }]] },
      Branch:  { main: [[{ node: 'SlackOK' }], [{ node: 'Email' }]] },
    },
  };
}

function workflowWithIds(): WorkflowJson {
  return {
    name: 'With IDs',
    nodes: [
      { id: 'id-1', name: 'Start', type: 'n8n-nodes-base.webhook', position: [0, 0]   },
      { id: 'id-2', name: 'End',   type: 'n8n-nodes-base.slack',   position: [260, 0] },
    ],
    connections: {
      Start: { main: [[{ node: 'End' }]] },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// isConditionNodeType
// ═══════════════════════════════════════════════════════════════════════════

describe('isConditionNodeType', () => {
  it('returns true for IF node', () => {
    expect(isConditionNodeType('n8n-nodes-base.if')).toBe(true);
  });

  it('returns true for condition node', () => {
    expect(isConditionNodeType('n8n-nodes-base.condition')).toBe(true);
  });

  it('returns true for switch node', () => {
    expect(isConditionNodeType('n8n-nodes-base.switch')).toBe(true);
  });

  it('returns false for shopify — contains "if" but is a provider', () => {
    expect(isConditionNodeType('n8n-nodes-base.shopify')).toBe(false);
  });

  it('returns false for shopifyTrigger', () => {
    expect(isConditionNodeType('n8n-nodes-base.shopifyTrigger')).toBe(false);
  });

  it('returns false for slack', () => {
    expect(isConditionNodeType('n8n-nodes-base.slack')).toBe(false);
  });

  it('returns false for webhook', () => {
    expect(isConditionNodeType('n8n-nodes-base.webhook')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateUniqueName
// ═══════════════════════════════════════════════════════════════════════════

describe('generateUniqueName', () => {
  it('returns base name when not taken', () => {
    expect(generateUniqueName('Slack', ['Webhook'])).toBe('Slack');
  });

  it('appends 2 when base is taken', () => {
    expect(generateUniqueName('Slack', ['Slack'])).toBe('Slack 2');
  });

  it('finds first available number', () => {
    expect(generateUniqueName('Slack', ['Slack', 'Slack 2', 'Slack 3'])).toBe('Slack 4');
  });

  it('returns base when list is empty', () => {
    expect(generateUniqueName('Node', [])).toBe('Node');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflowJsonToRF — basic structure
// ═══════════════════════════════════════════════════════════════════════════

describe('workflowJsonToRF — linear workflow', () => {
  it('produces correct number of RF nodes', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    expect(rfNodes).toHaveLength(2);
  });

  it('each RF node has a non-empty string id', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    for (const n of rfNodes) {
      expect(typeof n.id).toBe('string');
      expect(n.id.length).toBeGreaterThan(0);
    }
  });

  it('RF node type is always "workflowNode"', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    for (const n of rfNodes) {
      expect(n.type).toBe('workflowNode');
    }
  });

  it('preserves node names in data', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    const names = rfNodes.map((n) => n.data.name);
    expect(names).toContain('Webhook');
    expect(names).toContain('Slack');
  });

  it('preserves node types in data.nodeType', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    const types = rfNodes.map((n) => n.data.nodeType);
    expect(types).toContain('n8n-nodes-base.webhook');
    expect(types).toContain('n8n-nodes-base.slack');
  });

  it('produces correct number of RF edges', () => {
    const { rfEdges } = workflowJsonToRF(linearWorkflow());
    expect(rfEdges).toHaveLength(1);
  });

  it('edge connects Webhook → Slack via UUIDs', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    const webhookId = rfNodes.find((n) => n.data.name === 'Webhook')!.id;
    const slackId   = rfNodes.find((n) => n.data.name === 'Slack')!.id;
    expect(rfEdges[0].source).toBe(webhookId);
    expect(rfEdges[0].target).toBe(slackId);
  });

  it('edge uses sourceHandle=port-0', () => {
    const { rfEdges } = workflowJsonToRF(linearWorkflow());
    expect(rfEdges[0].sourceHandle).toBe('port-0');
  });

  it('edge uses targetHandle=in', () => {
    const { rfEdges } = workflowJsonToRF(linearWorkflow());
    expect(rfEdges[0].targetHandle).toBe('in');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflowJsonToRF — UUID migration
// ═══════════════════════════════════════════════════════════════════════════

describe('workflowJsonToRF — UUID migration', () => {
  it('sets migrated=true when nodes lack id', () => {
    const { migrated } = workflowJsonToRF(linearWorkflow());
    expect(migrated).toBe(true);
  });

  it('sets migrated=false when all nodes have id', () => {
    const { migrated } = workflowJsonToRF(workflowWithIds());
    expect(migrated).toBe(false);
  });

  it('preserves existing node ids', () => {
    const { rfNodes } = workflowJsonToRF(workflowWithIds());
    const ids = rfNodes.map((n) => n.id);
    expect(ids).toContain('id-1');
    expect(ids).toContain('id-2');
  });

  it('auto-assigns unique UUIDs when ids missing', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    const ids = rfNodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflowJsonToRF — position handling
// ═══════════════════════════════════════════════════════════════════════════

describe('workflowJsonToRF — positions', () => {
  it('uses stored positions when all nodes have them', () => {
    const { rfNodes } = workflowJsonToRF(workflowWithIds());
    const start = rfNodes.find((n) => n.data.name === 'Start')!;
    const end   = rfNodes.find((n) => n.data.name === 'End')!;
    expect(start.position).toEqual({ x: 0,   y: 0 });
    expect(end.position).toEqual(  { x: 260, y: 0 });
  });

  it('applies auto-layout when positions are missing', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    for (const n of rfNodes) {
      expect(typeof n.position.x).toBe('number');
      expect(typeof n.position.y).toBe('number');
    }
  });

  it('auto-layout places source node before target (lower x)', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    const webhook = rfNodes.find((n) => n.data.name === 'Webhook')!;
    const slack   = rfNodes.find((n) => n.data.name === 'Slack')!;
    expect(webhook.position.x).toBeLessThan(slack.position.x);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// workflowJsonToRF — condition workflow
// ═══════════════════════════════════════════════════════════════════════════

describe('workflowJsonToRF — condition workflow', () => {
  it('produces 4 RF nodes', () => {
    const { rfNodes } = workflowJsonToRF(conditionWorkflow());
    expect(rfNodes).toHaveLength(4);
  });

  it('produces 3 edges (trigger→branch, branch→slack, branch→email)', () => {
    const { rfEdges } = workflowJsonToRF(conditionWorkflow());
    expect(rfEdges).toHaveLength(3);
  });

  it('false branch uses sourceHandle=port-1', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(conditionWorkflow());
    const branchId = rfNodes.find((n) => n.data.name === 'Branch')!.id;
    const emailId  = rfNodes.find((n) => n.data.name === 'Email')!.id;
    const falseEdge = rfEdges.find((e) => e.source === branchId && e.target === emailId);
    expect(falseEdge?.sourceHandle).toBe('port-1');
  });

  it('true branch uses sourceHandle=port-0', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(conditionWorkflow());
    const branchId = rfNodes.find((n) => n.data.name === 'Branch')!.id;
    const slackId  = rfNodes.find((n) => n.data.name === 'SlackOK')!.id;
    const trueEdge = rfEdges.find((e) => e.source === branchId && e.target === slackId);
    expect(trueEdge?.sourceHandle).toBe('port-0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// rfToWorkflowJson — basic
// ═══════════════════════════════════════════════════════════════════════════

describe('rfToWorkflowJson', () => {
  it('produces correct node names', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'Test');
    const names = wf.nodes.map((n) => n.name);
    expect(names).toContain('Webhook');
    expect(names).toContain('Slack');
  });

  it('produces correct node types', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'Test');
    const types = wf.nodes.map((n) => n.type);
    expect(types).toContain('n8n-nodes-base.webhook');
    expect(types).toContain('n8n-nodes-base.slack');
  });

  it('uses name-based connections', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'Test');
    expect(wf.connections['Webhook']).toBeDefined();
    expect(wf.connections['Webhook'].main[0][0].node).toBe('Slack');
  });

  it('preserves workflow name', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'My Workflow');
    expect(wf.name).toBe('My Workflow');
  });

  it('stores positions in nodes', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(workflowWithIds());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'Test');
    for (const n of wf.nodes) {
      expect(Array.isArray(n.position)).toBe(true);
      expect(n.position).toHaveLength(2);
    }
  });

  it('preserves node ids for stable round-trips', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(workflowWithIds());
    const wf = rfToWorkflowJson(rfNodes, rfEdges, 'Test');
    const ids = wf.nodes.map((n) => n.id);
    expect(ids).toContain('id-1');
    expect(ids).toContain('id-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-trip fidelity
// ═══════════════════════════════════════════════════════════════════════════

describe('Round-trip: workflowJson → RF → workflowJson', () => {
  function roundTrip(wf: WorkflowJson): WorkflowJson {
    const { rfNodes, rfEdges } = workflowJsonToRF(wf);
    return rfToWorkflowJson(rfNodes, rfEdges, wf.name);
  }

  it('preserves node count — linear', () => {
    const wf = linearWorkflow();
    expect(roundTrip(wf).nodes).toHaveLength(wf.nodes.length);
  });

  it('preserves node count — condition', () => {
    const wf = conditionWorkflow();
    expect(roundTrip(wf).nodes).toHaveLength(wf.nodes.length);
  });

  it('preserves connection sources — linear', () => {
    const wf = linearWorkflow();
    const rt = roundTrip(wf);
    expect(Object.keys(rt.connections)).toContain('Webhook');
  });

  it('preserves connection targets — linear', () => {
    const wf = linearWorkflow();
    const rt = roundTrip(wf);
    expect(rt.connections['Webhook'].main[0][0].node).toBe('Slack');
  });

  it('preserves connection sources — condition', () => {
    const wf = conditionWorkflow();
    const rt = roundTrip(wf);
    expect(Object.keys(rt.connections)).toContain('Branch');
  });

  it('condition false branch preserved after round-trip', () => {
    const wf = conditionWorkflow();
    const rt = roundTrip(wf);
    const branch = rt.connections['Branch'];
    expect(branch.main[1][0].node).toBe('Email');
  });

  it('condition true branch preserved after round-trip', () => {
    const wf = conditionWorkflow();
    const rt = roundTrip(wf);
    const branch = rt.connections['Branch'];
    expect(branch.main[0][0].node).toBe('SlackOK');
  });

  it('rename does not break edges', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(linearWorkflow());
    // Simulate renaming "Slack" to "Slack Alerts"
    const renamed = rfNodes.map((n) =>
      n.data.name === 'Slack'
        ? { ...n, data: { ...n.data, name: 'Slack Alerts' } }
        : n,
    );
    const wf = rfToWorkflowJson(renamed, rfEdges, 'Test');
    // Edge should now reference the new name
    expect(wf.connections['Webhook'].main[0][0].node).toBe('Slack Alerts');
  });

  it('workflow name passes through unchanged', () => {
    const wf = linearWorkflow();
    expect(roundTrip(wf).name).toBe('Test Linear');
  });

  it('nodes include stable ids after round-trip', () => {
    const wf = workflowWithIds();
    const rt = roundTrip(wf);
    const ids = rt.nodes.map((n) => n.id);
    expect(ids).toContain('id-1');
    expect(ids).toContain('id-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Clone helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('cloneNodes / cloneEdges', () => {
  it('cloneNodes produces independent objects', () => {
    const { rfNodes } = workflowJsonToRF(linearWorkflow());
    const cloned = cloneNodes(rfNodes);
    cloned[0].data.name = 'MUTATED';
    expect(rfNodes[0].data.name).not.toBe('MUTATED');
  });

  it('cloneEdges produces independent objects', () => {
    const { rfEdges } = workflowJsonToRF(linearWorkflow());
    const cloned = cloneEdges(rfEdges);
    cloned[0].id = 'mutated-id';
    expect(rfEdges[0].id).not.toBe('mutated-id');
  });

  it('cloneNodes preserves length', () => {
    const { rfNodes } = workflowJsonToRF(conditionWorkflow());
    expect(cloneNodes(rfNodes)).toHaveLength(rfNodes.length);
  });

  it('cloneEdges preserves length', () => {
    const { rfEdges } = workflowJsonToRF(conditionWorkflow());
    expect(cloneEdges(rfEdges)).toHaveLength(rfEdges.length);
  });
});
