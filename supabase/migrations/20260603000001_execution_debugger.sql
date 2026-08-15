/*
  Execution Debugger — Schema additions

  The workflow_execution_steps table already captures everything we need
  (node_id, node_name, node_type, status, input_data, output_data, logs,
  error_message, attempt, started_at, completed_at).

  This migration adds:
    1. v_execution_steps_final  – one row per node per execution (final state)
    2. v_execution_summaries    – one row per execution with step counts and duration
    3. Performance indexes

  All views filter nothing — callers must always add user_id conditions.
*/

-- ============================================================================
-- 1) v_execution_steps_final
--
-- For every (execution_id, node_id) pair returns only the LATEST row.
-- This gives the terminal status of each node — not the intermediate 'running'
-- state — while preserving started_at from the first insert.
--
-- Callers ORDER BY min_started_at ASC to get timeline order.
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
  -- Duration in milliseconds (NULL when still running)
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
  -- Earliest started_at for this node across all attempts (used for ordering)
  MIN(s.started_at) OVER (
    PARTITION BY s.execution_id, s.node_id
  )                        AS min_started_at,
  -- Row rank: 1 = latest row (used for dedup in outer query)
  ROW_NUMBER() OVER (
    PARTITION BY s.execution_id, s.node_id
    ORDER BY s.created_at DESC
  )                        AS rn
FROM workflow_execution_steps s;

-- ============================================================================
-- 2) v_execution_summaries
--
-- One row per execution with workflow name, duration, and step counts.
-- ============================================================================

CREATE OR REPLACE VIEW v_execution_summaries AS
WITH final_steps AS (
  -- Deduplicate: keep only the latest row per (execution_id, node_id)
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
LEFT JOIN workflows  w  ON  w.id = e.workflow_id AND w.user_id = e.user_id
LEFT JOIN step_agg  sa  ON sa.execution_id = e.id AND sa.user_id = e.user_id;

-- ============================================================================
-- 3) Indexes
-- ============================================================================

-- Execution list: filter by user + status + started_at
CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_status_started
  ON workflow_executions_v2 (user_id, status, started_at DESC);

-- Step lookup: fetch steps for one execution, ordered by created_at
CREATE INDEX IF NOT EXISTS workflow_execution_steps_exec_created
  ON workflow_execution_steps (execution_id, user_id, created_at DESC);

-- Metrics aggregation: count by user + status within a date window
CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_started
  ON workflow_executions_v2 (user_id, started_at DESC);
