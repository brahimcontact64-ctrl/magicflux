import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { getLeadLifecycleHistory } from '@/lib/runtime/lead-lifecycle';

type Ctx = { params: { id: string } };

/**
 * GET /api/qualification-decisions/[id]
 *
 * Phase 9.9.15 -- Part J: the single-lead inspector. Combines three
 * INDEPENDENT dimensions (Part B) into one response WITHOUT collapsing
 * them into one ambiguous status:
 *   - AI qualification: ai_classification/ai_confidence (immutable) and
 *     final_classification/human_classification (set once, by Human
 *     Review, never by this route).
 *   - Operational handling: the linked workflow_acknowledgments row's own
 *     status (pending/acknowledged/timed_out), looked up by execution_id
 *     -- read-only, never written here.
 *   - Business outcome: outcome_status/outcome_revenue/outcome_currency
 *     plus the lifecycle audit history (contacted/won/lost transitions).
 *
 * Owner-scoped: every query filtered by the authenticated caller's own
 * user_id.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  const { data: decision } = await db
    .from('workflow_qualification_decisions')
    .select(
      'id, workflow_id, execution_id, classifier_node_name, created_at, ' +
      'ai_classification, ai_confidence, ai_reason, ' +
      'positive_signals, negative_signals, missing_required_fields, contradictions, qualification_status, needs_review, ' +
      'human_review_occurred, human_classification, human_reviewed_at, ' +
      'final_classification, overridden, ' +
      'outcome_status, outcome_revenue, outcome_currency, outcome_recorded_at, ' +
      'classification_policy_hash'
    )
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!decision) return NextResponse.json({ error: 'Qualification decision not found' }, { status: 404 });

  const executionId = String((decision as unknown as { execution_id: unknown }).execution_id);

  const [{ data: ack }, lifecycleHistory] = await Promise.all([
    db
      .from('workflow_acknowledgments')
      .select('status, deadline_at, acknowledged_at, escalation_level')
      .eq('execution_id', executionId)
      .eq('user_id', user.id)
      .maybeSingle(),
    getLeadLifecycleHistory({ qualificationDecisionId: params.id, executionId }),
  ]);

  return NextResponse.json({
    decision,
    // null when this lead's workflow never uses the SLA acknowledgment
    // capability at all -- distinct from an ack row that exists but is
    // still pending.
    acknowledgment: ack ?? null,
    lifecycleHistory,
  });
}
