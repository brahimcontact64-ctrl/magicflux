/*
  Phase 23 — Preserve Operator Access for Existing Users (S-02)

  Context: Before Phase 23, users with no role assignment implicitly received
  all 7 operational permissions (backward-compat default in getUserPermissions).
  Phase 23 changed that default to ['view_runtime'] only — the minimum safe
  posture for a new unknown user.

  This migration backfills all existing auth.users who have no entry in
  runtime_role_assignments into the 'operator' role, so they retain the access
  they relied on before the default changed.

  New users created AFTER this migration runs will start with ['view_runtime']
  only and must be explicitly assigned a role by an admin.

  Idempotent: ON CONFLICT DO NOTHING ensures replaying is safe.
  Guarded: returns early if RBAC tables don't exist yet.
*/

DO $$
DECLARE
  v_operator_id uuid;
BEGIN
  -- Guard: skip if runtime_roles hasn't been migrated yet.
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'runtime_roles'
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO v_operator_id FROM runtime_roles WHERE name = 'operator';

  -- Guard: operator role must exist (seeded in 20260531000004).
  IF v_operator_id IS NULL THEN
    RETURN;
  END IF;

  -- Assign operator role to every auth user who has no role assignment at all.
  INSERT INTO runtime_role_assignments (user_id, role_id, granted_by)
  SELECT u.id, v_operator_id, NULL
  FROM auth.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM runtime_role_assignments ra WHERE ra.user_id = u.id
  )
  ON CONFLICT (user_id, role_id) DO NOTHING;
END $$;
