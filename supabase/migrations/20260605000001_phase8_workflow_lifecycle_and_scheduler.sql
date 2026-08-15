/*
  Phase 8 — Production Automation Control Plane: workflow lifecycle,
  version freezing, and the schedule-trigger engine.

  Deliberately reuses existing schema rather than inventing parallel systems:
    - `deployment_versions` (phase8_autonomous_ai_builder, status lifecycle
      widened in expand_deployment_versions_statuses) already has exactly the
      right shape for a frozen, versioned workflow snapshot — this migration
      wires it up as THE active-version mechanism instead of creating a
      fourth version table (workflow_graph_versions, runtime_workflow_versions,
      and workflow_deployments already exist for other, unrelated purposes —
      see Phase 8 architecture audit).
    - `workflow_executions_v2` gets a nullable pointer to the exact version an
      execution was pinned to, fixing a real bug: resume previously re-read
      the *current* (possibly since-edited) workflow_json instead of what was
      live when the execution started.
    - `workflow_schedules` is genuinely new — no cron/schedule engine existed
      anywhere in the codebase before this migration (confirmed by audit).
*/

-- ============================================================================
-- 1) Workflow lifecycle status — widen from draft/deployed to the full set.
--    `workflows` predates the tracked migration history, so its exact current
--    CHECK constraint (if any) is unknown; this defensively drops whatever
--    status-related check exists (same pattern already used in
--    expand_deployment_versions_statuses.sql for deployment_versions) before
--    adding the superset. 'deployed' is kept for backward compatibility with
--    the existing external-n8n deploy pipeline.
-- ============================================================================

DO $$
DECLARE
  constraint_row record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows') THEN
    FOR constraint_row IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'workflows'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE workflows DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
    END LOOP;

    ALTER TABLE workflows
      ADD CONSTRAINT workflows_status_check CHECK (
        status IN ('draft', 'validating', 'active', 'paused', 'disabled', 'error', 'archived', 'deployed')
      );

    -- Activation / version-pointer columns.
    ALTER TABLE workflows
      ADD COLUMN IF NOT EXISTS active_deployment_version_id uuid REFERENCES deployment_versions(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS activated_at timestamptz,
      ADD COLUMN IF NOT EXISTS deployment_error text;

    CREATE INDEX IF NOT EXISTS workflows_status_idx ON workflows(status);
    CREATE INDEX IF NOT EXISTS workflows_active_version_idx ON workflows(active_deployment_version_id);
  END IF;
END $$;

-- ============================================================================
-- 2) deployment_versions — add an error column for failed/invalid activations
--    ("Activation must show validation errors instead of silently failing").
-- ============================================================================

ALTER TABLE deployment_versions
  ADD COLUMN IF NOT EXISTS error_message text;

-- ============================================================================
-- 3) workflow_executions_v2 — pin the exact deployment version an execution
--    used, so resume (and any future re-read) uses the SAME frozen JSON that
--    was live when the execution started, not whatever is live now.
-- ============================================================================

ALTER TABLE workflow_executions_v2
  ADD COLUMN IF NOT EXISTS deployment_version_id uuid REFERENCES deployment_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS workflow_executions_v2_deployment_version_idx
  ON workflow_executions_v2(deployment_version_id);

-- ============================================================================
-- 4) workflow_schedules — schedule-trigger registry. One row per schedule
--    trigger node per workflow. next_run_at is claimed via an atomic
--    compare-and-swap UPDATE (same optimistic-concurrency pattern already
--    used by runtime_execution_locks.lock_version), so two scheduler poller
--    processes racing on the same due schedule can never both fire it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_name text NOT NULL,
  schedule_type text NOT NULL CHECK (schedule_type IN ('cron', 'interval')),
  cron_expression text,
  interval_seconds integer,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_execution_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, node_id)
);

CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
  ON workflow_schedules(next_run_at)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS workflow_schedules_user_idx
  ON workflow_schedules(user_id, updated_at DESC);

ALTER TABLE workflow_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own workflow schedules" ON workflow_schedules;
CREATE POLICY "Users can access own workflow schedules" ON workflow_schedules
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- 5) Per-user / per-workflow concurrency limiting — indexes for the hot
--    "how many of my executions are currently running" query used by the new
--    concurrency guard (lib/runtime/concurrency-guard.ts). No new table:
--    this counts existing workflow_executions_v2 rows directly.
-- ============================================================================

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_running_idx
  ON workflow_executions_v2(user_id, status) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS workflow_executions_v2_workflow_running_idx
  ON workflow_executions_v2(workflow_id, status) WHERE status = 'running';
