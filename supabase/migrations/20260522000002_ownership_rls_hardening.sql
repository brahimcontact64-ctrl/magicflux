-- ============================================================================
-- RLS hardening: fix overly permissive policies on runtime infrastructure
-- tables created in phases 7 and 10-15.
--
-- Problems fixed:
--
--   runtime_workers
--     SELECT/INSERT/UPDATE USING (true) — any authenticated user can read all
--     worker rows (infrastructure leak), insert fake workers, update any worker.
--     Fix: drop all authenticated-role policies. Service role (used by all
--     backend paths) bypasses RLS and retains full access.
--
--   runtime_webhook_nonces
--     SELECT/INSERT WITH CHECK (true) — any authenticated user can read all
--     nonces or insert arbitrary nonces.  No user_id column exists; this table
--     is internal infrastructure only.
--     Fix: drop all authenticated-role policies.
--
--   runtime_webhook_request_log
--   runtime_security_alerts
--   runtime_metrics_minute
--     FOR ALL USING (auth.uid() = user_id OR user_id IS NULL) — the
--     OR user_id IS NULL clause lets every authenticated user read system-level
--     rows (rows written by the backend with no user context).
--     Fix: replace with SELECT scoped to auth.uid() = user_id only.
--     INSERT remains open for service-role writes; no authenticated INSERT
--     policy is needed since these tables are written server-side only.
-- ============================================================================

-- ── runtime_workers: remove permissive authenticated-role policies ─────────

DROP POLICY IF EXISTS "Users can view own workers"   ON runtime_workers;
DROP POLICY IF EXISTS "Users can insert workers"     ON runtime_workers;
DROP POLICY IF EXISTS "Users can update workers"     ON runtime_workers;

-- No replacement policies: service role bypasses RLS for all backend access.

-- ── runtime_webhook_nonces: remove permissive authenticated-role policies ──

DROP POLICY IF EXISTS "Users can view webhook nonces by workflow" ON runtime_webhook_nonces;
DROP POLICY IF EXISTS "Service can insert webhook nonces"         ON runtime_webhook_nonces;

-- No replacement policies: nonces are infrastructure-only, no user_id column.

-- ── runtime_webhook_request_log: restrict to own rows, drop null leak ──────

DROP POLICY IF EXISTS "Users can access own webhook logs" ON runtime_webhook_request_log;

CREATE POLICY "Users can read own webhook logs"
  ON runtime_webhook_request_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── runtime_security_alerts: restrict to own rows, drop null leak ──────────

DROP POLICY IF EXISTS "Users can access own security alerts" ON runtime_security_alerts;

CREATE POLICY "Users can read own security alerts"
  ON runtime_security_alerts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── runtime_metrics_minute: restrict to own rows, drop null leak ───────────

DROP POLICY IF EXISTS "Users can access own runtime metrics" ON runtime_metrics_minute;

CREATE POLICY "Users can read own runtime metrics"
  ON runtime_metrics_minute
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
