/*
  Lock down the four retention RPCs to service_role only.

  20260601000002_metrics_retention.sql created these functions without a
  REVOKE, so they carry Postgres's default EXECUTE grant to PUBLIC --
  meaning any caller holding the public anon key, or any authenticated
  user, can invoke them directly via the PostgREST RPC endpoint today, not
  just service-role/cron. Confirmed via schema dump immediately after that
  migration was applied: both target tables are currently empty (0 rows),
  so no data has been lost to this, but the exposure is real and live —
  the moment either table accumulates real rows, any anon/authenticated
  caller could trigger an early, out-of-schedule purge.

  This migration changes privileges only. It does not alter any function's
  logic (all four bodies are untouched, still CREATE OR REPLACE-free here
  — no ALTER FUNCTION ... body statements at all), does not invoke any of
  the four functions, and does not delete or modify any row in any table.

  Idempotent: REVOKE on a privilege not held, and GRANT on a privilege
  already held, are both no-ops in Postgres (safe to replay).
*/

REVOKE EXECUTE ON FUNCTION public.purge_stale_runtime_metrics(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_stale_runtime_metrics(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_stale_runtime_metrics(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_stale_runtime_metrics(integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.purge_stale_cost_records(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_stale_cost_records(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_stale_cost_records(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_stale_cost_records(integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.expire_old_execution_events(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_old_execution_events(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.expire_old_execution_events(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.expire_old_execution_events(integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.run_retention_policies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.run_retention_policies() FROM anon;
REVOKE EXECUTE ON FUNCTION public.run_retention_policies() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.run_retention_policies() TO service_role;
