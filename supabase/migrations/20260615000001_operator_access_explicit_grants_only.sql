/*
  Replacement for 20260601000004_preserve_operator_access.sql — NOT a
  drop-in re-implementation. That migration is retained in the tracked
  history for the record but is classified BLOCKING_UNSAFE and must never be
  applied: it grants the 'operator' role (manage_workers, manage_incidents,
  manage_commands, manage_executions, view_audit, manage_replay -- 7 of 8
  runtime permissions) to every auth.users row with no existing role
  assignment, unconditionally. In this production database that is all 41
  users, including the 16+ who have never created a workflow.

  Code-traced impact of 'operator' (see Batch C audit report):
    - execution-level actions (pause/resume/cancel/snapshot) ARE
      ownership-scoped in app/api/runtime/control/executions/route.ts --
      not the exposure.
    - worker-level actions are NOT ownership-scoped, structurally, because
      workers are shared infrastructure with no per-tenant owner concept.
      POST /api/runtime/control/workers {action:'restart'|'drain'} accepts
      any worker_id from any caller holding manage_workers, full stop.
    - GET /api/runtime/control/workers and /overview return the live
      worker fleet (hostnames, PIDs, cpu/memory, error messages) and
      system-wide health score to anyone holding view_runtime, which
      'operator' includes.
  Granting 'operator' in bulk therefore hands ordinary end-users the
  ability to see and disrupt shared production infrastructure serving
  every other tenant. This is not a legitimate authorization model worth
  "preserving" -- it re-introduces exactly the gap Phase 23's security
  hardening (fix_permissive_rls, the getUserPermissions() restrictive
  default) closed.

  Corrected policy, per explicit instruction:
    - ordinary users get NO new role assignment. The existing restrictive
      default (getUserPermissions() returns ['view_runtime'] for any user
      with zero runtime_role_assignments rows -- lib/runtime/rbac.ts:41-46,
      already live) is preserved as-is. No DB change is needed or made for
      this; it is already true today.
    - operator/admin roles are granted ONLY to an explicit, individually
      reviewed allowlist of trusted MagicFlux operations user IDs -- never
      inferred from workflow ownership, execution history, or any other
      product-usage signal.
    - this migration, as committed, grants NOTHING. TRUSTED_OPERATOR_IDS
      below is intentionally empty. It must be populated with real,
      reviewed user IDs (one per line, with a comment noting who approved
      it and why) before this migration has any effect. Applying it
      unmodified is a safe no-op.

  Idempotent: ON CONFLICT (user_id, role_id) DO NOTHING, safe to replay
  after the allowlist is populated and reapplied as a fresh migration
  (this file should not be edited after being applied once -- add a new
  forward migration for any later change to the allowlist, same pattern
  as every other migration in this project).
*/

DO $$
DECLARE
  -- Populate with real, reviewed user IDs before this has any effect.
  -- Example: '11111111-1111-1111-1111-111111111111', -- approved by <name>, <date>, <reason>
  v_trusted_operator_ids uuid[] := ARRAY[]::uuid[];
  v_operator_id uuid;
BEGIN
  IF array_length(v_trusted_operator_ids, 1) IS NULL THEN
    RAISE NOTICE 'operator_access_explicit_grants_only: allowlist is empty, no-op.';
    RETURN;
  END IF;

  SELECT id INTO v_operator_id FROM runtime_roles WHERE name = 'operator';
  IF v_operator_id IS NULL THEN
    RAISE NOTICE 'operator_access_explicit_grants_only: operator role not found, no-op.';
    RETURN;
  END IF;

  INSERT INTO runtime_role_assignments (user_id, role_id, granted_by)
  SELECT uid, v_operator_id, NULL
  FROM unnest(v_trusted_operator_ids) AS uid
  WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uid)
  ON CONFLICT (user_id, role_id) DO NOTHING;
END $$;
