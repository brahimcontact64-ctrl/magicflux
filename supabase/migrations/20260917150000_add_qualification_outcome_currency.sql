/*
  # Lead Lifecycle & Outcome Tracking -- add outcome_currency (Phase 9.9.15)

  PROPOSED MIGRATION -- NOT YET APPLIED. Presented for approval per the
  standing migration-safety instruction; STOP before applying.

  ============================================================================
  WHY THIS IS THE ONLY SCHEMA CHANGE NEEDED (Part A/O finding)
  ============================================================================

  Phase 9.9.13 already added, to workflow_qualification_decisions:
    outcome_status   text    (dormant, CHECK allows 'contacted'/'qualified'/'won'/'lost')
    outcome_revenue  numeric (dormant, exact decimal -- already suitable for money)
    outcome_recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
    outcome_recorded_at timestamptz
  plus a shape CHECK requiring status/recorded_by/recorded_at to be either
  all-null or all-set together. NOTHING has ever written to these columns --
  confirmed dormant, confirmed zero existing rows depend on their current
  shape.

  This is deliberately reused, not replaced or duplicated (Part A: "Prefer
  reusing the existing schema if it preserves correct semantics. Do not
  create another table merely because it is convenient.") -- a genuine
  gap exists in exactly ONE place: Part H requires "currency must be
  explicit... never assume USD", and outcome_revenue has NO accompanying
  currency column at all today. That is the ONE thing this migration adds.

  Everything else Phase 9.9.15 needs is already satisfied by EXISTING
  infrastructure, reused exactly as Phase 9.9.14 already established the
  precedent for:
    - Audit trail (Part E: actor/timestamp/previous state/new state/note)
      -> runtime_operator_actions + runtime_execution_events (both already
         exist, already free-form payload/result JSON, already used for
         exactly this kind of "operator changed durable business state"
         audit in Phase 9.9.14's side-effect-verification recovery flow).
         New action_type values ('lead_lifecycle_contacted'/'_won'/'_lost')
         and one new ExecutionEventType ('lead_lifecycle_changed') are pure
         TypeScript union additions -- neither table has a DB CHECK
         constraint on those columns, so no migration is needed for this.
    - Lifecycle correlation -> the qualification_decision's own id is
      embedded in the audit payload; execution_id/workflow_id (already FK'd
      on this table) provide the tenant/workflow scoping every other audit
      action already uses.
    - "Business qualified" as a concept -> ALREADY answered by
      ai_classification/final_classification (Hot/Warm/Cold) -- Part B
      explicitly requires NOT conflating AI qualification with business
      outcome, so V1's lifecycle deliberately does not add a redundant
      manual "qualified" checkpoint (the CHECK constraint's existing
      'qualified' allowed value is left in place, structurally harmless,
      simply unused by V1 -- available for a future phase if ever needed;
      removing it would require a migration for zero functional benefit).
    - Loss reason / contacted note -> stored ONLY in the audit trail's
      payload (Part E frames "optional safe note/reason" as part of the
      audit of a CHANGE, not a permanent field on the current-state row),
      never a new column -- keeps this migration to the one thing that
      really needs a first-class, queryable column: currency (Part H:
      "If analytics cannot safely aggregate mixed currencies, group by
      currency" requires currency to be a real, indexable value, not text
      buried in a note).

  ============================================================================
  THE ONE CHANGE
  ============================================================================

  ADD COLUMN outcome_currency text -- an ISO-4217-shaped 3-letter code
  (format-checked, e.g. 'USD'/'EUR'/'GBP' -- NOT validated against a real
  currency registry, which this project has no need for yet). Three new
  CHECK constraints, all additive and all satisfied trivially by every
  existing row (which has every outcome_* column NULL):

    1. outcome_revenue and outcome_currency must be both-null or both-set
       together -- revenue without an explicit currency is exactly the
       ambiguity Part H forbids.
    2. outcome_currency, when set, must be exactly 3 uppercase letters.
    3. outcome_revenue may only be set when outcome_status = 'won' (Part D:
       "Optional when Won: revenue/currency" -- structurally enforced, not
       just an application-code promise) and must be >= 0.

  No index is added for outcome_currency in this migration -- V1 analytics
  groups by currency over the same bounded, already-indexed
  (workflow_id, created_at) scan the existing qualification-analytics route
  already performs; a dedicated index can be added later if currency-scoped
  queries ever need to bypass that scan at scale.

  ============================================================================
  REVISION -- Phase 9.9.15A Part F: atomic transition + audit (CERTIFICATION
  BLOCKER, found during re-review, fixed BEFORE applying)
  ============================================================================

  The original Phase 9.9.15 draft performed the outcome CAS UPDATE and the
  audit writes (runtime_execution_events + runtime_operator_actions) as
  THREE separate round trips from application code. A process crash between
  the UPDATE committing and the audit writes running would leave a real
  business-outcome change with NO audit record of it ever having happened --
  exactly the gap Part F identifies. Postgres itself is the only thing that
  can make "update the row" and "write its audit trail" a single, genuinely
  atomic unit: this migration adds ONE new function,
  record_lead_outcome_atomic(), that performs the CAS UPDATE and (only if it
  actually won the CAS) the audit inserts within the SAME implicit
  transaction Postgres already wraps around a single top-level function
  call -- if anything after the UPDATE fails, the UPDATE itself rolls back
  too. A lost CAS race writes NO audit event (Part F: "do not write an audit
  event if the transition itself loses the CAS race").

  This function is SECURITY INVOKER (the default -- deliberately NOT
  SECURITY DEFINER, unlike the existing append_execution_event() it calls):
  it only ever needs to run as whatever role already has genuine write
  access to these three tables, which in this codebase is exclusively
  service_role (BYPASSRLS). EXECUTE is explicitly revoked from PUBLIC and
  granted only to service_role -- explicit, not assumed, the same
  belt-and-suspenders posture this project has applied to every sensitive
  RPC since the retention-RPC grant incident.

  runtime_execution_events.execution_id/workflow_id are `text` (an older,
  pre-uuid convention this migration does not change), while
  runtime_operator_actions.execution_id/workflow_id are already `uuid` and
  its operator_id is `text` -- workflow_qualification_decisions' own
  execution_id/workflow_id/user_id (uuid) are cast to match each target
  table's OWN actual column types exactly at each call site, never assumed
  to be uniform across tables.

  ============================================================================
  RLS / GRANTS
  ============================================================================

  ADD COLUMN inherits the table's existing RLS policy and grants
  automatically (no new policy/grant statement needed for the column
  itself): authenticated remains SELECT-only via the existing "Users can
  view own qualification decisions" policy; service_role remains the only
  writer. The new function's own EXECUTE grant is explicit (see above).

  ============================================================================
  DATA RETENTION
  ============================================================================

  Unchanged -- this column lives on the same row, subject to the same
  existing ON DELETE CASCADE behavior from workflows/auth.users/
  workflow_executions_v2. No new retention job.
*/

ALTER TABLE "public"."workflow_qualification_decisions"
    ADD COLUMN IF NOT EXISTS "outcome_currency" "text";

ALTER TABLE "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_outcome_revenue_currency_check" CHECK (
        (("outcome_revenue" IS NULL) AND ("outcome_currency" IS NULL))
        OR
        (("outcome_revenue" IS NOT NULL) AND ("outcome_currency" IS NOT NULL))
    );

ALTER TABLE "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_outcome_currency_format_check" CHECK (
        ("outcome_currency" IS NULL) OR ("outcome_currency" ~ '^[A-Z]{3}$')
    );

ALTER TABLE "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_outcome_revenue_shape_check" CHECK (
        ("outcome_revenue" IS NULL)
        OR
        (("outcome_status" = 'won') AND ("outcome_revenue" >= 0))
    );

-- ============================================================================
-- record_lead_outcome_atomic() -- Phase 9.9.15A Part F: the CAS transition
-- and its audit trail (runtime_execution_events + runtime_operator_actions)
-- as ONE atomic unit. See the migration's own header comment above for the
-- full rationale.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."record_lead_outcome_atomic"(
    p_qualification_decision_id uuid,
    p_user_id uuid,
    p_actor_id uuid,
    p_action text,
    p_revenue numeric,
    p_currency text,
    p_note text
)
RETURNS TABLE(
    ok boolean,
    already_in_state boolean,
    previous_status text,
    new_status text,
    current_status text,
    execution_id uuid,
    workflow_id uuid,
    reason text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
  v_updated_id uuid;
  v_fresh_status text;
BEGIN
  IF p_action NOT IN ('contacted', 'won', 'lost') THEN
    RETURN QUERY SELECT false, false, NULL::text, p_action, NULL::text, NULL::uuid, NULL::uuid, 'action must be contacted, won, or lost.';
    RETURN;
  END IF;

  SELECT d.id, d.outcome_status, d.execution_id, d.workflow_id
    INTO v_row
    FROM "public"."workflow_qualification_decisions" d
   WHERE d.id = p_qualification_decision_id
     AND d.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::text, p_action, NULL::text, NULL::uuid, NULL::uuid, 'Qualification decision not found.';
    RETURN;
  END IF;

  -- Idempotent no-op: already in the exact target state -- no audit event.
  IF v_row.outcome_status = p_action THEN
    RETURN QUERY SELECT true, true, v_row.outcome_status, p_action, v_row.outcome_status, v_row.execution_id, v_row.workflow_id, NULL::text;
    RETURN;
  END IF;

  -- V1: won/lost are terminal -- no undo/overwrite path.
  IF v_row.outcome_status IN ('won', 'lost') THEN
    RETURN QUERY SELECT false, false, v_row.outcome_status, p_action, v_row.outcome_status, v_row.execution_id, v_row.workflow_id,
      format('Outcome already recorded as "%s" -- terminal in V1, cannot change to "%s".', v_row.outcome_status, p_action);
    RETURN;
  END IF;

  -- CAS UPDATE: only applies if the row is STILL in the exact state just
  -- observed. IS NOT DISTINCT FROM correctly matches NULL = NULL, unlike
  -- plain "=". The CHECK constraints above are the final, structural
  -- backstop for revenue/currency shape regardless of what this function
  -- passes -- caught below rather than left as a raw exception.
  BEGIN
    UPDATE "public"."workflow_qualification_decisions"
       SET outcome_status = p_action,
           outcome_recorded_by = p_actor_id,
           outcome_recorded_at = now(),
           outcome_revenue = CASE WHEN p_action = 'won' THEN p_revenue ELSE outcome_revenue END,
           outcome_currency = CASE WHEN p_action = 'won' THEN p_currency ELSE outcome_currency END,
           updated_at = now()
     WHERE id = p_qualification_decision_id
       AND user_id = p_user_id
       AND outcome_status IS NOT DISTINCT FROM v_row.outcome_status
    RETURNING id INTO v_updated_id;
  EXCEPTION WHEN check_violation THEN
    RETURN QUERY SELECT false, false, NULL::text, p_action, NULL::text, NULL::uuid, NULL::uuid, ('Invalid outcome data: ' || SQLERRM);
    RETURN;
  END;

  IF v_updated_id IS NULL THEN
    -- Lost the race to a concurrent action -- re-read, NEVER write an
    -- audit event for a transition that did not actually happen.
    SELECT d.outcome_status INTO v_fresh_status FROM "public"."workflow_qualification_decisions" d WHERE d.id = p_qualification_decision_id;
    RETURN QUERY SELECT false, false, NULL::text, p_action, v_fresh_status, v_row.execution_id, v_row.workflow_id,
      format('Outcome was concurrently recorded as "%s" by another action.', v_fresh_status);
    RETURN;
  END IF;

  -- Audit -- same transaction as the UPDATE above. append_execution_event()
  -- is itself SECURITY DEFINER and already exists (Phase 13); called here,
  -- not duplicated.
  PERFORM "public"."append_execution_event"(
    v_row.execution_id::text,
    v_row.workflow_id::text,
    p_user_id,
    NULL,
    'lead_lifecycle_changed',
    1,
    NULL, NULL, NULL, NULL,
    jsonb_build_object(
      'qualification_decision_id', p_qualification_decision_id,
      'previous_status', v_row.outcome_status,
      'new_status', p_action,
      'note', p_note,
      'revenue', CASE WHEN p_action = 'won' THEN p_revenue ELSE NULL END,
      'currency', CASE WHEN p_action = 'won' THEN p_currency ELSE NULL END,
      'actor_id', p_actor_id
    ),
    jsonb_build_object('source', 'lead_lifecycle')
  );

  -- Phase 9.9.15A -- runtime_operator_actions.execution_id/workflow_id are
  -- uuid (unlike runtime_execution_events' text columns above) and
  -- operator_id is text -- cast to match each table's own actual column
  -- types exactly, never assumed.
  INSERT INTO "public"."runtime_operator_actions" (action_type, operator_id, execution_id, workflow_id, payload, result, created_at)
  VALUES (
    'lead_lifecycle_' || p_action,
    p_actor_id::text,
    v_row.execution_id,
    v_row.workflow_id,
    jsonb_build_object('qualificationDecisionId', p_qualification_decision_id, 'previousStatus', v_row.outcome_status, 'note', p_note),
    jsonb_build_object('newStatus', p_action,
      'revenue', CASE WHEN p_action = 'won' THEN p_revenue ELSE NULL END,
      'currency', CASE WHEN p_action = 'won' THEN p_currency ELSE NULL END),
    now()
  );

  RETURN QUERY SELECT true, false, v_row.outcome_status, p_action, p_action, v_row.execution_id, v_row.workflow_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION "public"."record_lead_outcome_atomic"(uuid, uuid, uuid, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."record_lead_outcome_atomic"(uuid, uuid, uuid, text, numeric, text, text) TO "service_role";
