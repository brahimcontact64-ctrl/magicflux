/**
 * Phase 9.9.1 — source invariants pinning the AI Classification generation
 * contract so it cannot silently regress: the generation prompt must
 * instruct the model to insert a real magicflux-nodes.aiClassifier node
 * BEFORE any IF node branching on its result, and the deterministic
 * post-generation guard must actually run before persistence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generateWorkflowJson() prompt includes the AI classification contract (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('mandates the exact magicflux-nodes.aiClassifier type string', () => {
    expect(source).toMatch(/magicflux-nodes\.aiClassifier/);
  });

  it('instructs the model to place the classifier BEFORE any IF node reading its result', () => {
    expect(source.toLowerCase()).toMatch(/before any n8n-nodes-base\.if node/);
  });

  it('documents the required parameters: instruction, allowedLabels, outputField, confidenceThreshold', () => {
    expect(source).toMatch(/"instruction"/);
    expect(source).toMatch(/"allowedLabels"/);
    expect(source).toMatch(/"outputField"/);
    expect(source).toMatch(/"confidenceThreshold"/);
  });

  it('warns against branching on a field nothing upstream computes', () => {
    expect(source.toLowerCase()).toMatch(/that no upstream node in this same graph actually computes/);
  });

  it('the deterministic AI-classification-claim guard runs before persistence', () => {
    const guardIdx = source.indexOf('validateAiClassificationClaim(');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(persistIdx);
  });
});

describe('generate_workflow_json tool schema mentions the ai_classifier block (lib/agent/tools.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools.ts'), 'utf8');

  it('block_blueprint description mentions ai_classifier', () => {
    const idx = source.indexOf('block_blueprint:');
    expect(idx).toBeGreaterThan(-1);
    // ai_classifier must be mentioned within block_blueprint's own description,
    // not merely somewhere else in the file.
    const nextPropIdx = source.indexOf('nodes_description:', idx);
    const section = source.slice(idx, nextPropIdx > idx ? nextPropIdx : idx + 1000);
    expect(section).toMatch(/ai_classifier/);
  });
});

describe('the canonical AI classifier node type is a single source of truth (lib/workflow-runtime/node-capabilities.ts)', () => {
  it('AI_CLASSIFIER_NODE_TYPE is exported and used consistently by the guard, the graph classifier, and the handler registry', async () => {
    const { AI_CLASSIFIER_NODE_TYPE, isKnownNodeType } = await import('../lib/workflow-runtime/node-capabilities');
    expect(AI_CLASSIFIER_NODE_TYPE.toLowerCase()).toBe('magicflux-nodes.aiclassifier');
    expect(isKnownNodeType(AI_CLASSIFIER_NODE_TYPE)).toBe(true);

    const { HANDLER_NODE_ALLOWLIST } = await import('../lib/workflow-runtime/node-handlers');
    expect(HANDLER_NODE_ALLOWLIST.has(AI_CLASSIFIER_NODE_TYPE.toLowerCase())).toBe(true);
  });

  it('is never misclassified as a conditional/branching node despite containing "if" as a substring', async () => {
    const { AI_CLASSIFIER_NODE_TYPE, isConditionalNodeType } = await import('../lib/workflow-runtime/node-capabilities');
    expect(isConditionalNodeType(AI_CLASSIFIER_NODE_TYPE)).toBe(false);
  });

  it('checkNodeCapability() reports it as capable (a real, dispatchable node)', async () => {
    const { checkNodeCapability, AI_CLASSIFIER_NODE_TYPE } = await import('../lib/workflow-runtime/node-capabilities');
    expect(checkNodeCapability({ type: AI_CLASSIFIER_NODE_TYPE })).toEqual({ capable: true });
  });
});
