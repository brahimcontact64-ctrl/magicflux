/**
 * Phase 9.9.0 — Complex Workflow Branching Integrity.
 *
 * Deterministic, generation-time backstop: rejects a workflow BEFORE
 * persistence whenever a conditional (if/switch/condition/filter) node's
 * connections collapse true/false branches into a single output-port array
 * instead of separate main[0]/main[1] entries — the exact malformed shape
 * found in the production lead-routing workflow, which rendered fine in the
 * Builder but made runtime/workflow-engine.ts execute identical downstream
 * nodes regardless of the branch actually taken.
 */

import { describe, it, expect } from 'vitest';
import { validateBranchConnections } from '../lib/agent/branch-connection-guard';

const IF_NODE = { id: '1', name: 'Lead Classification', type: 'n8n-nodes-base.if', parameters: {} };
const AIRTABLE_NODE = { id: '2', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: {} };
const HUMAN_REVIEW_NODE = { id: '3', name: 'Human Review', type: 'n8n-nodes-base.set', parameters: {} };

describe('validateBranchConnections', () => {
  it('accepts a well-formed if node with separate main[0]/main[1] arrays', () => {
    const connections = {
      'Lead Classification': {
        main: [
          [{ node: 'Save to Airtable', type: 'main', index: 0 }],
          [{ node: 'Human Review', type: 'main', index: 0 }],
        ],
      },
    };
    expect(validateBranchConnections([IF_NODE, AIRTABLE_NODE, HUMAN_REVIEW_NODE], connections)).toEqual({ ok: true });
  });

  it('accepts a well-formed if node where one branch deliberately has zero targets (empty array, not absent)', () => {
    const connections = {
      'Lead Classification': {
        main: [
          [{ node: 'Save to Airtable', type: 'main', index: 0 }],
          [],
        ],
      },
    };
    expect(validateBranchConnections([IF_NODE, AIRTABLE_NODE], connections)).toEqual({ ok: true });
  });

  it('rejects the exact production regression: both branches collapsed into main[0]', () => {
    const connections = {
      'Lead Classification': {
        main: [
          [
            { node: 'Save to Airtable', type: 'main', index: 0 },
            { node: 'Human Review', type: 'main', index: 1 },
          ],
        ],
      },
    };
    const result = validateBranchConnections([IF_NODE, AIRTABLE_NODE, HUMAN_REVIEW_NODE], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Lead Classification');
      expect(result.reason).toMatch(/collapses its branches/i);
    }
  });

  it('rejects a conditional node whose "main" is not an array at all', () => {
    const connections = { 'Lead Classification': { main: 'not-an-array' } };
    const result = validateBranchConnections([IF_NODE], connections);
    expect(result.ok).toBe(false);
  });

  it('rejects a conditional node with a malformed (non-array) output port', () => {
    const connections = { 'Lead Classification': { main: [null, [{ node: 'X' }]] } };
    const result = validateBranchConnections([IF_NODE], connections);
    expect(result.ok).toBe(false);
  });

  it('rejects a connection target with no valid node name', () => {
    const connections = {
      'Lead Classification': { main: [[{ node: '' }], [{ node: 'Human Review' }]] },
    };
    const result = validateBranchConnections([IF_NODE, HUMAN_REVIEW_NODE], connections);
    expect(result.ok).toBe(false);
  });

  it('is a no-op for a conditional node with no outgoing connections at all (a dead-end branch is not this guard\'s concern)', () => {
    expect(validateBranchConnections([IF_NODE], {})).toEqual({ ok: true });
  });

  it('ignores non-conditional nodes entirely, regardless of how their connections are shaped', () => {
    const connections = {
      'Save to Airtable': {
        main: [[{ node: 'Slack Notification' }, { node: 'Send Email' }]],
      },
    };
    expect(validateBranchConnections([AIRTABLE_NODE], connections)).toEqual({ ok: true });
  });

  it('recognizes switch/condition/filter-typed nodes as conditional too, not only "if"', () => {
    const switchNode = { id: '4', name: 'Router', type: 'n8n-nodes-base.switch', parameters: {} };
    const connections = { Router: { main: [[{ node: 'A' }, { node: 'B' }]] } };
    const result = validateBranchConnections([switchNode], connections);
    expect(result.ok).toBe(false);
  });

  it('handles malformed/non-array nodes input safely', () => {
    expect(validateBranchConnections(undefined as unknown as unknown[], {})).toEqual({ ok: true });
    expect(validateBranchConnections([null, 42, 'x', {}], {})).toEqual({ ok: true });
  });
});
