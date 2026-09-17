/*
  # RPC privilege lockdown -- REVISED, EXPANDED SCOPE

  PROPOSED MIGRATION -- NOT YET APPLIED. Presented for approval per the
  standing migration-safety instruction; STOP before applying.

  ============================================================================
  REVISION HISTORY
  ============================================================================

  Phase 9.9.16 Part P found 4 functions (append_execution_event,
  mark_execution_events_compactable, mark_execution_events_archivable,
  open_or_bump_incident) with EXECUTE still granted to anon/authenticated.
  Phase 9.9.16A Part A required a full re-audit of every function in every
  supabase/migrations SQL file before applying anything, specifically to
  rule out "are these 4 the entire exposed class, or only the first found."

  They were NOT the entire class. The full re-audit (29 CREATE FUNCTION
  statements across 14 migration files, confirmed exhaustive by grep across
  all 63 migration files) plus a LIVE `has_function_privilege` check found
  14 MORE functions with the identical gap, several more severe than the
  original 4 because they take NO tenant-scoping parameter at all (any
  caller can read cross-tenant data or hijack another tenant's queued work,
  not merely forge a row under a guessed id). This migration supersedes the
  original 4-function draft with the complete, verified set. Per Part F/G's
  explicit instruction, nothing was applied while this revision was in
  progress -- this file was rewritten in place before any `supabase db
  push`.

  ============================================================================
  CLASSIFICATION BY INTENDED CALLER (Part B/D)
  ============================================================================

  Every function below is called, in every confirmed application code path,
  through `createServiceClient()` (service_role) from inside a Next.js API
  route that has already performed its own `getUserFromRequest()` check --
  this codebase has NO code path that expects a browser/mobile client to
  invoke any of these RPCs directly with its own anon-key/authenticated-JWT
  session. None are "legitimately intended for authenticated direct
  invocation" (Part B's explicit caution) -- every one below is classified
  service-only and locked to `service_role` alone. No function in this
  migration is granted broadly "to be safe" -- each grant matches its own
  confirmed real caller.

  ============================================================================
  GROUP 1 -- SECURITY DEFINER, zero tenant-scoping parameter at all
  (most severe: exploitable for cross-tenant READ or cross-tenant queued-
  work HIJACK by any anon/authenticated caller, no guessed id required)
  ============================================================================

  detect_repeated_node_failures, detect_execution_loops, detect_retry_storm,
  detect_dlq_spike, detect_worker_crashes, detect_queue_congestion (Phase
  11/self-healing anomaly detectors, 20260525000001/20260525000003): each
  returns aggregate/row-level execution/worker/queue data across ALL
  tenants with no caller-supplied scope to even misuse -- confirmed live,
  anon and authenticated both have EXECUTE today.

  fetch_pending_execution_commands (Phase 14 command bus,
  20260529000001): takes only `p_worker_id text, p_limit integer` -- any
  caller can claim (UPDATE status on) ANY tenant's queued execution
  commands by supplying an arbitrary worker id string. This is the single
  most severe finding in this audit: a live cross-tenant execution-hijack/
  DoS primitive, not merely a forgeable audit log entry.

  ============================================================================
  GROUP 2 -- SECURITY DEFINER, trusts a caller-supplied user_id with no
  auth.uid() cross-check (the original 4, plus 3 more of the same shape)
  ============================================================================

  append_execution_event, mark_execution_events_compactable,
  mark_execution_events_archivable, open_or_bump_incident (original Part P
  finding) -- append_execution_command (identical shape to
  append_execution_event, same Phase 14 file) -- ack_execution_command
  (acknowledges an arbitrary command given only its uuid + a worker_id
  string, no user scoping) -- get_stale_credential_users (Phase 5, already
  had an explicit-but-INCOMPLETE grant statement in its own migration --
  confirmed LIVE it still grants EXECUTE to anon/authenticated today,
  because "REVOKE ... FROM PUBLIC" alone never revokes anon/authenticated's
  own separately-materialized default-privilege grant -- the identical root
  cause as the other 13; returns arbitrary users' UUIDs cross-tenant by
  design, for internal ops only).

  ============================================================================
  GROUP 3 -- SECURITY INVOKER, trusts a caller-supplied user_id in its own
  body, but table-level RLS was independently verified (read-only, this
  audit) to still block real cross-tenant harm today
  ============================================================================

  save_credentials_with_verification: writes integration_credentials and
  credential_verifications. Both tables' own RLS policies WITH CHECK
  (auth.uid() = user_id) / no permissive write policy at all (RLS defaults
  to deny) mean a caller who supplies someone else's p_user_id has their
  attempted write REJECTED by RLS regardless of what the function itself
  trusts -- confirmed structurally safe, exactly like record_lead_outcome_
  atomic's own prior audit. Locked down anyway (Part D: "do not leave
  broader privilege merely because exploitation is currently difficult" --
  and its own migration's stated intent was already service_role-only).

  reserve_concurrency_slot, release_concurrency_slot,
  reclaim_expired_concurrency_reservations: write
  runtime_concurrency_reservations, which carries a single blanket
  `USING (false) WITH CHECK (false)` policy for `public` -- confirmed live,
  this denies every write from any role that isn't RLS-exempt (owner/
  BYPASSRLS), regardless of the wide EXECUTE grant. Locked down anyway for
  the same least-privilege reasoning.

  record_lead_outcome_atomic (Phase 9.9.15A): re-checked under this same
  methodology per Part D's explicit instruction. Its own migration already
  ran `REVOKE ALL ... FROM PUBLIC` + `GRANT ... TO service_role`, but a
  LIVE check (this audit) shows anon/authenticated STILL have EXECUTE --
  the exact "REVOKE FROM PUBLIC never touches anon/authenticated's own
  grant" root cause found everywhere else in this migration. Its intended
  caller is exclusively the trusted /api/qualification-decisions/[id]/
  outcome route (service_role); direct authenticated invocation was never
  a design goal, so per Part D this gets the SAME explicit-role REVOKE
  here, correcting a gap in the fix that was believed complete last phase.

  ============================================================================
  GROUP 4 -- trigger-only functions (never directly RPC-callable via
  PostgREST -- fired only by their own CREATE TRIGGER binding, so no
  EXECUTE-grant change applies) -- search_path pinned anyway (Part C: "for
  every SECURITY DEFINER function that remains", not limited to the
  RPC-callable subset; pure metadata, zero behavior risk)
  ============================================================================

  protect_execution_event_immutability, prevent_execution_event_delete
  (20260601000001), guard_execution_command_ownership (20260602000001).

  ============================================================================
  THE CHANGE -- privileges/metadata only, no function body touched
  ============================================================================

  For every RPC-callable function in Groups 1-3: REVOKE ALL FROM PUBLIC,
  anon, authenticated (explicit per-role, not just PUBLIC); GRANT EXECUTE TO
  service_role only; ALTER FUNCTION ... SET search_path = public, pg_temp.
  For Group 4 (trigger-only): search_path pin only, no grant change (moot).

  No function's body, return type, or argument list is touched by this
  migration. Every already-correctly-locked-down function from
  20260616000001_lock_down_retention_rpcs.sql (purge_stale_runtime_metrics,
  purge_stale_cost_records, expire_old_execution_events,
  run_retention_policies) was re-verified live in this audit and is NOT
  touched here -- confirmed anon_exec=false/authenticated_exec=false
  already, proving the explicit-per-role REVOKE pattern this migration
  reuses does work correctly once actually applied with the right roles
  named.

  ============================================================================
  ROLLBACK
  ============================================================================

  GRANT EXECUTE ON FUNCTION <name>(<args>) TO anon, authenticated; and
  ALTER FUNCTION <name>(<args>) RESET search_path; per function, if a
  legitimate direct-invocation caller is ever found (none are known today).
*/

-- ── Group 1 -- zero tenant scoping, most severe ─────────────────────────────

REVOKE ALL ON FUNCTION "public"."detect_repeated_node_failures"(integer, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_repeated_node_failures"(integer, integer) TO "service_role";
ALTER FUNCTION "public"."detect_repeated_node_failures"(integer, integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."detect_execution_loops"(integer, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_execution_loops"(integer, integer) TO "service_role";
ALTER FUNCTION "public"."detect_execution_loops"(integer, integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."detect_retry_storm"(numeric, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_retry_storm"(numeric, integer) TO "service_role";
ALTER FUNCTION "public"."detect_retry_storm"(numeric, integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."detect_dlq_spike"(integer, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_dlq_spike"(integer, integer) TO "service_role";
ALTER FUNCTION "public"."detect_dlq_spike"(integer, integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."detect_worker_crashes"(integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_worker_crashes"(integer) TO "service_role";
ALTER FUNCTION "public"."detect_worker_crashes"(integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."detect_queue_congestion"(integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."detect_queue_congestion"(integer) TO "service_role";
ALTER FUNCTION "public"."detect_queue_congestion"(integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."fetch_pending_execution_commands"(text, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."fetch_pending_execution_commands"(text, integer) TO "service_role";
ALTER FUNCTION "public"."fetch_pending_execution_commands"(text, integer) SET search_path = public, pg_temp;

-- ── Group 2 -- trusts caller-supplied user_id, no auth.uid() check ─────────

REVOKE ALL ON FUNCTION "public"."append_execution_event"(text, text, uuid, text, text, integer, text, text, text, bigint, jsonb, jsonb) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."append_execution_event"(text, text, uuid, text, text, integer, text, text, text, bigint, jsonb, jsonb) TO "service_role";
ALTER FUNCTION "public"."append_execution_event"(text, text, uuid, text, text, integer, text, text, text, bigint, jsonb, jsonb) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."mark_execution_events_archivable"(text, uuid, timestamptz) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."mark_execution_events_archivable"(text, uuid, timestamptz) TO "service_role";
ALTER FUNCTION "public"."mark_execution_events_archivable"(text, uuid, timestamptz) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."mark_execution_events_compactable"(text, uuid, bigint) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."mark_execution_events_compactable"(text, uuid, bigint) TO "service_role";
ALTER FUNCTION "public"."mark_execution_events_compactable"(text, uuid, bigint) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."open_or_bump_incident"(text, text, uuid, uuid, text, uuid, text, text, jsonb) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."open_or_bump_incident"(text, text, uuid, uuid, text, uuid, text, text, jsonb) TO "service_role";
ALTER FUNCTION "public"."open_or_bump_incident"(text, text, uuid, uuid, text, uuid, text, text, jsonb) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."append_execution_command"(text, text, uuid, text, integer, text, text, text, jsonb, jsonb, timestamptz) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."append_execution_command"(text, text, uuid, text, integer, text, text, text, jsonb, jsonb, timestamptz) TO "service_role";
ALTER FUNCTION "public"."append_execution_command"(text, text, uuid, text, integer, text, text, text, jsonb, jsonb, timestamptz) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."ack_execution_command"(uuid, text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."ack_execution_command"(uuid, text) TO "service_role";
ALTER FUNCTION "public"."ack_execution_command"(uuid, text) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."get_stale_credential_users"(timestamptz, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_stale_credential_users"(timestamptz, integer) TO "service_role";
ALTER FUNCTION "public"."get_stale_credential_users"(timestamptz, integer) SET search_path = public, pg_temp;

-- ── Group 3 -- RLS-safe today, locked down anyway for least privilege ──────

REVOKE ALL ON FUNCTION "public"."save_credentials_with_verification"(uuid, text, jsonb, text, jsonb) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."save_credentials_with_verification"(uuid, text, jsonb, text, jsonb) TO "service_role";
ALTER FUNCTION "public"."save_credentials_with_verification"(uuid, text, jsonb, text, jsonb) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."reserve_concurrency_slot"(text, uuid, text, integer, integer, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reserve_concurrency_slot"(text, uuid, text, integer, integer, integer) TO "service_role";
ALTER FUNCTION "public"."reserve_concurrency_slot"(text, uuid, text, integer, integer, integer) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."release_concurrency_slot"(text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."release_concurrency_slot"(text) TO "service_role";
ALTER FUNCTION "public"."release_concurrency_slot"(text) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."reclaim_expired_concurrency_reservations"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reclaim_expired_concurrency_reservations"() TO "service_role";
ALTER FUNCTION "public"."reclaim_expired_concurrency_reservations"() SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION "public"."record_lead_outcome_atomic"(uuid, uuid, uuid, text, numeric, text, text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_lead_outcome_atomic"(uuid, uuid, uuid, text, numeric, text, text) TO "service_role";
ALTER FUNCTION "public"."record_lead_outcome_atomic"(uuid, uuid, uuid, text, numeric, text, text) SET search_path = public, pg_temp;

-- ── Group 4 -- trigger-only, search_path pin only (not RPC-callable) ───────

ALTER FUNCTION "public"."protect_execution_event_immutability"() SET search_path = public, pg_temp;
ALTER FUNCTION "public"."prevent_execution_event_delete"() SET search_path = public, pg_temp;
ALTER FUNCTION "public"."guard_execution_command_ownership"() SET search_path = public, pg_temp;
