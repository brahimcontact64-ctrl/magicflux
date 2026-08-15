/*
  # Execution Logs System — workflow_executions_v2 / workflow_execution_steps

  These two tables are the execution-log backbone the rest of the runtime was
  already built against: runtime/runtime-state.ts persists every execution
  and node-attempt row here, app/api/executions/* and the run viewer
  (components/runs/*) read from them, and later migrations
  (20260525000001_runtime_self_healing.sql, 20260602000001_command_ownership_guard.sql,
  20260603000001_execution_debugger.sql) already assume they exist — the
  command-ownership trigger queries workflow_executions_v2 directly, and the
  execution-debugger views SELECT straight from both tables. No migration
  ever actually created them; this backfills that gap so a fresh database
  matches what production has been running against.

  workflow_execution_steps is append-only: one row per node per attempt/status
  transition (never updated in place — see runtime-state.ts persistNodeState).
  v_execution_steps_final (in the execution-debugger migration) dedupes to the
  latest row per (execution_id, node_id).
*/

-- ============================================================================
-- 1) workflow_executions_v2 — one row per workflow run
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_executions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('running', 'success', 'failed', 'waiting', 'paused', 'cancelled')
  ),
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  input_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_data jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  current_node_id text,
  error_message text,
  next_run_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_status_started
  ON workflow_executions_v2 (user_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_started
  ON workflow_executions_v2 (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_v2_workflow_idx
  ON workflow_executions_v2 (workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_v2_user_updated
  ON workflow_executions_v2 (user_id, updated_at DESC);

-- ============================================================================
-- 2) workflow_execution_steps — append-only per-node execution log
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_name text NOT NULL,
  node_type text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'success', 'failed', 'retrying', 'cancelled')
  ),
  attempt integer NOT NULL DEFAULT 1,
  input_data jsonb,
  output_data jsonb,
  logs text[] NOT NULL DEFAULT '{}',
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_execution_steps_exec_created
  ON workflow_execution_steps (execution_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_execution_steps_workflow_idx
  ON workflow_execution_steps (workflow_id, created_at DESC);

-- ============================================================================
-- 3) RLS policies (matches runtime_node_states / runtime_execution_checkpoints)
-- ============================================================================

ALTER TABLE workflow_executions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own executions" ON workflow_executions_v2;
CREATE POLICY "Users can access own executions" ON workflow_executions_v2
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own execution steps" ON workflow_execution_steps;
CREATE POLICY "Users can access own execution steps" ON workflow_execution_steps
  FOR ALL USING (auth.uid() = user_id);
