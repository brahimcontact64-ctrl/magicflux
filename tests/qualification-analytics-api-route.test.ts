/**
 * Phase 9.9.13 Part E/F/I -- GET /api/analytics/qualification.
 *
 * Proves the metrics math, not just plumbing: agreement/override rates use
 * ONLY the human-reviewed subset as their denominator (never all automatic
 * classifications), every rate is null (never 0%/NaN) when its own
 * denominator is zero, override directions are counted correctly, and the
 * route is owner-scoped (tenant isolation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000d1';
const OTHER_ID = '00000000-0000-4000-8000-0000000000d2';
const WORKFLOW_ID = 'wf-1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const matched = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    return Promise.resolve(resolve({ data: matched, error: null }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? []),
  })),
  getUserFromRequest: vi.fn(),
}));

function decisionRow(overrides: Partial<Row>): Row {
  return {
    user_id: OWNER_ID, workflow_id: WORKFLOW_ID,
    ai_classification: 'Hot', ai_confidence: 0.9, final_classification: 'Hot',
    human_classification: null, human_review_occurred: false, overridden: false,
    qualification_status: 'classified', contradictions: [], classification_policy_hash: 'hash-1',
    ...overrides,
  };
}

function req(workflowId: string | null = WORKFLOW_ID) {
  const url = new URL('http://localhost/api/analytics/qualification');
  if (workflowId) url.searchParams.set('workflow_id', workflowId);
  return new NextRequest(url);
}

beforeEach(async () => {
  tables = { workflow_qualification_decisions: [] };
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
});

describe('GET /api/analytics/qualification', () => {
  it('requires authentication', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('requires workflow_id', async () => {
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req(null));
    expect(res.status).toBe(400);
  });

  it('zero denominator: an empty workflow returns null rates everywhere, never 0%/NaN (Part I)', async () => {
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.humanReview.rate).toBeNull();
    expect(body.agreement.rate).toBeNull();
    expect(body.override.rate).toBeNull();
    expect(body.needsInformation.rate).toBeNull();
    expect(body.contradictions.rate).toBeNull();
    expect(body.avgConfidence).toBeNull();
  });

  it('agreement/override denominator is ONLY human-reviewed decisions, never all automatic classifications (Part E)', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({}), // automatic, never reviewed
      decisionRow({}), // automatic, never reviewed
      decisionRow({ human_review_occurred: true, human_classification: 'Hot', overridden: false }), // reviewed, agreed
      decisionRow({ ai_classification: 'Cold', human_review_occurred: true, human_classification: 'Warm', final_classification: 'Warm', overridden: true }), // reviewed, overridden
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.total).toBe(4);
    expect(body.humanReview).toEqual({ count: 2, rate: 0.5 });
    // Denominator is 2 (human-reviewed only), NOT 4 (all decisions).
    expect(body.agreement).toEqual({ count: 1, denominator: 2, rate: 0.5 });
    expect(body.override).toEqual({ count: 1, denominator: 2, rate: 0.5 });
  });

  it('override direction counting is correct (from AI label -> to human label)', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_classification: 'Cold', human_review_occurred: true, human_classification: 'Warm', overridden: true }),
      decisionRow({ ai_classification: 'Cold', human_review_occurred: true, human_classification: 'Warm', overridden: true }),
      decisionRow({ ai_classification: 'Warm', human_review_occurred: true, human_classification: 'Hot', overridden: true }),
      decisionRow({ human_review_occurred: true, human_classification: 'Hot', overridden: false }), // agreement, not an override
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.overridesByDirection).toEqual([
      { from: 'Cold', to: 'Warm', count: 2 },
      { from: 'Warm', to: 'Hot', count: 1 },
    ]);
  });

  it('never labels agreement/override as "accuracy" anywhere in the response (Part F)', async () => {
    tables.workflow_qualification_decisions = [decisionRow({ human_review_occurred: true, human_classification: 'Hot' })];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(JSON.stringify(body).toLowerCase()).not.toContain('accuracy');
  });

  it('classification distribution rates are computed over the FULL total, and needsInformation/contradictions use the full total as denominator', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_classification: 'Hot' }),
      decisionRow({ ai_classification: 'Hot' }),
      decisionRow({ ai_classification: 'Warm', qualification_status: 'needs_information' }),
      decisionRow({ ai_classification: 'Cold', contradictions: ['x'] }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.total).toBe(4);
    const hot = body.aiClassificationDistribution.find((d: { label: string }) => d.label === 'Hot');
    expect(hot).toEqual({ label: 'Hot', count: 2, rate: 0.5 });
    expect(body.needsInformation).toEqual({ count: 1, rate: 0.25 });
    expect(body.contradictions).toEqual({ count: 1, rate: 0.25 });
  });

  it('tenant isolation: only returns the requesting user\'s own rows, never another tenant\'s', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ user_id: OWNER_ID, ai_classification: 'Hot' }),
      decisionRow({ user_id: OTHER_ID, workflow_id: WORKFLOW_ID, ai_classification: 'Cold' }), // same workflow_id (hypothetically), different tenant
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.aiClassificationDistribution).toEqual([{ label: 'Hot', count: 1, rate: 1 }]);
  });

  it('policy-version separation is surfaced in the response', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ classification_policy_hash: 'hash-a' }),
      decisionRow({ classification_policy_hash: 'hash-a' }),
      decisionRow({ classification_policy_hash: 'hash-b' }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.policyVersions).toEqual(expect.arrayContaining([
      { hash: 'hash-a', count: 2 },
      { hash: 'hash-b', count: 1 },
    ]));
  });

  it('Part G: AI vs final classification distributions remain DISTINCT after overrides -- never silently merged', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_classification: 'Cold', final_classification: 'Cold' }),
      decisionRow({ ai_classification: 'Cold', human_review_occurred: true, human_classification: 'Hot', final_classification: 'Hot', overridden: true }),
      decisionRow({ ai_classification: 'Cold', human_review_occurred: true, human_classification: 'Hot', final_classification: 'Hot', overridden: true }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    // The AI proposed Cold three times -- that fact must not be erased.
    expect(body.aiClassificationDistribution).toEqual([{ label: 'Cold', count: 3, rate: 1 }]);
    // But the FINAL outcome (after human overrides) is mostly Hot.
    expect(body.finalClassificationDistribution).toEqual(expect.arrayContaining([
      { label: 'Hot', count: 2, rate: 2 / 3 },
      { label: 'Cold', count: 1, rate: 1 / 3 },
    ]));
  });

  it('Part G: average confidence correctly includes genuine 0.0 values, never silently dropped as falsy', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_confidence: 0.0, qualification_status: 'needs_information' }), // a real, meaningful 0
      decisionRow({ ai_confidence: 1.0 }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    // If the 0.0 were dropped, avgConfidence would be 1.0 instead of 0.5.
    expect(body.avgConfidence).toBe(0.5);
  });

  it('Part G: confidence buckets have non-overlapping boundaries and total correctly, including exact boundary values', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_confidence: 0.0 }),
      decisionRow({ ai_confidence: 0.2 }), // boundary -- must land in [0.2,0.4), not [0.0,0.2)
      decisionRow({ ai_confidence: 0.4 }),
      decisionRow({ ai_confidence: 0.6 }),
      decisionRow({ ai_confidence: 0.8 }),
      decisionRow({ ai_confidence: 1.0 }), // top boundary -- must land in the last, inclusive bucket
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    const totalBucketed = body.confidenceBuckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0);
    expect(totalBucketed).toBe(6); // every row counted exactly once, none dropped, none double-counted
    expect(body.confidenceBuckets).toEqual([
      { range: '0.0-0.2', count: 1 }, // just 0.0
      { range: '0.2-0.4', count: 1 }, // just 0.2 (boundary owned by the upper bucket)
      { range: '0.4-0.6', count: 1 }, // just 0.4
      { range: '0.6-0.8', count: 1 }, // just 0.6
      { range: '0.8-1.0', count: 2 }, // 0.8 AND 1.0 (last bucket is inclusive on both ends)
    ]);
  });
});
