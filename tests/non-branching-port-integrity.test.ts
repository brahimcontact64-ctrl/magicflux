/**
 * Phase 9.9.3.1 — Non-Branching Port Integrity.
 *
 * The inverse of the Phase 9.9.0 branch-collapse check: a node that never
 * produces _conditionBranch (any type NOT covered by isConditionalNodeType)
 * must have AT MOST ONE output-port array in "main". Multiple TARGETS inside
 * that single port (fan-out) stay completely valid; multiple separate PORTS
 * do not, because the runtime's "conditionBranch === null" fallback fires
 * every port that exists.
 *
 * Includes an exact regression fixture reproducing the Phase 9.9.4
 * acceptance finding: a magicflux-nodes.aiClassifier node (genuinely
 * non-branching -- see ai-classifier.ts) generated with two separate output
 * ports (main[0] -> Airtable Save, main[1] -> Human Review), which the
 * runtime would have fired unconditionally on every execution.
 */

import { describe, it, expect } from 'vitest';
import { validateBranchConnections } from '../lib/agent/branch-connection-guard';

const AI_CLASSIFIER_NODE = {
  id: '1', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
  parameters: { instruction: 'Classify the lead.', allowedLabels: ['Hot', 'Warm', 'Cold'], confidenceThreshold: 0.6 },
};
const IF_NODE = { id: '2', name: 'Needs Review?', type: 'n8n-nodes-base.if', parameters: {} };
const HUMAN_REVIEW_NODE = { id: '3', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: {} };
const AIRTABLE_NODE = { id: '4', name: 'Airtable Save', type: 'n8n-nodes-base.airtable', parameters: {} };
const SET_NODE = { id: '5', name: 'Mark Cold', type: 'n8n-nodes-base.set', parameters: {} };

describe('validateBranchConnections -- non-branching node inverse check', () => {
  it('accepts a non-branching node with exactly one output port', () => {
    const connections = { 'AI Classifier': { main: [[{ node: 'Needs Review?', type: 'main', index: 0 }]] } };
    const result = validateBranchConnections([AI_CLASSIFIER_NODE, IF_NODE], connections);
    expect(result).toEqual({ ok: true });
  });

  it('accepts a non-branching node with one port fanning out to multiple targets', () => {
    const connections = {
      'AI Classifier': {
        main: [[
          { node: 'Needs Review?', type: 'main', index: 0 },
          { node: 'Airtable Save', type: 'main', index: 0 },
        ]],
      },
    };
    const result = validateBranchConnections([AI_CLASSIFIER_NODE, IF_NODE, AIRTABLE_NODE], connections);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a non-branching node wired with 2+ separate output ports', () => {
    const connections = {
      'Mark Cold': {
        main: [
          [{ node: 'Airtable Save', type: 'main', index: 0 }],
          [{ node: 'Human Review', type: 'main', index: 0 }],
        ],
      },
    };
    const result = validateBranchConnections([SET_NODE, AIRTABLE_NODE, HUMAN_REVIEW_NODE], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Mark Cold');
      expect(result.code).toBe('malformed_non_branching_connections');
      expect(result.reason).toMatch(/at most one output port/i);
    }
  });

  it('rejects an AI Classifier node specifically wired with two ports (the Phase 9.9.4 regression, minimal form)', () => {
    const connections = {
      'AI Classifier': {
        main: [
          [{ node: 'Airtable Save', type: 'main', index: 0 }],
          [{ node: 'Human Review', type: 'main', index: 0 }],
        ],
      },
    };
    const result = validateBranchConnections([AI_CLASSIFIER_NODE, AIRTABLE_NODE, HUMAN_REVIEW_NODE], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('AI Classifier');
      expect(result.code).toBe('malformed_non_branching_connections');
    }
  });

  it('exact Phase 9.9.4 regression graph: AI Classifier -> [Airtable Save, Human Review] is rejected end-to-end', () => {
    const nodes = [
      { id: 'trigger', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} },
      AI_CLASSIFIER_NODE,
      HUMAN_REVIEW_NODE,
      AIRTABLE_NODE,
      { id: 'ifHot', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: {} },
    ];
    const connections = {
      'Webhook Trigger': { main: [[{ node: 'AI Classifier', type: 'main', index: 0 }]] },
      'AI Classifier': {
        main: [
          [{ node: 'Airtable Save', type: 'main', index: 0 }],
          [{ node: 'Human Review', type: 'main', index: 0 }],
        ],
      },
      'Airtable Save': { main: [[{ node: 'If Hot', type: 'main', index: 0 }]] },
      'Human Review': { main: [[{ node: 'Airtable Save', type: 'main', index: 0 }], [], []] },
    };
    const result = validateBranchConnections(nodes, connections);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('AI Classifier');
      expect(result.code).toBe('malformed_non_branching_connections');
    }
  });

  it('IF nodes still require 2+ ports (unaffected by the inverse check)', () => {
    const connections = { 'Needs Review?': { main: [[{ node: 'Human Review' }]] } };
    const result = validateBranchConnections([IF_NODE, HUMAN_REVIEW_NODE], connections);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('malformed_branch_connections');
  });

  it('IF nodes with exactly two ports are accepted', () => {
    const connections = {
      'Needs Review?': {
        main: [[{ node: 'Human Review', type: 'main', index: 0 }], [{ node: 'Mark Cold', type: 'main', index: 0 }]],
      },
    };
    expect(validateBranchConnections([IF_NODE, HUMAN_REVIEW_NODE, SET_NODE], connections)).toEqual({ ok: true });
  });

  it('Human Review nodes with multiple outcome ports are accepted (it genuinely branches)', () => {
    const connections = {
      'Human Review': {
        main: [
          [{ node: 'Mark Cold', type: 'main', index: 0 }],
          [{ node: 'Airtable Save', type: 'main', index: 0 }],
          [],
        ],
      },
    };
    expect(validateBranchConnections([HUMAN_REVIEW_NODE, SET_NODE, AIRTABLE_NODE], connections)).toEqual({ ok: true });
  });

  it('the corrected topology -- AI Classifier -> IF needs_review -> Human Review -- is accepted', () => {
    const nodes = [AI_CLASSIFIER_NODE, IF_NODE, HUMAN_REVIEW_NODE, SET_NODE];
    const connections = {
      'AI Classifier': { main: [[{ node: 'Needs Review?', type: 'main', index: 0 }]] },
      'Needs Review?': {
        main: [[{ node: 'Human Review', type: 'main', index: 0 }], [{ node: 'Mark Cold', type: 'main', index: 0 }]],
      },
    };
    expect(validateBranchConnections(nodes, connections)).toEqual({ ok: true });
  });
});
