/*
  Repair: v_execution_summaries fails to (re)create against a database where
  workflow_execution_steps.execution_id / workflow_executions_v2.workflow_id
  are `uuid` columns, because 20260603000001_execution_debugger.sql's join
  `sa.execution_id = e.id::text` compares a `uuid` (sa.execution_id, inherited
  from workflow_execution_steps.execution_id) against a `text` (e.id::text) --
  Postgres has no `uuid = text` operator, so the statement fails with 42883.

  Read-only production inspection (pg_get_viewdef-equivalent, via
  `supabase db dump --schema public`) confirmed:
    - workflows.id                          uuid
    - workflow_executions_v2.workflow_id    uuid   (NOT text, unlike what
                                                      20260509091500's tracked
                                                      CREATE TABLE declares --
                                                      this production database's
                                                      execution-v2 tables were
                                                      never actually created by
                                                      that tracked file; they
                                                      predate it under a
                                                      different, undocumented
                                                      schema)
    - workflow_execution_steps.execution_id uuid   (same drift)
    - workflow_execution_steps.workflow_id  uuid   (same drift)

  The already-live v_execution_summaries (created outside the tracked
  migration history) already joins `w.id = e.workflow_id` with NO cast at
  all -- valid today only because both sides happen to be uuid in THIS
  database. 20260603000001's checked-in file, as originally written, assumes
  text columns (matching its own tracked CREATE TABLE) and would work fine
  end-to-end on a genuinely fresh database that ran the migration chain from
  scratch. It is not universally broken -- it only fails against this
  specific, already-drifted production schema. That is why this is a NEW
  forward migration rather than an edit to the historical file: the old file
  remains correct for a fresh/text-typed environment; this migration corrects
  the two views for THIS project's actual (uuid-typed) reality.

  Fix: cast BOTH sides of both join conditions to `::text` explicitly. This
  is the one direction that cannot throw regardless of the underlying column
  type -- `uuid::text` always succeeds (canonical string form, no validation
  to fail), and `text::text` is a no-op. So these view definitions are
  correct whether the underlying columns are uuid (this production) or text
  (a fresh environment that replayed 20260603000001 as originally written).

  Column names, order, and semantics are otherwise identical to
  20260603000001_execution_debugger.sql. No table is touched; no data is
  read differently than before. Idempotent (CREATE OR REPLACE VIEW).
*/

-- ============================================================================
-- 1) v_execution_steps_final -- unchanged from 20260603000001 (no join, no
--    cast issue). Recreated here only so this migration is a complete,
--    self-contained replacement of both views.
-- ============================================================================

CREATE OR REPLACE VIEW v_execution_steps_final AS
SELECT
  s.id,
  s.execution_id,
  s.workflow_id,
  s.user_id,
  s.node_id,
  s.node_name,
  s.node_type,
  s.status,
  s.attempt,
  s.input_data,
  s.output_data,
  s.logs,
  s.error_message,
  s.started_at,
  s.completed_at,
  s.created_at,
  CASE
    WHEN s.started_at  IS NOT NULL
     AND s.completed_at IS NOT NULL
    THEN (
      EXTRACT(EPOCH FROM (
        s.completed_at::timestamptz - s.started_at::timestamptz
      )) * 1000
    )::bigint
    ELSE NULL
  END                      AS duration_ms,
  MIN(s.started_at) OVER (
    PARTITION BY s.execution_id, s.node_id
  )                        AS min_started_at,
  ROW_NUMBER() OVER (
    PARTITION BY s.execution_id, s.node_id
    ORDER BY s.created_at DESC
  )                        AS rn
FROM workflow_execution_steps s;

-- ============================================================================
-- 2) v_execution_summaries -- both join conditions now cast both sides to
--    ::text, so the view works whether execution_id/workflow_id/id are uuid
--    or text in the underlying tables.
-- ============================================================================

CREATE OR REPLACE VIEW v_execution_summaries AS
WITH final_steps AS (
  SELECT *
  FROM v_execution_steps_final
  WHERE rn = 1
),
step_agg AS (
  SELECT
    execution_id,
    user_id,
    COUNT(*)                                                AS step_count,
    COUNT(*) FILTER (WHERE status = 'failed')              AS failed_step_count
  FROM final_steps
  GROUP BY execution_id, user_id
)
SELECT
  e.id,
  e.workflow_id,
  e.user_id,
  e.status,
  e.mode,
  e.started_at,
  e.completed_at,
  e.error_message,
  e.retry_count,
  COALESCE(w.name, 'Deleted workflow')                     AS workflow_name,
  COALESCE(sa.step_count,        0)                        AS step_count,
  COALESCE(sa.failed_step_count, 0)                        AS failed_step_count,
  CASE
    WHEN e.started_at  IS NOT NULL
     AND e.completed_at IS NOT NULL
    THEN (
      EXTRACT(EPOCH FROM (
        e.completed_at::timestamptz - e.started_at::timestamptz
      )) * 1000
    )::bigint
    ELSE NULL
  END                                                      AS duration_ms
FROM workflow_executions_v2  e
LEFT JOIN workflows  w  ON  w.id::text = e.workflow_id::text AND w.user_id = e.user_id
LEFT JOIN step_agg  sa  ON sa.execution_id::text = e.id::text AND sa.user_id = e.user_id;

-- ============================================================================
-- 3) Indexes from 20260603000001 -- already created by
--    20260509091500_execution_v2_tables.sql / this migration's IF NOT EXISTS
--    guards make re-declaring them here harmless either way.
-- ============================================================================

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_status_started
  ON workflow_executions_v2 (user_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS workflow_execution_steps_exec_created
  ON workflow_execution_steps (execution_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_started
  ON workflow_executions_v2 (user_id, started_at DESC);
