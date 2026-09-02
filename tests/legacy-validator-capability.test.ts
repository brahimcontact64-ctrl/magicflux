/**
 * Phase 9.4.3 Step E — lib/validator (the deterministic-Blocks-based
 * scorer used by the live canonical /builder flow, distinct from
 * lib/workflow-validator which the editor page uses -- both existed,
 * only the latter had capability-truth test coverage before this phase)
 * must not independently disagree with
 * lib/workflow-runtime/node-capabilities.ts and score a capability-blocked
 * node as deployment-ready.
 *
 * lib/planner's assertNodesAreCapable() already prevents FRESH generation
 * from ever producing one of these (tests/node-capabilities.test.ts
 * covers that upstream guard) -- this proves the scorer itself is also
 * correct in isolation, for any composition that reaches it some other
 * way (a saved/edited plan re-validated, a future call site), rather than
 * relying solely on the planner never sending it a bad one.
 */

import { describe, it, expect } from 'vitest';
import { createAutomationPlan } from '../lib/planner';
import { validateWorkflow } from '../lib/validator';
import { BLOCKS } from '../lib/blocks';

function basePlan() {
  // A genuinely supported prompt -- the deterministic keyword planner is
  // synchronous and calls no external APIs, so this is fast and reliable.
  return createAutomationPlan('When a webhook is received, send a slack message');
}

describe('lib/validator validateWorkflow() — capability truth', () => {
  it('a genuinely supported workflow scores as deployment-ready', () => {
    const { plan, composition, n8nJson } = basePlan();
    const result = validateWorkflow(plan, composition, n8nJson);
    expect(result.valid).toBe(true);
    expect(result.deploymentReady).toBe(true);
    expect(result.errors.some((e) => e.code === 'CAPABILITY_UNAVAILABLE')).toBe(false);
  });

  it('an approval/human-in-the-loop step (wait resume:"webhook") cannot score as deployment-ready even if it reaches the scorer directly', () => {
    const { plan, composition, n8nJson } = basePlan();
    const approvalBlock = BLOCKS.approval_node;
    expect(approvalBlock).toBeDefined();

    // Splice the approval block's real n8n node shape into an otherwise
    // valid, already-generated workflow -- simulating a composition that
    // reached validateWorkflow() without having passed through
    // assertNodesAreCapable() first (a saved/edited plan, a future call
    // site), the exact scenario this scorer must independently guard.
    const approvalNode = approvalBlock.buildN8nNode('approval_1', [999, 0], {});
    n8nJson.nodes.push(approvalNode);

    const result = validateWorkflow(plan, composition, n8nJson);
    expect(result.valid).toBe(false);
    expect(result.deploymentReady).toBe(false);
    const capabilityIssue = result.errors.find((e) => e.code === 'CAPABILITY_UNAVAILABLE');
    expect(capabilityIssue).toBeDefined();
    // user-safe: no raw node type, no internal jargon
    expect(capabilityIssue?.message).not.toContain('n8n-nodes-base');
    expect(capabilityIssue?.message).not.toContain('resume');
  });

  it('google_sheets_append, hubspot_create_contact, and twilio_sms all fail the same way if spliced in directly', () => {
    const blockedBlockIds = ['google_sheets_append', 'hubspot_create_contact', 'twilio_sms'] as const;
    for (const blockId of blockedBlockIds) {
      const { plan, composition, n8nJson } = basePlan();
      const block = BLOCKS[blockId];
      expect(block, blockId).toBeDefined();
      const node = block.buildN8nNode(`${blockId}_1`, [999, 0], {});
      n8nJson.nodes.push(node);

      const result = validateWorkflow(plan, composition, n8nJson);
      expect(result.deploymentReady, blockId).toBe(false);
      expect(result.errors.some((e) => e.code === 'CAPABILITY_UNAVAILABLE'), blockId).toBe(true);
    }
  });

  it('activationBlockReason and the deployment summary never mention n8n', () => {
    const { plan, composition, n8nJson } = basePlan();
    const result = validateWorkflow(plan, composition, n8nJson);
    expect(result.activationBlockReason.toLowerCase()).not.toContain('n8n');
    expect(result.summary.toLowerCase()).not.toContain('n8n');
  });
});
