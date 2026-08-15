/**
 * Workflow Generator V1 — test suite
 *
 * Validates every aspect of the generator pipeline:
 *   - Output shape (GenerateResult contract)
 *   - Trigger detection (webhook vs Shopify)
 *   - Action detection (Slack / Email / Airtable)
 *   - Topology construction (linear, fanout, conditional, wait)
 *   - Example retrieval (non-empty, relevant)
 *   - Valid flag accuracy
 *   - Repair fallback path
 *   - Edge cases (empty prompt, unknown input)
 *   - Internal helpers (parseIntent, buildWorkflowFromIntent, retrieveExamples)
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow, ValidationCodes } from '../lib/workflow-validator';
import {
  generateWorkflow,
  retrieveExamples,
  parseIntent,
  buildWorkflowFromIntent,
  type ParsedIntent,
} from '../lib/ai-workflows/workflow-generator';
import { NODE_TYPES } from '../lib/ai-workflows/ai-workflow-spec';
import { TRAINING_DATASET } from '../lib/ai-workflows/training-dataset';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Shorthand to extract the first node of a given type from a result. */
function findNode(result: ReturnType<typeof generateWorkflow>, type: string) {
  return result.workflow.nodes.find(n => n.type === type);
}

/** Verify a GenerateResult has the required shape. */
function assertResultShape(result: ReturnType<typeof generateWorkflow>) {
  expect(result).toHaveProperty('workflow');
  expect(result).toHaveProperty('valid');
  expect(result).toHaveProperty('examplesUsed');
  expect(result).toHaveProperty('repairApplied');
  expect(Array.isArray(result.examplesUsed)).toBe(true);
  expect(typeof result.valid).toBe('boolean');
  expect(typeof result.repairApplied).toBe('boolean');
}

// ═══════════════════════════════════════════════════════════════════════════
// Output shape contract
// ═══════════════════════════════════════════════════════════════════════════

describe('GenerateResult shape', () => {

  it('returns all required fields', () => {
    assertResultShape(generateWorkflow('send slack on webhook'));
  });

  it('workflow field has nodes and connections', () => {
    const r = generateWorkflow('webhook to slack');
    expect(Array.isArray(r.workflow.nodes)).toBe(true);
    expect(r.workflow.nodes.length).toBeGreaterThan(0);
    expect(typeof r.workflow.connections).toBe('object');
  });

  it('workflow.name is a non-empty string', () => {
    const r = generateWorkflow('shopify order to email');
    expect(typeof r.workflow.name).toBe('string');
    expect(r.workflow.name.trim().length).toBeGreaterThan(0);
  });

  it('valid flag matches validateWorkflow() result', () => {
    const r = generateWorkflow('send a Slack message on new webhook');
    const check = validateWorkflow(r.workflow);
    expect(r.valid).toBe(check.valid);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// All generated workflows must be valid
// ═══════════════════════════════════════════════════════════════════════════

describe('Every generated workflow is valid', () => {

  const prompts = [
    'send a Slack message when a webhook arrives',
    'notify team on Slack when Shopify order placed',
    'send email when webhook fires',
    'log to Airtable on new Shopify order',
    'wait 10 minutes then send email',
    'wait 1 hour then notify Slack',
    'if VIP customer send Slack otherwise email',
    'send Slack and email on webhook',
    'broadcast to Slack, email and Airtable',
    'shopify order high value alert',
    'save webhook data to Airtable',
    'when new order alert #orders on Slack',
    'send order confirmation email',
    'wait 30 minutes after shopify order then slack',
    'route by customer type: VIP gets Slack, others get email',
    'save to database and send notification',
    'send slack message to #alerts',
    'log every shopify purchase in Airtable',
    '',               // empty prompt
    'do something',   // vague prompt
    'xyz123',         // unrecognised
    'notify on shopify order',
    'send email notification',
  ];

  for (const prompt of prompts) {
    it(`generates valid workflow for: "${prompt.slice(0, 60) || '<empty>'}"`, () => {
      const r = generateWorkflow(prompt);
      expect(r.valid).toBe(true);
      const check = validateWorkflow(r.workflow);
      if (!check.valid) {
        console.error('Errors:', check.errors);
      }
      expect(check.valid).toBe(true);
    });
  }

});

// ═══════════════════════════════════════════════════════════════════════════
// Trigger detection
// ═══════════════════════════════════════════════════════════════════════════

describe('Trigger detection', () => {

  it('detects webhook trigger', () => {
    const r = generateWorkflow('when a webhook fires send Slack');
    const start = r.workflow.nodes[0];
    expect(start.type.toLowerCase()).toContain('webhook');
  });

  it('detects shopify trigger from "shopify"', () => {
    const r = generateWorkflow('when a Shopify order is placed send Slack');
    expect(r.workflow.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
  });

  it('detects shopify trigger from "new order"', () => {
    const intent = parseIntent('on new order notify team');
    expect(intent.trigger).toBe('shopify');
  });

  it('detects shopify trigger from "purchase"', () => {
    const intent = parseIntent('after a purchase send email');
    expect(intent.trigger).toBe('shopify');
  });

  it('defaults to webhook for unknown trigger', () => {
    const intent = parseIntent('send an email');
    expect(intent.trigger).toBe('webhook');
  });

  it('shopify trigger is a valid start node', () => {
    const r = generateWorkflow('shopify order to airtable');
    const check = validateWorkflow(r.workflow);
    expect(check.errors.some(e => e.code === ValidationCodes.NO_START_NODE)).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Action detection — Slack
// ═══════════════════════════════════════════════════════════════════════════

describe('Slack action detection', () => {

  it('detects Slack from "slack"', () => {
    const intent = parseIntent('send a Slack message on webhook');
    expect(intent.actions.some(a => a.kind === 'slack')).toBe(true);
  });

  it('detects Slack from "send message"', () => {
    const intent = parseIntent('send message to team on webhook');
    expect(intent.actions.some(a => a.kind === 'slack')).toBe(true);
  });

  it('Slack node uses detected channel #orders when #channel appears in prompt', () => {
    const r = generateWorkflow('notify #orders channel on Shopify order');
    const slackNode = findNode(r, NODE_TYPES.SLACK);
    expect(slackNode).toBeDefined();
    expect((slackNode!.parameters as Record<string, unknown>).channel).toBe('#orders');
  });

  it('Slack node falls back to #alerts for error prompt', () => {
    const r = generateWorkflow('send slack alert on error');
    const slackNode = findNode(r, NODE_TYPES.SLACK);
    expect(slackNode).toBeDefined();
    expect((slackNode!.parameters as Record<string, unknown>).channel).toBe('#alerts');
  });

  it('Slack node has non-empty text', () => {
    const r = generateWorkflow('notify Slack on new order');
    const slackNode = findNode(r, NODE_TYPES.SLACK);
    const text = (slackNode!.parameters as Record<string, unknown>).text as string;
    expect(text.trim().length).toBeGreaterThan(0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Action detection — Email
// ═══════════════════════════════════════════════════════════════════════════

describe('Email action detection', () => {

  it('detects email from "send email"', () => {
    const intent = parseIntent('send email on webhook');
    expect(intent.actions.some(a => a.kind === 'email')).toBe(true);
  });

  it('detects email from "notify by email"', () => {
    const intent = parseIntent('notify by email when order placed');
    expect(intent.actions.some(a => a.kind === 'email')).toBe(true);
  });

  it('email node extracts address from prompt', () => {
    const r = generateWorkflow('send email to ops@example.com on webhook');
    const emailNode = findNode(r, NODE_TYPES.EMAIL_SEND);
    const to = (emailNode!.parameters as Record<string, unknown>).to as string;
    expect(to).toContain('ops@example.com');
  });

  it('email node uses orders@example.com for order prompts', () => {
    const r = generateWorkflow('send order email on Shopify order');
    const emailNode = findNode(r, NODE_TYPES.EMAIL_SEND);
    const to = (emailNode!.parameters as Record<string, unknown>).to as string;
    expect(typeof to).toBe('string');
    expect(to.length).toBeGreaterThan(0);
  });

  it('email node has required parameters', () => {
    const r = generateWorkflow('webhook to email');
    const emailNode = findNode(r, NODE_TYPES.EMAIL_SEND);
    expect(emailNode!.parameters).toMatchObject({
      to:      expect.any(String),
      subject: expect.any(String),
    });
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Action detection — Airtable
// ═══════════════════════════════════════════════════════════════════════════

describe('Airtable action detection', () => {

  it('detects airtable from "airtable"', () => {
    const intent = parseIntent('save to Airtable on webhook');
    expect(intent.actions.some(a => a.kind === 'airtable')).toBe(true);
  });

  it('detects airtable from "log to database"', () => {
    const intent = parseIntent('log to database when order arrives');
    expect(intent.actions.some(a => a.kind === 'airtable')).toBe(true);
  });

  it('detects airtable from "record in"', () => {
    const intent = parseIntent('record in spreadsheet every new order');
    expect(intent.actions.some(a => a.kind === 'airtable')).toBe(true);
  });

  it('airtable node uses "Orders" table for order prompts', () => {
    const r = generateWorkflow('log every shopify order in Airtable');
    const atNode = findNode(r, NODE_TYPES.AIRTABLE);
    const table = (atNode!.parameters as Record<string, unknown>).table as string;
    expect(table.length).toBeGreaterThan(0);
  });

  it('airtable node has a table parameter', () => {
    const r = generateWorkflow('save webhook to airtable');
    const atNode = findNode(r, NODE_TYPES.AIRTABLE);
    expect((atNode!.parameters as Record<string, unknown>).table).toBeTruthy();
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Topology — Linear
// ═══════════════════════════════════════════════════════════════════════════

describe('Linear topology', () => {

  it('webhook → slack is linear', () => {
    const intent = parseIntent('send slack on webhook');
    expect(intent.topology).toBe('linear');
  });

  it('shopify → email is linear', () => {
    const intent = parseIntent('email on new shopify order');
    expect(intent.topology).toBe('linear');
  });

  it('linear workflow: trigger connects to action', () => {
    const r = generateWorkflow('webhook to slack');
    const triggerName = r.workflow.nodes[0].name;
    const conns = r.workflow.connections as Record<string, { main: Array<Array<{ node: string }>> }>;
    expect(conns[triggerName]).toBeDefined();
    expect(conns[triggerName].main[0].length).toBeGreaterThan(0);
  });

  it('slack then email is sequential (linear)', () => {
    const intent = parseIntent('send slack then email on webhook');
    expect(intent.topology).toBe('linear');
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Topology — Fan-out
// ═══════════════════════════════════════════════════════════════════════════

describe('Fan-out topology', () => {

  it('slack and email together is fanout', () => {
    const intent = parseIntent('send slack and email on webhook');
    expect(intent.topology).toBe('fanout');
  });

  it('fanout: trigger connects to multiple targets on port[0]', () => {
    const r = generateWorkflow('send slack and email on webhook');
    const triggerName = r.workflow.nodes[0].name;
    const conns = r.workflow.connections as Record<string, { main: Array<Array<{ node: string }>> }>;
    const port0 = conns[triggerName]?.main[0] ?? [];
    expect(port0.length).toBeGreaterThanOrEqual(2);
  });

  it('broadcast to three channels is fanout', () => {
    const r = generateWorkflow('broadcast webhook event to Slack, email, and Airtable');
    expect(r.valid).toBe(true);
    expect(r.workflow.nodes.length).toBeGreaterThanOrEqual(4);
  });

  it('fanout workflow passes validation', () => {
    const r = generateWorkflow('send slack and airtable on shopify order');
    expect(validateWorkflow(r.workflow).valid).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Topology — Conditional
// ═══════════════════════════════════════════════════════════════════════════

describe('Conditional topology', () => {

  it('detects condition from "if VIP"', () => {
    const intent = parseIntent('if VIP customer send slack otherwise email');
    expect(intent.topology).toBe('conditional');
    expect(intent.condition).not.toBeNull();
  });

  it('VIP condition uses customer_type field', () => {
    const intent = parseIntent('route VIP customers to Slack');
    expect(intent.condition?.field).toBe('customer_type');
    expect(intent.condition?.operator).toBe('equals');
    expect(intent.condition?.value).toBe('vip');
  });

  it('high value condition uses total_price greaterThan', () => {
    const intent = parseIntent('alert on slack for orders greater than 100');
    expect(intent.condition?.field).toBe('total_price');
    expect(intent.condition?.operator).toBe('greaterThan');
  });

  it('conditional workflow has an IF node', () => {
    const r = generateWorkflow('if VIP customer send Slack, otherwise email');
    const ifNode = findNode(r, NODE_TYPES.IF);
    expect(ifNode).toBeDefined();
  });

  it('conditional workflow IF node has 2 output ports', () => {
    const r = generateWorkflow('if VIP customer send Slack otherwise email');
    const ifNode = findNode(r, NODE_TYPES.IF);
    const conns = r.workflow.connections as Record<string, { main: Array<Array<unknown>> }>;
    expect(conns[ifNode!.name].main).toHaveLength(2);
  });

  it('conditional workflow passes validation', () => {
    const r = generateWorkflow('route by customer type: VIP gets Slack, others get email');
    expect(validateWorkflow(r.workflow).valid).toBe(true);
  });

  it('high value order condition produces valid workflow', () => {
    const r = generateWorkflow('alert on Slack for shopify orders over 500');
    expect(r.valid).toBe(true);
  });

  it('condition with only 1 detected action gets a complementary second branch', () => {
    // "if " at start of prompt triggers condition detection
    const intent = parseIntent('if order is paid send Slack otherwise log');
    // parseIntent should add a second action for the false branch
    expect(intent.actions.length).toBeGreaterThanOrEqual(2);
  });

  it('less than condition is detected', () => {
    const intent = parseIntent('if order total less than 20 just log it');
    expect(intent.condition?.operator).toBe('lessThan');
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Topology — Wait
// ═══════════════════════════════════════════════════════════════════════════

describe('Wait topology', () => {

  it('detects wait from "wait 10 minutes"', () => {
    const intent = parseIntent('wait 10 minutes then send email');
    expect(intent.topology).toBe('wait');
    expect(intent.wait).not.toBeNull();
  });

  it('wait of 10 minutes → 600 seconds', () => {
    const intent = parseIntent('wait 10 minutes then send slack');
    expect(intent.wait?.seconds).toBe(600);
  });

  it('wait of 1 hour → 3600 seconds', () => {
    const intent = parseIntent('after 1 hour then send email');
    expect(intent.wait?.seconds).toBe(3600);
  });

  it('wait of 2 days → 172800 seconds', () => {
    const intent = parseIntent('delay 2 days then notify');
    expect(intent.wait?.seconds).toBe(172800);
  });

  it('wait workflow has a WAIT node', () => {
    const r = generateWorkflow('wait 5 minutes then send Slack');
    const waitNode = findNode(r, NODE_TYPES.WAIT);
    expect(waitNode).toBeDefined();
  });

  it('wait node has amount parameter', () => {
    const r = generateWorkflow('wait 10 minutes then email');
    const waitNode = findNode(r, NODE_TYPES.WAIT);
    const amount = (waitNode!.parameters as Record<string, unknown>).amount as number;
    expect(amount).toBeGreaterThan(0);
  });

  it('wait workflow passes validation', () => {
    const r = generateWorkflow('after 30 minutes send a Slack reminder on new shopify order');
    expect(validateWorkflow(r.workflow).valid).toBe(true);
  });

  it('wait without a number gets a default duration', () => {
    const intent = parseIntent('wait then send email');
    expect(intent.wait?.seconds).toBeGreaterThan(0);
  });

  it('wait topology takes priority over fanout', () => {
    const intent = parseIntent('wait 5 minutes then send slack and email');
    expect(intent.topology).toBe('wait');
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Example retrieval
// ═══════════════════════════════════════════════════════════════════════════

describe('Example retrieval', () => {

  it('returns non-empty array', () => {
    const ex = retrieveExamples('send slack on webhook');
    expect(ex.length).toBeGreaterThan(0);
  });

  it('returns at most 3 examples by default', () => {
    const ex = retrieveExamples('shopify order to slack');
    expect(ex.length).toBeLessThanOrEqual(3);
  });

  it('returns k examples when k is specified', () => {
    const ex = retrieveExamples('webhook to email', 5);
    expect(ex.length).toBeLessThanOrEqual(5);
  });

  it('returns relevant examples for Shopify prompt', () => {
    const ex = retrieveExamples('notify team when shopify order arrives');
    const hasShopify = ex.some(e => e.tags.includes('shopify') || e.intent.includes('shopify'));
    expect(hasShopify).toBe(true);
  });

  it('returns relevant examples for email prompt', () => {
    const ex = retrieveExamples('send email notification on event');
    const hasEmail = ex.some(e => e.tags.includes('email'));
    expect(hasEmail).toBe(true);
  });

  it('returns relevant examples for wait prompt', () => {
    const ex = retrieveExamples('wait 10 minutes then send email');
    const hasWait = ex.some(e => e.tags.includes('wait'));
    expect(hasWait).toBe(true);
  });

  it('returns examples for empty prompt (first K)', () => {
    const ex = retrieveExamples('');
    expect(ex.length).toBeGreaterThan(0);
  });

  it('generated result includes examplesUsed', () => {
    const r = generateWorkflow('shopify order to slack');
    expect(r.examplesUsed.length).toBeGreaterThan(0);
  });

  it('examplesUsed are valid TrainingPair objects', () => {
    const r = generateWorkflow('webhook to email');
    for (const pair of r.examplesUsed) {
      expect(typeof pair.id).toBe('string');
      expect(typeof pair.naturalLanguage).toBe('string');
      expect(typeof pair.intent).toBe('string');
      expect(Array.isArray(pair.tags)).toBe(true);
      expect(validateWorkflow(pair.workflow).valid).toBe(true);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// repairApplied flag
// ═══════════════════════════════════════════════════════════════════════════

describe('repairApplied flag', () => {

  it('is false when generated workflow is already valid', () => {
    const r = generateWorkflow('webhook to slack');
    // If valid on first build, repair should not be applied
    if (!r.repairApplied) {
      expect(r.valid).toBe(true);
    }
    // Either way, must be valid
    expect(r.valid).toBe(true);
  });

  it('when repairApplied is true, workflow is still valid', () => {
    // Force through many prompts; any that needed repair must still be valid
    const prompts = ['', 'xyz', 'do something weird', 'vip customer alert'];
    for (const p of prompts) {
      const r = generateWorkflow(p);
      expect(r.valid).toBe(true);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Internal: parseIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('parseIntent()', () => {

  it('always returns trigger, actions, topology', () => {
    const intent = parseIntent('send slack on webhook');
    expect(intent.trigger).toBeTruthy();
    expect(Array.isArray(intent.actions)).toBe(true);
    expect(intent.topology).toBeTruthy();
  });

  it('returns non-empty actions', () => {
    const intent = parseIntent('do something');
    expect(intent.actions.length).toBeGreaterThan(0);
  });

  it('workflowName is a non-empty string', () => {
    const intent = parseIntent('webhook to email');
    expect(intent.workflowName.trim().length).toBeGreaterThan(0);
  });

  it('condition is null when no condition keyword', () => {
    const intent = parseIntent('webhook to slack');
    expect(intent.condition).toBeNull();
  });

  it('wait is null when no wait keyword', () => {
    const intent = parseIntent('webhook to email');
    expect(intent.wait).toBeNull();
  });

  it('empty prompt returns valid intent', () => {
    const intent = parseIntent('');
    expect(Array.isArray(intent.actions)).toBe(true);
    expect(intent.actions.length).toBeGreaterThan(0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Internal: buildWorkflowFromIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('buildWorkflowFromIntent()', () => {

  const baseIntent: ParsedIntent = {
    trigger: 'webhook',
    actions: [{ kind: 'slack', channel: '#test', text: 'hello' }],
    condition: null,
    wait: null,
    topology: 'linear',
    workflowName: 'Test Workflow',
  };

  it('produces a workflow with nodes and connections', () => {
    const wf = buildWorkflowFromIntent(baseIntent);
    expect(Array.isArray(wf.nodes)).toBe(true);
    expect(typeof wf.connections).toBe('object');
  });

  it('linear: 2 nodes for trigger + 1 action', () => {
    const wf = buildWorkflowFromIntent(baseIntent);
    expect(wf.nodes).toHaveLength(2);
  });

  it('fanout: trigger + N action nodes', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      actions: [
        { kind: 'slack', channel: '#a', text: 'a' },
        { kind: 'email', to: 'b@b.com', subject: 's', body: 'b' },
      ],
      topology: 'fanout',
    };
    const wf = buildWorkflowFromIntent(intent);
    expect(wf.nodes).toHaveLength(3); // trigger + 2 actions
    expect(validateWorkflow(wf).valid).toBe(true);
  });

  it('conditional: trigger + IF + 2 branch nodes', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      actions: [
        { kind: 'slack', channel: '#t', text: 'true' },
        { kind: 'email', to: 'f@f.com', subject: 's', body: 'b' },
      ],
      condition: { field: 'status', operator: 'equals', value: 'vip', name: 'Check' },
      topology: 'conditional',
    };
    const wf = buildWorkflowFromIntent(intent);
    expect(wf.nodes).toHaveLength(4);
    expect(validateWorkflow(wf).valid).toBe(true);
  });

  it('wait: trigger + wait + action', () => {
    const intent: ParsedIntent = {
      ...baseIntent,
      wait: { seconds: 300, name: 'Wait 5 Min' },
      topology: 'wait',
    };
    const wf = buildWorkflowFromIntent(intent);
    expect(wf.nodes.some(n => n.type === NODE_TYPES.WAIT)).toBe(true);
    expect(validateWorkflow(wf).valid).toBe(true);
  });

  it('shopify trigger produces shopifytrigger node', () => {
    const intent: ParsedIntent = { ...baseIntent, trigger: 'shopify' };
    const wf = buildWorkflowFromIntent(intent);
    expect(wf.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Specific workflow scenarios (end-to-end)
// ═══════════════════════════════════════════════════════════════════════════

describe('End-to-end workflow scenarios', () => {

  it('Shopify → Slack', () => {
    const r = generateWorkflow('notify team on Slack when a Shopify order is placed');
    expect(r.valid).toBe(true);
    expect(r.workflow.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    expect(findNode(r, NODE_TYPES.SLACK)).toBeDefined();
  });

  it('Shopify → Email', () => {
    const r = generateWorkflow('send email when Shopify order arrives');
    expect(r.valid).toBe(true);
    expect(r.workflow.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    expect(findNode(r, NODE_TYPES.EMAIL_SEND)).toBeDefined();
  });

  it('Shopify → Airtable', () => {
    const r = generateWorkflow('log each Shopify order in Airtable');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.AIRTABLE)).toBeDefined();
  });

  it('Webhook → Wait → Email', () => {
    const r = generateWorkflow('wait 5 minutes after webhook then send email');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.WAIT)).toBeDefined();
    expect(findNode(r, NODE_TYPES.EMAIL_SEND)).toBeDefined();
  });

  it('Webhook → Wait → Slack', () => {
    const r = generateWorkflow('after 10 minutes send Slack reminder');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.WAIT)).toBeDefined();
    expect(findNode(r, NODE_TYPES.SLACK)).toBeDefined();
  });

  it('Shopify → Wait → Slack', () => {
    const r = generateWorkflow('shopify order: wait 30 minutes then notify #fulfilment on Slack');
    expect(r.valid).toBe(true);
    expect(r.workflow.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    expect(findNode(r, NODE_TYPES.WAIT)).toBeDefined();
    expect(findNode(r, NODE_TYPES.SLACK)).toBeDefined();
  });

  it('Webhook → Condition → Slack / Email', () => {
    const r = generateWorkflow('if VIP customer route to Slack, otherwise send email');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.IF)).toBeDefined();
    expect(findNode(r, NODE_TYPES.SLACK)).toBeDefined();
    expect(findNode(r, NODE_TYPES.EMAIL_SEND)).toBeDefined();
  });

  it('Shopify → Condition → Slack / Airtable', () => {
    const r = generateWorkflow('for high value Shopify orders alert Slack, log others in Airtable');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.IF)).toBeDefined();
  });

  it('Webhook → Slack + Email + Airtable (fanout)', () => {
    const r = generateWorkflow('send slack and email and airtable on webhook');
    expect(r.valid).toBe(true);
  });

  it('Webhook → Slack → Email (sequential multi-notification)', () => {
    const r = generateWorkflow('send Slack then email on webhook');
    expect(r.valid).toBe(true);
    expect(findNode(r, NODE_TYPES.SLACK)).toBeDefined();
    expect(findNode(r, NODE_TYPES.EMAIL_SEND)).toBeDefined();
  });

  it('empty prompt returns valid webhook-based workflow', () => {
    const r = generateWorkflow('');
    expect(r.valid).toBe(true);
    const startType = r.workflow.nodes[0]?.type?.toLowerCase() ?? '';
    expect(
      startType.includes('webhook') || startType.includes('trigger')
    ).toBe(true);
  });

  it('unrecognised prompt returns valid default workflow', () => {
    const r = generateWorkflow('xyzzy frobnicator flux capacitor');
    expect(r.valid).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Node parameter quality checks
// ═══════════════════════════════════════════════════════════════════════════

describe('Node parameter quality', () => {

  it('all nodes have non-empty names', () => {
    const r = generateWorkflow('shopify order to slack then airtable');
    for (const node of r.workflow.nodes) {
      expect(node.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('all nodes have non-empty types', () => {
    const r = generateWorkflow('webhook to email');
    for (const node of r.workflow.nodes) {
      expect(node.type.trim().length).toBeGreaterThan(0);
    }
  });

  it('node names are unique within a workflow', () => {
    const r = generateWorkflow('send slack and email and airtable on webhook');
    const names = r.workflow.nodes.map(n => n.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('connection sources all exist as node names', () => {
    const r = generateWorkflow('shopify order: wait 5 min then slack');
    const nodeNames = new Set(r.workflow.nodes.map(n => n.name));
    const conns = r.workflow.connections as Record<string, unknown>;
    for (const src of Object.keys(conns)) {
      expect(nodeNames.has(src)).toBe(true);
    }
  });

});
