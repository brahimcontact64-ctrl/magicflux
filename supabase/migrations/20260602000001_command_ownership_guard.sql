/*
  Phase 22 — Command Ownership Guard + Scale Indexes

  Problem 1: Cross-tenant command injection
    A user with manage_commands permission could insert a command with an
    execution_id that belongs to a different user. append_execution_command()
    is SECURITY DEFINER and bypasses RLS, so RLS alone cannot block this.

    Fix: BEFORE INSERT trigger on runtime_execution_commands that looks up
    the execution owner in workflow_executions_v2. If the execution exists
    and the user_id on the incoming row does not match the execution owner,
    the INSERT is rejected with insufficient_privilege.

    The trigger allows inserts when:
      - NEW.user_id IS NULL (system-generated commands, e.g. timers/recovery)
      - No row found in workflow_executions_v2 for that execution_id
        (legacy/boot-phase executions predating v2)
      - NEW.user_id = workflow_executions_v2.user_id (correct ownership)

  Problem 2: Missing indexes flagged in Phase 21 scalability report
    - GIN index on runtime_metrics.labels (label-filtered queries sequential scan)
    - runtime_workers(heartbeat_at DESC)   (liveness check at 1K+ workers)
    - runtime_queue_jobs(status, heartbeat_at) (recovery hot path)

  All statements are idempotent — safe to replay.
*/

-- ============================================================================
-- 1) guard_execution_command_ownership() — BEFORE INSERT trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION guard_execution_command_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_owner_user_id uuid;
BEGIN
  -- System commands (NULL user_id) are always permitted.
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Look up the execution owner.  Cast execution_id (text) to match the uuid PK.
  -- If the cast fails (non-UUID execution_id) or no row exists, v_owner_user_id stays NULL.
  BEGIN
    SELECT e.user_id
      INTO v_owner_user_id
      FROM workflow_executions_v2 e
     WHERE e.id = NEW.execution_id::uuid
     LIMIT 1;
  EXCEPTION WHEN invalid_text_representation THEN
    -- execution_id is not a valid UUID — no ownership row can exist; allow.
    RETURN NEW;
  END;

  -- If the execution is not yet registered in v2, allow the insert.
  IF v_owner_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Reject cross-tenant command injection.
  IF v_owner_user_id <> NEW.user_id THEN
    RAISE EXCEPTION
      'cross_tenant_command_rejected: execution % is owned by a different user',
      left(NEW.execution_id, 8)
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_execution_command_ownership ON runtime_execution_commands;

CREATE TRIGGER tg_execution_command_ownership
  BEFORE INSERT ON runtime_execution_commands
  FOR EACH ROW
  EXECUTE FUNCTION guard_execution_command_ownership();

-- ============================================================================
-- 2) GIN index on runtime_metrics.labels (P1 from scalability report)
--    Enables WHERE labels @> '{"worker_id":"..."}' without a full table scan.
--    Guarded: skipped if runtime_metrics has not yet been migrated.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'runtime_metrics'
  ) THEN
    CREATE INDEX IF NOT EXISTS runtime_metrics_labels_gin
      ON runtime_metrics USING GIN (labels);
  END IF;
END $$;

-- ============================================================================
-- 3) runtime_workers(heartbeat_at DESC) — liveness-check hot path
--    Used by GET /api/health/runtime: WHERE heartbeat_at > now() - '2 minutes'
--    Guarded: skipped if runtime_workers has not yet been migrated.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'runtime_workers'
  ) THEN
    CREATE INDEX IF NOT EXISTS runtime_workers_heartbeat_idx
      ON runtime_workers (heartbeat_at DESC);
  END IF;
END $$;

-- ============================================================================
-- 4) runtime_queue_jobs(status, heartbeat_at) — recovery hot path
--    Used by recoverStuckQueueJobs(): WHERE status='active' AND heartbeat_at < cutoff
--    Guarded: skipped if runtime_queue_jobs or its heartbeat_at column is absent.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'runtime_queue_jobs'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'runtime_queue_jobs'
      AND column_name  = 'heartbeat_at'
  ) THEN
    CREATE INDEX IF NOT EXISTS runtime_queue_jobs_status_heartbeat_idx
      ON runtime_queue_jobs (status, heartbeat_at ASC)
      WHERE status = 'active';
  END IF;
END $$;
