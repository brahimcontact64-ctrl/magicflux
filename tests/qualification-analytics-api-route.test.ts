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
    outcome_status: null, outcome_revenue: null, outcome_currency: null,
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

  // Phase 9.9.15 -- Part I: business outcome analytics, a THIRD, separate
  // dimension from AI classification/Human Review agreement above.
  it('Part I: outcome counts and rates use `total` as their denominator, never humanReviewCount', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ outcome_status: 'contacted' }),
      decisionRow({ outcome_status: 'won', outcome_revenue: 100, outcome_currency: 'USD' }),
      decisionRow({ outcome_status: 'lost' }),
      decisionRow({}), // no outcome yet
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.total).toBe(4);
    expect(body.outcomes).toEqual({
      contacted: { count: 1, rate: 0.25 },
      won: { count: 1, rate: 0.25 },
      lost: { count: 1, rate: 0.25 },
      noOutcome: { count: 1, rate: 0.25 },
    });
  });

  it('Part H: revenue is grouped by currency, never summed across currencies into one misleading total', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ outcome_status: 'won', outcome_revenue: 1000, outcome_currency: 'USD' }),
      decisionRow({ outcome_status: 'won', outcome_revenue: 500, outcome_currency: 'USD' }),
      decisionRow({ outcome_status: 'won', outcome_revenue: 2000, outcome_currency: 'EUR' }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.revenueByCurrency).toEqual(expect.arrayContaining([
      { currency: 'USD', totalRevenue: 1500, wonCount: 2 },
      { currency: 'EUR', totalRevenue: 2000, wonCount: 1 },
    ]));
    // Never a single blended number mixing USD and EUR.
    expect(JSON.stringify(body.revenueByCurrency)).not.toContain('3500');
  });

  it('Part I: outcomesByAiClassification breaks down contacted/won/lost/pending per AI label, distinct from human-reviewed distribution', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ ai_classification: 'Hot', final_classification: 'Hot', outcome_status: 'won', outcome_revenue: 100, outcome_currency: 'USD' }),
      decisionRow({ ai_classification: 'Hot', final_classification: 'Warm', human_review_occurred: true, human_classification: 'Warm', overridden: true, outcome_status: 'lost' }),
      decisionRow({ ai_classification: 'Cold', final_classification: 'Cold' }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    const hotByAi = body.outcomesByAiClassification.find((b: { label: string }) => b.label === 'Hot');
    expect(hotByAi).toEqual({ label: 'Hot', total: 2, contacted: 0, won: 1, lost: 1, noOutcome: 0 });

    // A Hot lead that a human overrode to Warm now counts under "Warm" in
    // the FINAL-classification breakdown, not under "Hot" -- proving the
    // two breakdowns are genuinely independent views.
    const warmByFinal = body.outcomesByFinalClassification.find((b: { label: string }) => b.label === 'Warm');
    expect(warmByFinal).toEqual({ label: 'Warm', total: 1, contacted: 0, won: 0, lost: 1, noOutcome: 0 });
  });

  it('a Hot AI lead that later became Lost is counted correctly -- a Hot classification never implies Won (Part B)', async () => {
    tables.workflow_qualification_decisions = [decisionRow({ ai_classification: 'Hot', outcome_status: 'lost' })];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    const hot = body.outcomesByAiClassification.find((b: { label: string }) => b.label === 'Hot');
    expect(hot.lost).toBe(1);
    expect(hot.won).toBe(0);
  });

  it('never labels outcome/agreement metrics as "accuracy" anywhere in the response', async () => {
    tables.workflow_qualification_decisions = [decisionRow({ outcome_status: 'won', outcome_revenue: 100, outcome_currency: 'USD' })];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(JSON.stringify(body).toLowerCase()).not.toContain('accuracy');
  });

  it('zero-outcome workflow: outcome rates are all zero-but-defined (denominator is `total`, never null when total > 0)', async () => {
    tables.workflow_qualification_decisions = [decisionRow({}), decisionRow({})];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.outcomes.won).toEqual({ count: 0, rate: 0 });
    expect(body.outcomes.noOutcome).toEqual({ count: 2, rate: 1 });
  });

  // Phase 9.9.15A Part B/N -- the literal example from the certification
  // request: 125000 DZD and 900 EUR must remain separate analytics groups,
  // never blended, never FX-converted, never assumed to be a common unit.
  it('Part B: 125000 DZD and 900 EUR remain separate revenue groups, never blended or FX-converted', async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ outcome_status: 'won', outcome_revenue: 125000, outcome_currency: 'DZD' }),
      decisionRow({ outcome_status: 'won', outcome_revenue: 900, outcome_currency: 'EUR' }),
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();

    expect(body.revenueByCurrency).toEqual(expect.arrayContaining([
      { currency: 'DZD', totalRevenue: 125000, wonCount: 1 },
      { currency: 'EUR', totalRevenue: 900, wonCount: 1 },
    ]));
    expect(body.revenueByCurrency).toHaveLength(2);
    // No blended/summed figure (125900) appears anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('125900');
  });

  // Phase 9.9.15A Part G -- revenue summation must not accumulate binary
  // floating-point error across many rows (0.1 + 0.2 !== 0.3 in JS). Ten
  // rows of 0.10 must sum to EXACTLY 1, not 0.9999999999999999.
  it('Part G: revenue summation across many rows is exact, no floating-point accumulation error', async () => {
    tables.workflow_qualification_decisions = Array.from({ length: 10 }, () =>
      decisionRow({ outcome_status: 'won', outcome_revenue: 0.1, outcome_currency: 'USD' }),
    );
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    const body = await res.json();
    const usd = body.revenueByCurrency.find((r: { currency: string }) => r.currency === 'USD');
    expect(usd.totalRevenue).toBe(1);
  });

  // Phase 9.9.15A Part C -- a historical/future 'qualified' row (the DB's
  // old CHECK constraint still allows it; V1 never writes it) must not
  // crash analytics and must not be miscounted as contacted/won/lost, nor
  // silently folded into "no outcome yet" by naive subtraction.
  it("Part C: a historical outcome_status='qualified' row is handled safely -- not miscounted, not crashing, not equated with AI qualification", async () => {
    tables.workflow_qualification_decisions = [
      decisionRow({ outcome_status: 'qualified' as unknown as null }),
      decisionRow({ outcome_status: 'won', outcome_revenue: 100, outcome_currency: 'USD' }),
      decisionRow({}), // genuinely no outcome yet
    ];
    const { GET } = await import('../app/api/analytics/qualification/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(3);
    expect(body.outcomes.won).toEqual({ count: 1, rate: 1 / 3 });
    expect(body.outcomes.contacted).toEqual({ count: 0, rate: 0 });
    expect(body.outcomes.lost).toEqual({ count: 0, rate: 0 });
    // The 'qualified' row must NOT be folded into noOutcome (it has an
    // outcome_status, just not a V1 one) -- only the genuinely-null row is.
    expect(body.outcomes.noOutcome).toEqual({ count: 1, rate: 1 / 3 });
  });
});
