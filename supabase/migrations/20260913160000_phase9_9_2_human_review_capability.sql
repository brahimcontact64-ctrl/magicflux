/*
  # Durable Human Review / Approval — workflow_review_items (Phase 9.9.2)

  PROPOSED MIGRATION -- NOT YET APPLIED. Written for review per the explicit
  instruction to stop before applying any schema change for this capability.

  Backs magicflux-nodes.humanReview (lib/workflow-runtime/node-handlers/human-review.ts),
  the durable review/approval primitive: low-confidence AI classification,
  refund approval, risky order review, content approval, sales escalation --
  generic, not hardcoded to any one use case.

  Design, mirroring the EXISTING execution-log tables
  (20260509091500_execution_v2_tables.sql) so this table follows the same
  conventions already established in this schema rather than inventing new
  ones:
    - workflow_id / execution_id are loosely-typed `text`, NOT foreign keys
      into workflows/workflow_executions_v2 -- exactly like
      workflow_execution_steps.execution_id already is. workflows.id is
      itself uuid; the loose typing here matches the sibling table's own
      precedent rather than introducing a new, inconsistent convention.
    - deployment_version_id IS a real FK (uuid REFERENCES deployment_versions),
      matching workflow_executions_v2.deployment_version_id exactly (added in
      20260605000001_phase8_workflow_lifecycle_and_scheduler.sql) -- a
      resumed execution must re-read the SAME frozen workflow_json snapshot
      it started with, never whatever is live at decision time.
    - RLS policy shape (`FOR ALL USING (auth.uid() = user_id)`) is copied
      verbatim from workflow_executions_v2 / workflow_execution_steps --
      this is defense-in-depth, not the primary authorization boundary: all
      real reads/writes go through the service-role client from a trusted
      API route (app/api/reviews/*) that independently checks
      `.eq('user_id', authenticatedUserId)` on every query, exactly like
      every other owner-scoped table in this codebase (workflows,
      workflow_schedules, etc.) -- consistent with this project's
      established pattern of never relying on RLS alone for authorization.
    - UNIQUE (execution_id, node_id): the single mechanism that makes the
      handler's "look up my own review item, create if absent" idempotent
      (a concurrent duplicate insert fails the constraint, is treated as
      "already exists" rather than an error -- see human-review.ts) AND the
      one thing that makes "does a review item already exist for this exact
      node-in-this-exact-execution" a single indexed lookup, not a scan.
    - status starts 'pending' and transitions to 'approved'/'rejected'/
      'decided' (a named custom outcome) via a compare-and-swap UPDATE ...
      WHERE status = 'pending' in app/api/reviews/[id]/decide/route.ts --
      the SAME optimistic-concurrency pattern already proven by
      lib/runtime/scheduler.ts's pollDueSchedules() and
      lib/runtime/retry-dispatcher.ts's due-execution claim. This is what
      makes "duplicate decision does not resume twice" true: a second
      decide request for an already-decided item finds zero rows to update
      and never calls resumeExecution() again.
    - review_context is jsonb, always deep-redacted (lib/security/redact.ts's
      redact(), the one authoritative secret-scrubbing utility) and
      size-bounded BEFORE insert by the handler -- this table must never
      receive raw, unredacted workflow input or any credential/secret value.

  Execution-state changes (NONE required beyond what already exists):
  workflow_executions_v2.status already includes 'waiting', and
  next_run_at already accepts NULL (this migration's sibling code change --
  see runtime/workflow-engine.ts -- makes a 'waiting' result with no
  nextRunAt persist next_run_at = NULL instead of inventing a 60s-later
  fallback). lib/runtime/retry-dispatcher.ts's `.lte(next_run_at, now)`
  scan never matches a NULL next_run_at in Postgres, so a human-review-
  paused execution can ONLY resume via the explicit decide endpoint calling
  ExecutionManager.resumeExecution() directly -- never the timer-based
  dispatcher. No new execution-state columns or values are needed.

  Resume/idempotency design (implemented in
  app/api/reviews/[id]/decide/route.ts):
    1. Fetch the review item scoped to `id` AND `user_id = authenticated
       user's id` in the same query -- a row owned by a different user
       comes back as not-found, never leaking existence (cross-tenant
       isolation).
    2. Validate the submitted decision is one of the row's own
       allowed_outcomes.
    3. CAS UPDATE ... WHERE id = :id AND user_id = :userId AND
       status = 'pending' -- only the FIRST such request for a given item
       ever succeeds; a concurrent or later duplicate finds zero rows and
       returns an idempotent "already decided" response without touching
       the execution.
    4. Only on a successful CAS does the route resolve the workflow's
       frozen workflow_json (via deployment_version_id, exactly like
       scheduler.ts/execution-dispatch.ts already do) and call
       ExecutionManager.resumeExecution() for execution_id -- so a given
       execution is resumed from this path AT MOST once per review item.
    5. On resume, the engine re-invokes the SAME humanReview node; the
       handler looks up its own review row again, finds it no longer
       'pending', and returns success with _conditionBranch set to the
       decided outcome's index into allowed_outcomes -- routing through the
       exact same branch-dispatch logic an IF node uses (Phase 9.9.0's
       fix), continuing ONLY the matching branch.
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
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'decided')),
  allowed_outcomes text[] NOT NULL DEFAULT ARRAY['approve', 'reject'],
  decision_outcome text,
  instruction text,
  review_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, node_id)
);

CREATE INDEX IF NOT EXISTS workflow_review_items_user_status_created
  ON workflow_review_items (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_review_items_workflow_idx
  ON workflow_review_items (workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_review_items_execution_idx
  ON workflow_review_items (execution_id);

ALTER TABLE workflow_review_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own review items" ON workflow_review_items;
CREATE POLICY "Users can access own review items" ON workflow_review_items
  FOR ALL USING (auth.uid() = user_id);
