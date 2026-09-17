import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { recordLeadOutcome, type LeadLifecycleAction } from '@/lib/runtime/lead-lifecycle';

type Ctx = { params: { id: string } };

const VALID_ACTIONS = new Set<string>(['contacted', 'won', 'lost']);

/**
 * POST /api/qualification-decisions/[id]/outcome
 *
 * Phase 9.9.15 -- Part D/M: the ONE explicit, trusted way a workflow owner
 * records a lead's business outcome. Never inferred from Airtable, email
 * opens, acknowledgment, AI classification, or Slack activity -- an
 * explicit human action is the only path in V1. Recording an outcome does
 * NOT re-run the workflow or resend any Gmail/Slack/Airtable side effect
 * (Part M) -- this route never calls dispatchNode/runWorkflowExecution or
 * any provider handler at all.
 *
 * Body: { action: 'contacted' | 'won' | 'lost', revenue?: string, currency?: string, note?: string }
 *
 * Phase 9.9.15A Part G -- revenue is a STRING, not a number: the client
 * must send the exact decimal text the user typed (e.g. "125000.50"),
 * never a pre-parsed JS float -- recordLeadOutcome() validates its exact
 * shape before any conversion happens.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, revenue, currency, note } = body as { action?: unknown; revenue?: unknown; currency?: unknown; note?: unknown };
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "action must be 'contacted', 'won', or 'lost'" }, { status: 400 });
  }
  if (revenue !== undefined && typeof revenue !== 'string') {
    return NextResponse.json({ error: 'revenue must be a decimal string, e.g. "125000.50" -- never a raw number' }, { status: 400 });
  }
  if (currency !== undefined && typeof currency !== 'string') {
    return NextResponse.json({ error: 'currency must be a string' }, { status: 400 });
  }
  if (note !== undefined && typeof note !== 'string') {
    return NextResponse.json({ error: 'note must be a string' }, { status: 400 });
  }

  const result = await recordLeadOutcome({
    qualificationDecisionId: params.id,
    userId: user.id,
    actorId: user.id,
    action: action as LeadLifecycleAction,
    revenue: revenue as string | undefined,
    currency: currency as string | undefined,
    note: note as string | undefined,
  });

  if (!result.ok) {
    const notFound = result.reason === 'Qualification decision not found.';
    // A state conflict (terminal outcome already recorded, or a concurrent
    // action won the race) always carries a currentStatus; a validation
    // error (e.g. invalid revenue/currency) is caught before any row is
    // even read, so it never has one -- that distinction is what separates
    // a 400 (bad request) from a 409 (real conflict) here.
    const status = notFound ? 404 : result.currentStatus !== undefined ? 409 : 400;
    return NextResponse.json({ error: result.reason, currentStatus: result.currentStatus ?? null }, { status });
  }

  return NextResponse.json({
    id: params.id,
    alreadyInState: result.alreadyInState,
    previousStatus: result.previousStatus,
    newStatus: result.newStatus,
  });
}
