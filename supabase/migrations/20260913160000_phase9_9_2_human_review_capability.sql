/*
  # Durable Human Review / Approval — workflow_review_items (Phase 9.9.2 / 9.9.2A)

  PROPOSED MIGRATION -- NOT YET APPLIED. This is the REVISED design after
  Phase 9.9.2A's security/durability review (the original Phase 9.9.2 draft
  of this file was never applied, so this replaces it in place rather than
  layering a correction on top of a live schema).

  Backs magicflux-nodes.humanReview (lib/workflow-runtime/node-handlers/human-review.ts):
  low-confidence AI classification, refund approval, risky order review,
  content approval, sales escalation -- generic, not hardcoded to any one
  use case.

  ============================================================================
  WHY THIS CHANGED FROM THE ORIGINAL DRAFT
  ============================================================================

  1) RLS was too broad. `FOR ALL USING (auth.uid() = user_id)` let the
     authenticated (owning) role INSERT/UPDATE/DELETE this table directly
     through PostgREST -- meaning a user's own browser session (holding a
     normal Supabase JWT, not the service-role key) could forge
     status='approved', decision_outcome, reviewed_by, or reviewed_at
     without ever going through app/api/reviews/[id]/decide's authorization/
     idempotency/resume logic. This table is a server-authoritative state
     machine, not user-owned data like a workflow the user edits directly --
     the correct model, per this project's OWN precedent for exactly this
     class of table (20260601000003_fix_permissive_rls.sql,
     20260522000002_ownership_rls_hardening.sql), is: authenticated may
     SELECT own rows; only service_role (which bypasses RLS entirely, via
     Postgres's BYPASSRLS role attribute -- not a policy) may write.
     Per the explicit instruction not to assume RLS alone prevents
     mutation (this project has been burned by exactly that assumption
     before -- see 20260616000001_lock_down_retention_rpcs.sql, where a
     forgotten REVOKE left four RPCs EXECUTABLE by PUBLIC despite the
     intent being service-role-only), this migration ALSO explicitly
     REVOKEs INSERT/UPDATE/DELETE from authenticated and ALL from anon at
     the grant layer, not just via policy absence.

  2) The status vocabulary conflated TWO different things: the review
     LIFECYCLE (has a decision been made? has it actually taken effect on
     the execution yet?) and the DISPLAY value of the decision itself
     (approve/reject/custom). That conflation is exactly what created the
     crash-window bug: a CAS pending->approved looked identically "fully
     done" whether or not resumeExecution() had actually been called yet
     (or had crashed mid-flight) -- a repeated decide request saw
     status != 'pending' and treated it as complete, never retrying the
     resume. Fixed: `status` is now PURELY the resume lifecycle
     (pending -> resume_pending -> resumed); the decision's actual value
     lives only in `decision_outcome`, set atomically with the
     pending->resume_pending transition and never changed again.

  3) allowed_outcomes -> _conditionBranch mapping must be a fixed,
     persisted fact, not re-derived from mutable state at resume time.
     The handler now computes the branch index from the (execution_id,
     node_id) row's OWN persisted `allowed_outcomes` column -- the exact
     snapshot taken the moment this review item was created -- rather than
     re-parsing the node's live parameters on each invocation. (The two
     should always agree, since workflow_json is frozen per deployment
     version, but "should always agree" is not the same guarantee as "is
     structurally guaranteed to agree," which is what a durable snapshot
     column provides.)

  ============================================================================
  INVARIANTS ENFORCED IN SQL VS APPLICATION CODE, AND WHY
  ============================================================================

  Enforced here, in SQL (structural facts about a row's own shape --
  correct regardless of which code path writes it, now or in a future
  refactor; a CHECK constraint cannot be silently bypassed by a bug in one
  code path while another path remains "correct"):
    - allowed_outcomes must be non-empty.
    - decision_outcome, once set, must be one of that row's own
      allowed_outcomes (a CHECK constraint CAN reference sibling columns
      of the same row, so this is fully enforceable in SQL, not just app
      code).
    - a 'pending' row must carry NO decision metadata (decision_outcome/
      reviewed_by/reviewed_at all NULL) and a non-'pending' row must carry
      ALL of it (never a partially-decided row) -- one combined CHECK.

  Deliberately left to application code (lib/runtime/review-resume.ts /
  app/api/reviews/[id]/decide/route.ts), NOT SQL, because they are process
  logic, not row-shape facts:
    - "only the first decide request may transition pending->resume_pending"
      -- this is a compare-and-swap UPDATE...WHERE status='pending'
      concurrency pattern, not a constraint a CHECK can express (CHECK
      constraints see one row's proposed new values, not "was there a
      race with another transaction" -- that's what the WHERE clause on
      the UPDATE itself, plus Postgres's row-level locking, already
      guarantees).
    - "don't call resumeExecution() again if the execution already moved
      past this node" -- requires reading a DIFFERENT table
      (workflow_executions_v2) at decision/recovery time, which a CHECK
      constraint on THIS table cannot do (constraints can only see the row
      being written, or run a function, but cross-table business logic
      like this belongs in the recovery function, not a trigger, to keep
      it visible/testable/debuggable as ordinary application code rather
      than implicit database magic).

  ============================================================================
  REVIEW LIFECYCLE / STATE MACHINE
  ============================================================================

    pending  --[decide: CAS pending->resume_pending,
                 decision_outcome/reviewed_by/reviewed_at set atomically]-->
    resume_pending  --[attemptReviewResume(): execution still waiting at
                 exactly this node -> call resumeExecution(); on success,
                 CAS resume_pending->resumed]-->
    resumed  (terminal)

    resume_pending is durable and DETECTABLE: if the process crashes or the
    network fails between the first CAS and the resumeExecution() call (or
    while it's in flight), the row is left at resume_pending -- indistinguishable
    from "resume genuinely never got attempted yet" is exactly the point: both
    cases are safe to retry the SAME way. resume_attempts/last_resume_error
    record retry history for observability.

  Recovery is checked from TWO places, reusing the same
  lib/runtime/review-resume.ts#attemptReviewResume() function (no duplicate
  logic to drift):
    1. Inline, opportunistically: a decide request against an item already
       at resume_pending (a duplicate submit, or the founder reloading the
       review page and clicking again) drives recovery immediately.
    2. A cron sweep (app/api/cron/recover-review-resumes, mirroring
       lib/runtime/retry-dispatcher.ts's existing due-execution scan
       pattern exactly) for the case where no human ever retries -- claims
       stale resume_pending rows via the same optimistic-CAS pattern
       already proven by pollDueSchedules()/dispatchDueRetries(), so this
       reuses existing infrastructure conventions rather than inventing a
       new polling mechanism.

  Duplicate-side-effect safety: before ever calling resumeExecution() again,
  attemptReviewResume() checks workflow_executions_v2.status/current_node_id
  for this execution_id. If the execution has already moved past this exact
  node (status != 'waiting', or current_node_id no longer equals this row's
  node_id) -- proof a prior resume attempt already progressed the run -- it
  does NOT call resumeExecution() again; it only catches up this row's own
  bookkeeping to 'resumed'. resumeExecution() is only ever (re)invoked when
  the execution is STILL genuinely parked exactly at this review node.

  ============================================================================
  UNCHANGED FROM THE ORIGINAL DESIGN
  ============================================================================

    - workflow_id / execution_id stay loosely-typed `text` (matches
      workflow_execution_steps.execution_id's own precedent).
    - deployment_version_id is a real FK into deployment_versions, so
      resume always re-reads the SAME frozen snapshot the execution
      started with.
    - UNIQUE (execution_id, node_id) is still the single mechanism making
      review-item creation idempotent.
    - review_context stays deep-redacted + size-bounded before insert.
*/

CREATE TABLE IF NOT EXISTS workflow_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  deployment_version_id uuid REFERENCES deployment_versions(id) ON DELETE SET NULL,
  execution_id text NOT NULL,
  node_id text NOT NULL,
  node_name text,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),

  -- Resume LIFECYCLE only -- never the decision's own value (see decision_outcome).
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resume_pending', 'resumed')),

  allowed_outcomes text[] NOT NULL DEFAULT ARRAY['approve', 'reject'],
  decision_outcome text,
  instruction text,
  review_context jsonb NOT NULL DEFAULT '{}'::jsonb,

  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  resumed_at timestamptz,
  resume_attempts integer NOT NULL DEFAULT 0,
  last_resume_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (execution_id, node_id),

  CONSTRAINT workflow_review_items_outcomes_nonempty
    CHECK (cardinality(allowed_outcomes) > 0),

  CONSTRAINT workflow_review_items_decision_in_outcomes
    CHECK (decision_outcome IS NULL OR decision_outcome = ANY (allowed_outcomes)),

  -- A row is either fully undecided or fully decided -- never partial.
  CONSTRAINT workflow_review_items_decision_shape
    CHECK (
      (status = 'pending' AND decision_outcome IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR
      (status <> 'pending' AND decision_outcome IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS workflow_review_items_user_status_created
  ON workflow_review_items (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_review_items_workflow_idx
  ON workflow_review_items (workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_review_items_execution_idx
  ON workflow_review_items (execution_id);

-- Partial index for the recovery cron's sweep -- only ever scans rows that
-- could possibly need recovery, not the whole table.
CREATE INDEX IF NOT EXISTS workflow_review_items_resume_pending_idx
  ON workflow_review_items (updated_at)
  WHERE status = 'resume_pending';

-- ============================================================================
-- RLS: authenticated may SELECT own rows only. No INSERT/UPDATE/DELETE
-- policy exists for authenticated or anon at all -- once RLS is enabled,
-- the absence of a policy for a command is a default DENY for that role/
-- command, not an oversight to fix later. service_role bypasses RLS
-- entirely (BYPASSRLS), so all real writes (from app/api/reviews/* and
-- the recovery cron, both using createServiceClient()) are unaffected.
-- ============================================================================

ALTER TABLE workflow_review_items ENABLE ROW LEVEL SECURITY;

-- Defensive: drop the original (never-applied, but written-to-disk) overly
-- permissive FOR ALL policy name in case anyone already ran the Phase
-- 9.9.2 draft against a scratch/dev database.
DROP POLICY IF EXISTS "Users can access own review items" ON workflow_review_items;

DROP POLICY IF EXISTS "Users can read own review items" ON workflow_review_items;
CREATE POLICY "Users can read own review items"
  ON workflow_review_items
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================================
-- Grants: explicit, not assumed. Do not rely on RLS alone -- Supabase
-- projects commonly carry broad default GRANTs to authenticated/anon from
-- project bootstrap (ALTER DEFAULT PRIVILEGES), and this project has
-- already been bitten by exactly that once (see
-- 20260616000001_lock_down_retention_rpcs.sql's REVOKE EXECUTE ... FROM
-- PUBLIC/anon/authenticated). Belt-and-suspenders: even if this table
-- somehow inherited a broad default grant, INSERT/UPDATE/DELETE are
-- explicitly revoked from authenticated, and anon gets nothing at all.
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON workflow_review_items FROM authenticated;
REVOKE ALL ON workflow_review_items FROM anon;
GRANT SELECT ON workflow_review_items TO authenticated;
