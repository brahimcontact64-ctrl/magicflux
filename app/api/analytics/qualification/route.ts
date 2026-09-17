import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

/**
 * GET /api/analytics/qualification?workflow_id=<uuid>
 *
 * Phase 9.9.13 -- Part E/F/I: tenant/workflow-scoped AI qualification
 * feedback metrics. OWNER-ONLY (same authorization truth as /api/reviews
 * and /api/acknowledgments -- every query filtered by the authenticated
 * caller's own user_id, never a client-supplied one, no cross-tenant view).
 *
 * All rates are computed here, server-side, over a bounded row window (the
 * workflow's most recent MAX_ROWS decisions) rather than via a database
 * view/RPC -- this keeps the migration surface to exactly the one new table
 * (Part M: only schema that genuinely needs approval should require it).
 *
 * Part F -- deliberately NEVER computes or returns anything labeled
 * "accuracy". `agreement` is AI/Human Agreement (a human's decision is
 * feedback, not verified ground truth) and `override` is the Override Rate
 * -- both use the SAME denominator: only decisions a human actually
 * reviewed (Part E: "agreement rate must be calculated only among cases
 * where a human actually made a classification decision, not across all
 * automatic classifications"). Every rate field is `null`, never a
 * fabricated 0% or NaN, when its own denominator is zero (Part I).
 */

const MAX_ROWS = 5000;

type DecisionRow = {
  ai_classification: string;
  ai_confidence: number;
  final_classification: string;
  human_classification: string | null;
  human_review_occurred: boolean;
  overridden: boolean | null;
  qualification_status: string | null;
  contradictions: unknown;
  classification_policy_hash: string;
};

function rate(count: number, denominator: number): number | null {
  return denominator > 0 ? count / denominator : null;
}

function bucketConfidence(confidences: number[]): { range: string; count: number }[] {
  const ranges = [
    { range: '0.0-0.2', min: 0, max: 0.2 },
    { range: '0.2-0.4', min: 0.2, max: 0.4 },
    { range: '0.4-0.6', min: 0.4, max: 0.6 },
    { range: '0.6-0.8', min: 0.6, max: 0.8 },
    { range: '0.8-1.0', min: 0.8, max: 1.0 },
  ];
  return ranges.map(({ range: label, min, max }) => ({
    range: label,
    count: confidences.filter((c) => (max === 1.0 ? c >= min && c <= max : c >= min && c < max)).length,
  }));
}

function distribution(values: string[]): { label: string; count: number; rate: number | null }[] {
  const total = values.length;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, rate: rate(count, total) }))
    .sort((a, b) => b.count - a.count);
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = req.nextUrl.searchParams.get('workflow_id');
  if (!workflowId) {
    return NextResponse.json({ error: 'workflow_id query parameter is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflow_qualification_decisions')
    .select('ai_classification, ai_confidence, final_classification, human_classification, human_review_occurred, overridden, qualification_status, contradictions, classification_policy_hash')
    .eq('user_id', user.id)
    .eq('workflow_id', workflowId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message }, { status: safe.httpStatus });
  }

  const rows = (data ?? []) as DecisionRow[];
  const total = rows.length;

  const humanReviewed = rows.filter((r) => r.human_review_occurred);
  const humanReviewCount = humanReviewed.length;
  const agreementCount = humanReviewed.filter((r) => !r.overridden).length;
  const overrideCount = humanReviewed.filter((r) => r.overridden).length;

  const needsInformationCount = rows.filter((r) => r.qualification_status === 'needs_information').length;
  const contradictionCount = rows.filter((r) => Array.isArray(r.contradictions) && r.contradictions.length > 0).length;

  const overrideDirectionCounts = new Map<string, number>();
  for (const r of humanReviewed) {
    if (!r.overridden || !r.human_classification) continue;
    const key = `${r.ai_classification} -> ${r.human_classification}`;
    overrideDirectionCounts.set(key, (overrideDirectionCounts.get(key) ?? 0) + 1);
  }
  const overridesByDirection = Array.from(overrideDirectionCounts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split(' -> ');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  const policyHashCounts = new Map<string, number>();
  for (const r of rows) policyHashCounts.set(r.classification_policy_hash, (policyHashCounts.get(r.classification_policy_hash) ?? 0) + 1);
  const policyVersions = Array.from(policyHashCounts.entries())
    .map(([hash, count]) => ({ hash, count }))
    .sort((a, b) => b.count - a.count);

  const confidences = rows.map((r) => r.ai_confidence).filter((c) => typeof c === 'number' && Number.isFinite(c));
  const avgConfidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;

  return NextResponse.json({
    workflowId,
    total,
    automaticCount: total - humanReviewCount,
    humanReview: { count: humanReviewCount, rate: rate(humanReviewCount, total) },
    // Part F -- AI/Human Agreement and Override Rate, NEVER "accuracy".
    // Denominator is humanReviewCount for BOTH -- only cases a human
    // actually decided, per Part E's explicit instruction.
    agreement: { count: agreementCount, denominator: humanReviewCount, rate: rate(agreementCount, humanReviewCount) },
    override: { count: overrideCount, denominator: humanReviewCount, rate: rate(overrideCount, humanReviewCount) },
    aiClassificationDistribution: distribution(rows.map((r) => r.ai_classification)),
    finalClassificationDistribution: distribution(rows.map((r) => r.final_classification)),
    avgConfidence,
    confidenceBuckets: bucketConfidence(confidences),
    overridesByDirection,
    needsInformation: { count: needsInformationCount, rate: rate(needsInformationCount, total) },
    contradictions: { count: contradictionCount, rate: rate(contradictionCount, total) },
    policyVersions,
  });
}
