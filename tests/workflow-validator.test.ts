/**
 * Workflow Validator — test suite
 *
 * Covers every rule in lib/workflow-validator/index.ts:
 *   - Valid workflows (linear, branching, wait)
 *   - Every error code
 *   - Every warning code
 *   - Edge cases derived from the runtime engine source
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow, ValidationCodes } from '../lib/workflow-validator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function codes(errors: { code: string }[]): string[] {
  return errors.map(e => e.code);
}

function hasCode(result: { errors: { code: string }[]; warnings: { code: string }[] }, code: string): boolean {
  return result.errors.some(e => e.code === code) || result.warnings.some(w => w.code === code);
}

function hasError(result: { errors: { code: string }[] }, code: string): boolean {
  return result.errors.some(e => e.code === code);
}

function hasWarning(result: { warnings: { code: string }[] }, code: string): boolean {
  return result.warnings.some(w => w.code === code);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid linear workflow: webhook → slack */
const VALID_LINEAR = {
  name: 'Linear workflow',
  nodes: [
    { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
    { name: 'Notify',  type: 'n8n-nodes-base.slack', parameters: { channel: '#alerts', text: 'hello' } },
  ],
  connections: {
    Trigger: { main: [[{ node: 'Notify' }]] },
  },
};

/** Condition workflow: webhook → if → [slack, email] */
const VALID_CONDITION = {
  nodes: [
    { name: 'Trigger',   type: 'n8n-nodes-base.webhook' },
    { name: 'CheckVIP',  type: 'n8n-nodes-base.if',     parameters: { conditions: [{ field: 'vip', operator: 'equals', value: 'true' }] } },
    { name: 'SlackVIP',  type: 'n8n-nodes-base.slack' },
    { name: 'EmailAll',  type: 'n8n-nodes-base.emailsend' },
  ],
  connections: {
    Trigger:  { main: [[{ node: 'CheckVIP' }]] },
    CheckVIP: { main: [[{ node: 'SlackVIP' }], [{ node: 'EmailAll' }]] },
  },
};

/** Wait workflow: webhook → wait → airtable */
const VALID_WAIT = {
  nodes: [
    { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
    { name: 'Pause',   type: 'n8n-nodes-base.wait',    parameters: { seconds: 60 } },
    { name: 'Save',    type: 'n8n-nodes-base.airtable' },
  ],
  connections: {
    Trigger: { main: [[{ node: 'Pause'  }]] },
    Pause:   { main: [[{ node: 'Save'   }]] },
  },
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('validateWorkflow', () => {

  // ── Valid workflows ──────────────────────────────────────────────────────

  describe('valid workflows', () => {

    it('accepts a minimal linear workflow', () => {
      const r = validateWorkflow(VALID_LINEAR);
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('accepts a condition workflow with two output ports', () => {
      const r = validateWorkflow(VALID_CONDITION);
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('accepts a wait workflow', () => {
      const r = validateWorkflow(VALID_WAIT);
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('accepts every provider node type from HANDLER_NODE_ALLOWLIST that is actually production-safe', () => {
      // gmailtrigger, googledrive, and googledrivetrigger are in
      // PROVIDER_EXACT_TYPES (they dispatch to a real handler function) but
      // are explicitly blocked by the Phase 9.1.6 capability blocklist:
      // gmailtrigger has no watch/poll mechanism and would misfire
      // emailHandler; the googledrive handler is a known, honest stub with
      // no working credential path yet. See
      // tests/workflow-validator.test.ts's UNSUPPORTED_NODE_CAPABILITY
      // suite and lib/workflow-runtime/node-capabilities.ts for the
      // corresponding rejection tests/reasoning.
      const providerTypes = [
        'n8n-nodes-base.shopify',
        'n8n-nodes-base.shopifytrigger',
        'n8n-nodes-base.slack',
        'n8n-nodes-base.slacktrigger',
        'n8n-nodes-base.airtable',
        'n8n-nodes-base.airtabletrigger',
        'n8n-nodes-base.emailsend',
        'n8n-nodes-base.emailreadimap',
        'n8n-nodes-base.gmail',
      ];

      for (const type of providerTypes) {
        const r = validateWorkflow({
          nodes: [
            { name: 'Start', type: 'n8n-nodes-base.webhook' },
            { name: 'Action', type },
          ],
          connections: { Start: { main: [[{ node: 'Action' }]] } },
        });
        expect(r.valid, `expected valid for provider type "${type}"`).toBe(true);
        expect(r.errors).toHaveLength(0);
      }
    });

    it('accepts mixed-case type strings (shopify trigger is still a start node)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'ST', type: 'N8N-NODES-BASE.SHOPIFYTRIGGER' },
          { name: 'SL', type: 'n8n-nodes-base.slack' },
        ],
        connections: { ST: { main: [[{ node: 'SL' }]] } },
      });
      expect(r.valid).toBe(true);
    });

    it('accepts a fan-out (one source to multiple targets on same port)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'A',       type: 'n8n-nodes-base.slack' },
          { name: 'B',       type: 'n8n-nodes-base.airtable' },
        ],
        connections: {
          Trigger: { main: [[{ node: 'A' }, { node: 'B' }]] },
        },
      });
      expect(r.valid).toBe(true);
    });

    it('accepts a terminal node with no outgoing connections', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'End',     type: 'n8n-nodes-base.slack' },
        ],
        connections: { Trigger: { main: [[{ node: 'End' }]] } },
      });
      expect(r.valid).toBe(true);
    });

    it('produces no errors for empty connections object (isolated single trigger)', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

  });

  // ── INVALID_WORKFLOW ──────────────────────────────────────────────────────

  describe('INVALID_WORKFLOW', () => {

    it.each([null, undefined, 42, 'string', true, [1, 2, 3]])(
      'rejects non-object input: %j',
      (input) => {
        const r = validateWorkflow(input);
        expect(r.valid).toBe(false);
        expect(hasError(r, ValidationCodes.INVALID_WORKFLOW)).toBe(true);
      },
    );

  });

  // ── MISSING_NODES ─────────────────────────────────────────────────────────

  describe('MISSING_NODES', () => {

    it('fails when nodes is absent', () => {
      const r = validateWorkflow({ connections: {} });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.MISSING_NODES)).toBe(true);
    });

    it('fails when nodes is null', () => {
      const r = validateWorkflow({ nodes: null, connections: {} });
      expect(hasError(r, ValidationCodes.MISSING_NODES)).toBe(true);
    });

    it('fails when nodes is a string', () => {
      const r = validateWorkflow({ nodes: 'oops', connections: {} });
      expect(hasError(r, ValidationCodes.MISSING_NODES)).toBe(true);
    });

  });

  // ── EMPTY_WORKFLOW ────────────────────────────────────────────────────────

  describe('EMPTY_WORKFLOW', () => {

    it('fails when nodes is an empty array', () => {
      const r = validateWorkflow({ nodes: [], connections: {} });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.EMPTY_WORKFLOW)).toBe(true);
    });

  });

  // ── MISSING_CONNECTIONS ───────────────────────────────────────────────────

  describe('MISSING_CONNECTIONS', () => {

    it('fails when connections is absent', () => {
      const r = validateWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }] });
      expect(hasError(r, ValidationCodes.MISSING_CONNECTIONS)).toBe(true);
    });

    it('fails when connections is null', () => {
      const r = validateWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }], connections: null });
      expect(hasError(r, ValidationCodes.MISSING_CONNECTIONS)).toBe(true);
    });

    it('fails when connections is an array', () => {
      const r = validateWorkflow({ nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }], connections: [] });
      expect(hasError(r, ValidationCodes.MISSING_CONNECTIONS)).toBe(true);
    });

  });

  // ── MISSING_NODE_NAME ─────────────────────────────────────────────────────

  describe('MISSING_NODE_NAME', () => {

    it('fails when a node has no name field', () => {
      const r = validateWorkflow({
        nodes: [{ type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

    it('fails when name is an empty string', () => {
      const r = validateWorkflow({
        nodes: [{ name: '', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

    it('fails when name is whitespace only', () => {
      const r = validateWorkflow({
        nodes: [{ name: '   ', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

    it('fails when name is a number', () => {
      const r = validateWorkflow({
        nodes: [{ name: 42, type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

    it('fails when a node element is not an object', () => {
      const r = validateWorkflow({
        nodes: ['not-an-object'],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
    });

  });

  // ── MISSING_NODE_TYPE ─────────────────────────────────────────────────────

  describe('MISSING_NODE_TYPE', () => {

    it('fails when a node has no type field', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_TYPE)).toBe(true);
    });

    it('fails when type is an empty string', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: '' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_TYPE)).toBe(true);
    });

    it('fails when type is whitespace only', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: '\t\n' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_TYPE)).toBe(true);
    });

    it('includes the node index in the path', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'B', type: '' },
        ],
        connections: {},
      });
      const err = r.errors.find(e => e.code === ValidationCodes.MISSING_NODE_TYPE);
      expect(err?.path).toContain('nodes[1]');
    });

  });

  // ── DUPLICATE_NODE_NAME ───────────────────────────────────────────────────

  describe('DUPLICATE_NODE_NAME', () => {

    it('fails when two nodes share the same name', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Slack', type: 'n8n-nodes-base.webhook' },
          { name: 'Slack', type: 'n8n-nodes-base.slack' },
        ],
        connections: {},
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.DUPLICATE_NODE_NAME)).toBe(true);
    });

    it('reports the second occurrence index in path', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Dup', type: 'n8n-nodes-base.webhook' },
          { name: 'Dup', type: 'n8n-nodes-base.slack' },
        ],
        connections: {},
      });
      const err = r.errors.find(e => e.code === ValidationCodes.DUPLICATE_NODE_NAME);
      expect(err?.path).toContain('nodes[1]');
    });

    it('fails for three nodes with the same name (reports both duplicates)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'X', type: 'n8n-nodes-base.webhook' },
          { name: 'X', type: 'n8n-nodes-base.slack' },
          { name: 'X', type: 'n8n-nodes-base.airtable' },
        ],
        connections: {},
      });
      const dupErrors = r.errors.filter(e => e.code === ValidationCodes.DUPLICATE_NODE_NAME);
      expect(dupErrors.length).toBeGreaterThanOrEqual(2);
    });

  });

  // ── WORKFLOW_TOO_LARGE ────────────────────────────────────────────────────

  describe('WORKFLOW_TOO_LARGE', () => {

    it('fails when node count exceeds 200', () => {
      const nodes = Array.from({ length: 201 }, (_, i) => ({
        name: `N${i}`,
        type: i === 0 ? 'n8n-nodes-base.webhook' : 'n8n-nodes-base.slack',
      }));
      const r = validateWorkflow({ nodes, connections: {} });
      expect(hasError(r, ValidationCodes.WORKFLOW_TOO_LARGE)).toBe(true);
    });

    it('accepts exactly 200 nodes', () => {
      const nodes = Array.from({ length: 200 }, (_, i) => ({
        name: `N${i}`,
        type: i === 0 ? 'n8n-nodes-base.webhook' : 'n8n-nodes-base.slack',
      }));
      const connections: Record<string, { main: { node: string }[][] }> = {};
      for (let i = 0; i < 199; i++) {
        connections[`N${i}`] = { main: [[{ node: `N${i + 1}` }]] };
      }
      const r = validateWorkflow({ nodes, connections });
      expect(hasError(r, ValidationCodes.WORKFLOW_TOO_LARGE)).toBe(false);
    });

    it('fails when edge count exceeds 1000', () => {
      // Trigger with 1001 edges to the same target
      const targets = Array.from({ length: 1001 }, () => ({ node: 'End' }));
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'End',     type: 'n8n-nodes-base.slack' },
        ],
        connections: { Trigger: { main: [targets] } },
      });
      expect(hasError(r, ValidationCodes.WORKFLOW_TOO_LARGE)).toBe(true);
    });

  });

  // ── UNKNOWN_SOURCE_NODE ───────────────────────────────────────────────────

  describe('UNKNOWN_SOURCE_NODE', () => {

    it('fails when a connection source does not match any node name', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'Trigger', type: 'n8n-nodes-base.webhook' }],
        connections: {
          Ghost: { main: [[{ node: 'Trigger' }]] },
        },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNKNOWN_SOURCE_NODE)).toBe(true);
    });

    it('includes the source name in the error path', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: { NoSuchNode: { main: [[{ node: 'T' }]] } },
      });
      const err = r.errors.find(e => e.code === ValidationCodes.UNKNOWN_SOURCE_NODE);
      expect(err?.path).toContain('NoSuchNode');
    });

  });

  // ── UNKNOWN_TARGET_NODE ───────────────────────────────────────────────────

  describe('UNKNOWN_TARGET_NODE', () => {

    it('fails when a connection target does not match any node name', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'Trigger', type: 'n8n-nodes-base.webhook' }],
        connections: {
          Trigger: { main: [[{ node: 'Ghost' }]] },
        },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNKNOWN_TARGET_NODE)).toBe(true);
    });

    it('includes the target name and port index in the error path', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: { T: { main: [[{ node: 'Missing' }]] } },
      });
      const err = r.errors.find(e => e.code === ValidationCodes.UNKNOWN_TARGET_NODE);
      expect(err?.message).toContain('Missing');
    });

    it('reports multiple unknown targets independently', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {
          T: { main: [[{ node: 'A' }, { node: 'B' }]] },
        },
      });
      const targetErrors = r.errors.filter(e => e.code === ValidationCodes.UNKNOWN_TARGET_NODE);
      expect(targetErrors.length).toBe(2);
    });

  });

  // ── NO_START_NODE ─────────────────────────────────────────────────────────

  describe('NO_START_NODE', () => {

    it('fails when no node has a trigger/webhook type', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.slack' },
          { name: 'B', type: 'n8n-nodes-base.airtable' },
        ],
        connections: { A: { main: [[{ node: 'B' }]] } },
      });
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(true);
    });

    it('accepts a node whose type contains "trigger" anywhere', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'ST', type: 'n8n-nodes-base.shopifyTrigger' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(false);
    });

    it('accepts a node whose type contains "webhook" anywhere', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'WH', type: 'custom.myWebhookNode' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(false);
    });

    it('accepts "manualTrigger" type', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'MT', type: 'n8n-nodes-base.manualTrigger' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(false);
    });

  });

  // ── INVALID_CONDITION_PORTS ───────────────────────────────────────────────

  describe('INVALID_CONDITION_PORTS', () => {

    it('fails when an IF node has no entry in connections', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'Check',   type: 'n8n-nodes-base.if' },
        ],
        connections: { Trigger: { main: [[{ node: 'Check' }]] } },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
    });

    it('fails when a condition node has only one output port', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'Check',   type: 'n8n-nodes-base.if' },
          { name: 'Action',  type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          Trigger: { main: [[{ node: 'Check' }]] },
          Check:   { main: [[{ node: 'Action' }]] }, // only port[0] — no port[1]
        },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
    });

    it('accepts a condition node with exactly two output ports', () => {
      const r = validateWorkflow(VALID_CONDITION);
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(false);
    });

    it('accepts a condition node with two EMPTY ports (no targets yet)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'C', type: 'n8n-nodes-base.if' },
        ],
        connections: {
          T: { main: [[{ node: 'C' }]] },
          C: { main: [[], []] }, // 2 ports, both empty
        },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(false);
    });

    it('treats "switch" type as a condition node requiring 2 ports', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'SW', type: 'n8n-nodes-base.switch' },
        ],
        connections: { T: { main: [[{ node: 'SW' }]] } },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
    });

    it('treats "filter" type as a condition node requiring 2 ports', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'FL', type: 'n8n-nodes-base.filter' },
        ],
        connections: { T: { main: [[{ node: 'FL' }]] } },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(true);
    });

    // Critical: 'shopify'.includes('if') === true, but shopify is a PROVIDER
    // type in the exact allowlist and must NOT require condition ports.
    it('does NOT require condition ports for n8n-nodes-base.shopify (shopify contains "if")', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
          { name: 'Shop',    type: 'n8n-nodes-base.shopify' },
        ],
        connections: {
          Trigger: { main: [[{ node: 'Shop' }]] },
        },
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(false);
      expect(r.valid).toBe(true);
    });

    // Same guard for shopifyTrigger
    it('does NOT require condition ports for n8n-nodes-base.shopifyTrigger', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'ST', type: 'n8n-nodes-base.shopifytrigger' }],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.INVALID_CONDITION_PORTS)).toBe(false);
    });

    it('error message includes the node name and found port count', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'C', type: 'n8n-nodes-base.if' },
        ],
        connections: { T: { main: [[{ node: 'C' }]] } },
      });
      const err = r.errors.find(e => e.code === ValidationCodes.INVALID_CONDITION_PORTS);
      expect(err?.message).toContain('C');
      expect(err?.message).toContain('0');
    });

  });

  // ── GRAPH_CYCLE_DETECTED ──────────────────────────────────────────────────

  describe('GRAPH_CYCLE_DETECTED', () => {

    it('detects a simple 2-node cycle: A → B → A', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'B', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          A: { main: [[{ node: 'B' }]] },
          B: { main: [[{ node: 'A' }]] },
        },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
    });

    it('detects a 3-node cycle: A → B → C → A', () => {
      const r = validateWorkflow({
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
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
      const err = r.errors.find(e => e.code === ValidationCodes.GRAPH_CYCLE_DETECTED);
      // Message must contain all cycle nodes
      expect(err?.message).toContain('A');
      expect(err?.message).toContain('B');
      expect(err?.message).toContain('C');
    });

    it('detects a self-loop: A → A', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'A', type: 'n8n-nodes-base.webhook' }],
        connections: {
          A: { main: [[{ node: 'A' }]] },
        },
      });
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(true);
    });

    it('does not report a cycle for a valid DAG', () => {
      const r = validateWorkflow(VALID_LINEAR);
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(false);
    });

    it('does not report a cycle for a condition DAG (diamond)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',     type: 'n8n-nodes-base.webhook' },
          { name: 'Check', type: 'n8n-nodes-base.if' },
          { name: 'True',  type: 'n8n-nodes-base.slack' },
          { name: 'False', type: 'n8n-nodes-base.emailsend' },
        ],
        connections: {
          T:     { main: [[{ node: 'Check' }]] },
          Check: { main: [[{ node: 'True' }], [{ node: 'False' }]] },
        },
      });
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(false);
    });

    it('skips cycle detection when connections have unknown targets', () => {
      // Unknown target makes graph incomplete — cycle detection would be unreliable
      const r = validateWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.webhook' },
          { name: 'B', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          A: { main: [[{ node: 'Ghost' }]] },  // unknown target
          B: { main: [[{ node: 'A'     }]] },
        },
      });
      // UNKNOWN_TARGET_NODE must be reported
      expect(hasError(r, ValidationCodes.UNKNOWN_TARGET_NODE)).toBe(true);
      // Cycle check is skipped — no false GRAPH_CYCLE_DETECTED
      expect(hasError(r, ValidationCodes.GRAPH_CYCLE_DETECTED)).toBe(false);
    });

  });

  // ── UNREACHABLE_NODE (warning) ─────────────────────────────────────────────

  describe('UNREACHABLE_NODE', () => {

    it('warns about a node with no incoming edges and no start-node type', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'Trigger',  type: 'n8n-nodes-base.webhook' },
          { name: 'Slack',    type: 'n8n-nodes-base.slack' },
          { name: 'Isolated', type: 'n8n-nodes-base.airtable' }, // never connected
        ],
        connections: {
          Trigger: { main: [[{ node: 'Slack' }]] },
        },
      });
      expect(r.valid).toBe(true);   // warning only, not an error
      expect(hasWarning(r, ValidationCodes.UNREACHABLE_NODE)).toBe(true);
      const warn = r.warnings.find(w => w.code === ValidationCodes.UNREACHABLE_NODE);
      expect(warn?.message).toContain('Isolated');
    });

    it('warns about multiple isolated nodes', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'I1', type: 'n8n-nodes-base.slack' },
          { name: 'I2', type: 'n8n-nodes-base.airtable' },
        ],
        connections: {},
      });
      const unreachable = r.warnings.filter(w => w.code === ValidationCodes.UNREACHABLE_NODE);
      // I1 and I2 are unreachable (T is a start node and visits only itself)
      expect(unreachable.length).toBe(2);
    });

    it('does not warn when all nodes are reachable', () => {
      const r = validateWorkflow(VALID_LINEAR);
      expect(hasWarning(r, ValidationCodes.UNREACHABLE_NODE)).toBe(false);
    });

    it('does not warn about unreachable nodes when there is no start node', () => {
      // NO_START_NODE error takes precedence; no false unreachability warnings
      const r = validateWorkflow({
        nodes: [
          { name: 'A', type: 'n8n-nodes-base.slack' },
          { name: 'B', type: 'n8n-nodes-base.airtable' },
        ],
        connections: { A: { main: [[{ node: 'B' }]] } },
      });
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(true);
      expect(hasWarning(r, ValidationCodes.UNREACHABLE_NODE)).toBe(false);
    });

  });

  // ── UNSUPPORTED_NODE_CAPABILITY (hard error — Phase 9.1.6) ────────────────
  //
  // Was a warning-only UNKNOWN_NODE_TYPE before Phase 9.1.6; upgraded to a
  // hard error so an unsupported/unsafe node can never reach
  // activateWorkflow(). See lib/workflow-runtime/node-capabilities.ts.

  describe('UNSUPPORTED_NODE_CAPABILITY', () => {

    it('rejects a type not in any known registry', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'X',  type: 'company.myCustomNode' },  // unknown
        ],
        connections: { T: { main: [[{ node: 'X' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
      const err = r.errors.find(e => e.code === ValidationCodes.UNSUPPORTED_NODE_CAPABILITY);
      // User-safe message: the node's own (user-given) name is fine, but the
      // raw internal type string must never leak (Phase 9.1.6 Step E).
      expect(err?.message).toContain('X');
      expect(err?.message).not.toContain('company.myCustomNode');
    });

    it('does not reject provider types from HANDLER_NODE_ALLOWLIST', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'SL', type: 'n8n-nodes-base.slack' },
        ],
        connections: { T: { main: [[{ node: 'SL' }]] } },
      });
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(false);
    });

    it('does not reject safe generic types (wait, code, if, etc.)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'W', type: 'n8n-nodes-base.wait' },
        ],
        connections: { T: { main: [[{ node: 'W' }]] } },
      });
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(false);
    });

    it('does not reject the set node (Phase 9.1.6 implemented handler)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'S', type: 'n8n-nodes-base.set' },
        ],
        connections: { T: { main: [[{ node: 'S' }]] } },
      });
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(false);
    });

    it('includes the node path in the error', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'U', type: 'totally.unknown' },
        ],
        connections: { T: { main: [[{ node: 'U' }]] } },
      });
      const err = r.errors.find(e => e.code === ValidationCodes.UNSUPPORTED_NODE_CAPABILITY);
      expect(err?.path).toContain('nodes[1]');
    });

    it('rejects errorTrigger even though it matches the generic "trigger" substring', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'EH', type: 'n8n-nodes-base.errorTrigger' },
        ],
        connections: { T: { main: [[{ node: 'EH' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
    });

    it('rejects gmailTrigger even though it is in PROVIDER_EXACT_TYPES', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'GT', type: 'n8n-nodes-base.gmailTrigger' },
        ],
        connections: { T: { main: [[{ node: 'GT' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
    });

    it('rejects googleDrive even though it is in PROVIDER_EXACT_TYPES (known, honest stub — no credential path yet)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T',  type: 'n8n-nodes-base.webhook' },
          { name: 'GD', type: 'n8n-nodes-base.googleDrive' },
        ],
        connections: { T: { main: [[{ node: 'GD' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
    });

    it('rejects a wait node configured with resume:"webhook" (the Approval Step block)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.wait', parameters: { resume: 'webhook', options: { webhookSuffix: 'approval' } } },
        ],
        connections: { T: { main: [[{ node: 'A' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
    });

    it('does not reject an ordinary duration-based wait node', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'W', type: 'n8n-nodes-base.wait', parameters: { amount: 30 } },
        ],
        connections: { T: { main: [[{ node: 'W' }]] } },
      });
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(false);
    });

  });

  // ── Multiple errors in one pass ───────────────────────────────────────────

  describe('multiple errors in one pass', () => {

    it('reports MISSING_NODE_NAME and MISSING_NODE_TYPE on separate nodes', () => {
      const r = validateWorkflow({
        nodes: [
          { type: 'n8n-nodes-base.webhook' },  // missing name
          { name: 'B' },                          // missing type
        ],
        connections: {},
      });
      expect(hasError(r, ValidationCodes.MISSING_NODE_NAME)).toBe(true);
      expect(hasError(r, ValidationCodes.MISSING_NODE_TYPE)).toBe(true);
    });

    it('reports UNKNOWN_SOURCE_NODE alongside NO_START_NODE', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'A', type: 'n8n-nodes-base.slack' }],
        connections: { Ghost: { main: [[{ node: 'A' }]] } },
      });
      expect(hasError(r, ValidationCodes.UNKNOWN_SOURCE_NODE)).toBe(true);
      expect(hasError(r, ValidationCodes.NO_START_NODE)).toBe(true);
    });

    it('an otherwise-well-formed workflow with one unsupported node type is invalid (Phase 9.1.6)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'X', type: 'my.exoticNode' },
        ],
        connections: { T: { main: [[{ node: 'X' }]] } },
      });
      expect(r.valid).toBe(false);
      expect(hasError(r, ValidationCodes.UNSUPPORTED_NODE_CAPABILITY)).toBe(true);
      expect(r.errors).toHaveLength(1);
    });

  });

  // ── ValidationResult shape ────────────────────────────────────────────────

  describe('ValidationResult shape', () => {

    it('returns valid:true only when errors array is empty', () => {
      const r = validateWorkflow(VALID_LINEAR);
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('always returns errors and warnings arrays (never undefined)', () => {
      const r1 = validateWorkflow(null);
      expect(Array.isArray(r1.errors)).toBe(true);
      expect(Array.isArray(r1.warnings)).toBe(true);

      const r2 = validateWorkflow(VALID_LINEAR);
      expect(Array.isArray(r2.errors)).toBe(true);
      expect(Array.isArray(r2.warnings)).toBe(true);
    });

    it('every error has a code and message', () => {
      const r = validateWorkflow({ nodes: [], connections: {} });
      for (const err of r.errors) {
        expect(typeof err.code).toBe('string');
        expect(err.code.length).toBeGreaterThan(0);
        expect(typeof err.message).toBe('string');
        expect(err.message.length).toBeGreaterThan(0);
      }
    });

    it('every warning has a code and message', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'X', type: 'custom.unknown' },
        ],
        connections: { T: { main: [[{ node: 'X' }]] } },
      });
      for (const warn of r.warnings) {
        expect(typeof warn.code).toBe('string');
        expect(typeof warn.message).toBe('string');
      }
    });

  });

  // ── Robustness / malformed inputs ─────────────────────────────────────────

  describe('robustness with malformed inputs', () => {

    it('tolerates connection entries that are not objects (skips them)', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          T: { main: [[null, undefined, 42, { node: 'A' }]] },
        },
      });
      // Only the valid entry `{ node: 'A' }` should be processed
      expect(r.valid).toBe(true);
    });

    it('tolerates a connection value that is not a plain object', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
        ],
        connections: {
          T: 'not-an-object',  // invalid connection data
        },
      });
      // T is a valid node with no outgoing edges — still valid
      expect(r.valid).toBe(true);
    });

    it('tolerates a port that is not an array', () => {
      const r = validateWorkflow({
        nodes: [
          { name: 'T', type: 'n8n-nodes-base.webhook' },
          { name: 'A', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          T: { main: [null, [{ node: 'A' }]] },  // first port is null
        },
      });
      // Should not crash; null port becomes empty port
      expect(r.valid).toBe(true);
    });

    it('handles a workflow with no name field', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {},
      });
      expect(r.valid).toBe(true);
    });

    it('handles extra unknown fields on nodes without failing', () => {
      const r = validateWorkflow({
        nodes: [{
          name: 'T',
          type: 'n8n-nodes-base.webhook',
          id: 'abc-123',
          position: [100, 200],
          meta: { author: 'test' },
        }],
        connections: {},
      });
      expect(r.valid).toBe(true);
    });

    it('handles a connection entry with a blank node target (skips it)', () => {
      const r = validateWorkflow({
        nodes: [{ name: 'T', type: 'n8n-nodes-base.webhook' }],
        connections: {
          T: { main: [[{ node: '' }]] },  // blank target — should be skipped
        },
      });
      // No UNKNOWN_TARGET_NODE because blank targets are skipped
      expect(hasError(r, ValidationCodes.UNKNOWN_TARGET_NODE)).toBe(false);
    });

  });

  // ── ValidationCodes export ────────────────────────────────────────────────

  describe('ValidationCodes export', () => {

    it('exports all expected code constants', () => {
      const expected = [
        'INVALID_WORKFLOW', 'MISSING_NODES', 'EMPTY_WORKFLOW', 'MISSING_CONNECTIONS',
        'MISSING_NODE_NAME', 'MISSING_NODE_TYPE', 'DUPLICATE_NODE_NAME',
        'UNKNOWN_SOURCE_NODE', 'UNKNOWN_TARGET_NODE',
        'NO_START_NODE', 'INVALID_CONDITION_PORTS', 'GRAPH_CYCLE_DETECTED',
        'WORKFLOW_TOO_LARGE', 'UNREACHABLE_NODE', 'UNSUPPORTED_NODE_CAPABILITY',
      ];
      for (const code of expected) {
        expect(ValidationCodes).toHaveProperty(code);
        expect(ValidationCodes[code as keyof typeof ValidationCodes]).toBe(code);
      }
    });

  });

});
