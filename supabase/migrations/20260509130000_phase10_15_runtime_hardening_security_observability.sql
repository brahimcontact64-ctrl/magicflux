/*
  # Phase 10-15: Runtime Hardening, Worker Reliability, Security, Deployment Safety, Observability

  Adds production runtime lock/lease safety, distributed ownership, webhook security,
  deployment snapshotting, and observability aggregation primitives.
*/

-- ============================================================================
-- 1) Runtime lock/lease safety
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_execution_locks (
  execution_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  idempotency_key text,
  owner_id text,
  lock_version bigint NOT NULL DEFAULT 1,
  lease_expires_at timestamptz NOT NULL,
  last_status text NOT NULL DEFAULT 'running' CHECK (last_status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_execution_locks_idempotency_idx
  ON runtime_execution_locks(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runtime_execution_locks_user_idx
  ON runtime_execution_locks(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS runtime_execution_locks_lease_idx
  ON runtime_execution_locks(lease_expires_at);

CREATE TABLE IF NOT EXISTS runtime_node_mutexes (
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  owner_id text NOT NULL,
  lock_version bigint NOT NULL DEFAULT 1,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, node_id)
);

CREATE INDEX IF NOT EXISTS runtime_node_mutexes_lease_idx
  ON runtime_node_mutexes(lease_expires_at);

CREATE TABLE IF NOT EXISTS runtime_execution_ownership (
  execution_id text PRIMARY KEY,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  queue_job_id text,
  worker_id text NOT NULL,
  owner_token text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  failover_count integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released', 'orphaned', 'failed_over')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_execution_ownership_worker_idx
  ON runtime_execution_ownership(worker_id, heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS runtime_execution_ownership_lease_idx
  ON runtime_execution_ownership(lease_expires_at);

CREATE TABLE IF NOT EXISTS runtime_execution_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('checkpoint', 'rewind_point', 'failover', 'manual')),
  snapshot_version bigint NOT NULL,
  current_node_id text,
  state_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_queue jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, snapshot_version)
);

CREATE INDEX IF NOT EXISTS runtime_execution_snapshots_exec_idx
  ON runtime_execution_snapshots(execution_id, snapshot_version DESC);

CREATE TABLE IF NOT EXISTS runtime_execution_rewinds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_snapshot_version bigint,
  to_snapshot_version bigint,
  reason text,
  requested_by text NOT NULL DEFAULT 'user',
  applied boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE INDEX IF NOT EXISTS runtime_execution_rewinds_exec_idx
  ON runtime_execution_rewinds(execution_id, created_at DESC);

-- ============================================================================
-- 2) Queue ownership + worker reliability fields
-- ============================================================================

ALTER TABLE runtime_queue_jobs
  ADD COLUMN IF NOT EXISTS owner_worker_id text,
  ADD COLUMN IF NOT EXISTS owner_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS chunk_cursor integer,
  ADD COLUMN IF NOT EXISTS continuation_token text,
  ADD COLUMN IF NOT EXISTS progress_pct numeric(5,2);

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_owner_idx
  ON runtime_queue_jobs(owner_worker_id, heartbeat_at DESC);

ALTER TABLE runtime_workers
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS restart_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interrupted_jobs integer NOT NULL DEFAULT 0;

-- ============================================================================
-- 3) Webhook/runtime security
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_webhook_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  nonce text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, nonce)
);

CREATE INDEX IF NOT EXISTS runtime_webhook_nonces_exp_idx
  ON runtime_webhook_nonces(expires_at);

CREATE TABLE IF NOT EXISTS runtime_webhook_request_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ip_address text,
  signature_valid boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  block_reason text,
  request_hash text,
  suspicious_score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_webhook_request_log_workflow_idx
  ON runtime_webhook_request_log(workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_webhook_request_log_ip_idx
  ON runtime_webhook_request_log(ip_address, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  workflow_id text,
  execution_id text,
  alert_type text NOT NULL CHECK (
    alert_type IN (
      'prompt_injection',
      'tool_abuse',
      'provider_misuse',
      'unsafe_execution',
      'webhook_replay',
      'rate_limit_violation'
    )
  ),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  score integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_security_alerts_user_idx
  ON runtime_security_alerts(user_id, created_at DESC);

-- ============================================================================
-- 4) Deployment safety + observability
-- ============================================================================

CREATE TABLE IF NOT EXISTS deployment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  deployment_version integer NOT NULL,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('pre_activation', 'post_activation', 'rollback_point')),
  workflow_data jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_snapshots_workflow_idx
  ON deployment_snapshots(workflow_id, deployment_version DESC);

CREATE TABLE IF NOT EXISTS runtime_metrics_minute (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  workflow_id text,
  metric_minute timestamptz NOT NULL,
  queue_name text,
  worker_id text,
  executions_started integer NOT NULL DEFAULT 0,
  executions_completed integer NOT NULL DEFAULT 0,
  executions_failed integer NOT NULL DEFAULT 0,
  retries integer NOT NULL DEFAULT 0,
  avg_duration_ms integer,
  avg_provider_latency_ms integer,
  token_usage bigint NOT NULL DEFAULT 0,
  api_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, workflow_id, metric_minute, queue_name, worker_id)
);

CREATE INDEX IF NOT EXISTS runtime_metrics_minute_lookup_idx
  ON runtime_metrics_minute(user_id, workflow_id, metric_minute DESC);

-- ============================================================================
-- 5) RLS
-- ============================================================================

ALTER TABLE runtime_execution_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_node_mutexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_execution_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_execution_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_execution_rewinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_webhook_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_security_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_metrics_minute ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own execution locks" ON runtime_execution_locks;
CREATE POLICY "Users can access own execution locks" ON runtime_execution_locks
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own node mutexes" ON runtime_node_mutexes;
CREATE POLICY "Users can access own node mutexes" ON runtime_node_mutexes
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own execution ownership" ON runtime_execution_ownership;
CREATE POLICY "Users can access own execution ownership" ON runtime_execution_ownership
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own execution snapshots" ON runtime_execution_snapshots;
CREATE POLICY "Users can access own execution snapshots" ON runtime_execution_snapshots
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own execution rewinds" ON runtime_execution_rewinds;
CREATE POLICY "Users can access own execution rewinds" ON runtime_execution_rewinds
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view webhook nonces by workflow" ON runtime_webhook_nonces;
CREATE POLICY "Users can view webhook nonces by workflow" ON runtime_webhook_nonces
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service can insert webhook nonces" ON runtime_webhook_nonces;
CREATE POLICY "Service can insert webhook nonces" ON runtime_webhook_nonces
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can access own webhook logs" ON runtime_webhook_request_log;
CREATE POLICY "Users can access own webhook logs" ON runtime_webhook_request_log
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users can access own security alerts" ON runtime_security_alerts;
CREATE POLICY "Users can access own security alerts" ON runtime_security_alerts
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users can access own deployment snapshots" ON deployment_snapshots;
CREATE POLICY "Users can access own deployment snapshots" ON deployment_snapshots
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own runtime metrics" ON runtime_metrics_minute;
CREATE POLICY "Users can access own runtime metrics" ON runtime_metrics_minute
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);
