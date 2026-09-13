/**
 * Phase 9.9.3.1 — source invariants pinning the corrected AI Classifier ->
 * Human Review generation contract so it cannot silently regress back to
 * the Phase 9.9.4 shape: the prompt must mandate a linear, single-port
 * classifier, an explicit IF gate reading "needs_review" between the
 * classifier and Human Review, and the new product-truth guard must
 * actually run before persistence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generateWorkflowJson() prompt includes the needs-review routing contract (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('mandates the aiClassifier node stays linear with exactly one output port', () => {
    expect(source.toLowerCase()).toMatch(/aiclassifier node itself is always linear/);
    expect(source).toMatch(/exactly ONE entry in "main"/);
  });

  it('forbids wiring Human Review as a second port directly from the classifier', () => {
    expect(source.toLowerCase()).toMatch(/never wire magicflux-nodes\.humanreview directly from the aiclassifier node/);
  });

  it('mandates an IF node reading the literal needs_review field between classifier and review', () => {
    expect(source).toMatch(/\$json\[\\"needs_review\\"\]/);
    expect(source.toLowerCase()).toMatch(/branches on exactly.*needs_review/);
  });

  it('requires the true branch to go to Human Review and the false branch to continue normal routing', () => {
    const idx = source.indexOf('NEEDS-REVIEW ROUTING CONTRACT');
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 2000);
    expect(section).toMatch(/TRUE branch \(main\[0\]\).*Human Review/s);
    expect(section).toMatch(/FALSE branch \(main\[1\]\).*continues/s);
  });

  it('requires no Airtable/Slack/email side effects before Human Review on the needs_review path', () => {
    const idx = source.indexOf('NEEDS-REVIEW ROUTING CONTRACT');
    const section = source.slice(idx, idx + 2500);
    expect(section.toLowerCase()).toMatch(/no airtable\/slack\/email\/notification side effect should be reachable from the needs_review true branch/);
  });

  it('the deterministic AI-review-routing guard runs before persistence, after the AI classification and human review claim guards', () => {
    const aiClaimIdx = source.indexOf('validateAiClassificationClaim(');
    const humanReviewClaimIdx = source.indexOf('validateHumanReviewClaim(');
    const routingGuardIdx = source.indexOf('validateAiReviewRoutingContract(');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(aiClaimIdx).toBeGreaterThan(-1);
    expect(humanReviewClaimIdx).toBeGreaterThan(-1);
    expect(routingGuardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(routingGuardIdx).toBeGreaterThan(aiClaimIdx);
    expect(routingGuardIdx).toBeGreaterThan(humanReviewClaimIdx);
    expect(routingGuardIdx).toBeLessThan(persistIdx);
  });

  it('the branch-connection-guard runs before the AI-review-routing guard (structural checks first)', () => {
    const branchCheckIdx = source.indexOf('validateBranchConnections(');
    const routingGuardIdx = source.indexOf('validateAiReviewRoutingContract(');
    expect(branchCheckIdx).toBeGreaterThan(-1);
    expect(branchCheckIdx).toBeLessThan(routingGuardIdx);
  });
});
