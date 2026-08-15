/**
 * Node configuration save/load pipeline tests.
 *
 * Verifies that node parameters survive the full cycle:
 *   set config → rfToWorkflowJson → workflowJsonToRF → verify config
 *
 * Also verifies field validation at the config layer.
 */

import { describe, it, expect } from 'vitest';
import { workflowJsonToRF, rfToWorkflowJson } from '../lib/workflow-editor/convert';
import { validateNodeConfig, getNodeDef } from '../lib/node-registry';
import type { WorkflowJson } from '../lib/workflow-editor/types';
import type { Node } from '@xyflow/react';
import type { WorkflowNodeData } from '../lib/workflow-editor/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKFLOW_WITH_CONFIG: WorkflowJson = {
  name: 'Config Test',
  nodes: [
    {
      name: 'My Webhook',
      type: 'n8n-nodes-base.webhook',
      parameters: {
        path: '/orders',
        httpMethod: 'POST',
        responseMode: 'onLastNode',
      },
    },
    {
      name: 'Send Slack',
      type: 'n8n-nodes-base.slack',
      parameters: {
        channel: '#ops',
        message: 'New order received!',
        username: 'OrderBot',
      },
    },
  ],
  connections: {
    'My Webhook': { main: [[{ node: 'Send Slack' }]] },
  },
};

// ─── Round-trip helper ────────────────────────────────────────────────────────

function roundTrip(wf: WorkflowJson): WorkflowJson {
  const { rfNodes, rfEdges } = workflowJsonToRF(wf);
  return rfToWorkflowJson(rfNodes, rfEdges, wf.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// Config persistence through round-trip
// ═══════════════════════════════════════════════════════════════════════════

describe('Config save/load — round-trip fidelity', () => {
  it('webhook path is preserved', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    const webhook = rt.nodes.find((n) => n.name === 'My Webhook')!;
    expect(webhook.parameters?.path).toBe('/orders');
  });

  it('webhook httpMethod is preserved', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    const webhook = rt.nodes.find((n) => n.name === 'My Webhook')!;
    expect(webhook.parameters?.httpMethod).toBe('POST');
  });

  it('slack channel is preserved', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    const slack = rt.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.channel).toBe('#ops');
  });

  it('slack message is preserved', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    const slack = rt.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.message).toBe('New order received!');
  });

  it('slack optional username is preserved', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    const slack = rt.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.username).toBe('OrderBot');
  });

  it('all parameter keys survive 3 consecutive round-trips', () => {
    const rt1 = roundTrip(WORKFLOW_WITH_CONFIG);
    const rt2 = roundTrip(rt1);
    const rt3 = roundTrip(rt2);
    const slack = rt3.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.channel).toBe('#ops');
    expect(slack.parameters?.message).toBe('New order received!');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Config stored in RF node data.parameters
// ═══════════════════════════════════════════════════════════════════════════

describe('Config save/load — RF node data', () => {
  it('parameters are in data.parameters after workflowJsonToRF', () => {
    const { rfNodes } = workflowJsonToRF(WORKFLOW_WITH_CONFIG);
    const slackNode = rfNodes.find((n) => n.data.name === 'Send Slack')!;
    expect(slackNode.data.parameters.channel).toBe('#ops');
  });

  it('simulated parameter update persists into rfToWorkflowJson', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(WORKFLOW_WITH_CONFIG);
    // Simulate settings panel update
    const updated: Node<WorkflowNodeData>[] = rfNodes.map((n) =>
      n.data.name === 'Send Slack'
        ? { ...n, data: { ...n.data, parameters: { ...n.data.parameters, message: 'Updated message' } } }
        : n,
    );
    const wf = rfToWorkflowJson(updated, rfEdges, WORKFLOW_WITH_CONFIG.name);
    const slack = wf.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.message).toBe('Updated message');
  });

  it('old parameter values are replaced by update', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(WORKFLOW_WITH_CONFIG);
    const updated: Node<WorkflowNodeData>[] = rfNodes.map((n) =>
      n.data.name === 'Send Slack'
        ? { ...n, data: { ...n.data, parameters: { channel: '#new-channel', message: 'New msg' } } }
        : n,
    );
    const wf = rfToWorkflowJson(updated, rfEdges, WORKFLOW_WITH_CONFIG.name);
    const slack = wf.nodes.find((n) => n.name === 'Send Slack')!;
    expect(slack.parameters?.channel).toBe('#new-channel');
    expect(slack.parameters?.username).toBeUndefined(); // explicitly removed
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Field validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Node config validation', () => {
  it('empty parameters fails required fields', () => {
    const def = getNodeDef('n8n-nodes-base.slack')!;
    const errors = validateNodeConfig({}, def.fields);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('all required fields filled passes validation', () => {
    const def = getNodeDef('n8n-nodes-base.slack')!;
    const errors = validateNodeConfig({ channel: '#general', message: 'Hello!' }, def.fields);
    expect(errors).toHaveLength(0);
  });

  it('whitespace-only value fails required validation', () => {
    const def = getNodeDef('n8n-nodes-base.slack')!;
    const errors = validateNodeConfig({ channel: '   ', message: 'Hello' }, def.fields);
    expect(errors.some((e) => e.key === 'channel')).toBe(true);
  });

  it('number zero passes required validation (falsy but valid)', () => {
    const def = getNodeDef('n8n-nodes-base.wait')!;
    // amount=0 is technically an edge case; our validator checks for empty string
    const errors = validateNodeConfig({ amount: 0, unit: 'minutes' }, def.fields);
    // 0 is not an empty string, so it should NOT fail the required check
    expect(errors.some((e) => e.key === 'amount')).toBe(false);
  });

  it('airtable: both baseId and tableId required', () => {
    const def = getNodeDef('n8n-nodes-base.airtable')!;
    const errorsNoBase = validateNodeConfig({ tableId: 'tbl', operation: 'list' }, def.fields);
    const errorsNoTable = validateNodeConfig({ baseId: 'app', operation: 'list' }, def.fields);
    expect(errorsNoBase.some((e) => e.key === 'baseId')).toBe(true);
    expect(errorsNoTable.some((e) => e.key === 'tableId')).toBe(true);
  });

  it('openai: all required filled passes', () => {
    const def = getNodeDef('n8n-nodes-base.openAi')!;
    const errors = validateNodeConfig(
      { model: 'gpt-4o-mini', prompt: 'Summarise this.' },
      def.fields,
    );
    expect(errors).toHaveLength(0);
  });

  it('http: url required but method is also required', () => {
    const def = getNodeDef('n8n-nodes-base.httpRequest')!;
    const errorsNoUrl = validateNodeConfig({ method: 'GET' }, def.fields);
    expect(errorsNoUrl.some((e) => e.key === 'url')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multiple node types config persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('Config save/load — multiple node types', () => {
  const MULTI_WF: WorkflowJson = {
    name: 'Multi Config',
    nodes: [
      { name: 'Trigger',   type: 'n8n-nodes-base.webhook',     parameters: { path: '/go', httpMethod: 'GET' } },
      { name: 'OpenAI',    type: 'n8n-nodes-base.openAi',      parameters: { model: 'gpt-4o', prompt: 'Hello', temperature: 0.5 } },
      { name: 'Condition', type: 'n8n-nodes-base.if',          parameters: { field: 'status', operation: 'equals', value: 'ok' } },
      { name: 'HTTP',      type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com', method: 'POST' } },
      { name: 'Wait',      type: 'n8n-nodes-base.wait',        parameters: { amount: 10, unit: 'seconds' } },
    ],
    connections: {
      Trigger:   { main: [[{ node: 'OpenAI' }]] },
      OpenAI:    { main: [[{ node: 'Condition' }]] },
      Condition: { main: [[{ node: 'HTTP' }], [{ node: 'Wait' }]] },
    },
  };

  it('all 5 node configs survive round-trip', () => {
    const rt = roundTrip(MULTI_WF);
    expect(rt.nodes.find((n) => n.name === 'Trigger')?.parameters?.path).toBe('/go');
    expect(rt.nodes.find((n) => n.name === 'OpenAI')?.parameters?.model).toBe('gpt-4o');
    expect(rt.nodes.find((n) => n.name === 'Condition')?.parameters?.operation).toBe('equals');
    expect(rt.nodes.find((n) => n.name === 'HTTP')?.parameters?.url).toBe('https://example.com');
    expect(rt.nodes.find((n) => n.name === 'Wait')?.parameters?.amount).toBe(10);
  });

  it('numeric parameter preserved as number', () => {
    const rt = roundTrip(MULTI_WF);
    const openAi = rt.nodes.find((n) => n.name === 'OpenAI')!;
    expect(typeof openAi.parameters?.temperature).toBe('number');
    expect(openAi.parameters?.temperature).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security: no credentials in saved parameters
// ═══════════════════════════════════════════════════════════════════════════

describe('Config security — no credentials leaked', () => {
  it('parameters do not contain api_key after round-trip', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    expect(JSON.stringify(rt.nodes)).not.toContain('"api_key"');
  });

  it('parameters do not contain password after round-trip', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    expect(JSON.stringify(rt.nodes)).not.toContain('"password"');
  });

  it('parameters do not contain secret after round-trip', () => {
    const rt = roundTrip(WORKFLOW_WITH_CONFIG);
    expect(JSON.stringify(rt.nodes)).not.toContain('"secret"');
  });
});
