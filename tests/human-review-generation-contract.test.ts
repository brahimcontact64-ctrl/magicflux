/**
 * Phase 9.9.2 — source invariants pinning the Human Review generation
 * contract so it cannot silently regress: the generation prompt must
 * instruct the model to insert a real magicflux-nodes.humanReview node
 * (never Set/IF as a placeholder), and the deterministic post-generation
 * guard must actually run before persistence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generateWorkflowJson() prompt includes the Human Review contract (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('mandates the exact magicflux-nodes.humanReview type string', () => {
    expect(source).toMatch(/magicflux-nodes\.humanReview/);
  });

  it('explicitly forbids representing human review as Set or IF', () => {
    const lower = source.toLowerCase();
    expect(lower).toMatch(/never represent "human review"\/"approval" using n8n-nodes-base\.set/);
  });

  it('documents the required parameters: instruction, allowedOutcomes', () => {
    expect(source).toMatch(/"instruction"/);
    expect(source).toMatch(/"allowedOutcomes"/);
  });

  it('requires separate output-port arrays matching allowedOutcomes order, like an IF node', () => {
    expect(source.toLowerCase()).toMatch(/same order as "allowedoutcomes"/);
  });

  it('the deterministic human-review-claim guard runs before persistence', () => {
    const guardIdx = source.indexOf('validateHumanReviewClaim(');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(persistIdx);
  });
});

describe('generate_workflow_json tool schema mentions the human_review block (lib/agent/tools.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools.ts'), 'utf8');

  it('block_blueprint description mentions human_review', () => {
    const idx = source.indexOf('block_blueprint:');
    expect(idx).toBeGreaterThan(-1);
    const nextPropIdx = source.indexOf('nodes_description:', idx);
    const section = source.slice(idx, nextPropIdx > idx ? nextPropIdx : idx + 1200);
    expect(section).toMatch(/human_review/);
  });
});

describe('the canonical Human Review node type is a single source of truth (lib/workflow-runtime/node-capabilities.ts)', () => {
  it('HUMAN_REVIEW_NODE_TYPE is exported and used consistently by the guard, the graph classifier, and the handler registry', async () => {
    const { HUMAN_REVIEW_NODE_TYPE, isKnownNodeType } = await import('../lib/workflow-runtime/node-capabilities');
    expect(HUMAN_REVIEW_NODE_TYPE.toLowerCase()).toBe('magicflux-nodes.humanreview');
    expect(isKnownNodeType(HUMAN_REVIEW_NODE_TYPE)).toBe(true);

    const { HANDLER_NODE_ALLOWLIST } = await import('../lib/workflow-runtime/node-handlers');
    expect(HANDLER_NODE_ALLOWLIST.has(HUMAN_REVIEW_NODE_TYPE.toLowerCase())).toBe(true);
  });

  it('is recognized as a conditional/branching node (its own outcomes are real branches, like an IF node)', async () => {
    const { HUMAN_REVIEW_NODE_TYPE, isConditionalNodeType } = await import('../lib/workflow-runtime/node-capabilities');
    expect(isConditionalNodeType(HUMAN_REVIEW_NODE_TYPE)).toBe(true);
  });

  it('checkNodeCapability() reports it as capable (a real, dispatchable node)', async () => {
    const { checkNodeCapability, HUMAN_REVIEW_NODE_TYPE } = await import('../lib/workflow-runtime/node-capabilities');
    expect(checkNodeCapability({ type: HUMAN_REVIEW_NODE_TYPE })).toEqual({ capable: true });
  });

  it('a collapsed-branch humanReview node is rejected by the same branch-connections validator an IF node uses', async () => {
    const { validateBranchConnections } = await import('../lib/agent/branch-connection-guard');
    const { HUMAN_REVIEW_NODE_TYPE } = await import('../lib/workflow-runtime/node-capabilities');
    const node = { id: '1', name: 'Review', type: HUMAN_REVIEW_NODE_TYPE, parameters: {} };
    const connections = { Review: { main: [[{ node: 'A' }, { node: 'B' }]] } }; // collapsed into one port
    const result = validateBranchConnections([node], connections);
    expect(result.ok).toBe(false);
  });
});
