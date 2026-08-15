/*
  Phase 7 Fix: Self-Healing Runtime Architecture Hardening

  1. Alert deduplication: occurrences + first/last seen columns + unique index
  2. Expand runtime_workers status CHECK to include draining / restarting
  3. runtime_worker_restart_requests — lifecycle signal table for graceful restarts
  4. runtime_healing_actions — cooldown protection for self-healing actions
  5. Six DB-side aggregation functions (replace Node.js row-fetch loops)

  All statements are idempotent. No data is deleted. No RLS policies are modified.
*/

-- ============================================================================
-- 1) Alert deduplication columns
-- ============================================================================

ALTER TABLE runtime_security_alerts
  ADD COLUMN IF NOT EXISTS occurrences   integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;

-- Back-fill existing rows so the columns are never null after migration.
UPDATE runtime_security_alerts
  SET first_seen_at = created_at,
      last_seen_at  = created_at
  WHERE first_seen_at IS NULL;

-- Partial unique index: at most one *unresolved* alert per (type, workflow, execution, worker).
-- Uses COALESCE so that NULLs are treated as '' for uniqueness purposes.
CREATE UNIQUE INDEX IF NOT EXISTS runtime_security_alerts_dedup_idx
  ON runtime_security_alerts(
    alert_type,
    COALESCE(workflow_id, ''),
    COALESCE(execution_id, ''),
    COALESCE(worker_id, '')
  )
  WHERE resolved_at IS NULL;

-- ============================================================================
-- 2) Expand runtime_workers status constraint
-- ============================================================================

-- Drop the old named constraint (added in phase7_runtime_infra_hardening migration).
ALTER TABLE runtime_workers
  DROP CONSTRAINT IF EXISTS runtime_workers_status_check;

ALTER TABLE runtime_workers
  ADD CONSTRAINT runtime_workers_status_check
  CHECK (status IN (
    'starting', 'healthy', 'degraded',
    'draining', 'restarting',
    'stopping', 'stopped', 'crashed'
  ));

-- ============================================================================
-- 3) Worker restart requests table
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_worker_restart_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id      text        NOT NULL,
  reason         text        NOT NULL
    CHECK (reason IN ('anomaly_detected', 'high_crash_rate', 'manual')),
  requested_by   text        NOT NULL DEFAULT 'self_healer',
  status         text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'completed', 'failed')),
  acknowledged_at timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_worker_restart_requests_worker_idx
  ON runtime_worker_restart_requests(worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_worker_restart_requests_pending_idx
  ON runtime_worker_restart_requests(created_at ASC)
  WHERE status = 'pending';

ALTER TABLE runtime_worker_restart_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can manage worker restart requests"
  ON runtime_worker_restart_requests;
CREATE POLICY "Service can manage worker restart requests"
  ON runtime_worker_restart_requests FOR ALL USING (true);

-- ============================================================================
-- 4) Healing actions cooldown table
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_healing_actions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type   text        NOT NULL,
  target        text        NOT NULL,
  executed_at   timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz NOT NULL,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_healing_actions_cooldown_idx
  ON runtime_healing_actions(action_type, target, cooldown_until DESC);

ALTER TABLE runtime_healing_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can manage healing actions" ON runtime_healing_actions;
CREATE POLICY "Service can manage healing actions"
  ON runtime_healing_actions FOR ALL USING (true);

-- ============================================================================
-- 5a) detect_repeated_node_failures
--     Groups failed node states by (workflow_id, node_id) within a time window.
--     Returns rows only for (workflow, node) pairs that exceed p_threshold.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_repeated_node_failures(
  p_threshold      integer DEFAULT 5,
  p_window_minutes integer DEFAULT 10
)
RETURNS TABLE(
  node_key     text,
  workflow_id  text,
  execution_id text,
  user_id      text,
  failure_count bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    COALESCE(rns.workflow_id::text, '') || '_' || COALESCE(rns.node_id::text, '')
                                                                       AS node_key,
    COALESCE(rns.workflow_id::text, '')                                AS workflow_id,
    (array_agg(rns.execution_id::text ORDER BY rns.updated_at DESC))[1] AS execution_id,
    (array_agg(rns.user_id::text      ORDER BY rns.updated_at DESC))[1] AS user_id,
    COUNT(*)                                                             AS failure_count
  FROM runtime_node_states rns
  WHERE rns.status = 'failed'
    AND rns.updated_at >= NOW() - make_interval(mins => p_window_minutes)
  GROUP BY rns.workflow_id, rns.node_id
  HAVING COUNT(*) >= p_threshold
  LIMIT 100
$$;

-- ============================================================================
-- 5b) detect_execution_loops
--     Groups steps by execution_id; surfaces runs with abnormally high step counts.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_execution_loops(
  p_threshold      integer DEFAULT 100,
  p_window_minutes integer DEFAULT 10
)
RETURNS TABLE(
  execution_id text,
  workflow_id  text,
  user_id      text,
  step_count   bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    wes.execution_id::text,
    (array_agg(wes.workflow_id::text ORDER BY wes.started_at DESC))[1] AS workflow_id,
    (array_agg(wes.user_id::text     ORDER BY wes.started_at DESC))[1] AS user_id,
    COUNT(*) AS step_count
  FROM workflow_execution_steps wes
  WHERE wes.started_at >= NOW() - make_interval(mins => p_window_minutes)
  GROUP BY wes.execution_id
  HAVING COUNT(*) >= p_threshold
  LIMIT 50
$$;

-- ============================================================================
-- 5c) detect_retry_storm
--     Returns one row when the retry ratio in the window exceeds p_ratio,
--     minimum job count of 10 required to avoid false positives on low volume.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_retry_storm(
  p_ratio          numeric DEFAULT 0.20,
  p_window_minutes integer DEFAULT 10
)
RETURNS TABLE(retried_count bigint, total_count bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(rqj.attempts, 0)::int > 1) AS retried_count,
    COUNT(*)                                                      AS total_count
  FROM runtime_queue_jobs rqj
  WHERE rqj.created_at >= NOW() - make_interval(mins => p_window_minutes)
  HAVING COUNT(*) > 10
    AND (COUNT(*) FILTER (WHERE COALESCE(rqj.attempts, 0)::int > 1))::numeric
          / NULLIF(COUNT(*), 0) >= p_ratio
$$;

-- ============================================================================
-- 5d) detect_dlq_spike
--     Returns one row when dead-letter entries in the window meet p_threshold.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_dlq_spike(
  p_threshold      integer DEFAULT 5,
  p_window_minutes integer DEFAULT 10
)
RETURNS TABLE(dlq_count bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*) AS dlq_count
  FROM runtime_queue_dead_letters
  WHERE failed_at >= NOW() - make_interval(mins => p_window_minutes)
  HAVING COUNT(*) >= p_threshold
$$;

-- ============================================================================
-- 5e) detect_worker_crashes
--     Counts workers that transitioned to 'crashed' in the last 30 minutes.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_worker_crashes(
  p_threshold integer DEFAULT 2
)
RETURNS TABLE(crash_count bigint, worker_ids text[])
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    COUNT(*)                           AS crash_count,
    array_agg(worker_id::text)         AS worker_ids
  FROM runtime_workers
  WHERE status = 'crashed'
    AND updated_at >= NOW() - INTERVAL '30 minutes'
  HAVING COUNT(*) >= p_threshold
$$;

-- ============================================================================
-- 5f) detect_queue_congestion
--     Counts active jobs whose heartbeat has stalled for more than 5 minutes.
-- ============================================================================

CREATE OR REPLACE FUNCTION detect_queue_congestion(
  p_threshold integer DEFAULT 10
)
RETURNS TABLE(stalled_count bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*) AS stalled_count
  FROM runtime_queue_jobs
  WHERE status = 'active'
    AND heartbeat_at < NOW() - INTERVAL '5 minutes'
  HAVING COUNT(*) >= p_threshold
$$;
