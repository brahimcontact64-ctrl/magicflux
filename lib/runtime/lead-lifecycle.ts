import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { redactPiiPatterns, redactText } from '@/lib/security/redact';

/**
 * Phase 9.9.15/9.9.15A -- Part B/C/D/E/F/G: the business OUTCOME dimension
 * for a qualification decision ("lead"), deliberately separate from:
 *   - AI qualification (ai_classification/final_classification, Hot/Warm/
 *     Cold) -- immutable/human-review-corrected, never touched here.
 *   - Operational handling (workflow_acknowledgments -- acknowledged/
 *     timed_out) -- an SLA breach never implies Lost; never touched here.
 *
 * V1 lifecycle (Part C): a MINIMAL 3-action model, not the full
 * "new -> qualified -> contacted -> won|lost" sketch -- "qualified" is
 * deliberately DROPPED as a separate business checkpoint because that
 * question is already fully answered by the AI/Human classification
 * dimension (Part B explicitly forbids conflating the two). The DB's own
 * historical CHECK constraint still allows 'qualified' as a value (Phase
 * 9.9.13) -- left in place for backward compatibility, structurally
 * harmless, but this module's own p_action validation (both here and
 * inside record_lead_outcome_atomic()) never accepts it as an action a V1
 * caller can request.
 *
 *   (no outcome yet) --contacted--> contacted --won-->  won  (terminal)
 *                  \                        \--lost--> lost (terminal)
 *                   \--won--> won (terminal)
 *                    \-lost--> lost (terminal)
 *
 * 'contacted' is a non-terminal checkpoint (skippable). 'won'/'lost' are
 * TERMINAL in V1 -- no undo/overwrite path is exposed by this module or its
 * API route (Part G: "If V1 intentionally makes Won/Lost terminal, state
 * that honestly" -- this is that explicit decision). The only way to
 * correct a genuine mistake in V1 is a manual, out-of-band database
 * correction, never exposed to product code or the UI.
 *
 * Phase 9.9.15A Part F -- the CAS transition and its audit trail
 * (runtime_execution_events + runtime_operator_actions) are performed
 * ATOMICALLY by a single Postgres function, record_lead_outcome_atomic()
 * (see the migration's own doc comment for the full rationale): a process
 * crash between "the outcome changed" and "the audit event exists" is
 * structurally impossible -- either both happen, in the same transaction,
 * or neither does. A lost CAS race never writes an audit event.
 *
 * Phase 9.9.15A Part G -- revenue crosses the API boundary as a bounded,
 * regex-validated DECIMAL STRING (never a raw client-supplied JS number),
 * eliminating any floating-point arithmetic on money at the JS layer. The
 * single Number() conversion here happens only after that validation has
 * already proven the value is a short, clean decimal well within a
 * double's exact-integer range -- lossless by construction, not by luck.
 */

export type LeadLifecycleAction = 'contacted' | 'won' | 'lost';

const VALID_ACTIONS: ReadonlySet<string> = new Set(['contacted', 'won', 'lost']);

const MAX_NOTE_CHARS = 300;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Part G -- up to 12 integer digits + up to 2 decimal digits. 12 digits is
// an already-absurd bound for a single deal (999,999,999,999); this exists
// to reject garbage/overflow input, not to model a real-world ceiling.
// No sign is permitted at all -- this ALSO structurally guarantees
// non-negativity by construction, not just a separate numeric comparison.
const REVENUE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export type RecordLeadOutcomeParams = {
  qualificationDecisionId: string;
  userId: string;
  actorId: string;
  action: LeadLifecycleAction;
  /** A bounded decimal string, e.g. "125000.50" -- never a raw client-supplied number (Part G). */
  revenue?: string;
  currency?: string;
  note?: string;
};

export type RecordLeadOutcomeResult =
  | {
      ok: true;
      alreadyInState: boolean;
      previousStatus: string | null;
      newStatus: LeadLifecycleAction;
      executionId: string;
      workflowId: string;
    }
  | { ok: false; reason: string; currentStatus?: string | null };

function validateRevenueAndCurrency(action: LeadLifecycleAction, revenue: string | undefined, currency: string | undefined): { ok: true; revenueNumber: number | null } | { ok: false; reason: string } {
  const hasRevenue = revenue !== undefined;
  const hasCurrency = currency !== undefined;

  if (!hasRevenue && !hasCurrency) return { ok: true, revenueNumber: null };

  if (action !== 'won') {
    return { ok: false, reason: `revenue/currency may only be recorded for a "won" outcome (Part D), not "${action}".` };
  }
  if (hasRevenue !== hasCurrency) {
    return { ok: false, reason: 'revenue and currency must be provided together -- an amount with no explicit currency is never assumed to be USD.' };
  }
  if (typeof revenue !== 'string' || !REVENUE_PATTERN.test(revenue)) {
    return { ok: false, reason: 'revenue must be a plain decimal string with at most 12 integer digits and 2 decimal digits (e.g. "125000.50"), never negative or in scientific notation.' };
  }
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    return { ok: false, reason: 'currency must be a 3-letter uppercase code (e.g. "USD", "EUR").' };
  }
  // Safe: REVENUE_PATTERN already bounds this to at most 14 significant
  // digits, well within a double's exact-integer range (2^53) -- this
  // conversion cannot lose precision for any value that passed validation.
  const revenueNumber = Number(revenue);
  return { ok: true, revenueNumber };
}

type RpcRow = {
  ok: boolean;
  already_in_state: boolean;
  previous_status: string | null;
  new_status: string;
  current_status: string | null;
  execution_id: string | null;
  workflow_id: string | null;
  reason: string | null;
};

/**
 * Records a lead's business outcome via the atomic record_lead_outcome_atomic()
 * Postgres function (Part F) -- owner-scoped (userId must match the
 * qualification decision's own user_id, enforced INSIDE the function's own
 * SQL, never a client-supplied cross-tenant id). Never calls a provider,
 * never re-runs the originating workflow (Part M).
 */
export async function recordLeadOutcome(params: RecordLeadOutcomeParams): Promise<RecordLeadOutcomeResult> {
  // Part C/defense-in-depth: never reach the RPC (or the DB at all) for an
  // action outside the V1 set -- in particular 'qualified' must be rejected
  // here even if a caller bypasses the TS type (e.g. a stale client build),
  // not only by record_lead_outcome_atomic()'s own SQL-level check.
  if (!VALID_ACTIONS.has(params.action)) {
    return { ok: false, reason: "action must be 'contacted', 'won', or 'lost'." };
  }

  const validation = validateRevenueAndCurrency(params.action, params.revenue, params.currency);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const safeNote = params.note ? redactPiiPatterns(redactText(params.note, MAX_NOTE_CHARS * 2)).slice(0, MAX_NOTE_CHARS) : null;

  const db = createServiceClient();
  const { data, error } = await db.rpc('record_lead_outcome_atomic', {
    p_qualification_decision_id: params.qualificationDecisionId,
    p_user_id: params.userId,
    p_actor_id: params.actorId,
    p_action: params.action,
    p_revenue: validation.revenueNumber,
    p_currency: params.action === 'won' && params.currency ? params.currency : null,
    p_note: safeNote,
  });

  if (error) {
    return { ok: false, reason: 'Failed to record the outcome due to a database error.' };
  }

  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | undefined;
  if (!row) return { ok: false, reason: 'The database did not return a result for this action.' };

  if (!row.ok) {
    return { ok: false, reason: row.reason ?? 'Unable to record this outcome.', currentStatus: row.current_status };
  }

  return {
    ok: true,
    alreadyInState: row.already_in_state,
    previousStatus: row.previous_status,
    newStatus: row.new_status as LeadLifecycleAction,
    executionId: String(row.execution_id),
    workflowId: String(row.workflow_id),
  };
}

export type LeadLifecycleEvent = {
  previousStatus: string | null;
  newStatus: string;
  note: string | null;
  revenue: number | null;
  currency: string | null;
  actorId: string;
  createdAt: string;
};

/**
 * Read-only lifecycle audit history for one qualification decision --
 * queries the SAME runtime_execution_events log every other audit action
 * already writes to, filtered to this decision's own id (embedded in the
 * event payload) and this event type. Never used to decide anything, only
 * to display "why lost" / a contacted note / the transition history.
 */
export async function getLeadLifecycleHistory(params: { qualificationDecisionId: string; executionId: string }): Promise<LeadLifecycleEvent[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_execution_events')
    .select('payload, created_at')
    .eq('execution_id', params.executionId)
    .eq('event_type', 'lead_lifecycle_changed')
    .order('sequence_number', { ascending: true })
    .limit(50);

  const rows = (data ?? []) as Array<{ payload: Record<string, unknown>; created_at: string }>;
  return rows
    .filter((r) => r.payload?.qualification_decision_id === params.qualificationDecisionId)
    .map((r) => ({
      previousStatus: (r.payload.previous_status as string | null) ?? null,
      newStatus: String(r.payload.new_status ?? ''),
      note: (r.payload.note as string | null) ?? null,
      revenue: (r.payload.revenue as number | null) ?? null,
      currency: (r.payload.currency as string | null) ?? null,
      actorId: String(r.payload.actor_id ?? ''),
      createdAt: r.created_at,
    }));
}

