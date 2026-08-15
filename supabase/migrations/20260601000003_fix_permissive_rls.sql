/*
  Phase 23 — Fix Permissive RLS Policies (S-03)

  Five runtime tables had USING (true) / WITH CHECK (true) RLS policies that
  allowed any `authenticated` role user to read or write these tables directly
  through the Supabase anon key — bypassing all tenant isolation.

  All app-layer access to these tables goes through createServiceClient() which
  uses the service role key and already bypasses RLS. The RLS policies only
  matter for connections using the anon or authenticated role — there the
  correct answer is DENY unless the caller IS the service role.

  Tables fixed:
    - runtime_execution_events     (event sourcing store)
    - runtime_idempotency_keys     (dedup keys)
    - runtime_execution_commands   (command bus)
    - runtime_command_dispatch_log (dispatch audit)
    - runtime_workflow_versions    (workflow snapshots)

  All statements are idempotent — safe to replay.
*/

-- ============================================================================
-- 1) runtime_execution_events
-- ============================================================================

DROP POLICY IF EXISTS "Service can insert execution events" ON runtime_execution_events;
DROP POLICY IF EXISTS "Service can read execution events"   ON runtime_execution_events;

CREATE POLICY "service_role_only_execution_events_insert"
  ON runtime_execution_events FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service_role_only_execution_events_select"
  ON runtime_execution_events FOR SELECT
  USING (auth.role() = 'service_role');

-- ============================================================================
-- 2) runtime_idempotency_keys
-- ============================================================================

DROP POLICY IF EXISTS "Service can manage idempotency keys" ON runtime_idempotency_keys;

CREATE POLICY "service_role_only_idempotency_keys"
  ON runtime_idempotency_keys FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================================
-- 3) runtime_execution_commands
-- ============================================================================

DROP POLICY IF EXISTS "Service can insert execution commands" ON runtime_execution_commands;
DROP POLICY IF EXISTS "Service can read execution commands"   ON runtime_execution_commands;
DROP POLICY IF EXISTS "Service can update execution commands" ON runtime_execution_commands;

CREATE POLICY "service_role_only_execution_commands_insert"
  ON runtime_execution_commands FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service_role_only_execution_commands_select"
  ON runtime_execution_commands FOR SELECT
  USING (auth.role() = 'service_role');

CREATE POLICY "service_role_only_execution_commands_update"
  ON runtime_execution_commands FOR UPDATE
  USING (auth.role() = 'service_role');

-- ============================================================================
-- 4) runtime_command_dispatch_log
-- ============================================================================

DROP POLICY IF EXISTS "Service can manage command dispatch log" ON runtime_command_dispatch_log;

CREATE POLICY "service_role_only_command_dispatch_log"
  ON runtime_command_dispatch_log FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================================
-- 5) runtime_workflow_versions
-- ============================================================================

DROP POLICY IF EXISTS "Service can manage workflow versions" ON runtime_workflow_versions;

CREATE POLICY "service_role_only_workflow_versions"
  ON runtime_workflow_versions FOR ALL
  USING (auth.role() = 'service_role');
