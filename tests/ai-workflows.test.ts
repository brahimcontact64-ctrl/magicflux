/**
 * AI Workflows — Comprehensive test suite
 *
 * Covers:
 *   Phase 2/3 — All 14 example workflows validate correctly
 *   Phase 4   — Training dataset integrity
 *   Phase 5   — Prompt template integrity
 *   Phase 6   — Workflow repair engine (every repair scenario)
 *   Spec      — Builder helpers produce valid output
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow, ValidationCodes } from '../lib/workflow-validator';

// ── Imports under test ───────────────────────────────────────────────────────

import {
  EXAMPLE_WORKFLOWS,
  ex01, ex02, ex03, ex04, ex05, ex06, ex07,
  ex08, ex09, ex10, ex11, ex12, ex13, ex14,
} from '../lib/ai-workflows/examples';

import {
  TRAINING_DATASET,
  DATASET_STATS,
} from '../lib/ai-workflows/training-dataset';

import {
  ALL_TEMPLATES,
  WORKFLOW_GENERATOR_PROMPT,
  WORKFLOW_REPAIR_PROMPT,
  WORKFLOW_VALIDATOR_PROMPT,
  WORKFLOW_EXPLANATION_PROMPT,
  WORKFLOW_OPTIMIZER_PROMPT,
  fillTemplate,
} from '../lib/ai-workflows/prompt-templates';

import {
  repairWorkflow,
  repairOrThrow,
} from '../lib/ai-workflows/workflow-repair';

import {
  buildLinearWorkflow,
  buildFanoutWorkflow,
  buildConditionalWorkflow,
  buildWaitWorkflow,
  webhookNode,
  shopifyTriggerNode,
  slackNode,
  emailNode,
  airtableNode,
  conditionNode,
  waitNode,
  NODE_TYPES,
  VALIDATION_RULES,
} from '../lib/ai-workflows/ai-workflow-spec';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasError(r: ReturnType<typeof validateWorkflow>, code: string) {
  return r.errors.some(e => e.code === code);
}
function hasWarning(r: ReturnType<typeof validateWorkflow>, code: string) {
  return r.warnings.some(w => w.code === code);
}

/** JSON imports have narrowly-inferred connection key types — cast for dynamic access. */
type ConnMap = Record<string, { main: Array<Array<{ node: string }>> }>;
function connMap(wf: { connections: unknown }): ConnMap {
  return wf.connections as unknown as ConnMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2/3 — Example workflow validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2/3 — Example workflows', () => {

  // ── Bulk: every example passes validation ─────────────────────────────────

  it('EXAMPLE_WORKFLOWS array contains exactly 14 entries', () => {
    expect(EXAMPLE_WORKFLOWS).toHaveLength(14);
  });

  for (let i = 0; i < EXAMPLE_WORKFLOWS.length; i++) {
    it(`example ${String(i + 1).padStart(2, '0')} passes validateWorkflow()`, () => {
      const r = validateWorkflow(EXAMPLE_WORKFLOWS[i]);
      if (!r.valid) {
        console.error(`Example ${i + 1} errors:`, r.errors);
      }
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });
  }

  // ── 01: webhook → slack ───────────────────────────────────────────────────

  describe('01-webhook-to-slack', () => {
    it('has 2 nodes', () => expect(ex01.nodes).toHaveLength(2));
    it('has a webhook start node', () => {
      expect(ex01.nodes[0].type.toLowerCase()).toContain('webhook');
    });
    it('has a Slack action node', () => {
      expect(ex01.nodes[1].type).toBe(NODE_TYPES.SLACK);
    });
    it('trigger connects to Slack', () => {
      const src = ex01.nodes[0].name;
      expect(connMap(ex01)[src]).toBeDefined();
    });
  });

  // ── 02: webhook → email ───────────────────────────────────────────────────

  describe('02-webhook-to-email', () => {
    it('has 2 nodes', () => expect(ex02.nodes).toHaveLength(2));
    it('email node has required parameters', () => {
      const email = ex02.nodes[1];
      expect(email.parameters).toMatchObject({ to: expect.any(String), subject: expect.any(String), text: expect.any(String) });
    });
  });

  // ── 03: webhook → airtable ────────────────────────────────────────────────

  describe('03-webhook-to-airtable', () => {
    it('has 2 nodes', () => expect(ex03.nodes).toHaveLength(2));
    it('airtable node has a table parameter', () => {
      expect((ex03.nodes[1].parameters as Record<string, unknown>).table).toBeTruthy();
    });
  });

  // ── 04-06: shopify triggers ───────────────────────────────────────────────

  describe('04-06 shopify examples', () => {
    it('04 starts with shopifytrigger', () => {
      expect(ex04.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    });
    it('05 starts with shopifytrigger', () => {
      expect(ex05.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    });
    it('06 starts with shopifytrigger', () => {
      expect(ex06.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    });
  });

  // ── 07: shopify → slack → airtable ───────────────────────────────────────

  describe('07-shopify-slack-airtable', () => {
    it('has 3 nodes', () => expect(ex07.nodes).toHaveLength(3));
    it('Slack connects to Airtable (sequential)', () => {
      const slackName = ex07.nodes[1].name;
      const airtableName = ex07.nodes[2].name;
      const targets = connMap(ex07)[slackName]?.main[0]?.map((e: { node: string }) => e.node) ?? [];
      expect(targets).toContain(airtableName);
    });
  });

  // ── 08: condition – vip ───────────────────────────────────────────────────

  describe('08-condition-vip-customer', () => {
    it('has 4 nodes', () => expect(ex08.nodes).toHaveLength(4));
    it('condition node has exactly 2 output ports', () => {
      const condName = ex08.nodes[1].name;
      expect(connMap(ex08)[condName].main).toHaveLength(2);
    });
    it('port[0] leads to Slack (true branch)', () => {
      const condName = ex08.nodes[1].name;
      expect(connMap(ex08)[condName].main[0]).toHaveLength(1);
    });
    it('port[1] leads to Email (false branch)', () => {
      const condName = ex08.nodes[1].name;
      expect(connMap(ex08)[condName].main[1]).toHaveLength(1);
    });
    it('condition parameters have conditions array', () => {
      const cond = ex08.nodes[1];
      const params = cond.parameters as Record<string, unknown>;
      expect(Array.isArray(params.conditions)).toBe(true);
    });
  });

  // ── 09: condition – order value ───────────────────────────────────────────

  describe('09-condition-order-value', () => {
    it('has 4 nodes', () => expect(ex09.nodes).toHaveLength(4));
    it('condition node has 2 ports', () => {
      const condName = ex09.nodes[1].name;
      expect(connMap(ex09)[condName].main).toHaveLength(2);
    });
    it('condition checks total_price with greaterThan', () => {
      const params = ex09.nodes[1].parameters as Record<string, unknown>;
      const conds = params.conditions as Array<Record<string, unknown>>;
      expect(conds[0].operator).toBe('greaterThan');
    });
  });

  // ── 10-12: wait examples ──────────────────────────────────────────────────

  describe('10-12 wait examples', () => {
    it('10 has a wait node with amount parameter', () => {
      const wait = ex10.nodes[1];
      expect(wait.type).toBe(NODE_TYPES.WAIT);
      expect((wait.parameters as Record<string, unknown>).amount).toBeGreaterThan(0);
    });
    it('11 wait node connects to Slack', () => {
      const waitName = ex11.nodes[1].name;
      const slackName = ex11.nodes[2].name;
      const targets = connMap(ex11)[waitName]?.main[0]?.map((e: { node: string }) => e.node) ?? [];
      expect(targets).toContain(slackName);
    });
    it('12 shopify → wait → slack', () => {
      expect(ex12.nodes[0].type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
      expect(ex12.nodes[1].type).toBe(NODE_TYPES.WAIT);
      expect(ex12.nodes[2].type).toBe(NODE_TYPES.SLACK);
    });
  });

  // ── 13: multi-notification (sequential) ──────────────────────────────────

  describe('13-multi-notification', () => {
    it('has 3 nodes', () => expect(ex13.nodes).toHaveLength(3));
    it('Slack connects to Email', () => {
      const slackName = ex13.nodes[1].name;
      const emailName = ex13.nodes[2].name;
      const targets = connMap(ex13)[slackName]?.main[0]?.map((e: { node: string }) => e.node) ?? [];
      expect(targets).toContain(emailName);
    });
  });

  // ── 14: fan-out ───────────────────────────────────────────────────────────

  describe('14-fanout-workflow', () => {
    it('has 4 nodes', () => expect(ex14.nodes).toHaveLength(4));
    it('trigger sends to all 3 targets on same port', () => {
      const triggerName = ex14.nodes[0].name;
      const port0 = connMap(ex14)[triggerName]?.main[0] ?? [];
      expect(port0).toHaveLength(3);
    });
    it('fan-out has no unreachable nodes warning', () => {
      const r = validateWorkflow(ex14);
      expect(hasWarning(r, ValidationCodes.UNREACHABLE_NODE)).toBe(false);
    });
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Training dataset
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 4 — Training dataset', () => {

  it('dataset has at least 100 entries', () => {
    expect(TRAINING_DATASET.length).toBeGreaterThanOrEqual(100);
  });

  it('DATASET_STATS.total matches actual array length', () => {
    expect(DATASET_STATS.total).toBe(TRAINING_DATASET.length);
  });

  it('every entry has a unique id', () => {
    const ids = TRAINING_DATASET.map(p => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every entry has a non-empty naturalLanguage string', () => {
    for (const pair of TRAINING_DATASET) {
      expect(typeof pair.naturalLanguage).toBe('string');
      expect(pair.naturalLanguage.trim().length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty intent string', () => {
    for (const pair of TRAINING_DATASET) {
      expect(typeof pair.intent).toBe('string');
      expect(pair.intent.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a tags array with at least one entry', () => {
    for (const pair of TRAINING_DATASET) {
      expect(Array.isArray(pair.tags)).toBe(true);
      expect(pair.tags.length).toBeGreaterThan(0);
    }
  });

  it('every training workflow passes validateWorkflow()', () => {
    const failures: string[] = [];
    for (const pair of TRAINING_DATASET) {
      const r = validateWorkflow(pair.workflow);
      if (!r.valid) failures.push(`${pair.id}: ${r.errors.map(e => e.code).join(', ')}`);
    }
    if (failures.length > 0) {
      console.error('Invalid training workflows:\n' + failures.join('\n'));
    }
    expect(failures).toHaveLength(0);
  });

  it('dataset covers webhook triggers', () => {
    expect(DATASET_STATS.byTag.webhook).toBeGreaterThan(0);
  });

  it('dataset covers shopify triggers', () => {
    expect(DATASET_STATS.byTag.shopify).toBeGreaterThan(0);
  });

  it('dataset covers condition/IF nodes', () => {
    expect(DATASET_STATS.byTag.condition).toBeGreaterThan(0);
  });

  it('dataset covers wait nodes', () => {
    expect(DATASET_STATS.byTag.wait).toBeGreaterThan(0);
  });

  it('dataset covers fan-out patterns', () => {
    expect(DATASET_STATS.byTag.fanout).toBeGreaterThan(0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Prompt templates
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 5 — Prompt templates', () => {

  it('ALL_TEMPLATES contains all 5 templates', () => {
    expect(Object.keys(ALL_TEMPLATES)).toHaveLength(5);
  });

  for (const [name, template] of Object.entries(ALL_TEMPLATES)) {
    describe(name, () => {
      it('is a non-empty string', () => {
        expect(typeof template).toBe('string');
        expect(template.trim().length).toBeGreaterThan(100);
      });

      it('does not contain unfilled {{...}} placeholders (except intended ones)', () => {
        // Templates should contain placeholder markers, but not accidental unfilled ones
        // Check that there are no double-brace placeholders with whitespace-only content
        const badPlaceholders = template.match(/\{\{\s+\}\}/g);
        expect(badPlaceholders).toBeNull();
      });
    });
  }

  it('WORKFLOW_GENERATOR_PROMPT mentions all provider node types', () => {
    expect(WORKFLOW_GENERATOR_PROMPT).toContain('n8n-nodes-base.slack');
    expect(WORKFLOW_GENERATOR_PROMPT).toContain('n8n-nodes-base.emailsend');
    expect(WORKFLOW_GENERATOR_PROMPT).toContain('n8n-nodes-base.airtable');
  });

  it('WORKFLOW_GENERATOR_PROMPT mentions condition rules', () => {
    expect(WORKFLOW_GENERATOR_PROMPT).toContain('two ports');
  });

  it('WORKFLOW_GENERATOR_PROMPT contains {{USER_REQUEST}} placeholder', () => {
    expect(WORKFLOW_GENERATOR_PROMPT).toContain('{{USER_REQUEST}}');
  });

  it('WORKFLOW_REPAIR_PROMPT contains repair rules for every error code', () => {
    expect(WORKFLOW_REPAIR_PROMPT).toContain('MISSING_NODE_NAME');
    expect(WORKFLOW_REPAIR_PROMPT).toContain('DUPLICATE_NODE_NAME');
    expect(WORKFLOW_REPAIR_PROMPT).toContain('NO_START_NODE');
    expect(WORKFLOW_REPAIR_PROMPT).toContain('INVALID_CONDITION_PORTS');
    expect(WORKFLOW_REPAIR_PROMPT).toContain('GRAPH_CYCLE_DETECTED');
  });

  it('WORKFLOW_REPAIR_PROMPT contains {{BROKEN_WORKFLOW}} placeholder', () => {
    expect(WORKFLOW_REPAIR_PROMPT).toContain('{{BROKEN_WORKFLOW}}');
  });

  it('WORKFLOW_REPAIR_PROMPT contains {{VALIDATION_ERRORS}} placeholder', () => {
    expect(WORKFLOW_REPAIR_PROMPT).toContain('{{VALIDATION_ERRORS}}');
  });

  it('WORKFLOW_VALIDATOR_PROMPT lists all structural checks', () => {
    expect(WORKFLOW_VALIDATOR_PROMPT).toContain('nodes');
    expect(WORKFLOW_VALIDATOR_PROMPT).toContain('connections');
    expect(WORKFLOW_VALIDATOR_PROMPT).toContain('{{WORKFLOW}}');
  });

  it('WORKFLOW_EXPLANATION_PROMPT mentions TRIGGER and STEPS sections', () => {
    expect(WORKFLOW_EXPLANATION_PROMPT).toContain('TRIGGER');
    expect(WORKFLOW_EXPLANATION_PROMPT).toContain('STEPS');
  });

  it('WORKFLOW_OPTIMIZER_PROMPT mentions PARALLELISM', () => {
    expect(WORKFLOW_OPTIMIZER_PROMPT).toContain('PARALLELISM');
  });

  describe('fillTemplate()', () => {
    it('substitutes a single placeholder', () => {
      const result = fillTemplate('Hello {{NAME}}!', { NAME: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('substitutes multiple placeholders', () => {
      const result = fillTemplate('{{A}} and {{B}}', { A: 'foo', B: 'bar' });
      expect(result).toBe('foo and bar');
    });

    it('substitutes all occurrences of the same placeholder', () => {
      const result = fillTemplate('{{X}} and {{X}}', { X: 'test' });
      expect(result).toBe('test and test');
    });

    it('leaves unknown placeholders intact', () => {
      const result = fillTemplate('Hello {{UNKNOWN}}', { NAME: 'World' });
      expect(result).toBe('Hello {{UNKNOWN}}');
    });

    it('fills USER_REQUEST in WORKFLOW_GENERATOR_PROMPT', () => {
      const filled = fillTemplate(WORKFLOW_GENERATOR_PROMPT, {
        USER_REQUEST: 'Send Slack on order',
      });
      expect(filled).toContain('Send Slack on order');
      expect(filled).not.toContain('{{USER_REQUEST}}');
    });

    it('fills BROKEN_WORKFLOW and VALIDATION_ERRORS in repair prompt', () => {
      const filled = fillTemplate(WORKFLOW_REPAIR_PROMPT, {
        BROKEN_WORKFLOW: '{"broken":true}',
        VALIDATION_ERRORS: '[{"code":"NO_START_NODE"}]',
      });
      expect(filled).toContain('{"broken":true}');
      expect(filled).toContain('NO_START_NODE');
    });
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — Workflow repair engine
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 6 — Workflow repair engine', () => {

  // ── Already-valid input ───────────────────────────────────────────────────

  describe('already-valid input', () => {
    it('returns valid:true for a valid workflow with no changes', () => {
      const r = repairWorkflow(ex01);
      expect(r.valid).toBe(true);
      expect(r.remainingErrors).toHaveLength(0);
    });

    it('makes no changes to an already-valid workflow', () => {
      const r = repairWorkflow(ex08);
      expect(r.valid).toBe(true);
      // Changes for an already-valid workflow should be empty (or just cosmetic)
      const errorChanges = r.changes.filter(c => c.code !== 'STRUCTURE_FIX');
      expect(errorChanges).toHaveLength(0);
    });
  });

  // ── INVALID_WORKFLOW ──────────────────────────────────────────────────────

  describe('INVALID_WORKFLOW repairs', () => {
    it('repairs null input → adds minimal structure', () => {
      const r = repairWorkflow(null);
      expect(r.changes.some(c => c.code === ValidationCodes.INVALID_WORKFLOW)).toBe(true);
      // After adding start node it should be valid
      expect(r.valid).toBe(true);
    });

    it('repairs a string input', () => {
      const r = repairWorkflow('not-a-workflow');
      expect(r.changes.some(c => c.code === ValidationCodes.INVALID_WORKFLOW)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('repairs an array input', () => {
      const r = repairWorkflow([1, 2, 3]);
      expect(r.changes.some(c => c.code === ValidationCodes.INVALID_WORKFLOW)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('repairs a number input', () => {
      const r = repairWorkflow(42);
      expect(r.valid).toBe(true);
    });

    it('repairs undefined', () => {
      const r = repairWorkflow(undefined);
      expect(r.valid).toBe(true);
    });
  });

  // ── MISSING_NODES ─────────────────────────────────────────────────────────

  describe('MISSING_NODES repairs', () => {
    it('adds nodes array when missing', () => {
      const r = repairWorkflow({ connections: {} });
      expect(r.changes.some(c => c.code === ValidationCodes.MISSING_NODES)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('handles nodes: null', () => {
      const r = repairWorkflow({ nodes: null, connections: {} });
      expect(r.valid).toBe(true);
    });

    it('handles nodes: "string"', () => {
      const r = repairWorkflow({ nodes: 'oops', connections: {} });
      expect(r.valid).toBe(true);
    });
  });

  // ── MISSING_CONNECTIONS ───────────────────────────────────────────────────

  describe('MISSING_CONNECTIONS repairs', () => {
    it('adds connections object when missing', () => {
      const r = repairWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }] });
      expect(r.changes.some(c => c.code === ValidationCodes.MISSING_CONNECTIONS)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('handles connections: null', () => {
      const r = repairWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }], connections: null });
      expect(r.valid).toBe(true);
    });

    it('handles connections: []', () => {
      const r = repairWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }], connections: [] });
      expect(r.valid).toBe(true);
    });
  });

  // ── MISSING_NODE_NAME ─────────────────────────────────────────────────────

  describe('MISSING_NODE_NAME repairs', () => {
    it('generates a name when node.name is missing', () => {
      const r = repairWorkflow({
        nodes: [{ type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.MISSING_NODE_NAME)).toBe(true);
      expect(r.workflow.nodes[0].name.length).toBeGreaterThan(0);
      expect(r.valid).toBe(true);
    });

    it('generates a name when node.name is empty string', () => {
      const r = repairWorkflow({
        nodes: [{ name: '', type: 'n8n-nodes-base.slack' }],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

    it('skips non-object node entries', () => {
      const r = repairWorkflow({
        nodes: ['not-an-object', { name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      // After skipping the non-object, we should still have the webhook node
      expect(r.workflow.nodes.some(n => n.type === 'n8n-nodes-base.webhook')).toBe(true);
    });
  });

  // ── MISSING_NODE_TYPE ─────────────────────────────────────────────────────

  describe('MISSING_NODE_TYPE repairs', () => {
    it('sets default type when node.type is missing', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'MyNode' }],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.MISSING_NODE_TYPE)).toBe(true);
      expect(r.workflow.nodes[0].type).toBe('n8n-nodes-base.webhook');
      expect(r.valid).toBe(true);
    });

    it('sets default type when node.type is empty', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'N', type: '   ' }],
        connections: {},
      });
      expect(r.workflow.nodes[0].type.length).toBeGreaterThan(0);
    });
  });

  // ── DUPLICATE_NODE_NAME ───────────────────────────────────────────────────

  describe('DUPLICATE_NODE_NAME repairs', () => {
    it('renames the second node with _2 suffix', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'Slack', type: 'n8n-nodes-base.webhook' },
          { name: 'Slack', type: 'n8n-nodes-base.slack' },
        ],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.DUPLICATE_NODE_NAME)).toBe(true);
      const names = r.workflow.nodes.map(n => n.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
      expect(r.valid).toBe(true);
    });

    it('handles three duplicates', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
          { name: 'A', type: 'n8n-nodes-base.airtable' },
        ],
        connections: {},
      });
      const names = r.workflow.nodes.map(n => n.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
      expect(r.valid).toBe(true);
    });

    it('updates connection references when renaming', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'Action',  type: 'n8n-nodes-base.slack' },
          { name: 'Action',  type: 'n8n-nodes-base.emailsend' },
        ],
        connections: {
          Trigger: { main: [[{ node: 'Action' }]] },
        },
      });
      // After repair, all node names unique and validation passes
      expect(r.valid).toBe(true);
    });
  });

  // ── NO_START_NODE ─────────────────────────────────────────────────────────

  describe('NO_START_NODE repairs', () => {
    it('adds a webhook trigger when no start node exists', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'Slack', type: 'n8n-nodes-base.slack' }],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.NO_START_NODE)).toBe(true);
      const hasWebhook = r.workflow.nodes.some(n =>
        n.type.toLowerCase().includes('webhook') || n.type.toLowerCase().includes('trigger')
      );
      expect(hasWebhook).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('adds a webhook trigger to an empty nodes array', () => {
      const r = repairWorkflow({ nodes: [], connections: {} });
      expect(r.changes.some(c => c.code === ValidationCodes.NO_START_NODE)).toBe(true);
      expect(r.workflow.nodes.length).toBeGreaterThan(0);
      expect(r.valid).toBe(true);
    });

    it('does NOT add a trigger when one already exists', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(r.changes.some(c => c.code === ValidationCodes.NO_START_NODE)).toBe(false);
    });

    it('recognises shopifytrigger as a valid start node', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'ST', type: 'n8n-nodes-base.shopifytrigger' },
          { name: 'SL', type: 'n8n-nodes-base.slack' },
        ],
        connections: { ST: { main: [[{ node: 'SL' }]] } },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.NO_START_NODE)).toBe(false);
      expect(r.valid).toBe(true);
    });
  });

  // ── UNKNOWN_SOURCE_NODE ───────────────────────────────────────────────────

  describe('UNKNOWN_SOURCE_NODE repairs', () => {
    it('removes a connection from an unknown source', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {
          Ghost: { main: [[{ node: 'T' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.UNKNOWN_SOURCE_NODE)).toBe(true);
      expect(r.workflow.connections['Ghost']).toBeUndefined();
      expect(r.valid).toBe(true);
    });

    it('keeps valid connections while removing invalid ones', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          T:     { main: [[{ node: 'A' }]] },
          Ghost: { main: [[{ node: 'A' }]] },
        },
      });
      expect(r.workflow.connections['T']).toBeDefined();
      expect(r.workflow.connections['Ghost']).toBeUndefined();
      expect(r.valid).toBe(true);
    });
  });

  // ── UNKNOWN_TARGET_NODE ───────────────────────────────────────────────────

  describe('UNKNOWN_TARGET_NODE repairs', () => {
    it('removes a target that does not match any node', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          T: { main: [[{ node: 'Ghost' }, { node: 'A' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.UNKNOWN_TARGET_NODE)).toBe(true);
      // Valid target 'A' must remain
      const targets = r.workflow.connections['T']?.main[0]?.map(e => e.node) ?? [];
      expect(targets).toContain('A');
      expect(targets).not.toContain('Ghost');
      expect(r.valid).toBe(true);
    });

    it('removes all bad targets from every port', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {
          T: { main: [[{ node: 'Bad1' }], [{ node: 'Bad2' }]] },
        },
      });
      // All targets removed — connection becomes empty
      expect(r.valid).toBe(true);
    });
  });

  // ── INVALID_CONDITION_PORTS ───────────────────────────────────────────────

  describe('INVALID_CONDITION_PORTS repairs', () => {
    it('adds two ports when IF node has no connections entry', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'T',     type: 'n8n-nodes-base.webhook' },
          { name: 'Check', type: 'n8n-nodes-base.if', parameters: { conditions: [] } },
        ],
        connections: {
          T: { main: [[{ node: 'Check' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
      expect(r.workflow.connections['Check'].main).toHaveLength(2);
      expect(r.valid).toBe(true);
    });

    it('extends one port to two for IF node', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'C', type: 'n8n-nodes-base.if' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          T: { main: [[{ node: 'C' }]] },
          C: { main: [[{ node: 'A' }]] },  // only 1 port
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
      expect(r.workflow.connections['C'].main).toHaveLength(2);
      expect(r.valid).toBe(true);
    });

    it('does NOT add ports for shopify node (shopify contains "if")', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'SH', type: 'n8n-nodes-base.shopify' },
        ],
        connections: {
          T: { main: [[{ node: 'SH' }]] },
        },
      });
      // shopify node must NOT get condition ports added
      expect(r.workflow.connections['SH']).toBeUndefined();
      expect(r.valid).toBe(true);
    });
  });

  // ── GRAPH_CYCLE_DETECTED ──────────────────────────────────────────────────

  describe('GRAPH_CYCLE_DETECTED repairs', () => {
    it('removes a simple 2-node cycle: A → B → A', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'B', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          A: { main: [[{ node: 'B' }]] },
          B: { main: [[{ node: 'A' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('removes a self-loop: A → A', () => {
      const r = repairWorkflow({
        nodes: [{ name: 'A', type: 'n8n-nodes-base.webhook' }],
        connections: {
          A: { main: [[{ node: 'A' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
      expect(r.valid).toBe(true);
    });

    it('removes a 3-node cycle: A → B → C → A', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'B', type: 'n8n-nodes-base.slack' },
          { name: 'C', type: 'n8n-nodes-base.airtable' },
        ],
        connections: {
          A: { main: [[{ node: 'B' }]] },
          B: { main: [[{ node: 'C' }]] },
          C: { main: [[{ node: 'A' }]] },
        },
      });
      expect(r.changes.some(c => c.code === ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
      expect(r.valid).toBe(true);
    });
  });

  // ── Multiple simultaneous errors ──────────────────────────────────────────

  describe('multiple errors repaired in one call', () => {
    it('fixes no start node + unknown target + condition ports', () => {
      const r = repairWorkflow({
        nodes: [
          { name: 'Check', type: 'n8n-nodes-base.if', parameters: { conditions: [] } },
          { name: 'Slack',  type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          Check: { main: [[{ node: 'Slack' }, { node: 'Ghost' }]] },
        },
      });
      expect(r.valid).toBe(true);
      // Start node added
      const hasStart = r.workflow.nodes.some(n => n.type.toLowerCase().includes('webhook'));
      expect(hasStart).toBe(true);
      // Condition has 2 ports
      expect(r.workflow.connections['Check'].main).toHaveLength(2);
    });

    it('fixes completely broken input: not-an-object → valid workflow', () => {
      const r = repairWorkflow('garbage string');
      expect(r.valid).toBe(true);
      expect(r.workflow.nodes.length).toBeGreaterThan(0);
      expect(typeof r.workflow.connections).toBe('object');
    });

    it('tracks all changes made', () => {
      const r = repairWorkflow({
        // missing connections, duplicate names, no start node
        nodes: [
          { name: 'X', type: 'n8n-nodes-base.slack' },
          { name: 'X', type: 'n8n-nodes-base.emailsend' },
        ],
      });
      expect(r.changes.length).toBeGreaterThan(0);
      expect(r.valid).toBe(true);
    });
  });

  // ── repairOrThrow ─────────────────────────────────────────────────────────

  describe('repairOrThrow()', () => {
    it('returns the workflow when repair succeeds', () => {
      const wf = repairOrThrow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(wf).toBeDefined();
      expect(Array.isArray(wf.nodes)).toBe(true);
    });

    it('returns a valid workflow for an empty input', () => {
      const wf = repairOrThrow(null);
      expect(validateWorkflow(wf).valid).toBe(true);
    });
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Spec helper functions
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec — builder helpers produce valid workflows', () => {

  describe('buildLinearWorkflow()', () => {
    it('produces a valid linear workflow', () => {
      const wf = buildLinearWorkflow('Test', [
        webhookNode('Start'),
        slackNode('End', '#general', 'hi'),
      ]);
      expect(validateWorkflow(wf).valid).toBe(true);
    });

    it('chains 3 nodes correctly', () => {
      const wf = buildLinearWorkflow('Chain', [
        webhookNode('A'),
        slackNode('B', '#ch', 'msg'),
        airtableNode('C', 'Table'),
      ]);
      expect(wf.connections['A'].main[0][0].node).toBe('B');
      expect(wf.connections['B'].main[0][0].node).toBe('C');
      expect(validateWorkflow(wf).valid).toBe(true);
    });

    it('single node workflow is valid', () => {
      const wf = buildLinearWorkflow('Single', [webhookNode('T')]);
      expect(validateWorkflow(wf).valid).toBe(true);
    });
  });

  describe('buildFanoutWorkflow()', () => {
    it('produces a valid fan-out workflow', () => {
      const wf = buildFanoutWorkflow('Fan', webhookNode('T'), [
        slackNode('A', '#a', 'msg'),
        emailNode('B', 'b@b.com', 'sub', 'body'),
      ]);
      expect(validateWorkflow(wf).valid).toBe(true);
    });

    it('all targets on the same port', () => {
      const trigger = webhookNode('T');
      const wf = buildFanoutWorkflow('Fan', trigger, [
        slackNode('A', '#a', 'msg'),
        airtableNode('B', 'Table'),
        emailNode('C', 'c@c.com', 's', 'b'),
      ]);
      const port0 = wf.connections['T'].main[0];
      expect(port0).toHaveLength(3);
      expect(validateWorkflow(wf).valid).toBe(true);
    });
  });

  describe('buildConditionalWorkflow()', () => {
    it('produces a valid conditional workflow', () => {
      const wf = buildConditionalWorkflow(
        'Cond',
        webhookNode('T'),
        conditionNode('C', [{ field: 'x', operator: 'equals', value: 'y' }]),
        [slackNode('True', '#t', 'yes')],
        [emailNode('False', 'f@f.com', 's', 'no')],
      );
      expect(validateWorkflow(wf).valid).toBe(true);
    });

    it('condition node has exactly 2 ports', () => {
      const wf = buildConditionalWorkflow(
        'C', webhookNode('T'), conditionNode('C', []),
        [slackNode('Tr', '#t', 'm')], [emailNode('Fa', 'f@f.com', 's', 'b')],
      );
      expect(wf.connections['C'].main).toHaveLength(2);
    });
  });

  describe('buildWaitWorkflow()', () => {
    it('produces a valid wait workflow', () => {
      const wf = buildWaitWorkflow('Wait', webhookNode('T'), 300, 'Wait 5m', [
        slackNode('S', '#ch', 'done'),
      ]);
      expect(validateWorkflow(wf).valid).toBe(true);
    });

    it('wait node is at index 1', () => {
      const wf = buildWaitWorkflow('W', webhookNode('T'), 60, 'Wait', [slackNode('S', '#c', 'm')]);
      expect(wf.nodes[1].type).toBe(NODE_TYPES.WAIT);
      expect((wf.nodes[1].parameters as Record<string, unknown>).amount).toBe(60);
    });
  });

  describe('node factory helpers', () => {
    it('webhookNode() has correct type', () => {
      expect(webhookNode().type).toBe(NODE_TYPES.WEBHOOK);
    });
    it('shopifyTriggerNode() has correct type', () => {
      expect(shopifyTriggerNode().type).toBe(NODE_TYPES.SHOPIFY_TRIGGER);
    });
    it('slackNode() includes channel and text', () => {
      const n = slackNode('S', '#ch', 'hello');
      expect(n.parameters).toMatchObject({ channel: '#ch', text: 'hello' });
    });
    it('emailNode() includes to, subject, text', () => {
      const n = emailNode('E', 'a@b.com', 'Sub', 'Body');
      expect(n.parameters).toMatchObject({ to: 'a@b.com', subject: 'Sub', text: 'Body' });
    });
    it('airtableNode() includes table', () => {
      const n = airtableNode('A', 'Orders');
      expect((n.parameters as Record<string, unknown>).table).toBe('Orders');
    });
    it('conditionNode() includes conditions array', () => {
      const n = conditionNode('C', [{ field: 'x', operator: 'equals', value: 'y' }]);
      expect(Array.isArray((n.parameters as Record<string, unknown>).conditions)).toBe(true);
    });
    it('waitNode() includes amount', () => {
      const n = waitNode('W', 120);
      expect((n.parameters as Record<string, unknown>).amount).toBe(120);
    });
  });

  describe('VALIDATION_RULES constants', () => {
    it('MAX_NODES is 200', () => expect(VALIDATION_RULES.MAX_NODES).toBe(200));
    it('MAX_EDGES is 1000', () => expect(VALIDATION_RULES.MAX_EDGES).toBe(1000));
    it('start node substrings include webhook', () => {
      expect(VALIDATION_RULES.START_NODE_SUBSTRINGS).toContain('webhook');
    });
  });

});
