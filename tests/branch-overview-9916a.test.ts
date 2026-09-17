/**
 * Phase 9.9.16A -- Part L found (via live browser certification) that
 * BranchOverviewPanel never rendered for a realistic reference-pattern
 * workflow: it used a hand-rolled `isConditional()` matching only
 * 'condition'/'switch'/'filter' substrings, so a plain 'n8n-nodes-base.if'
 * node (whose type segment is exactly "if", not a substring of
 * "condition") was never recognized as a branch point. Fixed by deriving
 * from the SAME authoritative isConditionalNodeType() every generation/
 * activation guard already shares. These tests lock the fix in.
 */
import { describe, it, expect } from 'vitest';
import { computeBranchOverview } from '../lib/workflow/branch-overview';

function classifierNode(labels = ['Hot', 'Warm', 'Cold']) {
  return { id: 'ai1', name: 'Classify', type: 'magicflux-nodes.aiClassifier', parameters: { allowedLabels: labels } };
}

describe('computeBranchOverview', () => {
  it('recognizes a plain n8n-nodes-base.if node as the branch point (the exact real-world case that was broken)', () => {
    const nodes = [
      classifierNode(['Hot', 'Cold']),
      { id: 'if1', name: 'Branch', type: 'n8n-nodes-base.if', parameters: {} },
      { id: 'at1', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: {} },
      { id: 'sl1', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
    ];
    const connections = {
      'Classify': { main: [[{ node: 'Branch' }]] },
      'Branch': { main: [[{ node: 'Save to Airtable' }, { node: 'Slack' }], []] },
    };
    const result = computeBranchOverview(nodes, connections);
    expect(result).not.toBeNull();
    expect(result!.branches).toHaveLength(2);
    expect(result!.labelsMatch).toBe(true);
    expect(result!.branches[0]).toEqual({ label: 'Hot', airtable: true, gmail: false, slack: true, sla: false });
    expect(result!.branches[1]).toEqual({ label: 'Cold', airtable: false, gmail: false, slack: false, sla: false });
  });

  it('recognizes Human Review itself as the branch point when it branches directly (no separate IF node)', () => {
    const nodes = [
      classifierNode(['Hot', 'Warm', 'Cold']),
      { id: 'hr1', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Hot', 'Warm', 'Cold'] } },
      { id: 'em1', name: 'Gmail', type: 'n8n-nodes-base.emailSend', parameters: {} },
    ];
    const connections = {
      'Classify': { main: [[{ node: 'Human Review' }]] },
      'Human Review': { main: [[{ node: 'Gmail' }], [], []] },
    };
    const result = computeBranchOverview(nodes, connections);
    expect(result).not.toBeNull();
    expect(result!.branches).toHaveLength(3);
    expect(result!.branches[0]).toEqual({ label: 'Hot', airtable: false, gmail: true, slack: false, sla: false });
  });

  it('finds the SLA node several hops downstream within one branch', () => {
    const nodes = [
      classifierNode(['Hot', 'Cold']),
      { id: 'if1', name: 'Branch', type: 'n8n-nodes-base.if', parameters: {} },
      { id: 'em1', name: 'Gmail', type: 'n8n-nodes-base.emailSend', parameters: {} },
      { id: 'ack1', name: 'Ack', type: 'magicflux-nodes.waitForAcknowledgment', parameters: {} },
    ];
    const connections = {
      'Classify': { main: [[{ node: 'Branch' }]] },
      'Branch': { main: [[{ node: 'Gmail' }], []] },
      'Gmail': { main: [[{ node: 'Ack' }]] },
    };
    const result = computeBranchOverview(nodes, connections);
    expect(result!.branches[0]).toEqual({ label: 'Hot', airtable: false, gmail: true, slack: false, sla: true });
  });

  it('falls back to numbered branches when the port count does not match allowedLabels.length', () => {
    const nodes = [
      classifierNode(['Hot', 'Warm', 'Cold']),
      { id: 'if1', name: 'Branch', type: 'n8n-nodes-base.if', parameters: {} },
    ];
    const connections = { 'Classify': { main: [[{ node: 'Branch' }]] }, 'Branch': { main: [[], []] } };
    const result = computeBranchOverview(nodes, connections);
    expect(result!.labelsMatch).toBe(false);
    expect(result!.branches.map((b) => b.label)).toEqual(['Branch 1', 'Branch 2']);
  });

  it('returns null when there is no AI classifier node at all', () => {
    expect(computeBranchOverview([{ id: 'x', name: 'x', type: 'n8n-nodes-base.webhook', parameters: {} }], {})).toBeNull();
  });

  it('returns null when no branch-deciding node is reachable from the classifier', () => {
    const nodes = [classifierNode(), { id: 'em1', name: 'Gmail', type: 'n8n-nodes-base.emailSend', parameters: {} }];
    const connections = { 'Classify': { main: [[{ node: 'Gmail' }]] } };
    expect(computeBranchOverview(nodes, connections)).toBeNull();
  });
});
