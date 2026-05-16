/*
  # Phase 5: Execution Safety + Observability

  Adds production safety/governance + telemetry primitives for autonomous agents.
*/

CREATE TABLE IF NOT EXISTS agent_execution_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text,
  mode text NOT NULL DEFAULT 'safe' CHECK (mode IN ('safe', 'staging', 'production')),
  sandbox_enabled boolean NOT NULL DEFAULT true,
  dry_run_enabled boolean NOT NULL DEFAULT true,
  require_approval_high_risk boolean NOT NULL DEFAULT true,
  max_tool_calls_per_turn integer NOT NULL DEFAULT 12,
  max_rounds_per_turn integer NOT NULL DEFAULT 8,
  max_external_actions_per_hour integer NOT NULL DEFAULT 120,
  max_deployments_per_hour integer NOT NULL DEFAULT 20,
  max_activation_per_hour integer NOT NULL DEFAULT 30,
  max_api_calls_per_minute integer NOT NULL DEFAULT 60,
  duplicate_window_seconds integer NOT NULL DEFAULT 120,
  max_repeat_same_action integer NOT NULL DEFAULT 3,
  max_ai_tokens_per_day integer NOT NULL DEFAULT 400000,
  max_ai_cost_usd_per_day numeric(12,4) NOT NULL DEFAULT 25,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS agent_execution_policies_user_idx
  ON agent_execution_policies(user_id);

CREATE TABLE IF NOT EXISTS agent_action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  action_key text NOT NULL,
  action_type text NOT NULL,
  action_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, action_key)
);

CREATE INDEX IF NOT EXISTS agent_action_approvals_session_idx
  ON agent_action_approvals(session_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_execution_locks (
  lock_key text PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text,
  action_name text,
  workflow_id text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS agent_execution_locks_expires_idx
  ON agent_execution_locks(expires_at);

CREATE TABLE IF NOT EXISTS agent_deploy_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_name text,
  workflow_id text,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'deployed', 'activated', 'rolled_back', 'failed')),
  dry_run boolean NOT NULL DEFAULT false,
  sandbox boolean NOT NULL DEFAULT true,
  snapshot_before jsonb,
  snapshot_after jsonb,
  rollback_plan jsonb,
  rollback_result jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_deploy_transactions_user_idx
  ON agent_deploy_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  agent_name text NOT NULL DEFAULT 'planner',
  event_type text NOT NULL,
  action_name text,
  status text NOT NULL DEFAULT 'info' CHECK (status IN ('info', 'success', 'warning', 'error')),
  detail text,
  workflow_id text,
  workflow_url text,
  duration_ms integer,
  retry_count integer NOT NULL DEFAULT 0,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_action_events_session_idx
  ON agent_action_events(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_action_events_user_idx
  ON agent_action_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_id text,
  provider text NOT NULL,
  model text NOT NULL,
  agent_name text NOT NULL DEFAULT 'planner',
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_ai_usage_user_idx
  ON agent_ai_usage(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  monthly_budget_usd numeric(12,2) NOT NULL DEFAULT 50,
  per_workflow_budget_usd numeric(12,2) NOT NULL DEFAULT 10,
  auto_stop_threshold_pct integer NOT NULL DEFAULT 90 CHECK (auto_stop_threshold_pct > 0 AND auto_stop_threshold_pct <= 100),
  provider_restrictions text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE agent_execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_deploy_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own execution policies" ON agent_execution_policies;

CREATE POLICY "Users can view own execution policies"
  ON agent_execution_policies FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own execution policies" ON agent_execution_policies;

CREATE POLICY "Users can insert own execution policies"
  ON agent_execution_policies FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own execution policies" ON agent_execution_policies;

CREATE POLICY "Users can update own execution policies"
  ON agent_execution_policies FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own approvals" ON agent_action_approvals;

CREATE POLICY "Users can view own approvals"
  ON agent_action_approvals FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own approvals" ON agent_action_approvals;

CREATE POLICY "Users can insert own approvals"
  ON agent_action_approvals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own approvals" ON agent_action_approvals;

CREATE POLICY "Users can update own approvals"
  ON agent_action_approvals FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own locks" ON agent_execution_locks;

CREATE POLICY "Users can view own locks"
  ON agent_execution_locks FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own locks" ON agent_execution_locks;

CREATE POLICY "Users can insert own locks"
  ON agent_execution_locks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own locks" ON agent_execution_locks;

CREATE POLICY "Users can delete own locks"
  ON agent_execution_locks FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own deploy transactions" ON agent_deploy_transactions;

CREATE POLICY "Users can view own deploy transactions"
  ON agent_deploy_transactions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own deploy transactions" ON agent_deploy_transactions;

CREATE POLICY "Users can insert own deploy transactions"
  ON agent_deploy_transactions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own deploy transactions" ON agent_deploy_transactions;

CREATE POLICY "Users can update own deploy transactions"
  ON agent_deploy_transactions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own action events" ON agent_action_events;

CREATE POLICY "Users can view own action events"
  ON agent_action_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own action events" ON agent_action_events;

CREATE POLICY "Users can insert own action events"
  ON agent_action_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own ai usage" ON agent_ai_usage;

CREATE POLICY "Users can view own ai usage"
  ON agent_ai_usage FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own ai usage" ON agent_ai_usage;

CREATE POLICY "Users can insert own ai usage"
  ON agent_ai_usage FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own budgets" ON agent_budgets;

CREATE POLICY "Users can view own budgets"
  ON agent_budgets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own budgets" ON agent_budgets;

CREATE POLICY "Users can insert own budgets"
  ON agent_budgets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own budgets" ON agent_budgets;

CREATE POLICY "Users can update own budgets"
  ON agent_budgets FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
