/*
  Phase 8.1 — Production Hardening Closure.

  Three genuinely new pieces of schema, none duplicating an existing system:

  1. workflow_executions_v2.status gains 'queued' — the async webhook
     dispatch flow (lib/runtime/execution-dispatch.ts) now creates the
     execution row BEFORE the worker picks it up, so a status distinct from
     'running' is needed for the window between HTTP-accept and worker-claim.

  2. runtime_concurrency_reservations — replaces the Phase 8
     check-then-act concurrency guard (SELECT count(*) then trust it) with a
     true atomic reservation. reserve_concurrency_slot() takes a Postgres
     transaction-scoped advisory lock keyed on (user_id, workflow_id) before
     counting, so two concurrent reservation attempts against the same scope
     can never both observe "under the limit" — the second one blocks on the
     advisory lock until the first commits, then re-counts and sees the
     first's row. This is the same class of guarantee the codebase already
     leans on elsewhere (optimistic CAS via lock_version), just implemented
     as a stored procedure because "check N rows exist, then insert" cannot
     be made atomic through two separate PostgREST round trips no matter how
     it's phrased in JS.

  3. runtime_usage_events — an append-only usage ledger. One row per
     billable/observable fact (execution started/completed/failed, node
     executed, HTTP request made, AI tokens consumed), each carrying a
     caller-supplied idempotency_key under a UNIQUE constraint so retries,
     resumes, and at-least-once queue delivery can never double-count.
     runtime_cost_records / cost-engine.ts (Phase 7-era) were audited and
     found unwired to anything — this is a new, simpler ledger built for
     actual runtime call sites, not a replacement for that dead code (left
     alone per "do not rewrite stable systems"; cost-engine.ts is inert, not
     stable).
*/

-- ============================================================================
-- 1) workflow_executions_v2 — allow 'queued' as a valid status.
-- ============================================================================

DO $$
DECLARE
  constraint_row record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_executions_v2') THEN
    FOR constraint_row IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'workflow_executions_v2'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE workflow_executions_v2 DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
    END LOOP;

    ALTER TABLE workflow_executions_v2
      ADD CONSTRAINT workflow_executions_v2_status_check CHECK (
        status IN ('queued', 'running', 'success', 'failed', 'waiting', 'paused', 'cancelled')
      );
  END IF;
END $$;

-- ============================================================================
-- 2) Atomic concurrency reservations.
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_concurrency_reservations (
  execution_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE INDEX IF NOT EXISTS runtime_concurrency_reservations_user_active_idx
  ON runtime_concurrency_reservations(user_id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS runtime_concurrency_reservations_workflow_active_idx
  ON runtime_concurrency_reservations(workflow_id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS runtime_concurrency_reservations_expiry_idx
  ON runtime_concurrency_reservations(expires_at) WHERE released_at IS NULL;

ALTER TABLE runtime_concurrency_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only_concurrency_reservations" ON runtime_concurrency_reservations;
CREATE POLICY "service_role_only_concurrency_reservations"
  ON runtime_concurrency_reservations FOR ALL USING (false) WITH CHECK (false);

-- Atomically checks and reserves one execution slot for both the owning user
-- and the target workflow in a single round trip. Advisory locks are
-- transaction-scoped (auto-released at COMMIT) and always acquired in a
-- fixed order (user, then workflow) so no two callers can deadlock on them.
-- Expired reservations are reclaimed lazily, inline, before counting, so a
-- crashed worker's slot frees itself on the very next reservation attempt
-- for that scope without requiring a separate sweep process.
CREATE OR REPLACE FUNCTION reserve_concurrency_slot(
  p_execution_id text,
  p_user_id uuid,
  p_workflow_id text,
  p_max_per_user int,
  p_max_per_workflow int,
  p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_count int;
  v_workflow_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('concurrency_user:' || p_user_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('concurrency_workflow:' || p_workflow_id, 0));

  UPDATE runtime_concurrency_reservations
  SET released_at = now()
  WHERE released_at IS NULL AND expires_at < now();

  SELECT count(*) INTO v_user_count
  FROM runtime_concurrency_reservations
  WHERE user_id = p_user_id AND released_at IS NULL;

  IF v_user_count >= p_max_per_user THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'USER_CONCURRENCY_LIMIT', 'current', v_user_count, 'limit', p_max_per_user);
  END IF;

  SELECT count(*) INTO v_workflow_count
  FROM runtime_concurrency_reservations
  WHERE workflow_id = p_workflow_id AND released_at IS NULL;

  IF v_workflow_count >= p_max_per_workflow THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'WORKFLOW_CONCURRENCY_LIMIT', 'current', v_workflow_count, 'limit', p_max_per_workflow);
  END IF;

  INSERT INTO runtime_concurrency_reservations (execution_id, user_id, workflow_id, expires_at)
  VALUES (p_execution_id, p_user_id, p_workflow_id, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (execution_id) DO NOTHING;

  RETURN jsonb_build_object('reserved', true);
END;
$$;

-- Idempotent: releasing an already-released (or never-reserved) execution_id
-- is a silent no-op, so it is always safe to call from every exit path
-- (success, failure, cancellation, enqueue failure, crash-recovery sweep).
CREATE OR REPLACE FUNCTION release_concurrency_slot(p_execution_id text) RETURNS void
LANGUAGE sql
AS $$
  UPDATE runtime_concurrency_reservations
  SET released_at = now()
  WHERE execution_id = p_execution_id AND released_at IS NULL;
$$;

-- Proactive sweep (called from the existing orphan-recovery path) so stale
-- reservations are reclaimed even for scopes that see no new traffic to
-- trigger the lazy reclaim inside reserve_concurrency_slot.
CREATE OR REPLACE FUNCTION reclaim_expired_concurrency_reservations() RETURNS int
LANGUAGE sql
AS $$
  WITH reclaimed AS (
    UPDATE runtime_concurrency_reservations
    SET released_at = now()
    WHERE released_at IS NULL AND expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::int FROM reclaimed;
$$;

GRANT EXECUTE ON FUNCTION reserve_concurrency_slot(text, uuid, text, int, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION release_concurrency_slot(text) TO service_role;
GRANT EXECUTE ON FUNCTION reclaim_expired_concurrency_reservations() TO service_role;

-- ============================================================================
-- 3) Usage metering ledger.
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  execution_id text NOT NULL,
  node_id text,
  event_type text NOT NULL CHECK (
    event_type IN ('execution_started', 'execution_completed', 'execution_failed', 'node_executed', 'http_request', 'ai_tokens')
  ),
  quantity numeric NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS runtime_usage_events_user_month_idx
  ON runtime_usage_events(user_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_usage_events_execution_idx
  ON runtime_usage_events(execution_id);

ALTER TABLE runtime_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only_usage_events" ON runtime_usage_events;
CREATE POLICY "service_role_only_usage_events"
  ON runtime_usage_events FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "users_read_own_usage_events" ON runtime_usage_events;
CREATE POLICY "users_read_own_usage_events"
  ON runtime_usage_events FOR SELECT USING (auth.uid() = user_id);
