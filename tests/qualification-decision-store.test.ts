/**
 * Phase 9.9.13 -- lib/workflow-runtime/node-handlers/qualification-decision-store.ts
 * unit tests: hash stability/uniqueness, idempotent insert (retry/concurrent
 * duplicate), redaction, and the CAS-guarded human-review link.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeClassificationPolicyHash,
  recordQualificationDecision,
  linkHumanReviewToQualificationDecision,
} from '../lib/workflow-runtime/node-handlers/qualification-decision-store';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    const m = idxs.map((i) => this.rows[i]);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  // linkHumanReviewToQualificationDecision awaits the `.update().eq()...`
  // chain directly (no .maybeSingle()) -- a real Supabase PostgrestFilterBuilder
  // is itself thenable, so this fake must be too, or the patch never applies.
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    return Promise.resolve(resolve({ data: idxs.map((i) => this.rows[i]), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows).update(patch); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.classifier_node_id === row.classifier_node_id);
    if (conflict) {
      return { then: (resolve: (v: { error: { message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { message: 'duplicate key value violates unique constraint' } })) };
    }
    this.rows.push({ id: `row-${this.rows.length + 1}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTableHandle(this.tables.get(name)!);
  }
}

function baseParams(overrides: Partial<Parameters<typeof recordQualificationDecision>[1]> = {}) {
  return {
    userId: 'user-1',
    workflowId: 'wf-1',
    executionId: 'exec-1',
    classifierNodeId: 'node-classifier',
    classifierNodeName: 'AI Classifier',
    deploymentVersionId: null,
    mode: 'live' as const,
    classificationPolicyHash: 'hash-abc',
    aiClassification: 'Hot',
    aiConfidence: 0.9,
    aiReason: 'Strong budget and urgency signals.',
    positiveSignals: [{ field: 'budget_max', value: 500000 }],
    negativeSignals: [],
    missingRequiredFields: [],
    contradictions: [],
    qualificationStatus: 'classified' as const,
    needsReview: false,
    ...overrides,
  };
}

describe('computeClassificationPolicyHash', () => {
  it('is stable regardless of object key order', () => {
    const a = computeClassificationPolicyHash({
      instruction: 'Classify.', allowedLabels: ['Hot', 'Warm'], confidenceThreshold: 0.6,
      qualificationPolicy: { version: 1, allowedInputFields: ['budget'], fields: [{ field: 'budget', required: true, kind: 'numeric' }] },
    });
    const b = computeClassificationPolicyHash({
      confidenceThreshold: 0.6, allowedLabels: ['Warm', 'Hot'].reverse(), instruction: 'Classify.',
      qualificationPolicy: { fields: [{ kind: 'numeric', required: true, field: 'budget' }], version: 1, allowedInputFields: ['budget'] },
    });
    expect(a).toBe(b);
  });

  it('changes when confidenceThreshold changes -- a genuinely different ruleset', () => {
    const a = computeClassificationPolicyHash({ instruction: 'Classify.', allowedLabels: ['Hot'], confidenceThreshold: 0.6, qualificationPolicy: null });
    const b = computeClassificationPolicyHash({ instruction: 'Classify.', allowedLabels: ['Hot'], confidenceThreshold: 0.7, qualificationPolicy: null });
    expect(a).not.toBe(b);
  });

  it('changes when the instruction text changes', () => {
    const a = computeClassificationPolicyHash({ instruction: 'A', allowedLabels: ['Hot'], confidenceThreshold: 0.6, qualificationPolicy: null });
    const b = computeClassificationPolicyHash({ instruction: 'B', allowedLabels: ['Hot'], confidenceThreshold: 0.6, qualificationPolicy: null });
    expect(a).not.toBe(b);
  });

  it('produces a hex sha256 digest, never the raw instruction text itself', () => {
    const hash = computeClassificationPolicyHash({ instruction: 'Secret internal instruction text', allowedLabels: ['Hot'], confidenceThreshold: 0.6, qualificationPolicy: null });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('Secret');
  });
});

describe('recordQualificationDecision', () => {
  let db: FakeDb;
  beforeEach(() => { db = new FakeDb(); });

  it('inserts a new row and returns its id', async () => {
    const result = await recordQualificationDecision(db as never, baseParams());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBeTruthy();
    expect(db.tables.get('workflow_qualification_decisions')).toHaveLength(1);
  });

  it('a retried classifier invocation for the SAME (execution, node) is idempotent -- never a second row (Part L)', async () => {
    const first = await recordQualificationDecision(db as never, baseParams());
    const second = await recordQualificationDecision(db as never, baseParams());
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
    expect(db.tables.get('workflow_qualification_decisions')).toHaveLength(1);
  });

  it('concurrent persistence for the same execution/node cannot double-count (Part L)', async () => {
    const [a, b] = await Promise.all([
      recordQualificationDecision(db as never, baseParams()),
      recordQualificationDecision(db as never, baseParams()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(db.tables.get('workflow_qualification_decisions')).toHaveLength(1);
  });

  it('a DIFFERENT classifier node in the same execution gets its own row', async () => {
    await recordQualificationDecision(db as never, baseParams());
    await recordQualificationDecision(db as never, baseParams({ classifierNodeId: 'node-classifier-2' }));
    expect(db.tables.get('workflow_qualification_decisions')).toHaveLength(2);
  });

  it('redacts a credential/token-shaped value inside positive/negative signals before storing (defense in depth)', async () => {
    await recordQualificationDecision(db as never, baseParams({
      positiveSignals: [{ field: 'api_key', value: 'sk-live-abcdef1234567890' }],
    }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect(JSON.stringify(row.positive_signals)).not.toContain('sk-live-abcdef1234567890');
  });

  it('caps ai_reason length and contradictions count for storage safety', async () => {
    await recordQualificationDecision(db as never, baseParams({
      aiReason: 'x'.repeat(1000),
      contradictions: Array.from({ length: 20 }, (_, i) => `contradiction ${i}`),
    }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect((row.ai_reason as string).length).toBeLessThanOrEqual(500);
    expect((row.contradictions as string[]).length).toBeLessThanOrEqual(10);
  });

  it('Part F: scrubs an email address the model echoed into free-text "reason" -- field-name redaction alone cannot catch this', async () => {
    await recordQualificationDecision(db as never, baseParams({
      aiReason: 'High intent -- lead provided contact john.doe@example.com for follow-up.',
    }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect(row.ai_reason).not.toContain('john.doe@example.com');
    expect(row.ai_reason).toContain('[EMAIL_REDACTED]');
  });

  it('Part F: scrubs a phone number the model echoed into free-text "reason"', async () => {
    await recordQualificationDecision(db as never, baseParams({
      aiReason: 'Lead is reachable at 555-867-5309 and very engaged.',
    }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect(row.ai_reason).not.toContain('555-867-5309');
    expect(row.ai_reason).toContain('[PHONE_REDACTED]');
  });

  it('Part F: scrubs PII shapes inside contradiction strings too', async () => {
    await recordQualificationDecision(db as never, baseParams({
      contradictions: ['Urgent per text, but email jane@corp.com suggests distant timeline'],
    }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect((row.contradictions as string[])[0]).not.toContain('jane@corp.com');
  });

  it('Part F: never persists a chain-of-thought/prompt-shaped reason -- there is simply no column for either', async () => {
    // Structural guarantee, not a runtime check: assert the insert payload
    // itself has no "prompt"/"chainOfThought"/"reasoning" key at all.
    await recordQualificationDecision(db as never, baseParams({ aiReason: 'Clear business reason.' }));
    const row = db.tables.get('workflow_qualification_decisions')![0];
    expect(row).not.toHaveProperty('prompt');
    expect(row).not.toHaveProperty('chain_of_thought');
    expect(row).not.toHaveProperty('reasoning');
  });
});

describe('linkHumanReviewToQualificationDecision', () => {
  let db: FakeDb;
  beforeEach(() => { db = new FakeDb(); });

  async function seedDecision() {
    const result = await recordQualificationDecision(db as never, baseParams({ aiClassification: 'Cold' }));
    return result.ok ? result.id : '';
  }

  it('records the human override audit trail exactly once', async () => {
    const id = await seedDecision();
    await linkHumanReviewToQualificationDecision(db as never, {
      qualificationDecisionId: id, workflowId: 'wf-1', executionId: 'exec-1', humanReviewNodeId: 'review-1',
      humanClassification: 'Warm', reviewedBy: 'user-1', reviewedAt: '2026-01-01T00:00:00.000Z',
    });
    const row = db.tables.get('workflow_qualification_decisions')!.find((r) => r.id === id)!;
    expect(row.human_review_occurred).toBe(true);
    expect(row.human_classification).toBe('Warm');
    expect(row.final_classification).toBe('Warm');
    expect(row.ai_classification).toBe('Cold'); // never rewritten (Part C)
  });

  it('duplicate resume cannot create a duplicate/second feedback record (CAS guard, Part L)', async () => {
    const id = await seedDecision();
    await linkHumanReviewToQualificationDecision(db as never, {
      qualificationDecisionId: id, workflowId: 'wf-1', executionId: 'exec-1', humanReviewNodeId: 'review-1',
      humanClassification: 'Warm', reviewedBy: 'user-1', reviewedAt: '2026-01-01T00:00:00.000Z',
    });
    // A second resume attempt tries to link again with a DIFFERENT decision --
    // the CAS (human_review_occurred = false) must make this a no-op.
    await linkHumanReviewToQualificationDecision(db as never, {
      qualificationDecisionId: id, workflowId: 'wf-1', executionId: 'exec-1', humanReviewNodeId: 'review-1',
      humanClassification: 'Hot', reviewedBy: 'user-1', reviewedAt: '2026-01-01T00:05:00.000Z',
    });
    const rows = db.tables.get('workflow_qualification_decisions')!;
    expect(rows).toHaveLength(1); // never a second row
    expect(rows[0].human_classification).toBe('Warm'); // first decision wins, never overwritten
  });

  it('never throws, even against a nonexistent decision id (best-effort)', async () => {
    await expect(linkHumanReviewToQualificationDecision(db as never, {
      qualificationDecisionId: 'nonexistent', workflowId: 'wf-1', executionId: 'exec-1', humanReviewNodeId: 'review-1',
      humanClassification: 'Warm', reviewedBy: 'user-1', reviewedAt: '2026-01-01T00:00:00.000Z',
    })).resolves.toBeUndefined();
  });
});
