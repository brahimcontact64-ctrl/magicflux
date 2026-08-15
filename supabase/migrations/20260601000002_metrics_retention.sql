/*
  Phase 21 — Metrics Retention & Automated Purge

  Problem: runtime_metrics grows without bound (69M rows/month at scale).
  runtime_cost_records accumulates indefinitely. Both tables have no TTL.

  runtime_execution_events CANNOT be hard-deleted — the BEFORE DELETE trigger
  added in 20260601000001 will reject any DELETE unconditionally to protect
  event-sourcing replay correctness. Instead we mark old events archivable=true
  via a direct UPDATE that only touches that column (trigger allows it).

  Retention policy:
    runtime_metrics            — 30  days  (high-frequency, low-value after window)
    runtime_cost_records       — 365 days  (financial audit trail, 1-year retention)
    runtime_execution_events   — 90  days  (mark archivable only; no hard delete)

  Implementation:
    1. purge_stale_runtime_metrics()   — DELETE rows older than 30 days
    2. purge_stale_cost_records()      — DELETE rows older than 365 days
    3. expire_old_execution_events()   — UPDATE archivable=true where > 90 days old
    4. run_retention_policies()        — wrapper that calls all three and returns counts
    5. pg_cron schedule (if pg_cron extension exists) — daily at 03:00 UTC

  All functions are SECURITY DEFINER to bypass RLS. Idempotent — safe to replay.
*/

-- ============================================================================
-- 1) purge_stale_runtime_metrics()
-- ============================================================================

CREATE OR REPLACE FUNCTION purge_stale_runtime_metrics(
  p_retention_days integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff    timestamptz := now() - make_interval(days => p_retention_days);
  v_deleted   integer;
BEGIN
  DELETE FROM runtime_metrics
   WHERE recorded_at < v_cutoff;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ============================================================================
-- 2) purge_stale_cost_records()
-- ============================================================================

CREATE OR REPLACE FUNCTION purge_stale_cost_records(
  p_retention_days integer DEFAULT 365
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff    timestamptz := now() - make_interval(days => p_retention_days);
  v_deleted   integer;
BEGIN
  DELETE FROM runtime_cost_records
   WHERE period_start < v_cutoff;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ============================================================================
-- 3) expire_old_execution_events()
--
--    Marks events archivable=true for rows older than p_retention_days.
--    Uses direct UPDATE (only touches archivable column) — passes the
--    immutability trigger added in 20260601000001.
--    Does NOT delete rows — hard deletion is forbidden.
-- ============================================================================

CREATE OR REPLACE FUNCTION expire_old_execution_events(
  p_retention_days integer DEFAULT 90
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff    timestamptz := now() - make_interval(days => p_retention_days);
  v_marked    integer;
BEGIN
  UPDATE runtime_execution_events
     SET archivable = true
   WHERE created_at  < v_cutoff
     AND archivable  = false;

  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN v_marked;
END;
$$;

-- ============================================================================
-- 4) run_retention_policies() — orchestrating wrapper
-- ============================================================================

CREATE OR REPLACE FUNCTION run_retention_policies()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_metrics_deleted   integer;
  v_cost_deleted      integer;
  v_events_marked     integer;
BEGIN
  v_metrics_deleted := purge_stale_runtime_metrics(30);
  v_cost_deleted    := purge_stale_cost_records(365);
  v_events_marked   := expire_old_execution_events(90);

  RETURN jsonb_build_object(
    'runtime_metrics_deleted',        v_metrics_deleted,
    'runtime_cost_records_deleted',   v_cost_deleted,
    'runtime_execution_events_marked_archivable', v_events_marked,
    'ran_at', now()
  );
END;
$$;

-- ============================================================================
-- 5) pg_cron schedule — daily at 03:00 UTC (only if pg_cron is available)
--
--    Wrapped in a DO block with an existence check so this migration succeeds
--    on Supabase instances without pg_cron (free tier, local dev).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Remove any existing schedule with the same name before re-creating.
    PERFORM cron.unschedule('runtime_retention_daily')
      WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'runtime_retention_daily'
      );

    PERFORM cron.schedule(
      'runtime_retention_daily',
      '0 3 * * *',
      'SELECT run_retention_policies()'
    );
  END IF;
END;
$$;
